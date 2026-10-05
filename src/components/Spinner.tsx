
import React, {
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react'
import { Box, Text } from '../ink.js'
import { stringWidth } from '../ink/stringWidth.js'
import { useTerminalSize } from '../hooks/useTerminalSize.js'
import { useAppState } from '../state/AppState.js'
import { getViewedCrewmateTask } from '../state/selectors.js'
import type { InProcessCrewmateTaskState } from '../tasks/InProcessCrewmateTask/types.js'
import { activityManager } from '../utils/activityManager.js'
import { getEffortSuffix } from '../utils/effort.js'
import { formatDuration } from '../utils/format.js'
import { truncateKeepingTail } from '../utils/truncate.js'
import {
  getFocusedSessionConnector,
  subscribeThroughFocused,
} from '../services/engine-connector/focusedConnector.js'
import type { Theme } from '../utils/theme.js'
import { isEnvTruthy } from '../utils/envUtils.js'
import { plural } from '../utils/stringUtils.js'
import { GLYPH, truncateToWidth } from './mercury-ui/glyphs.js'
import { sampleSpinnerVerb } from '../constants/spinnerVerbs.js'
import { CockpitActiveContext } from '../context/cockpitActiveContext.js'
import { WorkCapsuleContext } from './mercury-ui/WorkCapsule.js'
import { useNowTick } from './mercury-ui/components.js'
import { SpinnerAnimationRow } from './Spinner/SpinnerAnimationRow.js'
import { liveCounterLine, liveCounterPhaseOf, liveCounterWords, turnFactsOfRefs } from './Spinner/liveCounterWords.js'
import type { LiveTurnFactsV1 } from '../services/engine-connector/seatLive.js'
import { CrewmateSpinnerTree } from './Spinner/CrewmateSpinnerTree.js'
import { TaskListV2 } from './TaskListV2.js'
import type { SpinnerMode } from './Spinner/types.js'
import { useFocusedMission } from './tasks/useFocusedWork.js'

export type { SpinnerMode } from './Spinner/types.js'

const WHIMSY_ROTATE_MS = 15_000
const LONG_TURN_TIP_MS = 30 * 60 * 1000

const subscribeFocusedSpinnerModel = subscribeThroughFocused((connector, listener) => connector.subscribeModel(listener))
const getFocusedSpinnerModel = (): string => getFocusedSessionConnector().modelFacts().main

type ThemeKey = keyof Theme

export type SpinnerWithVerbProps = {
  compact?: boolean
  compactWarning?: boolean
  mode: SpinnerMode
  loadingStartTimeRef: React.RefObject<number>
  totalPausedMsRef: React.RefObject<number>
  pauseStartTimeRef: React.RefObject<number | null>
  spinnerTip?: string | null
  responseLengthRef: React.RefObject<number>
  outputTokensRef?: React.RefObject<number | null>
  liveTurnFactsRef?: React.RefObject<LiveTurnFactsV1>
  overrideColor?: ThemeKey | null
  overrideShimmerColor?: ThemeKey | null
  overrideMessage?: string | null
  still?: boolean
  spinnerSuffix?: string | null
  verbose: boolean
  hasActiveTools: boolean
  activeToolCount: number
  activeToolLabel?: string | null
  leaderIsIdle?: boolean
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
  compact = false,
  compactWarning = false,
  mode,
  loadingStartTimeRef,
  totalPausedMsRef,
  pauseStartTimeRef,
  spinnerTip,
  responseLengthRef,
  outputTokensRef,
  liveTurnFactsRef,
  overrideColor,
  overrideShimmerColor,
  overrideMessage,
  still = false,
  spinnerSuffix,
  verbose,
  hasActiveTools,
  activeToolCount,
  activeToolLabel,
  leaderIsIdle,
}: SpinnerWithVerbProps): React.ReactNode {
  const { columns } = useTerminalSize()
  const inCockpit = useContext(CockpitActiveContext)
  const inWorkCapsule = useContext(WorkCapsuleContext)
  const engineModel = useSyncExternalStore(subscribeFocusedSpinnerModel, getFocusedSpinnerModel, getFocusedSpinnerModel)
  const reducedMotion =
    useAppState(state => state.settings.view?.reducedMotion === true) ||
    isEnvTruthy(process.env.MERCURY_REDUCED_MOTION)
  const expandedView = useAppState(state => state.expandedView)
  const appEffort = useAppState(state => state.effortValue)
  const mission = useFocusedMission()

  const effectiveMode: SpinnerMode = mode

  const runningCrewmateCount = useAppState(state =>
    Object.values(state.tasks).filter(
      task =>
        (task as { type?: string }).type === 'in_process_crewmate' &&
        (task as { status?: string }).status === 'running',
    ).length,
  )
  const hasRunningCrewmates = runningCrewmateCount > 0
  const crewmateTokens = useAppState(state =>
    Object.values(state.tasks).reduce(
      (sum, task) =>
        (task as { type?: string }).type === 'in_process_crewmate'
          ? sum + ((task as { tokens?: number }).tokens ?? 0)
          : sum,
      0,
    ),
  )
  const foregroundedCrewmate = useAppState(state =>
    getViewedCrewmateTask(state),
  ) as InProcessCrewmateTaskState | undefined
  const foregroundedIdle =
    foregroundedCrewmate !== undefined &&
    (foregroundedCrewmate as { status?: string }).status !== 'running'

  const [whimsyVerb, setWhimsyVerb] = useState(() => sampleSpinnerVerb())
  useEffect(() => {
    const timer = setInterval(
      () => setWhimsyVerb(sampleSpinnerVerb()),
      WHIMSY_ROTATE_MS,
    )
    return () => clearInterval(timer)
  }, [])

  const crewmateVerbRaw = foregroundedCrewmate
    ? (foregroundedCrewmate as Record<string, unknown>)['verb']
    : undefined
  const crewmateVerb =
    typeof crewmateVerbRaw === 'string' && crewmateVerbRaw !== ''
      ? crewmateVerbRaw
      : null

  let chosenVerb: string
  if (foregroundedCrewmate && !foregroundedIdle) {
    chosenVerb = crewmateVerb ?? whimsyVerb
  } else if (overrideMessage != null && overrideMessage !== '') {
    chosenVerb = overrideMessage
  } else if (hasActiveTools && activeToolLabel) {
    chosenVerb = activeToolLabel
  } else {
    chosenVerb = whimsyVerb
  }
  const effectiveVerb = chosenVerb
  const message = still || effectiveVerb.endsWith('…') ? effectiveVerb : `${effectiveVerb}…`

  const requesting =
    effectiveMode !== 'thinking' &&
    effectiveMode !== 'responding' &&
    effectiveMode !== 'tool-use' &&
    effectiveMode !== 'tool-input'
  const messageColor: ThemeKey =
    overrideColor ?? (requesting ? 'info' : 'brand')
  const shimmerColor: ThemeKey =
    overrideShimmerColor ?? (requesting ? 'infoShimmer' : 'brandShimmer')

  useEffect(() => {
    const id = `spinner:${effectiveMode}`
    activityManager.startCLIActivity(id)
    return () => activityManager.endCLIActivity(id)
  }, [effectiveMode])

  useNowTick(1000)
  const now = Date.now()
  const pausedSoFar =
    (totalPausedMsRef.current ?? 0) +
    (pauseStartTimeRef.current !== null ? now - pauseStartTimeRef.current : 0)
  const elapsedMs = Math.max(
    0,
    now - (loadingStartTimeRef.current ?? now) - pausedSoFar,
  )
  const pendingNext = nextPendingTask(mission)
  const spinnerTipsDisabled = useAppState(
    state => state.settings.activity?.tips?.enabled === false,
  )
  const effectiveTip = still
    ? null
    : elapsedMs > LONG_TURN_TIP_MS && !spinnerTipsDisabled && !pendingNext
      ? 'This turn has been running a while — esc interrupts it, not its agents.'
      : (spinnerTip ?? null)

  const treeExpanded = expandedView === 'crewmates'
  const ledgerExpanded = expandedView === 'tasks'
  const tail =
    treeExpanded && hasRunningCrewmates ? (
      <CrewmateSpinnerTree />
    ) : ledgerExpanded && mission.length > 0 ? (
      <TaskListV2 tasks={mission} />
    ) : pendingNext ? (
      <Text dimColor wrap="truncate-end">
        next: {pendingNext.subject}
      </Text>
    ) : effectiveTip ? (
      <Text dimColor wrap="wrap">
        {effectiveTip}
      </Text>
    ) : null

  if (compact) {
    if (compactWarning) return <Box height={1} width="100%" overflow="hidden"><Text color="warning" wrap="truncate-end">{truncateKeepingTail(message, Math.max(0, columns))}</Text></Box>
    const liveWords = liveCounterWords(
      { ...(liveTurnFactsRef?.current ?? turnFactsOfRefs(responseLengthRef.current ?? 0, outputTokensRef?.current ?? null)), phase: liveCounterPhaseOf(effectiveMode), sentAtMs: now - elapsedMs },
      now,
    )
    const detail = liveCounterLine(liveWords, Math.max(0, columns - 5))
    const head = truncateToWidth(message.replace(/\s+/g, ' '), Math.max(0, columns - stringWidth(detail) - (detail ? 5 : 2)))
    return <Box height={1} width="100%" overflow="hidden"><Text wrap="truncate-end"><Text color={messageColor}>{GLYPH.spark} {head}</Text><Text dimColor>{detail ? `${head ? ' · ' : ''}${detail}` : ''}</Text></Text></Box>
  }

  if (leaderIsIdle && hasRunningCrewmates && !foregroundedCrewmate) {
    const allIdle = runningCrewmateCount === 0
    return (
      <Box flexDirection="column" width="100%">
        <Box width="100%">
          <Text dimColor>
            ✶ idle
            {!allIdle
              ? ` · ${runningCrewmateCount} ${plural(runningCrewmateCount, 'crewmate')} running`
              : ''}
          </Text>
        </Box>
        {treeExpanded ? <CrewmateSpinnerTree /> : null}
      </Box>
    )
  }
  if (foregroundedCrewmate && foregroundedIdle) {
    const startedAt = (foregroundedCrewmate as { startedAt?: number }).startedAt
    const everythingIdle = leaderIsIdle && runningCrewmateCount === 0
    return (
      <Box flexDirection="column" width="100%">
        <Box width="100%">
          <Text dimColor>
            {'✶ '}
            {everythingIdle && startedAt
              ? `worked for ${formatDuration(Date.now() - startedAt)}`
              : 'idle'}
          </Text>
        </Box>
        {treeExpanded && hasRunningCrewmates ? <CrewmateSpinnerTree /> : null}
      </Box>
    )
  }

  const row = (
    <SpinnerAnimationRow
      mode={effectiveMode}
      reducedMotion={reducedMotion}
      activeToolCount={activeToolCount}
      responseLengthRef={responseLengthRef}
      outputTokensRef={outputTokensRef}
      liveTurnFactsRef={liveTurnFactsRef}
      message={message}
      messageColor={messageColor}
      shimmerColor={shimmerColor}
      overrideColor={overrideColor ?? null}
      loadingStartTimeRef={loadingStartTimeRef}
      totalPausedMsRef={totalPausedMsRef}
      pauseStartTimeRef={pauseStartTimeRef}
      spinnerSuffix={spinnerSuffix}
      verbose={verbose}
      columns={columns}
      hasRunningCrewmates={hasRunningCrewmates}
      crewmateTokens={crewmateTokens}
      foregroundedCrewmate={foregroundedCrewmate}
      effortSuffix={getEffortSuffix(engineModel, appEffort)}
      inWorkCapsule={inWorkCapsule}
      still={still}
    />
  )

  const inner = (
    <Box flexDirection="column" width="100%">
      {row}
      {tail}
    </Box>
  )
  if (inWorkCapsule) return inner
  return (
    <Box flexDirection="column" width="100%">
      {inCockpit ? (
        row
      ) : (
        <Box>
          <Text color="claude">▎</Text>
          <Box flexDirection="column" flexGrow={1}>
            {row}
          </Box>
        </Box>
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
    isEnvTruthy(process.env.MERCURY_REDUCED_MOTION)
  useNowTick(reducedMotion ? null : STAR_TICK_MS)
  if (reducedMotion) {
    return <Text color="claude">● </Text>
  }
  const frame =
    STAR_FRAMES[Math.floor(Date.now() / STAR_TICK_MS) % STAR_FRAMES.length]
  return <Text color="claude">{frame} </Text>
}
