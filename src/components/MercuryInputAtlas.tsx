import * as React from 'react'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { Box, Text, useInput } from '../ink.js'
import { KEYBINDING_ACTIONS } from '../keybindings/actionGraph.js'
import {
  atlasMatches,
  buildAtlas,
  explainResolution,
  suggestFreeChords,
  type AtlasRow,
  type LookupReport,
} from '../keybindings/atlas.js'
import {
  useKeybindingContext,
  useRegisterKeybindingContext,
} from '../keybindings/KeybindingContext.js'
import { useKeybinding } from '../keybindings/useKeybinding.js'
import { useShortcutDisplay } from '../keybindings/useShortcutDisplay.js'
import { claimKeyCapture } from '../keybindings/keyCapture.js'
import { DEFAULT_BINDINGS } from '../keybindings/defaultBindings.js'
import { parseBindings } from '../keybindings/parser.js'
import { resolveKeyWithChordState, unboundConsumes } from '../keybindings/resolver.js'
import { KEYBINDING_CONTEXTS } from '../keybindings/schema.js'
import type {
  KeybindingContextName,
  ParsedBinding,
  ParsedKeystroke,
} from '../keybindings/types.js'
import { writeUserBinding } from '../keybindings/writeBindings.js'
import { useTerminalSize } from '../hooks/useTerminalSize.js'
import { isTopOverlayNow, useRegisterOverlay } from '../context/overlayContext.js'
import { toTildePath } from '../utils/path.js'
import TextInput from './TextInput.js'
import { CommandCenter, EmptyState } from './mercury-ui/components.js'
import { cockpitBottomSlotReserve, paneWindow, viewportRows } from './mercury-ui/geometry.js'
import { CockpitActiveContext } from '../context/cockpitActiveContext.js'
import { GLYPH, padTo, truncateToWidth } from './mercury-ui/glyphs.js'
import { InteractiveRow } from './mercury-ui/InteractiveRow.js'
import { applyNavMotion, decodeNavKey } from './mercury-ui/navSemantics.js'
import { useMercuryTokens } from './mercury-ui/useMercuryTokens.js'


const CHORD_WIDTH = 16
const ACTION_WIDTH = 26
const QUERY_WIDTH = 44
const MAX_ROWS = 14
const MIN_ROWS = 4
const HEIGHT_RESERVE = 20

type Mode = 'browse' | 'lookup' | 'rebind'

const ALL_CONTEXTS: KeybindingContextName[] = Array.from(
  new Set<KeybindingContextName>([
    ...KEYBINDING_CONTEXTS,
    ...DEFAULT_BINDINGS.map(b => b.context),
  ]),
).sort()

function stateTone(
  row: AtlasRow,
  t: ReturnType<typeof useMercuryTokens>,
): string {
  if (row.state === 'disabled') return t.warning
  if (row.state === 'unbound') return t.textMuted
  return t.info
}

export function MercuryInputAtlas({
  onClose,
}: {
  onClose: () => void
}): React.ReactNode {
  const t = useMercuryTokens()
  const kb = useKeybindingContext()
  const termRows = useTerminalSize().rows
  const cockpitActive = React.useContext(CockpitActiveContext)
  const overlayToken = useRegisterOverlay('input-atlas', true, { ownsPageKeys: true })

  const [query, setQuery] = useState('')
  const [cursorOffset, setCursorOffset] = useState(0)
  const [sel, setSel] = useState(0)
  const [mode, setMode] = useState<Mode>('browse')
  const [report, setReport] = useState<LookupReport | null>(null)
  const [pending, setPending] = useState<ParsedKeystroke[] | null>(null)
  const [notice, setNotice] = useState<string | null>(null)

  const [contextIndex, setContextIndex] = useState(() =>
    Math.max(0, ALL_CONTEXTS.indexOf('Chat')),
  )
  const inspected = ALL_CONTEXTS[contextIndex] ?? 'Chat'
  const contexts = useMemo<KeybindingContextName[]>(
    () => (inspected === 'Global' ? ['Global'] : [inspected, 'Global']),
    [inspected],
  )

  const defaultCount = useMemo(() => parseBindings(DEFAULT_BINDINGS).length, [])

  const rows = useMemo(
    () =>
      buildAtlas(kb.bindings, { defaultCount }).filter(r =>
        contexts.includes(r.context),
      ),
    [kb.bindings, defaultCount, contexts],
  )
  const filtered = useMemo(
    () => rows.filter(r => atlasMatches(r, query)),
    [rows, query],
  )

  const rowCap = viewportRows(termRows, {
    reserve: cockpitActive ? cockpitBottomSlotReserve(termRows) : HEIGHT_RESERVE,
    min: MIN_ROWS,
    cap: MAX_ROWS,
  })
  const listRows = filtered.length > rowCap ? Math.max(1, rowCap - 1) : rowCap
  const winStart = paneWindow(filtered.length, sel, listRows).start
  const shown = filtered.slice(winStart, winStart + listRows)
  const current = filtered[Math.min(sel, Math.max(0, filtered.length - 1))]

  useEffect(() => {
    setSel(s => Math.min(s, Math.max(0, filtered.length - 1)))
  }, [filtered.length])

  const leaveCapture = useCallback(() => {
    setMode('browse')
    setPending(null)
  }, [])

  const onLookupKey = useCallback(
    (input: string, key: import('../ink.js').Key) => {
      if (key.escape && pending === null) {
        leaveCapture()
        return
      }
      const result = resolveKeyWithChordState(
        input,
        key,
        contexts,
        kb.bindings,
        pending,
      )
      const explained = explainResolution(
        input,
        key,
        contexts,
        kb.bindings,
        pending,
        result,
        {
          defaultCount,
          passesThroughToEditor: !unboundConsumes(input, key),
        },
      )
      setReport(explained)
      if (result.type === 'chord_started') {
        setPending(result.pending)
        return
      }
      setPending(null)
      setMode('browse')
    },
    [contexts, kb.bindings, defaultCount, pending, leaveCapture],
  )

  const onRebindKey = useCallback(
    (input: string, key: import('../ink.js').Key) => {
      if (key.escape) {
        leaveCapture()
        setNotice('rebind cancelled')
        return
      }
      const row = current
      if (!row || row.action === null) {
        leaveCapture()
        return
      }
      const result = resolveKeyWithChordState(input, key, contexts, kb.bindings, pending)
      if (result.type === 'chord_started') {
        setPending(result.pending)
        return
      }
      const explained = explainResolution(input, key, contexts, kb.bindings, pending, result, {
        defaultCount,
        passesThroughToEditor: false,
      })
      setPending(null)
      setMode('browse')
      const chord = explained.chord
      if (!chord || chord === '…') {
        setNotice('that keystroke has no chord spelling Mercury can store')
        return
      }
      if (explained.reserved && explained.reserved.severity === 'error') {
        setNotice(`${chord} is reserved — ${explained.reserved.reason}`)
        return
      }
      void writeUserBinding({ context: row.context, chord, action: row.action })
        .then(written => {
          setNotice(
            written.ok
              ? `${chord} → ${row.action} written to ${toTildePath(written.path)}`
              : written.error,
          )
        })
        // global handler (a silently-inert rebind). The panel has a
        .catch((e: unknown) =>
          setNotice(`rebind failed — ${e instanceof Error ? e.message : String(e)}`),
        )
    },
    [current, contexts, kb.bindings, defaultCount, pending, leaveCapture],
  )

  useEffect(() => {
    if (mode === 'lookup') return claimKeyCapture(onLookupKey)
    if (mode === 'rebind') return claimKeyCapture(onRebindKey)
    return undefined
  }, [mode, onLookupKey, onRebindKey])

  useInput(
    (input, key, event) => {
      if (mode !== 'browse') return
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
      if (key.tab) {
        event.stopImmediatePropagation()
        setContextIndex(i => (i + (key.shift ? ALL_CONTEXTS.length - 1 : 1)) % ALL_CONTEXTS.length)
        setSel(0)
        return
      }
    },
    { isActive: true },
  )

  useRegisterKeybindingContext('Atlas')
  useKeybinding(
    'atlas:lookup',
    () => {
      if (mode !== 'browse') return false
      setReport(null)
      setNotice(null)
      setMode('lookup')
    },
    { context: 'Atlas' },
  )
  useKeybinding(
    'atlas:rebind',
    () => {
      if (mode !== 'browse') return false
      setNotice(null)
      if (current && current.action !== null) setMode('rebind')
      else setNotice('select an action first — an unbind row has nothing to rebind')
    },
    { context: 'Atlas' },
  )
  const lookupChord = useShortcutDisplay('atlas:lookup', 'Atlas', 'ctrl+l')
  const rebindChord = useShortcutDisplay('atlas:rebind', 'Atlas', 'ctrl+r')

  const liveContexts = Array.from(kb.activeContexts)
  const footer =
    mode === 'lookup'
      ? 'press the chord you want explained · esc back'
      : mode === 'rebind'
        ? 'press the chord to assign · esc cancel'
        : `${filtered.length} of ${rows.length} · tab context · ${lookupChord} look up · ${rebindChord} rebind`

  return (
    <CommandCenter
      view="input atlas"
      subtitle={`${inspected}${inspected === 'Global' ? '' : ' + Global'}`}
      elevated
      onClose={onClose}
      captureInput={false}
      footer={footer}
    >
      <>
          <Box marginTop={1}>
            <Text color={t.accent}>{GLYPH.prompt} </Text>
            <TextInput
              value={query}
              onChange={q => {
                setQuery(q.replace(/[\r\n\t]+/g, ' '))
                setSel(0)
              }}
              focus={mode === 'browse'}
              showCursor={mode === 'browse'}
              multiline={false}
              disableCursorMovementForUpDownKeys={true}
              disableEscapeDoublePress={true}
              disablePageKeyCursorMovement={true}
              columns={QUERY_WIDTH}
              cursorOffset={cursorOffset}
              onChangeCursorOffset={setCursorOffset}
              placeholder="find an action by name or by what it does…"
            />
          </Box>

          <Text color={t.textMuted}>
            {`  focus now: ${liveContexts.length > 0 ? liveContexts.join(', ') : 'Global'}`}
          </Text>

          {mode === 'lookup' || report ? (
            <LookupView report={report} pending={pending} live={mode === 'lookup'} />
          ) : null}

          {filtered.length === 0 ? (
            <Box marginTop={1}>
              <EmptyState
                title="no actions match"
                hint={`nothing in ${inspected} matches "${truncateToWidth(query, 24)}" — backspace to widen, tab for another context`}
              />
            </Box>
          ) : (
            <Box marginTop={1} flexDirection="column">
              {shown.map((row, i) => {
                const abs = winStart + i
                const here = abs === sel
                return (
                  <InteractiveRow
                    key={`${row.context}:${row.action}:${row.chord}:${abs}`}
                    id={`atlas:row:${row.action}`}
                    width="100%"
                    selected={here}
                    onSelect={() => setSel(abs)}
                  >
                    <Text wrap="truncate-end">
                      <Text color={here ? t.accent : t.textMuted}>
                        {here ? `${GLYPH.cursor} ` : '  '}
                      </Text>
                      <Text color={stateTone(row, t)}>
                        {padTo(row.chord === '' ? '—' : row.chord, CHORD_WIDTH)}
                      </Text>
                      <Text color={here ? t.textPrimary : t.textSecondary}>
                        {padTo(truncateToWidth(String(row.action ?? '(unbind)'), ACTION_WIDTH - 1), ACTION_WIDTH)}
                      </Text>
                      <Text color={t.textMuted}>{row.description}</Text>
                    </Text>
                  </InteractiveRow>
                )
              })}
            </Box>
          )}

          {current ? <RowDetail row={current} bindings={kb.bindings} /> : null}
          {notice ? (
            <Text color={t.info}>{`  ${GLYPH.spark} ${notice}`}</Text>
          ) : null}
        </>
    </CommandCenter>
  )
}

function RowDetail({
  row,
  bindings,
}: {
  row: AtlasRow
  bindings: readonly ParsedBinding[]
}): React.ReactNode {
  const t = useMercuryTokens()
  const lines: { text: string; tone: string }[] = []
  if (row.state === 'bound') {
    lines.push({
      text: `${row.chord} is ${row.origin === 'user' ? 'yours' : "Mercury's default"} in ${row.context}`,
      tone: t.textSecondary,
    })
  } else if (row.state === 'disabled') {
    lines.push({
      text: `${row.chord} is disabled in ${row.context} — a printable key types instead of acting`,
      tone: t.warning,
    })
  } else {
    lines.push({
      text: `no chord reaches this action — ${row.reason ?? 'no default binding'}`,
      tone: t.textMuted,
    })
  }
  for (const shadow of row.shadowed) {
    lines.push({
      text: `shadows ${shadow.action ?? 'an unbind'} (${shadow.origin} · ${shadow.context})`,
      tone: t.textMuted,
    })
  }
  if (row.reserved) {
    lines.push({
      text: `${GLYPH.warn} ${row.reserved.reason}`,
      tone: row.reserved.severity === 'error' ? t.failure : t.warning,
    })
  }
  if (row.delivery?.status === 'aliases-to') {
    lines.push({
      text: row.collidesWith
        ? `${GLYPH.warn} on this terminal these bytes arrive as ${row.collidesWith.chord} — pressing it fires ${row.collidesWith.action ?? 'that chord'}; use the portable chord instead`
        : `${GLYPH.warn} this terminal cannot send this chord distinctly — ${row.delivery.reason}`,
      tone: t.warning,
    })
  }
  if (row.state !== 'bound') {
    const free = suggestFreeChords(bindings, row.context, { limit: 3 })
    if (free.length > 0) {
      lines.push({ text: `free here: ${free.join(' · ')}`, tone: t.textMuted })
    }
  }
  return (
    <Box flexDirection="column" marginTop={1}>
      {lines.map((line, i) => (
        <Text key={i} color={line.tone}>{`  ${line.text}`}</Text>
      ))}
    </Box>
  )
}

function LookupView({
  report,
  pending,
  live,
}: {
  report: LookupReport | null
  pending: ParsedKeystroke[] | null
  live: boolean
}): React.ReactNode {
  const t = useMercuryTokens()
  return (
    <Box flexDirection="column" marginTop={1}>
      {live && pending !== null ? (
        <Text color={t.accent}>{`  ${GLYPH.inProgress} chord pending — press the next key`}</Text>
      ) : live ? (
        <Text color={t.accent}>{`  ${GLYPH.cursor} listening — press a chord`}</Text>
      ) : null}
      {report ? (
        <>
          <Text>
            <Text color={t.textMuted}>{'  '}</Text>
            <Text color={t.info}>{padTo(report.chord, CHORD_WIDTH)}</Text>
            <Text color={t.textPrimary}>{report.verdict}</Text>
          </Text>
          {report.context ? (
            <Text color={t.textMuted}>{`  owned by the ${report.context} context`}</Text>
          ) : null}
          {report.candidates.length > 1 ? (
            <Text color={t.textMuted}>
              {`  beat ${report.candidates
                .slice(0, -1)
                .map(c => `${c.action ?? 'an unbind'} (${c.context})`)
                .join(', ')}`}
            </Text>
          ) : null}
          {report.reserved ? (
            <Text color={report.reserved.severity === 'error' ? t.failure : t.warning}>
              {`  ${GLYPH.warn} ${report.reserved.reason}`}
            </Text>
          ) : null}
        </>
      ) : null}
    </Box>
  )
}
