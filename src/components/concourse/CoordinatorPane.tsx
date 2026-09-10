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


export const COORDINATOR_EXAMPLE_PROMPTS = [
  'launch two sessions on this project',
  'what needs me right now?',
  'pause the parser session',
] as const

const REPLY_FOLD_LINES = 8
const REPLY_FOLD_CHARS = 900
const REPLY_PREVIEW_LINES = 4
const NL = String.fromCharCode(10)

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
const THINKING_VERB_ROTATE_MS = 15_000

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

  const plate = (entry: CoordinatorConversationEntryV1): React.ReactNode => {
    const clock = clockOf(entry)
    const isOp = entry.role === 'operator'
    const isHarness = entry.harness === true
    const name = isHarness ? 'harness' : isOp ? operatorHandle : 'Coordinator'
    return (
      <Text>
        {clock !== null ? <Text color={FAINT}>{clock} </Text> : null}
        <Text color={FAINT}>[</Text>
        {}
        <Text color={isHarness ? t.textMuted : isOp ? t.accentSoft : TEAL}>{name}</Text>
        <Text color={FAINT}>]</Text>
        <Text> </Text>
      </Text>
    )
  }
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
  minimal = false,
}: {
  callbacks: ConcourseCallbacks
  mode: 'off' | 'rules-only' | 'agent-assisted'
  fallbackReason?: string
  operatorHandle: string
  focused: boolean
  paneRows: number
  paneWidth: number
  bounds: [number, number, number, number]
  pending: boolean
  settingsOpen: boolean
  onCloseSettings: () => void
  onPickExample: (text: string) => void
  draftHeld?: boolean
  modalUp?: boolean
  gitOffer?: GitOfferV1
  onAnswerGitOffer?: (requestId: string, allow: boolean, obligationId: string) => void
  managerCardNode?: React.ReactNode
  composerNode?: React.ReactNode
  onFocus?: () => void
  collapsed?: boolean
  tailNote?: { tone: 'muted' | 'warning'; text: string } | null
  minimal?: boolean
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
        setEntries(prev => mergeCoordinatorEntries(prev, rows))
      })
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
    if (modalUp || settingsOpen) return
    if (paneRows === 0) return
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
    if (gitOffer !== undefined) return
    if (!focused) return
    if ((key.pageUp || key.pageDown) && !key.ctrl && !key.meta) {
      event.stopImmediatePropagation()
      const viewport = scrollRef.current?.getViewportHeight() ?? 8
      scrollRows(key.pageDown ? pageStepRows(viewport) : -pageStepRows(viewport))
      return
    }
    if (!minimal && entries !== null && entries.length === 0 && (key.upArrow || key.downArrow)) {
      event.stopImmediatePropagation()
      const n = COORDINATOR_EXAMPLE_PROMPTS.length
      const next = Math.min(n - 1, Math.max(0, exampleIdxRef.current + (key.downArrow ? 1 : -1)))
      exampleIdxRef.current = next
      setExampleIdx(next)
      return
    }
    if (!minimal && key.return && entries !== null && entries.length === 0 && !pending && !draftHeld) {
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

  if (collapsed && !minimal) {
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
          <CoordinatorThinkingRow />
        ) : tailNote !== null ? (
          <Text color={tailNote.tone === 'warning' ? t.warning : t.textMuted} wrap="truncate-end">
            {tailNote.text}
          </Text>
        ) : (
          <Text color={t.textMuted} wrap="truncate-end">
            {last !== undefined
              ?
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
      borderStyle={minimal ? undefined : paletteCollapsed() && focused ? 'bold' : 'round'}
      borderColor={focused ? t.info : t.borderSubtle}
      paddingX={minimal ? 0 : 1}
    >
      <Box height={minimal ? 0 : 1} flexShrink={0} overflow="hidden">
        {}
        <InteractiveRow id="coordinator:focus-title" directActivate hoverStyle="chrome-ink" {...(onFocus !== undefined ? { onActivate: onFocus } : {})}>
          {hover => (
            <Text bold color={focused || hover ? t.infoText : t.textMuted} wrap="truncate-end">
              COORDINATOR
            </Text>
          )}
        </InteractiveRow>
      </Box>
      <Box flexDirection="column" flexGrow={1} minHeight={0} overflow="hidden">
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
          {
}
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
                    {
}
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
        <CoordinatorThinkingRow />
      ) : null}
      {
}
      {gauge !== null && !settingsOpen && calculateTokenWarningState(gauge.contextTokens, gauge.modelId).level !== 'ok' ? (
        <Box height={1} flexShrink={0} overflow="hidden">
          <TokenWarning tokenUsage={gauge.contextTokens} model={gauge.modelId} />
        </Box>
      ) : null}
      {gitOffer !== undefined && onAnswerGitOffer !== undefined && !settingsOpen ? (
        <GitOfferCard offer={gitOffer} onAnswer={onAnswerGitOffer} />
      ) : managerCardNode !== undefined && !settingsOpen ? (
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
      </Box>
      {composerNode !== undefined && !settingsOpen ? (
        <Box flexDirection="column" flexShrink={0}>{composerNode}</Box>
      ) : null}
    </Box>
  )
}
