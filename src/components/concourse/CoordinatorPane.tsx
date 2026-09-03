import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Box, Text, paletteCollapsed, useInput } from '../../ink.js';
import ScrollBox, { type ScrollBoxHandle } from '../../ink/components/ScrollBox.js';
import { GLYPH } from '../mercury-ui/glyphs.js';
import { keyHintLabel } from '../mercury-ui/keyHintLabel.js';
import { InteractiveRow } from '../mercury-ui/InteractiveRow.js';
import { InteractiveDisclosure } from '../mercury-ui/InteractiveDisclosure.js';
import { useMercuryTokens } from '../mercury-ui/useMercuryTokens.js';
import { useNowTick } from '../mercury-ui/components.js';
import { pageStepRows, WHEEL_STEP_ROWS } from '../mercury-ui/replFloor.js';
import { Spinner } from '../Spinner.js';
import { sampleSpinnerVerb } from '../../constants/spinnerVerbs.js';
import { Markdown } from '../Markdown.js';
import { stripInlineMarkdown } from '../../utils/markdown.js';
import { TEAL, FAINT } from '../mercuryPalette.js';
import { formatClock } from '../messages/TranscriptNameplate.js';
import {
  readCoordinatorConversation,
  readCoordinatorGauge,
  subscribeCoordinatorConversation,
  type CoordinatorConversationEntryV1,
  type CoordinatorContextGaugeV1,
} from '../../services/concourse/coordinatorConversation.js';
import { calculateTokenWarningState } from '../../services/compact/autoCompact.js';
import TokenWarning from '../TokenWarning.js';
import { CoordinatorModelPicker } from './CoordinatorModelPicker.js';
import { GitOfferCard, type GitOfferV1 } from './GitOfferCard.js';
import type { ConcourseCallbacks } from './contracts.js';

// ============================================================================
//  CoordinatorPane — the coordinator conversation as the
//  PERMANENT LEFT PANE (the 'm' overlay is dead; the pane is the surface).
//
//  Recomposed from CoordinatorSurface under the design addendum:
//   · frame joins the QUIET pane grammar (round borderSubtle;
//     the always-lit info frame died with the overlay);
//   · transcript heads join the ratified nameplate grammar
//     (the coordinator plate grammar): FAINT clock + FAINT brackets,
//     coordinator in TEAL, the operator's handle in accentSoft, body text
//     in textPrimary — the whole-accent flood is absent;
//   · the composer left this pane — it is the screen's bottom strip; this
//     pane is transcript + receipts + folds + the on/off banner;
//   · wheel is POINTER-GATED (IP-2): this pane consumes wheel only when
//     the stamped cell is inside its bounds (or, coordinate-less, when the
//     pane holds focus); pgup/pgdn only while focused;
//   · zero-state: reworked example prompts, no at-rest
//     cursor unless the pane holds focus — the screen keeps ONE caret.
// ============================================================================

/** the example prompts teach the hero gesture first. */
export const COORDINATOR_EXAMPLE_PROMPTS = [
  'launch two sessions on this project',
  'what needs me right now?',
  'pause the parser session',
] as const

const REPLY_FOLD_LINES = 8
const REPLY_FOLD_CHARS = 900
const REPLY_PREVIEW_LINES = 4
const NL = String.fromCharCode(10)

/** CONTENT-KEYED ENTRY MERGE (pure — the pool pin drives BOTH directions):
 *  an entry with the same id and the same bytes at the same index keeps the
 *  object the previous read minted (the memoized rows bail — the churn
 *  kill); changed bytes always take the fresh object (a reuse there would
 *  paint a stale entry forever — the stale-paint kill); a byte-identical
 *  read returns `prev` ITSELF, so the state set bails and nothing repaints.
 *  Compaction prepends a marker and shifts indices — every shifted index
 *  falls out conservatively fresh. */
export function mergeCoordinatorEntries(
  prev: CoordinatorConversationEntryV1[] | null,
  rows: CoordinatorConversationEntryV1[],
): CoordinatorConversationEntryV1[] {
  if (prev === null) return rows
  let allSame = prev.length === rows.length
  const merged = rows.map((r, i) => {
    const p = prev[i]
    if (p !== undefined && p.id === r.id && JSON.stringify(p) === JSON.stringify(r)) return p
    allSame = false
    return r
  })
  return allSame ? prev : merged
}
const THINKING_VERB_ROTATE_MS = 15_000 // the main chat's whimsy cadence

/** Item 6 (thinking-token polish): the coordinator's working line IS the
 *  main chat's presentation — the calm star cadence through the ONE Spinner
 *  owner (reduced-motion aware) and the SAME verb vocabulary
 *  (sampleSpinnerVerb, rotating on the main chat's 15s whimsy clock) —
 *  sized for the pane: one row, glyph + verb + elapsed. Mounts fresh per
 *  turn (the conditional render), so the clock starts at the send. */
function CoordinatorThinkingRow(): React.ReactNode {
  const t = useMercuryTokens()
  const [verb, setVerb] = useState(() => sampleSpinnerVerb())
  const startRef = useRef(Date.now())
  useEffect(() => {
    const timer = setInterval(() => setVerb(sampleSpinnerVerb()), THINKING_VERB_ROTATE_MS)
    timer.unref?.()
    return () => clearInterval(timer)
  }, [])
  useNowTick(1000)
  const secs = Math.max(0, Math.floor((Date.now() - startRef.current) / 1000))
  return (
    <Box height={1} flexShrink={0} overflow="hidden">
      <Text wrap="truncate-end">
        <Spinner />
        <Text color="claude" bold>
          {verb}…
        </Text>
        <Text color={t.textMuted}> ({secs}s)</Text>
      </Text>
    </Box>
  )
}

/** ONE conversation entry — plate, body, receipts. Memoized on the ENTRY
 *  OBJECT (the load path above keeps identity for unchanged entries), the
 *  fold state and the handle, so an append re-renders the new entry alone
 *  instead of re-parsing every prior entry's Markdown (the coordinator
 *  REPL's share of the transcript calm law). */
const CoordinatorEntryBlock = React.memo(function CoordinatorEntryBlock({
  entry: e,
  first,
  expanded,
  onToggle,
  operatorHandle,
}: {
  entry: CoordinatorConversationEntryV1
  first: boolean
  expanded: boolean
  onToggle: (id: string) => void
  operatorHandle: string
}): React.ReactNode {
  const t = useMercuryTokens()
  const clockOf = (entry: CoordinatorConversationEntryV1): string | null => {
    const ts = (entry as { ts?: number | string }).ts
    if (ts === undefined) return null
    try {
      return formatClock(typeof ts === 'number' ? new Date(ts).toISOString() : ts)
    } catch {
      return null
    }
  }
  // COMPACT REFUSAL LAW (ruled): a refused/failed row is ONE pane line —
  // the label owner (receiptLabelOf) composes it as what · why · the one
  // fix, and the full daemon sentence lives in the debug log. The line
  // truncates in the MIDDLE: the head keeps what · why, the tail keeps THE
  // ONE FIX ("did you mean claude-sonnet-5?"), whatever the pane's width —
  // an end-truncation ate exactly the clause the operator needed. An
  // applied LAUNCH row still wraps: it names the model the session started
  // on, and that is the fact the pane edge was eating. Every other applied
  // row stays one line (the verb + title is the whole story).
  const receiptRow = (
    r: NonNullable<CoordinatorConversationEntryV1['receipts']>[number],
    key: string,
  ): React.ReactNode => {
    const negative = r.outcome === 'refused' || r.outcome === 'failed'
    const carriesFacts = !negative && r.verb === 'session.launch'
    return (
      <Box key={key} flexShrink={0}>
        <Text wrap={carriesFacts ? 'wrap' : negative ? 'truncate-middle' : 'truncate-end'}>
          <Text color={r.outcome === 'applied' ? t.success : negative ? t.failure : t.textMuted}>
            {'  '}
            {r.outcome === 'applied' ? GLYPH.ok : negative ? GLYPH.fail : GLYPH.dot}{' '}
          </Text>
          <Text color={t.textSecondary}>{r.label}</Text>
        </Text>
      </Box>
    )
  }

  // The ratified plate grammar: FAINT clock+brackets; coordinator
  // TEAL; operator handle accentSoft; body textPrimary. A HARNESS row is
  // Mercury reporting on the lane — a refusal, a turn that did not run, the
  // off hint — so it wears its own muted plate: the operator must never read
  // a harness notice as something the coordinator said.
  const plate = (entry: CoordinatorConversationEntryV1): React.ReactNode => {
    const clock = clockOf(entry)
    const isOp = entry.role === 'operator'
    const isHarness = entry.harness === true
    const name = isHarness ? 'harness' : isOp ? operatorHandle : 'Coordinator'
    return (
      <Text>
        {clock !== null ? <Text color={FAINT}>{clock} </Text> : null}
        <Text color={FAINT}>[</Text>
        {/* Operator-ruled: [Coordinator], capitalized. */}
        <Text color={isHarness ? t.textMuted : isOp ? t.accentSoft : TEAL}>{name}</Text>
        <Text color={FAINT}>]</Text>
        <Text> </Text>
      </Text>
    )
  }
  // A compact-summary row (harness-voiced by law) folds like a long reply:
  // its body is the folded turns' whole memory — page-flooding at full
  // height, one glance at preview height, expandable in place.
  const foldable =
    ((e.role === 'coordinator' && e.harness !== true) || e.summary === true) &&
    (e.text.length > REPLY_FOLD_CHARS || e.text.split(NL).length > REPLY_FOLD_LINES)
  const body =
    e.role === 'operator' || (e.harness === true && e.summary !== true) ? (
      <Text wrap="wrap">
        {plate(e)}
        <Text color={e.harness === true ? t.textSecondary : t.textPrimary}>{e.text}</Text>
      </Text>
    ) : foldable && !expanded ? (
      <InteractiveDisclosure expanded={false} clickable onToggle={() => onToggle(e.id)}>
        <Markdown color={t.textPrimary} leadingInline={plate(e)}>
          {e.text.split(NL).slice(0, REPLY_PREVIEW_LINES).join(NL).slice(0, REPLY_FOLD_CHARS)}
        </Markdown>
        <Text color={t.textMuted}>
          {'  '}⌄ +{Math.max(1, e.text.split(NL).length - REPLY_PREVIEW_LINES)} more lines — click to expand
        </Text>
      </InteractiveDisclosure>
    ) : foldable ? (
      <InteractiveDisclosure expanded clickable onToggle={() => onToggle(e.id)}>
        <Markdown color={t.textPrimary} leadingInline={plate(e)}>
          {e.text}
        </Markdown>
      </InteractiveDisclosure>
    ) : (
      <Markdown color={t.textPrimary} leadingInline={plate(e)}>
        {e.text}
      </Markdown>
    )
  return (
    <Box flexDirection="column" flexShrink={0} marginTop={first ? 0 : 1}>
      {body}
      {(e.receipts ?? []).map((r, j) => receiptRow(r, `${e.id}:r${j}`))}
    </Box>
  )
})

export function CoordinatorPane({
  callbacks,
  mode,
  fallbackReason,
  operatorHandle,
  focused,
  paneRows,
  paneWidth,
  bounds,
  pending,
  settingsOpen,
  onCloseSettings,
  onPickExample,
  draftHeld = false,
  modalUp = false,
  gitOffer,
  onAnswerGitOffer,
  managerCardNode,
  composerNode,
  onFocus,
  collapsed = false,
  tailNote = null,
}: {
  callbacks: ConcourseCallbacks
  mode: 'off' | 'rules-only' | 'agent-assisted'
  fallbackReason?: string
  /** The operator's nameplate handle (snapshot.context.operatorHandle). */
  operatorHandle: string
  focused: boolean
  paneRows: number
  paneWidth: number
  /** The pane's absolute cell bounds [x1, x2, y1, y2] from the ONE geometry
   *  owner — the wheel gate (IP-2). */
  bounds: [number, number, number, number]
  /** The coordinator's turn is running — the pane paints the aligned
   *  thinking row (item 6) and suppresses its examples; the strip only
   *  settles its ReadyBreath. */
  pending: boolean
  /** The coordinator model picker, nested (⌃s / the strip chip). */
  settingsOpen: boolean
  onCloseSettings: () => void
  /** The examples ride the ONE send path the composer owns. */
  /** ↵ or a click on an example PLACES it in the composer — never a send
   *  (the example is a lesson, not a dispatch). */
  onPickExample: (text: string) => void
  /** The composer holds typed words — the example walk's ↵ YIELDS (typed
   *  words outrank the example, the estate's one precedence law: without
   *  this the ghost example dispatched over the operator's own ask). */
  draftHeld?: boolean
  /** THE ONE MODAL OWNER read (boardModalOwner ≠ null): while ANY board
   *  modal owns the key stream — the repo picker, a consent card, a row
   *  pick — this pane's own verbs (wheel, example walk, ↵ send) park
   *  whole. The screen computes it; the pane never re-derives pairwise. */
  modalUp?: boolean
  /** Items 1–3: the armed git offer — the STANDARD consent card mounts
   *  inline at this pane's bottom (the mini-REPL) and owns the keys. */
  gitOffer?: GitOfferV1
  onAnswerGitOffer?: (requestId: string, allow: boolean, obligationId: string) => void
  /** MANAGER MODE (ledger T7+T8): the armed interview/plan card — the
   *  screen composes it (state + answer wires stay the screen's); it mounts
   *  in the git offer's slot grammar, above the composer, confined to this
   *  pane. The git offer outranks it while both stand. */
  managerCardNode?: React.ReactNode
  /** THE PANE'S OWN COMPOSER (the two-composers law, L17 item 1): the
   *  screen composes it (state, send, keys stay the screen's); this pane
   *  owns its geometry — the mini-REPL's foot, under everything. Exactly
   *  one input widget lives in this pane. */
  composerNode?: React.ReactNode
  /** FOCUS IS LEGIBLE (item 4): clicking the panel title focuses the
   *  panel — mouse parity for the Tab stop (the collapsed tail included:
   *  its click swaps the tall band up). */
  onFocus?: () => void
  /** Stacked tail: title + one line, frameless. */
  collapsed?: boolean
  /** The board's own one-line answer to a list key (the split refusal's
   *  width line, "parked — nothing to stop · x again clears it", a door's
   *  "↵ opens the repo picker"). Its home is the coordinator composer's note
   *  row — which the stacked profile does not mount while the tail is
   *  collapsed, so every such answer went unpainted under 120 columns (at
   *  100×30, `s` answered nothing). While one
   *  stands it takes the tail's second row over the latest coordinator line. */
  tailNote?: { tone: 'muted' | 'warning'; text: string } | null
}): React.ReactNode {
  const t = useMercuryTokens()
  const [entries, setEntries] = useState<CoordinatorConversationEntryV1[] | null>(null)
  const [gauge, setGauge] = useState<CoordinatorContextGaugeV1 | null>(null)
  const [expandedIds, setExpandedIds] = useState<ReadonlySet<string>>(() => new Set())
  const [exampleIdx, setExampleIdx] = useState(0)
  const exampleIdxRef = useRef(0)
  const aliveRef = useRef(true)

  const scrollRef = useRef<ScrollBoxHandle | null>(null)
  const [away, setAway] = useState(false)
  const awayBaseRef = useRef(0)
  const jumpNewest = useCallback((): void => {
    scrollRef.current?.scrollToBottom()
    setAway(false)
  }, [])
  const scrollRows = (dy: number): void => {
    const el = scrollRef.current
    if (el === null) return
    if (dy > 0) {
      const max = Math.max(0, el.getFreshScrollHeight() - el.getViewportHeight())
      if (el.getScrollTop() + el.getPendingDelta() + dy >= max) {
        jumpNewest()
        return
      }
    } else if (!away) {
      awayBaseRef.current = entries?.length ?? 0
      setAway(true)
    }
    el.scrollBy(dy)
  }
  const newSince = away ? Math.max(0, (entries?.length ?? 0) - awayBaseRef.current) : 0

  useEffect(() => {
    aliveRef.current = true
    const load = (): void => {
      void readCoordinatorConversation().then(rows => {
        if (!aliveRef.current) return
        // CONTENT-KEYED ENTRIES (the transcript calm law, chat-feel item 2):
        // every store event re-reads the whole conversation and handed React
        // a fresh object per entry — each append re-rendered (and re-parsed
        // the Markdown of) every prior entry. The pure merge above keeps
        // unchanged entries' objects (the memoized rows bail), hands changed
        // bytes the fresh object, and returns prev itself on a
        // byte-identical read so nothing repaints at all.
        setEntries(prev => mergeCoordinatorEntries(prev, rows))
      })
      // The context gauge rides the SAME store (one subscription, one beat):
      // the assisted turn stamps it; /clear and every compaction clear it.
      void readCoordinatorGauge().then(g => {
        if (!aliveRef.current) return
        setGauge(prev =>
          prev !== null && g !== undefined && prev.ts === g.ts && prev.contextTokens === g.contextTokens && prev.modelId === g.modelId
            ? prev
            : (g ?? null),
        )
      })
    }
    load()
    const unsub = subscribeCoordinatorConversation(load)
    return () => {
      aliveRef.current = false
      unsub()
    }
  }, [])

  useInput((_input, key, event) => {
    // THE ONE MODAL OWNER: any armed board modal (the repo picker, a
    // consent card, a row pick, the nested model picker) owns the keys
    // whole — the pairwise settingsOpen/gitOffer guards this replaced
    // left every OTHER owner leaking into the example walk (the repo
    // picker's ↓/↵ dispatched the ghost example).
    if (modalUp || settingsOpen) return
    // IP-2 (the wheel law): consume ONLY inside this pane's bounds; a
    // coordinate-less transport falls back to focus ownership.
    if (key.wheelUp || key.wheelDown) {
      const kp = event.keypress as { x?: number; y?: number }
      const inside =
        kp.x !== undefined && kp.y !== undefined
          ? kp.x >= bounds[0] && kp.x <= bounds[1] && kp.y >= bounds[2] && kp.y <= bounds[3]
          : focused
      if (!inside) return
      event.stopImmediatePropagation()
      scrollRows(key.wheelDown ? WHEEL_STEP_ROWS : -WHEEL_STEP_ROWS)
      return
    }
    // Items 1–3: the mounted consent card owns the keys — the pane's own
    // browse verbs (example walk, ↵ send) park while the ask waits.
    if (gitOffer !== undefined) return
    if (!focused) return
    if ((key.pageUp || key.pageDown) && !key.ctrl && !key.meta) {
      event.stopImmediatePropagation()
      const viewport = scrollRef.current?.getViewportHeight() ?? 8
      scrollRows(key.pageDown ? pageStepRows(viewport) : -pageStepRows(viewport))
      return
    }
    if (entries !== null && entries.length === 0 && (key.upArrow || key.downArrow)) {
      event.stopImmediatePropagation()
      const n = COORDINATOR_EXAMPLE_PROMPTS.length
      const next = Math.min(n - 1, Math.max(0, exampleIdxRef.current + (key.downArrow ? 1 : -1)))
      exampleIdxRef.current = next
      setExampleIdx(next)
      return
    }
    // Typed words OUTRANK the example (the estate's one precedence law —
    // the letter-verb yield's own shape): with a held draft the ↵ falls
    // through to the composer's submit, and the ghost example can never
    // dispatch over the operator's own ask.
    if (key.return && entries !== null && entries.length === 0 && !pending && !draftHeld) {
      event.stopImmediatePropagation()
      onPickExample(COORDINATOR_EXAMPLE_PROMPTS[exampleIdxRef.current]!)
      return
    }
  })

  const toggleExpanded = useCallback((id: string): void => {
    setExpandedIds(prev => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }, [])

  if (collapsed) {
    // The stacked 2-row tail — title + the latest line, frameless; the
    // title clicks to focus (item 4 — the tall band swaps up).
    const last = entries !== null && entries.length > 0 ? entries[entries.length - 1] : undefined
    return (
      <Box flexDirection="column" flexShrink={0} overflow="hidden" paddingX={1}>
        <InteractiveRow id="coordinator:focus-tail" directActivate hoverStyle="chrome-ink" {...(onFocus !== undefined ? { onActivate: onFocus } : {})}>
          {hover => (
            <Text color={hover ? t.info : t.textMuted} bold wrap="truncate-end">
              COORDINATOR <Text color={t.textMuted}>· tab or click to focus</Text>
            </Text>
          )}
        </InteractiveRow>
        {pending ? (
          // Item 6: the tail's second row carries the aligned thinking
          // token while the turn runs (one presentation, every geometry).
          <CoordinatorThinkingRow />
        ) : tailNote !== null ? (
          <Text color={tailNote.tone === 'warning' ? t.warning : t.textMuted} wrap="truncate-end">
            {tailNote.text}
          </Text>
        ) : (
          <Text color={t.textMuted} wrap="truncate-end">
            {last !== undefined
              ? // Coordinator replies are model text — inline markers are
                // routine, and this plain-Text tail must not paint literal
                // **asterisks** (the operator's driven-capture find).
                stripInlineMarkdown(last.text).replace(/\s+/g, ' ').slice(0, 200)
              : mode === 'agent-assisted'
                ? 'ask in plain words'
                : 'coordinator off'}
          </Text>
        )}
      </Box>
    )
  }

  return (
    <Box
      flexDirection="column"
      flexGrow={1}
      overflow="hidden"
      // FOCUS IS LEGIBLE (L17 item 4, superseding the quiet-frame clause):
      // the focused panel's border takes the accent, siblings stay subtle
      // — the estate's existing tokens; collapsed palettes keep the bold
      // SHAPE fork (a11y-p2-04).
      borderStyle={paletteCollapsed() && focused ? 'bold' : 'round'}
      borderColor={focused ? t.info : t.borderSubtle}
      paddingX={1}
    >
      <Box height={1} flexShrink={0}>
        {/* The panel title dims with its panel and clicks to focus (item 4). */}
        <InteractiveRow id="coordinator:focus-title" directActivate hoverStyle="chrome-ink" {...(onFocus !== undefined ? { onActivate: onFocus } : {})}>
          {hover => (
            <Text bold color={focused || hover ? t.infoText : t.textMuted} wrap="truncate-end">
              COORDINATOR
            </Text>
          )}
        </InteractiveRow>
      </Box>
      {settingsOpen ? (
        <>
          <Box height={1} flexShrink={0}>
            <Text bold color={t.infoText} wrap="truncate-end">
              COORDINATOR MODEL
            </Text>
          </Box>
          <CoordinatorModelPicker
            callbacks={callbacks}
            onClose={onCloseSettings}
            nested
            allottedRows={Math.max(6, paneRows - 4)}
            allottedWidth={Math.max(24, paneWidth - 4)}
          />
        </>
      ) : entries === null ? (
        <Box flexDirection="column" flexShrink={0}>
          <Text color={t.textMuted}>opening the conversation…</Text>
        </Box>
      ) : entries.length === 0 ? (
        <Box flexDirection="column" flexShrink={0}>
          <Text color={t.textMuted} wrap="wrap">
            it launches, watches, and reconciles your sessions — ask in plain words
          </Text>
          {/* While the consent card owns the pane the example rows yield
              their rows to it (they are unreachable anyway — the card owns
              the keys); the intro line stays. */}
          {gitOffer !== undefined ? null : COORDINATOR_EXAMPLE_PROMPTS.map((ex, i) => (
            <Box key={ex} height={1} flexShrink={0}>
              <InteractiveRow
                id={`coordinator:example:${ex.replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '').toLowerCase()}`}
                directActivate
                hoverStyle="row-fill"
                onActivate={() => onPickExample(ex)}
              >
                {hover => (
                  <Text wrap="truncate-end">
                    {/* no at-rest cursor — the cursor and its ↵ hint
                        appear only while THIS pane holds focus (one caret,
                        one lesson: the composer beneath owns the screen's
                        resting affordance). */}
                    {focused && exampleIdx === i ? (
                      <Text color={t.info}>{GLYPH.cursor} </Text>
                    ) : (
                      <Text>{'  '}</Text>
                    )}
                    <Text color={(focused && exampleIdx === i) || hover ? t.textPrimary : t.textMuted}>
                      {ex}
                    </Text>
                    {focused && exampleIdx === i ? <Text color={t.textMuted}> · ↵ fills the box</Text> : null}
                  </Text>
                )}
              </InteractiveRow>
            </Box>
          ))}
        </Box>
      ) : (
        <ScrollBox ref={scrollRef} stickyScroll flexGrow={1} flexDirection="column">
          <Box flexGrow={1} flexShrink={0} />
          {entries.map((e, i) => (
            <CoordinatorEntryBlock
              key={e.id}
              entry={e}
              first={i === 0}
              expanded={expandedIds.has(e.id)}
              onToggle={toggleExpanded}
              operatorHandle={operatorHandle}
            />
          ))}
        </ScrollBox>
      )}
      {pending && !settingsOpen ? (
        // Item 6: the coordinator's turn-in-flight line, the main chat's
        // presentation — under the transcript, above the composer (the
        // mini-REPL grammar). The strip's inline token retired with this.
        <CoordinatorThinkingRow />
      ) : null}
      {/* THE CONTEXT WARNING (chat-relief): the main chat's own warning line
          over the coordinator's stamped gauge — the SAME component, the SAME
          thresholds, the coordinator's model. Nothing paints at the ok level
          or without a stamped gauge (a fresh or just-compacted conversation
          holds none until the next turn answers). */}
      {gauge !== null && !settingsOpen && calculateTokenWarningState(gauge.contextTokens, gauge.modelId).level !== 'ok' ? (
        <Box height={1} flexShrink={0} overflow="hidden">
          <TokenWarning tokenUsage={gauge.contextTokens} model={gauge.modelId} />
        </Box>
      ) : null}
      {gitOffer !== undefined && onAnswerGitOffer !== undefined && !settingsOpen ? (
        // Items 1–3: the git offer's STANDARD consent card, inline at the
        // pane's bottom — ask-and-answer in place; the card names the exact
        // folder and its own keys settle it through the answer wire.
        <GitOfferCard offer={gitOffer} onAnswer={onAnswerGitOffer} />
      ) : managerCardNode !== undefined && !settingsOpen ? (
        // MANAGER MODE's card in the same slot grammar — the interview
        // question or the plan, above the composer, inside this pane only.
        <Box flexDirection="column" flexShrink={0}>{managerCardNode}</Box>
      ) : null}
      {away && !settingsOpen ? (
        <Box height={1} flexShrink={0}>
          <InteractiveRow id="coordinator:jump-newest" directActivate hoverStyle="row-fill" onActivate={jumpNewest}>
            {hover => (
              <Text color={hover ? t.textPrimary : newSince > 0 ? t.warning : t.textMuted} wrap="truncate-end">
                ↓ {newSince > 0 ? `+${newSince} new · ` : ''}return to newest — click or pgdn
              </Text>
            )}
          </InteractiveRow>
        </Box>
      ) : null}
      {mode !== 'agent-assisted' && !settingsOpen ? (
        // on/off vocabulary only — 'rules-only' IS the off posture.
        <Box height={1} flexShrink={0}>
          <InteractiveRow
            id="coordinator:switch-on"
            directActivate
            hoverStyle="row-fill"
            onActivate={() => {
              void callbacks.switchCoordinatorMode('agent-assisted')
            }}
          >
            {hover => (
              <Text wrap="truncate-end">
                <Text color={t.textMuted}>
                  {fallbackReason !== undefined ? fallbackReason.slice(0, 90) : 'coordinator off'}
                  {' · '}
                </Text>
                <Text color={hover ? 'infoShimmer' : t.info}>{`▸ turn on · ${keyHintLabel('⌃a')}`}</Text>
              </Text>
            )}
          </InteractiveRow>
        </Box>
      ) : null}
      {composerNode !== undefined && !settingsOpen ? (
        // The pane's OWN composer at its foot (the two-composers law) —
        // the mini-REPL grammar: transcript above, the one input below.
        <Box flexDirection="column" flexShrink={0}>{composerNode}</Box>
      ) : null}
    </Box>
  )
}
