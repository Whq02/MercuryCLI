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


type PaletteItem = { name: string; desc: string; recent: boolean; score: number; run?: () => void; kind?: ActionKind; keychord?: string; unavailable?: string }
export type ActionKind = 'open' | 'insert' | 'toggle' | 'switch'
export type PaletteAction = {
  label: string
  detail?: string
  run: () => void
  kind?: ActionKind
  action?: string
  context?: KeybindingContextName
}

const NAME_WIDTH = 22
const QUERY_WIDTH = 56
const QUERY_MAX_LENGTH = 200
const MAX_ROWS = 12
const GRAPH_ROWS = 5
const HEIGHT_RESERVE = 26
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
  const overlayToken = useRegisterOverlay('command-palette', true, { ownsPageKeys: true });
  const tokens = useMercuryTokens()
  const accent = tokens.accent
  const termRows = useTerminalSize().rows
  const cockpitActive = React.useContext(CockpitActiveContext)
  const rowCap = viewportRows(termRows, {
    reserve: cockpitActive ? cockpitBottomSlotReserve(termRows) : HEIGHT_RESERVE,
    min: MIN_ROWS,
    cap: MAX_ROWS,
  })
  const [query, setQuery] = useState('')
  const [sel, setSel] = useState(0)
  const [unreachable, setUnreachable] = useState<string | null>(null)
  useEffect(() => {
    setUnreachable(null)
  }, [query, sel])
  const [cursorOffset, setCursorOffset] = useState(0)

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

  const filtered = useMemo<PaletteItem[]>(() => {
    const q = query.trim()
    const ql = q.toLowerCase()
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
    const graphHits = graphItems
      .filter(g => g.name.toLowerCase().includes(ql) || g.desc.toLowerCase().includes(ql))
      .slice(0, GRAPH_ROWS)
    return [...acts, ...nameHits, ...descHits, ...graphHits]
  }, [items, actionItems, graphItems, query])

  const listRows = filtered.length > rowCap ? Math.max(1, rowCap - 1) : rowCap
  const winStart = paneWindow(filtered.length, sel, listRows).start
  const shown = useMemo(() => filtered.slice(winStart, winStart + listRows), [filtered, winStart, listRows])
  const noun = filtered.length === 1 ? 'command' : 'commands'
  const recentCount = query.trim() === '' ? items.filter(i => i.recent).length : 0
  const selVerb = filtered[Math.min(sel, Math.max(0, filtered.length - 1))]?.run ? 'run' : 'insert'
  const footer =
    items.length === 0
      ? 'no commands'
      : recentCount > 0
        ? `${filtered.length} ${noun} · ${recentCount} recent · ↑↓ · ↵ ${selVerb}`
        : `${filtered.length} ${noun} · ↑↓ move · ↵ ${selVerb}`

  const pastOpenEvent = useOpenEventGate()

  useEffect(() => {
    setSel(s => Math.min(s, Math.max(0, filtered.length - 1)))
  }, [filtered.length])

  const activateSelected = (abs: number): void => {
    const it = filtered[Math.min(abs, Math.max(0, filtered.length - 1))]
    if (it?.run) it.run()
    else if (it) onRun(`/${it.name} `)
  }

  useInput(
    (input, key, event) => {
      if (!isActive) return
      const action = decodeNavKey(input, key, { orientation: 'vertical', pageKeys: true })
      if (action === 'cancel') {
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
    },
    { isActive },
  )

  return (
    <CommandCenter view="command palette" elevated onClose={onClose} captureInput={false} footer={footer}>
      <Box marginTop={1}>
        <Text color={accent}>{GLYPH.prompt} </Text>
        {
}
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
                onSelect={() => setSel(abs)}
                onActivate={() => activateSelected(abs)}
              >
              {
}
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
