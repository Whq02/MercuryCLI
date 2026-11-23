import React, {
  useContext,
  useState,
  useSyncExternalStore,
} from 'react'
import { useClaim, useTimer } from '../hooks/effects.js'
import { flagEnv } from '../substrate/flagRegistry.js'
import { Box, Text } from '../ink.js'
import { stringWidth } from '../ink/stringWidth.js'
import { useTerminalSize } from '../hooks/useTerminalSize.js'
import { useAppState } from '../state/AppState.js'
import { activityManager } from '../utils/activityManager.js'
import { getEffortSuffix } from '../utils/effort.js'
import { truncateKeepingTail } from '../utils/truncate.js'
import {
  getFocusedSessionConnector,
  subscribeThroughFocused,
} from '../services/engine-connector/focusedConnector.js'
import type { Theme } from '../utils/theme.js'
import { isEnvTruthy } from '../utils/envUtils.js'
import { GLYPH, truncateToWidth } from '../utils/glyphs.js'
import { sampleSpinnerVerb } from '../constants/spinnerVerbs.js'
import { WAITING_VERB } from '../utils/cockpit/toolVerb.js'
import { CockpitActiveContext } from '../context/cockpitActiveContext.js'
import { WorkCapsuleContext } from './mercury-ui/WorkCapsule.js'
import { useNowTick } from './mercury-ui/components.js'
import { SpinnerAnimationRow } from './Spinner/SpinnerAnimationRow.js'
import { liveCounterLine, liveCounterPhaseOf, liveCounterWords, turnFactsOfRefs } from './Spinner/liveCounterWords.js'
import { useOutputRate } from './Spinner/useOutputRate.js'
import type { LiveTurnFactsV1 } from '../services/engine-connector/seatLive.js'
import { TaskListV2 } from './TaskListV2.js'
import type { SpinnerMode } from '../types/spinner.js'
import { useFocusedMission } from './tasks/useFocusedWork.js'
import { startInterval, stopInterval } from '../utils/timers.js'
const WHIMSY_ROTATE_MS = 15_000
const LONG_TURN_TIP_MS = 30 * 60 * 1000
const LONG_TURN_TIP =
  'This turn has been running a while — esc interrupts it, not its crewmates.'

const subscribeFocusedSpinnerModel = subscribeThroughFocused((connector, listener) => connector.subscribeModel(listener))
const getFocusedSpinnerModel = (): string => getFocusedSessionConnector().modelFacts().main

type ThemeKey = keyof Theme

export type SpinnerWithVerbProps = {
  mode: SpinnerMode
  loadingStartTimeRef: React.RefObject<number>
  totalPausedMsRef: React.RefObject<number>
  pauseStartTimeRef: React.RefObject<number | null>
  responseLengthRef: React.RefObject<number>
  outputTokensRef?: React.RefObject<number | null>
  liveTurnFactsRef?: React.RefObject<LiveTurnFactsV1>
  spinnerTip?: string | null
  overrideColor?: ThemeKey | null
  overrideShimmerColor?: ThemeKey | null
  overrideMessage?: string | null
  still?: boolean
  spinnerSuffix?: string | null
  hookWaitKeys?: readonly string[]
  verbose: boolean
  hasActiveTools: boolean
  activeToolCount: number
  activeToolLabel?: string | null
  waitingOnCrewmates?: boolean
  leaderIsIdle?: boolean
  compact?: boolean
  compactWarning?: boolean
}

export function nextPendingTask<T extends { id: string; status: string; blockedBy?: readonly string[] }>(tasks: readonly T[]): T | undefined {
  const pending = tasks.filter(task => task.status === 'pending')
  const byId = new Map(tasks.map(task => [task.id, task]))
  const unblocked = pending.find(task =>
    (task.blockedBy ?? []).every(blocker => {
      const other = byId.get(blocker)
      return other === undefined || other.status === 'completed'
    }),
  )
  return unblocked ?? pending[0]
}

export function SpinnerWithVerb({
  mode,
  loadingStartTimeRef,
  totalPausedMsRef,
  pauseStartTimeRef,
  responseLengthRef,
  outputTokensRef,
  liveTurnFactsRef,
  spinnerTip,
  overrideColor = null,
  overrideShimmerColor = null,
  overrideMessage = null,
  still = false,
  spinnerSuffix = null,
  hookWaitKeys,
  verbose,
  hasActiveTools,
  activeToolCount,
  activeToolLabel = null,
  waitingOnCrewmates = false,
  compact = false,
  compactWarning = false,
}: SpinnerWithVerbProps): React.ReactNode {
  const { columns } = useTerminalSize()
  const cockpitActive = useContext(CockpitActiveContext)
  const inWorkCapsule = useContext(WorkCapsuleContext)
  const focusedModel = useSyncExternalStore(
    subscribeFocusedSpinnerModel,
    getFocusedSpinnerModel,
    getFocusedSpinnerModel,
  )
  const effortValue = useAppState(state => state.effortValue)
  const expandedView = useAppState(state => state.expandedView)
  const tipsDisabled = useAppState(
    state => state.settings.activity?.tips?.enabled === false,
  )
  const reducedMotion =
    useAppState(state => state.settings.view?.reducedMotion === true) ||
    isEnvTruthy(flagEnv('MERCURY_REDUCED_MOTION'))
  const mission = useFocusedMission()
  const effortSuffix = getEffortSuffix(focusedModel, effortValue)

  useClaim(() => {
    const id = `spinner:${mode}`
    activityManager.startCLIActivity(id)
    return () => {
      activityManager.endCLIActivity(id)
    }
  }, [mode])

  const [verb, setVerb] = useState(() => sampleSpinnerVerb())
  useTimer(() => {
    const timer = startInterval(() => {
      setVerb(sampleSpinnerVerb())
    }, WHIMSY_ROTATE_MS)
    return () => {
      stopInterval(timer)
    }
  }, [])

  useNowTick(1000)
  const wallNow = Date.now()
  const ongoingPauseMs =
    pauseStartTimeRef.current === null
      ? 0
      : Math.max(0, wallNow - pauseStartTimeRef.current)
  const elapsedMs =
    loadingStartTimeRef.current === 0
      ? 0
      : Math.max(
          0,
          wallNow -
            loadingStartTimeRef.current -
            totalPausedMsRef.current -
            ongoingPauseMs,
        )

  const rawMessage =
    overrideMessage && overrideMessage !== ''
      ? overrideMessage
      : hasActiveTools && activeToolLabel
        ? activeToolLabel
        : waitingOnCrewmates
          ? WAITING_VERB
          : verb
  const message =
    still || rawMessage.endsWith('…') ? rawMessage : `${rawMessage}…`

  const isWorkMode =
    mode === 'thinking' ||
    mode === 'responding' ||
    mode === 'tool-use' ||
    mode === 'tool-input'
  const messageColor: ThemeKey =
    overrideColor ?? (isWorkMode ? 'brand' : 'info')
  const shimmerColor: ThemeKey =
    overrideShimmerColor ?? (isWorkMode ? 'brandShimmer' : 'infoShimmer')

  const currentResponseLength = responseLengthRef.current ?? 0
  const facts =
    liveTurnFactsRef?.current ??
    turnFactsOfRefs(currentResponseLength, outputTokensRef?.current ?? null)
  const liveWords = liveCounterWords(
    {
      ...facts,
      phase: liveCounterPhaseOf(mode),
      sentAtMs: loadingStartTimeRef.current === 0 ? null : wallNow - elapsedMs,
    },
    wallNow,
  )
  const compactOtps = useOutputRate(
    liveTurnFactsRef?.current.replyChars ?? currentResponseLength,
    compact &&
      !still &&
      !reducedMotion &&
      pauseStartTimeRef.current === null &&
      facts.wait === null &&
      (mode === 'responding' || mode === 'tool-input'),
    wallNow,
  )

  if (compact) {
    if (compactWarning || still) {
      const color = compactWarning ? 'warning' : messageColor
      const text = still
        ? `${GLYPH.spark} ${truncateKeepingTail(message, Math.max(1, columns - 2))}`
        : truncateKeepingTail(message, Math.max(1, columns))
      return (
        <Box height={1} width="100%">
          <Text color={color} wrap="truncate-end">
            {text}
          </Text>
        </Box>
      )
    }

    const detail = liveCounterLine(
      liveWords,
      Math.max(0, columns - 5),
      ' · ',
      compactOtps,
    )
    const foldedHead = message.replace(/\s+/g, ' ').trim()
    const headBudget = Math.max(
      0,
      columns - 2 - (detail !== '' ? stringWidth(detail) + 3 : 0),
    )
    const head = headBudget > 0 ? truncateToWidth(foldedHead, headBudget) : ''
    return (
      <Box height={1} width="100%">
        <Text wrap="truncate-end">
          <Text color={messageColor}>
            {GLYPH.spark}
            {head !== '' ? ` ${head}` : detail !== '' ? ' ' : ''}
          </Text>
          {detail !== '' ? (
            <Text dimColor>{head !== '' ? ` · ${detail}` : detail}</Text>
          ) : null}
        </Text>
      </Box>
    )
  }

  const showRail = !inWorkCapsule && !cockpitActive
  const row = (
    <SpinnerAnimationRow
      activeToolCount={activeToolCount}
      columns={showRail ? Math.max(1, columns - 2) : columns}
      effortSuffix={effortSuffix}
      hookWaitKeys={hookWaitKeys}
      inWorkCapsule={inWorkCapsule}
      liveTurnFactsRef={liveTurnFactsRef}
      loadingStartTimeRef={loadingStartTimeRef}
      message={message}
      messageColor={messageColor}
      mode={mode}
      outputTokensRef={outputTokensRef}
      overrideColor={overrideColor}
      pauseStartTimeRef={pauseStartTimeRef}
      reducedMotion={reducedMotion}
      responseLengthRef={responseLengthRef}
      shimmerColor={shimmerColor}
      spinnerSuffix={spinnerSuffix}
      still={still}
      totalPausedMsRef={totalPausedMsRef}
      verbose={verbose}
    />
  )

  const nextTask = nextPendingTask(mission)
  let tail: React.ReactNode = null
  if (expandedView === 'tasks' && mission.length > 0) {
    tail = <TaskListV2 tasks={mission} />
  } else if (nextTask) {
    tail = (
      <Text dimColor wrap="truncate-end">
        next: {nextTask.subject}
      </Text>
    )
  } else if (!still) {
    const effectiveTip =
      elapsedMs > LONG_TURN_TIP_MS && !tipsDisabled ? LONG_TURN_TIP : spinnerTip
    if (effectiveTip) {
      tail = (
        <Text dimColor wrap="truncate-end">
          {effectiveTip}
        </Text>
      )
    }
  }

  return (
    <Box flexDirection="column" width="100%">
      {showRail ? (
        <Box flexDirection="row" width="100%">
          <Box width={2} flexShrink={0} marginTop={1}>
            <Text color="claude">▎</Text>
          </Box>
          <Box flexDirection="column" flexGrow={1} minWidth={0}>
            {row}
          </Box>
        </Box>
      ) : (
        row
      )}
      {tail}
    </Box>
  )
}


const STAR_BASE = ['✶', '✸', '✹', '✺', '✹', '✷']
const STAR_FRAMES = [...STAR_BASE, ...[...STAR_BASE].reverse()]
const STAR_TICK_MS = 160

export function Spinner(): React.ReactNode {
  const reducedMotion =
    useAppState(state => state.settings.view?.reducedMotion === true) ||
    isEnvTruthy(flagEnv('MERCURY_REDUCED_MOTION'))
  useNowTick(reducedMotion ? null : STAR_TICK_MS)
  if (reducedMotion) {
    return <Text color="claude">● </Text>
  }
  const frame =
    STAR_FRAMES[Math.floor(Date.now() / STAR_TICK_MS) % STAR_FRAMES.length]
  return <Text color="claude">{frame} </Text>
}
