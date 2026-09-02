import { isTopOverlayNow, useRegisterOverlay } from '../context/overlayContext.js';
import * as React from 'react'
import { useEffect, useMemo, useState } from 'react'
import type { Command } from '../commands.js'
import { useTerminalSize } from '../hooks/useTerminalSize.js'
import { CockpitActiveContext } from '../context/cockpitActiveContext.js'
import { Box, Text, useInput } from '../ink.js'
import { ACTION_GRAPH } from '../keybindings/actionGraph.js'
import { actionAffordance } from '../keybindings/atlas.js'
import { useOptionalKeybindingContext } from '../keybindings/KeybindingContext.js'
import type { KeybindingContextName } from '../keybindings/types.js'
import { getCommandName } from '../types/command.js'
import { fuzzySearch } from '../utils/fuzzyMatch.js'
import { getSkillUsageScore } from '../utils/suggestions/skillUsageTracking.js'
import TextInput from './TextInput.js'
import { CommandCenter, EmptyState } from './mercury-ui/components.js'
import { displayWidth, GLYPH, truncateToWidth } from './mercury-ui/glyphs.js'
import { InteractiveRow } from './mercury-ui/InteractiveRow.js'
import { useMercuryTokens } from './mercury-ui/useMercuryTokens.js'
import { applyNavMotion, decodeNavKey } from './mercury-ui/navSemantics.js'
import { cockpitBottomSlotReserve, paneWindow, viewportRows } from './mercury-ui/geometry.js'
import { useOpenEventGate } from './mercury-ui/useOpenEventGate.js'

// Greedy-earliest subsequence positions of `q` within `s` (case-insensitive) — the
// same match shape fuzzySearch ranks by. Returns the matched indices ONLY when the
// FULL query is a subsequence of the name; a description-hit row (query not in the
// name) returns empty → no highlight. Lets the palette bold the chars that matched,
// the signature "why did this rank" affordance of a modern command palette.
function matchPositions(s: string, q: string): Set<number> {
  const out = new Set<number>()
  if (!q) return out
  const sl = s.toLowerCase()
  const ql = q.toLowerCase()
  let qi = 0
  for (let i = 0; i < sl.length && qi < ql.length; i++) {
    if (sl[i] === ql[qi]) {
      out.add(i)
      qi++
    }
  }
  return qi === ql.length ? out : new Set()
}

// The command name with its fuzzy-matched chars popped (accent+bold on the focused
// row, primary+bold otherwise), padded to the column. Per-char Text is fine at palette
// scale (≤ NAME_WIDTH × MAX_ROWS spans). Exported for the deterministic render-proof
// (render-command-palette.tsx) — a PURE component (ink roles arrive as props so the
// proof can mount it without theme context), no input/timing to race.
export function NameHighlight({
  name,
  query,
  here,
  accent,
  textPrimary,
  textSecondary,
}: {
  name: string
  query: string
  here: boolean
  accent: string
  textPrimary: string
  textSecondary: string
}): React.ReactNode {
  const nm = truncateToWidth(name, NAME_WIDTH)
  const hits = matchPositions(nm, query.trim())
  const base = here ? textPrimary : textSecondary
  const hi = here ? accent : textPrimary
  const pad = ' '.repeat(Math.max(0, NAME_WIDTH - displayWidth(nm)))
  return (
    <Text>
      {[...nm].map((ch, k) => (
        <Text key={k} color={hits.has(k) ? hi : base} bold={hits.has(k)}>
          {ch}
        </Text>
      ))}
      {pad}
    </Text>
  )
}

// ============================================================================
//  MercuryCommandPalette — the warm-ink command launcher (fork). A chord-invoked
//  (ctrl+x p) overlay that fuzzy-ranks ALL enabled slash commands by name AND
//  finds them by what they DO (description substring), with the recently-used
//  ones surfaced first on an empty query. This is strictly MORE than the inline
//  `/` menu: invokable mid-typing from anywhere, fuzzy-over-description, and a
//  honest "recent" section. Selecting INSERTS `/name ` at the cursor (safe,
//  reversible — no auto-run, no data loss): one ↵ runs a no-arg command, or type
//  args first. ONE useInput owns the query buffer + row nav (clamped, never
//  wraps); a short ready-buffer swallows the launching chord's trailing key.
//  Bounded list + `+N more`; honest empty states. Flag-gated at the call site.
// ============================================================================

type PaletteItem = { name: string; desc: string; recent: boolean; score: number; run?: () => void; kind?: ActionKind; keychord?: string; unavailable?: string }
// A non-command ACTION row (e.g. "open a file" → ctrl+x f). Selecting it runs the
// callback instead of inserting `/name `, making ctrl+x p the single quick-open hub.
// `kind` names the Enter semantics EXPLICITLY (grammar: Enter performs the
// primary reversible action — 'open' a picker, 'insert' text, 'toggle' a
// setting, 'switch' a context); the direct binding shown on the row is
// RESOLVED from `action`/`context` through the Action Graph, never a literal —
// a palette that prints a chord the operator has rebound teaches the wrong key.
export type ActionKind = 'open' | 'insert' | 'toggle' | 'switch'
export type PaletteAction = {
  label: string
  detail?: string
  run: () => void
  kind?: ActionKind
  /** Action Graph id whose live binding is shown beside the row. */
  action?: string
  context?: KeybindingContextName
}

const NAME_WIDTH = 22
const QUERY_WIDTH = 56
// A paste is capped here: a fuzzy query longer than this matches nothing a
// shorter prefix would not, and an uncapped paste grew the overlay past the
// screen. Generous headroom over the visible QUERY_WIDTH viewport.
const QUERY_MAX_LENGTH = 200
const MAX_ROWS = 12
// Action Graph rows are a bounded tail on a query, never the bulk of the list.
const GRAPH_ROWS = 5
// On the home screen the living splash is fixed-height ABOVE this bottom-slot
// overlay, so a tall list overflows the alt-screen and clips its own footer.
// Reserve ~26 rows for the splash + palette chrome and clamp the visible list to
// what fits — premium on a tall terminal, never-overflow on a short one.
const HEIGHT_RESERVE = 26
// The COCKPIT's bottom slot is shorter than the home's (the rails row + the
// SESSIONS card sit above it): a 40-row cockpit fits ~8 list rows, and the
// old home-tuned cap (12) overflowed the slot — the clipped tail merged into
// the counter line (`…full listUST use this…`, the before-capture
// defect). Reserve the extra rows the cockpit chrome actually costs.
const MIN_ROWS = 4

export function MercuryCommandPalette({
  commands,
  actions,
  onRun,
  onClose,
  isActive = true,
}: {
  commands: Command[]
  actions?: PaletteAction[]
  onRun: (insertText: string) => void
  onClose: () => void
  isActive?: boolean
}): React.ReactNode {
  // class kill: registered at the CONTAINER — the first
  // cut landed inside NameHighlight (a per-row child), so an empty filter
  // unregistered the overlay while the palette was still open (skeptic #1).
  // ownsPageKeys: this palette renders a REAL paged viewport (rowCap), so
  // the transcript scroller yields PageUp/PageDown while it is top
  // (MINI-TEMPER item 2).
  const overlayToken = useRegisterOverlay('command-palette', true, { ownsPageKeys: true });
  // LIVE adaptive ink — an /appearance or /critter re-tint repaints the open palette.
  const tokens = useMercuryTokens()
  const accent = tokens.accent
  const termRows = useTerminalSize().rows
  const cockpitActive = React.useContext(CockpitActiveContext)
  // Declared chrome reserves through the ONE viewport contract (geometry.ts):
  // clamp-at-zero + floor/cap spelled once, never re-derived inline.
  // Cockpit reserve SCALES with the terminal (the 50% bottom slot +
  // SESSIONS card + palette chrome — geometry.ts owns the law); identical
  // to the old constant 32 at the 40-row tuning point.
  const rowCap = viewportRows(termRows, {
    reserve: cockpitActive ? cockpitBottomSlotReserve(termRows) : HEIGHT_RESERVE,
    min: MIN_ROWS,
    cap: MAX_ROWS,
  })
  const [query, setQuery] = useState('')
  const [sel, setSel] = useState(0)
  // An Action Graph row whose handler no surface currently owns: the palette
  // says so in place instead of closing on a keystroke that did nothing.
  const [unreachable, setUnreachable] = useState<string | null>(null)
  // The notice is about the invoke the operator just tried. The moment they
  // move on — edit the query, move the selection — it clears; a stale
  // "no owner on screen" pinned under an unrelated row taught the wrong
  // lesson until the palette closed (re-audit edge).
  useEffect(() => {
    setUnreachable(null)
  }, [query, sel])
  // Grapheme cursor for the REAL query editor (TextInput) — ←→/Home/End/
  // word chords/paste behave like the main editor (MINI-TEMPER item 2).
  const [cursorOffset, setCursorOffset] = useState(0)

  // One PaletteItem per visible command (dedup by name; first wins). menuDescription
  // is the short picker blurb when present, else the model-facing description flattened.
  const items = useMemo<PaletteItem[]>(() => {
    const byName = new Map<string, PaletteItem>()
    for (const c of commands) {
      if (c.isHidden) continue
      const name = getCommandName(c)
      if (!name || byName.has(name)) continue
      const raw = c.menuDescription ?? c.description ?? ''
      const desc = raw.replace(/\s+/g, ' ').trim()
      const score = c.type === 'prompt' ? getSkillUsageScore(name) : 0
      byName.set(name, { name, desc, recent: score > 0, score })
    }
    return Array.from(byName.values())
  }, [commands])

  // Action rows (open file / search contents) surface FIRST — the palette as hub.
  // Each row's chord is RESOLVED against the live bindings: rebind ctrl+x f and
  // the palette teaches your key, unbind it and the palette says so instead of
  // advertising a dead one.
  const kb = useOptionalKeybindingContext()
  const bindings = kb?.bindings
  const actionItems = useMemo<PaletteItem[]>(
    () =>
      (actions ?? []).map(a => {
        const reach =
          a.action && bindings
            ? actionAffordance(a.action, a.context ?? 'Chat', bindings)
            : undefined
        return {
          name: a.label,
          desc: a.detail ?? '',
          recent: false,
          score: 0,
          run: a.run,
          kind: a.kind,
          keychord: reach?.kind === 'bound' ? reach.chord : undefined,
          unavailable: reach && reach.kind !== 'bound' ? reach.reason : undefined,
        }
      }),
    [actions, bindings],
  )

  // The Action Graph's own rows, on a non-empty query only: the palette is the
  // one hub, so "what opens the transcript?" answers here and not only in
  // /keys. Bound rows teach their live chord; unreachable ones say WHY — the
  // rule the whole estate follows, that a surface never advertises an action
  // the operator cannot reach.
  const graphItems = useMemo<PaletteItem[]>(() => {
    if (!bindings) return []
    const out: PaletteItem[] = []
    for (const [action, meta] of Object.entries(ACTION_GRAPH) as [string, { description: string }][]) {
      const context = ((): KeybindingContextName => {
        const contexts = (meta as { contexts?: readonly string[] }).contexts
        return contexts?.[0] ?? 'Global'
      })()
      const reach = actionAffordance(action, context, bindings)
      out.push({
        name: action,
        desc: meta.description,
        recent: false,
        score: 0,
        kind: 'switch',
        run: () => {
          if (!kb?.invokeAction(action)) setUnreachable(action)
        },
        keychord: reach.kind === 'bound' ? reach.chord : undefined,
        unavailable: reach.kind === 'bound' ? undefined : reach.reason,
      })
    }
    return out
  }, [bindings, kb])

  // Empty query → recent (most-used) first, then the rest alpha. Non-empty → fuzzy
  // on the command NAME (unique → unambiguous map-back), then append commands whose
  // DESCRIPTION substring-matches (find-by-what-it-does) that the name pass missed.
  const filtered = useMemo<PaletteItem[]>(() => {
    const q = query.trim()
    const ql = q.toLowerCase()
    // Actions lead the list — all of them on an empty query, or those matching.
    const acts = q
      ? actionItems.filter(a => a.name.toLowerCase().includes(ql) || a.desc.toLowerCase().includes(ql))
      : actionItems
    if (!q) {
      const recent = items.filter(i => i.recent).sort((a, b) => b.score - a.score)
      const rest = items.filter(i => !i.recent).sort((a, b) => a.name.localeCompare(b.name))
      return [...acts, ...recent, ...rest]
    }
    const byName = new Map(items.map(i => [i.name, i] as const))
    const ranked = fuzzySearch(items.map(i => i.name), q, 60)
    const seen = new Set<string>()
    const nameHits: PaletteItem[] = []
    for (const r of ranked) {
      const it = byName.get(r.path)
      if (it) {
        nameHits.push(it)
        seen.add(it.name)
      }
    }
    const descHits = items.filter(i => !seen.has(i.name) && i.desc.toLowerCase().includes(ql))
    // Action Graph rows trail the command hits and stay bounded — the palette
    // is a launcher first; /keys is the full atlas.
    const graphHits = graphItems
      .filter(g => g.name.toLowerCase().includes(ql) || g.desc.toLowerCase().includes(ql))
      .slice(0, GRAPH_ROWS)
    return [...acts, ...nameHits, ...descHits, ...graphHits]
  }, [items, actionItems, graphItems, query])

  // Cursor-following WINDOW over the COMPLETE ranked set (mercury-feel
  // the old first-slice made every row beyond the cap unreachable
  // — ↓ walks the full list now, the window follows the cursor.
  // THE cursor-following window (paneWindow — centered, clamped, every row
  // reachable); the palette's inline center/clamp math is dead.
  // The overflow counter SPENDS one of the cap's rows (LUSTRE L4): with the
  // full cap given to items, the counter line was an 11th child in a 10-row
  // budget and yoga squeezed a mid-list row — the selected action row could
  // vanish while the counter blended into a neighbor (both chromes; the
  // pre-fix 120×44 captures carry the artifact).
  const listRows = filtered.length > rowCap ? Math.max(1, rowCap - 1) : rowCap
  const winStart = paneWindow(filtered.length, sel, listRows).start
  const shown = useMemo(() => filtered.slice(winStart, winStart + listRows), [filtered, winStart, listRows])
  // Count + recency live in the footer (always pinned to the bottom of the box),
  // not a separate header row — a header line clips first when the bottom slot is
  // tight on a short terminal. The per-row ● already marks the recently-used.
  const noun = filtered.length === 1 ? 'command' : 'commands'
  const recentCount = query.trim() === '' ? items.filter(i => i.recent).length : 0
  // Input/hint agreement: ACTION rows (it.run) execute on ↵ —
  // the footer must say so, not promise a reversible insert it won't do.
  const selVerb = filtered[Math.min(sel, Math.max(0, filtered.length - 1))]?.run ? 'run' : 'insert'
  const footer =
    items.length === 0
      ? 'no commands'
      : recentCount > 0
        ? `${filtered.length} ${noun} · ${recentCount} recent · ↑↓ · ↵ ${selVerb}`
        : `${filtered.length} ${noun} · ↑↓ move · ↵ ${selVerb}`

  // Swallow the launching chord's trailing key (ctrl+x p → a stray 'p') so it
  // can't seed the query — as a open-event seq gate (event identity, not wall-clock), not the old
  // setTimeout→setState flag whose parked commit could swallow the first
  // keypress for seconds (§STALE-PAINT idle-parked-commits;
  // swept). esc/arrows respond ungated per the doctrine; only the
  // keys that ACT (↵ · typed/pasted text — TextInput's inputFilter rides the
  // same gate) wait out the buffer.
  const pastOpenEvent = useOpenEventGate()

  // Keep the cursor in range as the filter narrows.
  useEffect(() => {
    setSel(s => Math.min(s, Math.max(0, filtered.length - 1)))
  }, [filtered.length])

  // The ONE ↵ meaning — shared by the editor's onSubmit and a mouse
  // activate: run an action row, or insert `/name ` for a command row.
  const activateSelected = (abs: number): void => {
    const it = filtered[Math.min(abs, Math.max(0, filtered.length - 1))]
    if (it?.run) it.run()
    else if (it) onRun(`/${it.name} `)
  }

  // List navigation through the ONE semantic vocabulary (MINI-TEMPER item 2):
  // ↑↓ move, PageUp/PageDown page by the REAL viewport (rowCap), and every
  // handled key is CONSUMED (3-arg form) so it can't leak to lower owners.
  // ←→/Home/End decode into the query editor's grapheme cursor instead —
  // the palette declines them here (decodeNavKey vertical returns null for
  // ←→; 'first'/'last' are deliberately left to the editor). ↵ is owned by
  // the editor's onSubmit (registered first — child effects before parent);
  // esc closes ONE layer via the overlay stack.
  useInput(
    (input, key, event) => {
      if (!isActive) return
      const action = decodeNavKey(input, key, { orientation: 'vertical', pageKeys: true })
      if (action === 'cancel') {
        // esc closes ONE layer — only when this palette is the top overlay.
        if (overlayToken !== null && !isTopOverlayNow(overlayToken)) return
        event.stopImmediatePropagation()
        onClose()
        return
      }
      if (
        action === 'movePrevious' ||
        action === 'moveNext' ||
        action === 'pagePrevious' ||
        action === 'pageNext'
      ) {
        event.stopImmediatePropagation()
        const target = applyNavMotion(action, sel, filtered.length, {
          orientation: 'vertical',
          pageSize: listRows,
        })
        if (target !== null) setSel(target)
        return
      }
      // Everything else (typing · ←→ · Home/End · word chords · paste ·
      // backspace) belongs to the query editor — decline untouched.
    },
    { isActive },
  )

  return (
    <CommandCenter view="command palette" elevated onClose={onClose} captureInput={false} footer={footer}>
      <Box marginTop={1}>
        <Text color={accent}>{GLYPH.prompt} </Text>
        {/* The query is Mercury's ONE editor machinery (MINI-TEMPER item 2):
            grapheme ←→, Home/End, word chords, paste, range deletes — like
            the main composer. ↑↓ keep navigating results
            (disableCursorMovementForUpDownKeys); esc belongs to the overlay
            stack (disableEscapeDoublePress); PageUp/PageDown belong to the
            list pager (disablePageKeyCursorMovement). The inputFilter rides
            the SAME open-event identity gate the old hand-rolled buffer used,
            so the launching chord's trailing key still can't seed the query.
            Newlines can't enter a single-line query (shift/meta+↵ strip). */}
        <TextInput
          value={query}
          onChange={q => {
            setQuery(q.replace(/[\r\n\t]+/g, ' ').slice(0, QUERY_MAX_LENGTH))
            setSel(0)
          }}
          onSubmit={() => {
            if (!pastOpenEvent()) return
            activateSelected(sel)
          }}
          focus={isActive}
          showCursor={true}
          multiline={false}
          disableCursorMovementForUpDownKeys={true}
          disableEscapeDoublePress={true}
          disablePageKeyCursorMovement={true}
          inputFilter={input => (pastOpenEvent() ? input : '')}
          columns={QUERY_WIDTH}
          cursorOffset={cursorOffset}
          onChangeCursorOffset={setCursorOffset}
          placeholder="run a command — fuzzy by name or what it does…"
        />
      </Box>

      {items.length === 0 ? (
        <Box marginTop={1}>
          <EmptyState title="no commands" hint="no slash commands were available to the palette" />
        </Box>
      ) : filtered.length === 0 ? (
        <Box marginTop={1}>
          <EmptyState title="no matches" hint={`nothing matches "${truncateToWidth(query, 30)}" — backspace to widen`} />
        </Box>
      ) : (
        <Box marginTop={1} flexDirection="column">
          {shown.map((it, i) => {
            const abs = winStart + i
            const here = abs === sel
            return (
              <InteractiveRow
                key={`${it.name}-${abs}`}
                id={`palette:row:${it.name}`}
                width="100%"
                selected={here}
                // Mouse parity (grammar): click selects the row; a click on
                // the ALREADY-selected row performs its primary action —
                // same two-step as ↓ then ↵, never a surprise run.
                onSelect={() => setSel(abs)}
                onActivate={() => activateSelected(abs)}
              >
              {/* wrap="truncate-end": the row is ONE line by construction —
                  a long description would otherwise wrap and bleed into the
                  counter footer at mid widths (120×40). */}
              <Text wrap="truncate-end">
                <Text color={here ? accent : tokens.textMuted}>{here ? `${GLYPH.prompt} ` : '  '}</Text>
                {it.run
                  ? <Text color={here ? accent : tokens.success}>{GLYPH.handoff}</Text>
                  : <Text color={here ? accent : tokens.textSecondary}>/</Text>}
                <NameHighlight
                  name={it.name}
                  query={query}
                  here={here}
                  accent={accent}
                  textPrimary={tokens.textPrimary}
                  textSecondary={tokens.textSecondary}
                />
                {it.recent ? <Text color={tokens.success}>{`${GLYPH.done} `}</Text> : <Text>{'  '}</Text>}
                {it.kind ? <Text color={here ? tokens.textPrimary : tokens.textMuted}>{`${it.kind} `}</Text> : null}
                {it.desc ? <Text color={tokens.textMuted}>{truncateToWidth(it.desc, it.keychord || it.unavailable ? 36 : 46)}</Text> : null}
                {it.keychord ? <Text color={tokens.textMuted}>{`  ${it.keychord}`}</Text> : null}
                {it.unavailable ? <Text color={tokens.warning}>{`  no key — ${truncateToWidth(it.unavailable, 34)}`}</Text> : null}
              </Text>
              </InteractiveRow>
            )
          })}
          {filtered.length > listRows ? (
            <Text color={tokens.textMuted}>  {sel + 1}/{filtered.length} · ↑↓ walks the full list</Text>
          ) : null}
          {unreachable ? (
            <Text color={tokens.warning}>
              {`  ${unreachable} has no owner on screen right now — open the surface that owns it first`}
            </Text>
          ) : null}
        </Box>
      )}
    </CommandCenter>
  )
}
