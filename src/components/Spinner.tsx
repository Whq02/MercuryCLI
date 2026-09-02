// The working-status surface. SpinnerWithVerb is the full variant:
// the authoritative turn-phase machine drives the mode whenever a turn is
// open; the legacy mode prop remains the authority — permanently — for
// loading states with no open turn (compaction, pre-wire channels). The
// brief WORKING line is deliberately unreachable (the wrapper never
// branches); the brief IDLE line is live and exported.

import React, {
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react'
import { Box, Text } from '../ink.js'
import { stringWidth } from '../ink/stringWidth.js'
import { useTerminalSize } from '../hooks/useTerminalSize.js'
import { useTasksV2 } from '../hooks/useTasksV2.js'
import { useAppState } from '../state/AppState.js'
import { getViewedTeammateTask } from '../state/selectors.js'
import type { InProcessTeammateTaskState } from '../tasks/InProcessTeammateTask/types.js'
import { isManageableTask } from './tasks/taskStatusUtils.js'
import { activityManager } from '../utils/activityManager.js'
import { getEffortSuffix } from '../utils/effort.js'
import { formatDuration } from '../utils/format.js'
import {
  getFocusedSessionConnector,
  subscribeThroughFocused,
} from '../services/engine-connector/focusedConnector.js'
import { usePulsePhase } from '../utils/pulse/turnPhase.js'
import { getActivePulseTrace } from '../utils/pulse/turnTrace.js'
import type { Task } from '../utils/tasks.js'
import type { Theme } from '../utils/theme.js'
import { isEnvTruthy } from '../utils/envUtils.js'
import { plural } from '../utils/stringUtils.js'
import { GLYPH } from './mercury-ui/glyphs.js'
import { sampleSpinnerVerb } from '../constants/spinnerVerbs.js'
import { CockpitActiveContext } from '../context/cockpitActiveContext.js'
import { WorkCapsuleContext } from './mercury-ui/WorkCapsule.js'
import { useNowTick } from './mercury-ui/components.js'
import { SpinnerAnimationRow } from './Spinner/SpinnerAnimationRow.js'
import { TeammateSpinnerTree } from './Spinner/TeammateSpinnerTree.js'
import { TaskListV2 } from './TaskListV2.js'
import type { SpinnerMode } from './Spinner/types.js'

export type { SpinnerMode } from './Spinner/types.js'

const WHIMSY_ROTATE_MS = 15_000
const LONG_TURN_TIP_MS = 30 * 60 * 1000

// The focused chat's main-model label feed (primitive snapshot).
const subscribeFocusedSpinnerModel = subscribeThroughFocused((connector, listener) => connector.subscribeModel(listener))
const getFocusedSpinnerModel = (): string => getFocusedSessionConnector().modelFacts().main

type ThemeKey = keyof Theme

export type SpinnerWithVerbProps = {
  mode: SpinnerMode
  loadingStartTimeRef: React.RefObject<number>
  totalPausedMsRef: React.RefObject<number>
  pauseStartTimeRef: React.RefObject<number | null>
  spinnerTip?: string | null
  responseLengthRef: React.RefObject<number>
  overrideColor?: ThemeKey | null
  overrideShimmerColor?: ThemeKey | null
  overrideMessage?: string | null
  spinnerSuffix?: string | null
  verbose: boolean
  hasActiveTools: boolean
  activeToolCount: number
  activeToolLabel?: string | null
  leaderIsIdle?: boolean
  apiMetricsRef: React.RefObject<
    Array<{
      ttftMs: number
      firstTokenTime: number
      lastTokenTime: number
      responseLengthBaseline: number
      endResponseLength: number
    }>
  >
}

/** Phase → effective mode: every pre-first-chunk phase projects onto the
 *  requesting mode; streaming phases speak for themselves. */
function phaseToMode(phase: string): SpinnerMode {
  switch (phase) {
    case 'thinking':
      return 'thinking'
    case 'responding':
      return 'responding'
    case 'tool-work':
      return 'tool-use'
    default:
      return 'requesting'
  }
}

/** The next pending task: the first pending task none of whose blockers are
 *  unresolved, falling back to the first pending task. */
export function nextPendingTask(tasks: Task[]): Task | undefined {
  const pending = tasks.filter(task => task.status === 'pending')
  const byId = new Map(tasks.map(task => [task.id, task]))
  const unblocked = pending.find(task =>
    task.blockedBy.every(blocker => {
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
  spinnerTip,
  responseLengthRef,
  overrideColor,
  overrideShimmerColor,
  overrideMessage,
  spinnerSuffix,
  verbose,
  hasActiveTools,
  activeToolCount,
  activeToolLabel,
  leaderIsIdle,
  apiMetricsRef,
}: SpinnerWithVerbProps): React.ReactNode {
  const { columns } = useTerminalSize()
  const inCockpit = useContext(CockpitActiveContext)
  const inWorkCapsule = useContext(WorkCapsuleContext)
  const snapshot = usePulsePhase()
  const mainLoopModel = useSyncExternalStore(subscribeFocusedSpinnerModel, getFocusedSpinnerModel, getFocusedSpinnerModel)
  const reducedMotion =
    useAppState(state => state.settings.prefersReducedMotion === true) ||
    isEnvTruthy(process.env.MERCURY_REDUCED_MOTION)
  const expandedView = useAppState(state => state.expandedView)
  const appEffort = useAppState(state => state.effortValue)
  const tasks: Task[] = useTasksV2() ?? []

  // ── mode: the phase machine is authoritative while a turn is open ────────
  const turnOpen = snapshot.generation > 0 && snapshot.phase !== 'idle'
  const effectiveMode: SpinnerMode = turnOpen
    ? phaseToMode(snapshot.phase)
    : mode

  // ── teammates ────────────────────────────────────────────────────────────
  // Primitive subscriptions: a per-delta task publish re-renders the spinner
  // only when a count, a token sum, or the viewed teammate entry changes.
  const runningTeammateCount = useAppState(state =>
    Object.values(state.tasks).filter(
      task =>
        (task as { type?: string }).type === 'in_process_teammate' &&
        (task as { status?: string }).status === 'running',
    ).length,
  )
  const hasRunningTeammates = runningTeammateCount > 0
  const teammateTokens = useAppState(state =>
    Object.values(state.tasks).reduce(
      (sum, task) =>
        (task as { type?: string }).type === 'in_process_teammate'
          ? sum + ((task as { tokens?: number }).tokens ?? 0)
          : sum,
      0,
    ),
  )
  const foregroundedTeammate = useAppState(state =>
    getViewedTeammateTask(state),
  ) as InProcessTeammateTaskState | undefined
  const foregroundedIdle =
    foregroundedTeammate !== undefined &&
    (foregroundedTeammate as { status?: string }).status !== 'running'

  // ── verb selection ───────────────────────────────────────────────────────
  const [whimsyVerb, setWhimsyVerb] = useState(() => sampleSpinnerVerb())
  useEffect(() => {
    // A change of wording, not an animation: one state update per interval
    // on its own slow timer, nowhere near the frame cadence.
    const timer = setInterval(
      () => setWhimsyVerb(sampleSpinnerVerb()),
      WHIMSY_ROTATE_MS,
    )
    return () => clearInterval(timer)
  }, [])

  const activeTask = tasks.find(
    task => task.status === 'in_progress',
  )
  const teammateVerbRaw = foregroundedTeammate
    ? (foregroundedTeammate as Record<string, unknown>)['verb']
    : undefined
  const teammateVerb =
    typeof teammateVerbRaw === 'string' && teammateVerbRaw !== ''
      ? teammateVerbRaw
      : null

  let chosenVerb: string
  if (foregroundedTeammate && !foregroundedIdle) {
    chosenVerb = teammateVerb ?? whimsyVerb
  } else if (overrideMessage != null && overrideMessage !== '') {
    chosenVerb = overrideMessage
  } else if (activeTask) {
    chosenVerb = activeTask.activeForm ?? activeTask.subject
  } else if (hasActiveTools && activeToolLabel) {
    chosenVerb = activeToolLabel
  } else {
    chosenVerb = whimsyVerb
  }
  const effectiveVerb = chosenVerb
  // An override that already carries its own trailing ellipsis ('stopping…')
  // must not gain a second one — the '✻ stopping……' artifact in the
  // operator's screenshot.
  const message = effectiveVerb.endsWith('…') ? effectiveVerb : `${effectiveVerb}…`
  const phaseBylineEligible = !overrideMessage && !(foregroundedTeammate && !foregroundedTeammate.isIdle)

  // ── colour channel: informational until the first token, then brand ─────
  const requesting =
    effectiveMode !== 'thinking' &&
    effectiveMode !== 'responding' &&
    effectiveMode !== 'tool-use' &&
    effectiveMode !== 'tool-input'
  const messageColor: ThemeKey =
    overrideColor ?? (requesting ? 'info' : 'brand')
  const shimmerColor: ThemeKey =
    overrideShimmerColor ?? (requesting ? 'infoShimmer' : 'brandShimmer')

  // ── ttft ─────────────────────────────────────────────────────────────────
  const ttftText = useMemo(() => {
    const trace = getActivePulseTrace()
    if (trace) {
      const sent = trace.events.find(event => event.name === 'api_request_sent')
      const first = trace.events.find(
        event => event.name === 'first_stream_chunk_received',
      )
      if (sent && first && first.at > sent.at) {
        return `ttft ${((first.at - sent.at) / 1000).toFixed(1)}s`
      }
      return null
    }
    const sample = apiMetricsRef.current?.[0]
    return sample ? `ttft ${(sample.ttftMs / 1000).toFixed(1)}s` : null
    // eslint-disable-next-line react-hooks/exhaustive-deps -- sampled per phase change
  }, [snapshot.phase, snapshot.generation, apiMetricsRef])

  // ── activity tracking, keyed by the current mode ─────────────────────────
  useEffect(() => {
    const id = `spinner:${effectiveMode}`
    activityManager.startCLIActivity(id)
    return () => activityManager.endCLIActivity(id)
  }, [effectiveMode])

  // ── elapsed (pause-aware) + tip ─────────────────────────────────────────
  useNowTick(1000)
  const now = Date.now()
  const pausedSoFar =
    (totalPausedMsRef.current ?? 0) +
    (pauseStartTimeRef.current !== null ? now - pauseStartTimeRef.current : 0)
  const elapsedMs = Math.max(
    0,
    now - (loadingStartTimeRef.current ?? now) - pausedSoFar,
  )
  const pendingNext = nextPendingTask(tasks)
  const spinnerTipsDisabled = useAppState(
    state => state.settings.spinnerTipsEnabled === false,
  )
  const effectiveTip =
    elapsedMs > LONG_TURN_TIP_MS && !spinnerTipsDisabled && !pendingNext
      ? 'This turn has been running a while — esc interrupts it; a fresh conversation keeps context sharp.'
      : (spinnerTip ?? null)

  // ── the tail block (full width, single home) ───────────────────
  const treeExpanded = expandedView === 'teammates'
  const ledgerExpanded = expandedView === 'tasks'
  const tail =
    treeExpanded && hasRunningTeammates ? (
      <TeammateSpinnerTree />
    ) : ledgerExpanded && !inCockpit && tasks.length > 0 ? (
      <TaskListV2 tasks={tasks} />
    ) : pendingNext ? (
      <Text dimColor wrap="truncate-end">
        next: {pendingNext.subject}
      </Text>
    ) : effectiveTip ? (
      <Text dimColor wrap="wrap">
        {effectiveTip}
      </Text>
    ) : null

  // ── idle states ──────────────────────────────────────────────────────────
  // The status-row family shares ONE anchor: flush left (the anchor law
  // in SpinnerAnimationRow — these rows resize mid-state, and idle↔working
  // transitions must never jump the text between anchors either).
  if (leaderIsIdle && hasRunningTeammates && !foregroundedTeammate) {
    const allIdle = runningTeammateCount === 0
    return (
      <Box flexDirection="column" width="100%">
        <Box width="100%">
          <Text dimColor>
            ✶ idle
            {!allIdle
              ? ` · ${runningTeammateCount} ${plural(runningTeammateCount, 'teammate')} running`
              : ''}
          </Text>
        </Box>
        {treeExpanded ? <TeammateSpinnerTree /> : null}
      </Box>
    )
  }
  if (foregroundedTeammate && foregroundedIdle) {
    const startedAt = (foregroundedTeammate as { startedAt?: number }).startedAt
    const everythingIdle = leaderIsIdle && runningTeammateCount === 0
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
        {treeExpanded && hasRunningTeammates ? <TeammateSpinnerTree /> : null}
      </Box>
    )
  }

  const row = (
    <SpinnerAnimationRow
      mode={effectiveMode}
      reducedMotion={reducedMotion}
      hasActiveTools={hasActiveTools}
      activeToolCount={activeToolCount}
      responseLengthRef={responseLengthRef}
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
      hasRunningTeammates={hasRunningTeammates}
      teammateTokens={teammateTokens}
      foregroundedTeammate={foregroundedTeammate}
      leaderIsIdle={leaderIsIdle}
      effortSuffix={getEffortSuffix(mainLoopModel, appEffort)}
      phaseBylineEligible={phaseBylineEligible}
      bylineVerb={effectiveVerb}
      ttftText={ttftText}
      inWorkCapsule={inWorkCapsule}
    />
  )

  // Outside the cockpit's work capsule the live block sits in a single left
  // rail in the session accent; inside the capsule the chassis already
  // contains it — ONE container, no fork (the rail drops).
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

// ── the brief idle status (live) ───────────────────────────────────────────

export function BriefIdleStatus(): React.ReactNode {
  const { columns } = useTerminalSize()
  const connection = useAppState(state => state.remoteConnectionStatus)
  const backgroundCount = useAppState(
    state => Object.values(state.tasks).filter(task => isManageableTask(task)).length,
  )

  const warning =
    connection === 'reconnecting'
      ? 'reconnecting…'
      : connection === 'disconnected'
        ? 'disconnected'
        : null
  const right = backgroundCount > 0 ? `${backgroundCount} background` : ''

  // The fixed two-row footprint (blank row above, content flush against the
  // input bar) keeps the composer from jumping between states.
  if (warning === null && right === '') return <Box height={2} />

  const left = warning ?? ''
  const pad = Math.max(1, columns - 2 - stringWidth(left) - stringWidth(right))
  return (
    <Box flexDirection="column" height={2} justifyContent="flex-end">
      <Text wrap="truncate-end">
        {warning ? <Text color="error">{left}</Text> : left}
        {' '.repeat(pad)}
        <Text dimColor>{right}</Text>
      </Text>
    </Box>
  )
}

// ── the plain star spinner ─────────────────────────────────────────────────

const STAR_BASE = ['✶', '✸', '✹', '✺', '✹', '✷']
const STAR_FRAMES = [...STAR_BASE, ...[...STAR_BASE].reverse()]
const STAR_TICK_MS = 160

export function Spinner(): React.ReactNode {
  const reducedMotion =
    useAppState(state => state.settings.prefersReducedMotion === true) ||
    isEnvTruthy(process.env.MERCURY_REDUCED_MOTION)
  useNowTick(reducedMotion ? null : STAR_TICK_MS)
  if (reducedMotion) {
    return <Text color="claude">● </Text>
  }
  const frame =
    STAR_FRAMES[Math.floor(Date.now() / STAR_TICK_MS) % STAR_FRAMES.length]
  return <Text color="claude">{frame} </Text>
}
