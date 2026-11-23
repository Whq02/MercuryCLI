import React, { useCallback, useMemo, useRef, useState } from 'react'
import { usePublish } from '../effects/effects.js'
import { useAnimationValue, useInput } from '../themedRenderer.js'
import type { ScrollBoxHandle } from '../renderer/elements/ScrollBox.js'
import { isXtermJs } from '../renderer/terminal-session/capabilities.js'
import { topOverlay } from '../overlays/overlayStack.js'
import { useAppState, type AppState } from '../app-state/AppState.js'
import { getTools } from '../../tools/kit/toolList.js'
import { WORK_TICK_MS } from '../cockpit/liveGlyphs.js'
import { useIdleMotion } from '../effects/useIdleMotion.js'
import { controlNoteOf, type ControlNoteState } from './contracts.js'
import {
  computeWheelStep,
  initWheelAccel,
  readScrollSpeedBase,
  type WheelAccelState,
} from '../scroll-keys/ScrollKeybindingHandler.js'
import { truncateToWidth } from '../theme/glyphs.js'
import { stringWidth } from '../renderer/stringWidth.js'
import { mirrorHeaderFit } from './mirrorHeader.js'
import { pageStepRows, WHEEL_ROWS_PER_NOTCH } from '../widgets/composerFloor.js'
import { useSessionAccent } from '../widgets/sessionAccent.js'
import { useMercuryTokens } from '../widgets/useMercuryTokens.js'
import {
  deriveTranscriptRows,
  useCoordinatorAttribution,
  useWorkerTranscriptFold,
} from './workerTranscriptFold.js'
import { rememberSessionWarmth } from '../concourse-model/sessionWarmth.js'
import { readSessionReceipts, type SessionReceiptEntry } from '../../daemon/switchboard/sessionReceipts.js'
import { getProjectDir } from '../../sessions/transcripts/paths.js'
import { logForDebugging } from '../../platform/logs/debugLog.js'
import { errorMessage } from '../../platform/errors/errors.js'
import { sessionMirrorView } from './session-mirror/sessionMirrorView.js'

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

export function readMirrorReceipts(
  workspaceId: string,
  sessionId: string,
  readReceipts: typeof readSessionReceipts = readSessionReceipts,
): { entries: SessionReceiptEntry[]; error: string | null } {
  try {
    return { entries: readReceipts(getProjectDir(workspaceId), sessionId).slice().reverse(), error: null }
  } catch (error) {
    logForDebugging(`[concourse] session receipts unreadable (${sessionId}): ${error}`)
    return { entries: [], error: errorMessage(error) }
  }
}

export function mirrorStatusNote(
  note: ControlNoteState | undefined,
  transcriptError: string | null,
  receiptsError: string | null,
): ControlNoteState | undefined {
  if (note !== undefined) return note
  if (transcriptError !== null) {
    return { state: 'failed', reason: `Could not read transcript (${transcriptError}) — check permissions.` }
  }
  if (receiptsError !== null) {
    return { state: 'failed', reason: `Could not read receipts (${receiptsError}) — check permissions.` }
  }
  return undefined
}

function useSessionReceiptsNewestFirst(
  sessionId: string,
  workspaceId: string,
  state: string | undefined,
  foldLength: number,
): { entries: SessionReceiptEntry[]; error: string | null } {
  return useMemo(() => readMirrorReceipts(workspaceId, sessionId), [sessionId, workspaceId, state, foldLength])
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
          : e.kind === 'runner-restart' || e.kind === 'build-behind'
            ? `build: ${flat}`
            : flat
}


export function SessionMirror({
  sessionId,
  workspaceId,
  title,
  titleFacts = [],
  accent,
  paneRows,
  paneWidth,
  focused,
  pointerOver = false,
  onEnter,
  note,
  state,
  nowLabel,
  nowLive = false,
  bare = false,
  liveTailLine,
  idScope = 'mirror',
  wheelBand,
  wheelRows,
}: {
  sessionId: string
  workspaceId: string
  state?: string
  nowLabel?: string | null
  nowLive?: boolean
  title: string
  titleFacts?: readonly string[]
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
  wheelRows?: [number, number]
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
  const [armedBucket, setArmedBucket] = useState<number | null>(null)
  if (!changePending) {
    if (armedBucket !== null) setArmedBucket(null)
  } else if (armedBucket === null) {
    setArmedBucket(bucket)
  } else if (bucket !== armedBucket) {
    setArmedBucket(null)
    setBody({ sessionId, workspaceId })
  }

  const { fold, readError: transcriptError } = useWorkerTranscriptFold(body.sessionId, body.workspaceId)
  usePublish(() => {
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
  usePublish(() => {
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
        const kp = event.keypress as { x?: number; y?: number }
        if (wheelBand !== undefined && kp.x !== undefined && (kp.x < wheelBand[0] || kp.x > wheelBand[1])) {
          return
        }
        if (wheelRows !== undefined && kp.y !== undefined && (kp.y < wheelRows[0] || kp.y > wheelRows[1])) {
          return
        }
        event.stopImmediatePropagation()
        wheelAccel.current ??= initWheelAccel(isXtermJs(), readScrollSpeedBase())
        const dir = key.wheelDown ? 1 : -1
        const step = event.wheelStep ? WHEEL_ROWS_PER_NOTCH : computeWheelStep(wheelAccel.current, dir, performance.now())
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

  const { entries: receiptsNewestFirst, error: receiptsError } = useSessionReceiptsNewestFirst(
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
  const effectiveNote = mirrorStatusNote(note, transcriptError, receiptsError)
  const noteView = effectiveNote !== undefined ? controlNoteOf(effectiveNote) : undefined
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
  const titleShown = truncateToWidth(title, titleBudget)
  const { factsShown, nowText: nowShown } = mirrorHeaderFit({
    titleShown,
    facts: titleFacts,
    paneWidth,
    hintWidth: hintVisible ? stringWidth('↵ enter session') : 0,
    noteReserve: noteText !== null ? clusterReserve : null,
    nowWords: state === 'working' ? (nowLabel !== undefined && nowLabel !== null && nowLabel.length > 0 ? nowLabel : 'working…') : null,
    nowText,
    nowLive,
  })
  const paneSize = useMemo(() => ({ columns: paneWidth, rows: paneRows }), [paneWidth, paneRows])
  return sessionMirrorView({ t, identityInk, fold, classifyAttribution, tools, derived, turnLive, canAnimate, scrollRef, away, jumpNewest, newSince, receiptsNewestFirst, receiptPlan, hintVisible, noteView, noteText, clusterReserve, titleShown, factsShown, nowShown, paneSize, paneRows, paneWidth, focused, onEnter, state, bare, liveTailLine, idScope, receiptRowText })
}
