import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Box, Text, useAnimationValue, useInput } from '../../ink.js'
import ScrollBox, { type ScrollBoxHandle } from '../../ink/components/ScrollBox.js'
import { TerminalSizeContext } from '../../ink/components/TerminalSizeContext.js'
import { isXtermJs } from '../../ink/session/capabilities.js'
import { topOverlay } from '../../context/overlayStack.js'
import { useAppState, type AppState } from '../../state/AppState.js'
import { getTools } from '../../tools.js'
import type { RenderableMessage } from '../../types/message.js'
import type { Screen } from '../../screens/REPL.js'
import { EMPTY_STRING_SET } from '../../utils/messages.js'
import { WORK_TICK_MS } from '../../utils/cockpit/liveGlyphs.js'
import { useIdleMotion } from '../../hooks/useIdleMotion.js'
import { hasContentAfterIndex, MessageRow } from '../MessageRow.js'
import { RowErrorBoundary } from '../RowErrorBoundary.js'
import { controlNoteOf, type ControlNoteState } from './contracts.js'
import { isAssistantContinuationRow } from '../Messages.js'
import {
  AttachedAttributionContext,
  NameplateAccentContext,
  NameplateContinuationContext,
} from '../messages/TranscriptNameplate.js'
import {
  computeWheelStep,
  initWheelAccel,
  readScrollSpeedBase,
  type WheelAccelState,
} from '../ScrollKeybindingHandler.js'
import { GLYPH, truncateToWidth } from '../mercury-ui/glyphs.js'
import { stringWidth } from '../../ink/stringWidth.js'
import { WorkingGlyph } from '../mercury-ui/LiveGlyphs.js'
import { InteractiveRow } from '../mercury-ui/InteractiveRow.js'
import { pageStepRows } from '../mercury-ui/replFloor.js'
import { useSessionAccent } from '../mercury-ui/sessionAccent.js'
import { useMercuryTokens } from '../mercury-ui/useMercuryTokens.js'
import {
  deriveTranscriptRows,
  useCoordinatorAttribution,
  useWorkerTranscriptFold,
} from './workerTranscriptFold.js'
import { rememberSessionWarmth } from '../../services/concourse/sessionWarmth.js'
import { readSessionReceipts, type SessionReceiptEntry } from '../../services/switchboard/sessionReceipts.js'
import { getProjectDir } from '../../utils/sessionStorage/paths.js'


const RECEIPT_ENTRIES_SHOWN = 4

function planReceiptSection(
  entryCount: number,
  firstIsAgentClose: boolean,
  paneRows: number,
): { shown: number; deepFirst: boolean; olderLine: boolean } | null {
  if (entryCount === 0) return null
  const budget = Math.min(6, Math.floor(paneRows / 3))
  if (budget < 2) return null
  const rowsLeft = budget - 1
  const deepFirst = firstIsAgentClose && rowsLeft >= 2
  const shown = Math.min(entryCount, RECEIPT_ENTRIES_SHOWN, rowsLeft - (deepFirst ? 1 : 0))
  if (shown < 1) return null
  const olderLine = entryCount > shown && shown + (deepFirst ? 1 : 0) < rowsLeft
  return { shown, deepFirst, olderLine }
}

function useSessionReceiptsNewestFirst(
  sessionId: string,
  workspaceId: string,
  state: string | undefined,
  foldLength: number,
): SessionReceiptEntry[] {
  return useMemo(() => {
    try {
      return readSessionReceipts(getProjectDir(workspaceId), sessionId).slice().reverse()
    } catch {
      return []
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- state + foldLength are the re-read triggers
  }, [sessionId, workspaceId, state, foldLength])
}

function receiptRowText(e: SessionReceiptEntry): string {
  const flat = e.summary.replace(/\s+/g, ' ').trim()
  return e.kind === 'machine-floor'
    ? `floor: ${flat}`
    : e.kind === 'agent-close'
      ? `close (${e.by}): ${flat}`
      : e.kind === 'kit-restamp' || e.kind === 'kit-refused' || e.kind === 'kit-dial'
        ? `kit: ${flat}`
        : e.kind === 'schedule-set' || e.kind === 'schedule-fire' || e.kind === 'schedule-held'
          ? `schedule: ${flat}`
          : `contract: ${flat}`
}


export function SessionMirror({
  sessionId,
  workspaceId,
  title,
  accent,
  paneRows,
  paneWidth,
  focused,
  pointerOver = false,
  onEnter,
  note,
  state,
  nowLabel,
  bare = false,
  liveTailLine,
  idScope = 'mirror',
  wheelBand,
}: {
  sessionId: string
  workspaceId: string
  state?: string
  nowLabel?: string | null
  title: string
  accent?: string
  paneRows: number
  paneWidth: number
  focused: boolean
  pointerOver?: boolean
  onEnter?: () => void
  note?: ControlNoteState
  bare?: boolean
  idScope?: string
  wheelBand?: [number, number]
  liveTailLine?: string | null
}): React.ReactNode {
  const t = useMercuryTokens()
  const critter = useSessionAccent()
  const identityInk = accent ?? critter.accent

  const [body, setBody] = useState({ sessionId, workspaceId })
  const changePending = sessionId !== body.sessionId || workspaceId !== body.workspaceId
  const [, bucket] = useAnimationValue(changePending ? WORK_TICK_MS : null, time =>
    Math.floor(time / WORK_TICK_MS),
  )
  const armedBucketRef = useRef<number | null>(null)
  useEffect(() => {
    if (!changePending) {
      armedBucketRef.current = null
      return
    }
    if (armedBucketRef.current === null) {
      armedBucketRef.current = bucket
      return
    }
    if (bucket !== armedBucketRef.current) {
      armedBucketRef.current = null
      setBody({ sessionId, workspaceId })
    }
  }, [changePending, bucket, sessionId, workspaceId])

  const { fold } = useWorkerTranscriptFold(body.sessionId, body.workspaceId)
  useEffect(() => {
    if (fold !== null && fold.messages.length > 0) rememberSessionWarmth(body.sessionId, fold.messages, fold.shed)
  }, [fold, body.sessionId])
  const classifyAttribution = useCoordinatorAttribution(body.sessionId, fold)
  const toolPermissionContext = useAppState((s: AppState) => s.toolPermissionContext)
  const tools = useMemo(() => getTools(toolPermissionContext), [toolPermissionContext])
  const derived = useMemo(() => deriveTranscriptRows(fold?.messages ?? [], tools), [fold, tools])
  const lastRecord = fold?.messages[fold.messages.length - 1]
  const turnLive = derived.inProgress.size > 0 || lastRecord?.type === 'user'
  const canAnimate = useIdleMotion('glyphs') !== 'off'

  const scrollRef = useRef<ScrollBoxHandle | null>(null)
  const [away, setAway] = useState(false)
  const awayBaseRef = useRef(0)
  const jumpNewest = useCallback((): void => {
    scrollRef.current?.scrollToBottom()
    setAway(false)
  }, [])
  useEffect(() => {
    jumpNewest()
  }, [body.sessionId, body.workspaceId, jumpNewest])

  const scrollRows = useCallback(
    (dy: number): void => {
      const el = scrollRef.current
      if (el === null) return
      if (dy > 0) {
        const max = Math.max(0, el.getFreshScrollHeight() - el.getViewportHeight())
        if (el.getScrollTop() + el.getPendingDelta() + dy >= max) {
          jumpNewest()
          return
        }
      } else if (!away) {
        awayBaseRef.current = fold?.messages.length ?? 0
        setAway(true)
      }
      el.scrollBy(dy)
    },
    [away, fold, jumpNewest],
  )
  const newSince = away ? Math.max(0, (fold?.messages.length ?? 0) - awayBaseRef.current) : 0

  const wheelAccel = useRef<WheelAccelState | null>(null)
  useInput(
    (_input, key, event) => {
      const pagerTop = topOverlay()
      if (pagerTop?.ownsPageKeys === true && !pagerTop.id.startsWith('surface:')) return
      if (key.wheelUp || key.wheelDown) {
        const kp = event.keypress as { x?: number }
        if (wheelBand !== undefined && kp.x !== undefined && (kp.x < wheelBand[0] || kp.x > wheelBand[1])) {
          return
        }
        event.stopImmediatePropagation()
        wheelAccel.current ??= initWheelAccel(isXtermJs(), readScrollSpeedBase())
        const dir = key.wheelDown ? 1 : -1
        const step = computeWheelStep(wheelAccel.current, dir, performance.now())
        if (step > 0) scrollRows(dir * step)
        return
      }
      if (focused && (key.pageUp || key.pageDown) && !key.ctrl && !key.meta) {
        event.stopImmediatePropagation()
        const viewport = scrollRef.current?.getViewportHeight() ?? 8
        scrollRows(key.pageDown ? pageStepRows(viewport) : -pageStepRows(viewport))
      }
    },
    { isActive: focused || pointerOver },
  )

  const receiptsNewestFirst = useSessionReceiptsNewestFirst(
    body.sessionId,
    body.workspaceId,
    state,
    fold?.messages.length ?? 0,
  )
  const receiptPlan = planReceiptSection(
    receiptsNewestFirst.length,
    receiptsNewestFirst[0]?.kind === 'agent-close',
    paneRows,
  )

  const hintVisible = onEnter !== undefined
  const noteView = note !== undefined ? controlNoteOf(note) : undefined
  const noteText =
    noteView === undefined
      ? null
      : noteView.state === 'refused' || noteView.state === 'failed'
        ? `✕ ${noteView.reason ?? 'refused'}${noteView.next !== undefined ? ` · ${noteView.next}` : ''}`
        : noteView.state === 'applied'
          ? `✓ ${noteView.reason ?? 'entering'}`
          : (noteView.reason ?? 'working…')
  const nowText =
    state === 'working'
      ? nowLabel !== undefined && nowLabel !== null && nowLabel.length > 0
        ? truncateToWidth(nowLabel, Math.max(8, Math.floor(paneWidth / 3)))
        :
          'working…'
      : null
  const clusterDesired =
    noteText !== null
      ? stringWidth(noteText)
      : hintVisible
        ? stringWidth('↵ enter session') + (nowText !== null ? stringWidth(nowText) + 3 : 0)
        : 0
  const clusterReserve = Math.min(clusterDesired, Math.max(10, Math.floor(paneWidth / 2)))
  const titleBudget = Math.max(8, paneWidth - clusterReserve - 2)
  const paneSize = useMemo(() => ({ columns: paneWidth, rows: paneRows }), [paneWidth, paneRows])
  return (
    <TerminalSizeContext.Provider value={paneSize}>
    <Box flexDirection="column" height={paneRows} width={paneWidth} flexShrink={0} overflow="hidden">
      {bare ? null : (
      <Box height={1} flexShrink={0} overflow="hidden">
        <InteractiveRow
          id={`${idScope}:title`}
          directActivate
          hoverStyle="chrome-ink"
          flexGrow={1}
          onActivate={onEnter}
        >
          {hover => (
            <Box flexDirection="row" width="100%" overflow="hidden">
              <Text color={identityInk} wrap="truncate-end">
                {truncateToWidth(title, titleBudget)}
              </Text>
              <Box flexGrow={1} />
              {noteView !== undefined && noteText !== null ? (
                <Text
                  color={
                    noteView.state === 'refused' || noteView.state === 'failed'
                      ? t.failureText
                      : noteView.state === 'applied'
                        ? t.success
                        : t.textInstruction
                  }
                  wrap="truncate-end"
                >
                  {truncateToWidth(noteText, clusterReserve)}
                </Text>
              ) : hintVisible ? (
                <Box flexDirection="row" overflow="hidden">
                  {state === 'working' ? (
                    <Box flexDirection="row" marginRight={1} overflow="hidden">
                      <WorkingGlyph color={t.info} active />
                      <Text color={t.textInstruction} wrap="truncate-end">
                        {' '}
                        {nowText}
                      </Text>
                    </Box>
                  ) : null}
                  <Text color={hover || focused ? t.textPrimary : t.textMuted}>
                    ↵ enter session
                  </Text>
                </Box>
              ) : null}
            </Box>
          )}
        </InteractiveRow>
      </Box>
      )}
      {fold === null || derived.collapsed.length === 0 ? (
        <Box flexDirection="column" flexGrow={1} marginTop={bare ? 0 : 1}>
          <Text color={t.textMuted}>
            {state === 'parked'
              ? 'parked — ↵ brings it back'
              : state === 'ready-to-review'
                ? 'no chat yet — ready for your first words · ↵ enters it'
                : 'no chat yet — the session is starting'}
          </Text>
        </Box>
      ) : (
        <AttachedAttributionContext.Provider value={classifyAttribution}>
          <NameplateAccentContext.Provider value={identityInk}>
            <ScrollBox ref={scrollRef} stickyScroll flexGrow={1} flexDirection="column" marginTop={bare ? 0 : 1}>
              {fold.shed > 0 ? (
                <Text color={t.textMuted} wrap="truncate-end">
                  {GLYPH.dot} older history capped here — {fold.shed} earlier record
                  {fold.shed === 1 ? '' : 's'} stay in the session&apos;s transcript
                </Text>
              ) : null}
              {derived.collapsed.map((m, i) => (
                <NameplateContinuationContext.Provider
                  key={m.uuid}
                  value={isAssistantContinuationRow(derived.collapsed, i)}
                >
                  {
}
                  <RowErrorBoundary>
                  <MessageRow
                    message={m}
                    isUserContinuation={m.type === 'user' && derived.collapsed[i - 1]?.type === 'user'}
                    hasContentAfter={
                      m.type === 'collapsed_read_search' &&
                      hasContentAfterIndex(
                        derived.collapsed as RenderableMessage[],
                        i,
                        tools,
                        EMPTY_STRING_SET as Set<string>,
                      )
                    }
                    tools={tools}
                    commands={[]}
                    verbose={false}
                    inProgressToolUseIDs={derived.inProgress}
                    streamingToolUseIDs={EMPTY_STRING_SET as Set<string>}
                    screen={'prompt' as Screen}
                    canAnimate={canAnimate}
                    lastThinkingBlockId={null}
                    latestBashOutputUUID={null}
                    columns={paneWidth}
                    isLoading={turnLive}
                    lookups={derived.lookups}
                  />
                  </RowErrorBoundary>
                </NameplateContinuationContext.Provider>
              ))}
            </ScrollBox>
          </NameplateAccentContext.Provider>
        </AttachedAttributionContext.Provider>
      )}
      {receiptPlan !== null ? (
        <Box flexDirection="column" flexShrink={0} overflow="hidden">
          <Box height={1} overflow="hidden">
            <Text color={t.textMuted} wrap="truncate-end">
              {GLYPH.dot} receipt · {receiptsNewestFirst.length}{' '}
              {receiptsNewestFirst.length === 1 ? 'entry' : 'entries'}
            </Text>
          </Box>
          {receiptsNewestFirst.slice(0, receiptPlan.shown).map((e, i) => {
            const deep = i === 0 && receiptPlan.deepFirst
            const text = receiptRowText(e)
            return (
              <Box key={`${e.at}:${e.kind}:${i}`} height={deep ? 2 : 1} overflow="hidden">
                <Text
                  color={e.kind === 'machine-floor' ? t.textMuted : t.textSecondary}
                  wrap={deep ? 'wrap' : 'truncate-end'}
                >
                  {deep ? truncateToWidth(text, Math.max(16, paneWidth * 2 - 2)) : text}
                </Text>
              </Box>
            )
          })}
          {receiptPlan.olderLine ? (
            <Box height={1} overflow="hidden">
              <Text color={t.textMuted} wrap="truncate-end">
                +{receiptsNewestFirst.length - receiptPlan.shown} older
              </Text>
            </Box>
          ) : null}
        </Box>
      ) : null}
      {liveTailLine !== undefined && liveTailLine !== null && liveTailLine.length > 0 ? (
        <Box height={1} flexShrink={0} overflow="hidden">
          <Text color={t.textMuted} wrap="truncate-start">
            {GLYPH.dot} {liveTailLine}
          </Text>
        </Box>
      ) : null}
      {away ? (
        <Box height={1} flexShrink={0}>
          <InteractiveRow id={`${idScope}:jump-newest`} directActivate hoverStyle="row-fill" onActivate={jumpNewest}>
            {hover => (
              <Text
                color={hover ? t.textPrimary : newSince > 0 ? t.warning : t.textMuted}
                wrap="truncate-end"
              >
                ↓ {newSince > 0 ? `+${newSince} new · ` : ''}return to newest
              </Text>
            )}
          </InteractiveRow>
        </Box>
      ) : null}
    </Box>
    </TerminalSizeContext.Provider>
  )
}
