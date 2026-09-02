
import * as React from 'react'
import { useRef, useState } from 'react'
import { existsSync } from 'node:fs'
import type { DeepImmutable } from 'src/types/utils.js'
import { AlternateScreen } from '../../ink/components/AlternateScreen.js'
import { Box, Text, useInput } from '../../ink.js'
import { useElapsedTime } from '../../hooks/useElapsedTime.js'
import { useTerminalSize } from '../../hooks/useTerminalSize.js'
import { useSetAppState } from '../../state/AppState.js'
import {
  killWorkflowTask,
  pauseWorkflowTask,
  retryWorkflowAgent,
  skipWorkflowAgent,
  type LocalWorkflowTaskState,
  type WorkflowPhase,
} from '../../tasks/LocalWorkflowTask/LocalWorkflowTask.js'
import {
  buildAgentSummaries,
  groupAgentsByPhase,
  runLiveness,
  type PhaseBucketOf,
  type WorkflowRunAgentSummary,
  type WorkflowRunManifest,
} from '../../tools/WorkflowTool/runManifest.js'
import { saveWorkflowToProject } from '../../tools/WorkflowTool/registry.js'
import { getCwd } from '../../utils/cwd.js'
import { chatOnlyBoot } from '../../context/surfaceRoute.js'
import { formatDuration, formatTokens } from '../../utils/format.js'
import { getWorkflowTranscriptDir } from '../../utils/sessionStorage.js'
import { plural } from '../../utils/stringUtils.js'
import { agentHeadAt } from '../../utils/cockpit/agentHeadData.js'
import { AMBER, CRIMSON, FAINT, IVORY, SECOND, TEAL } from '../mercuryPalette.js'
import { Crab, Wordmark } from '../mercury-ui/assets.js'
import { EmptyState, StateBadge, useNowTick } from '../mercury-ui/components.js'
import { displayWidth, GLYPH, truncateToWidth } from '../mercury-ui/glyphs.js'
import { WorkingGlyph } from '../mercury-ui/LiveGlyphs.js'
import { agentPulse, agentPulseWord } from '../../tools/WorkflowTool/livePulse.js'
import { useSessionAccent } from '../mercury-ui/sessionAccent.js'
import { useMercuryTokens } from '../mercury-ui/useMercuryTokens.js'
import { decodeNavKey } from '../mercury-ui/navSemantics.js'
import { useOpenEventGate } from '../mercury-ui/useOpenEventGate.js'
import { useStableSelection } from '../mercury-ui/useStableSelection.js'
import { STATE_STYLE, type SnapshotState } from '../mercury-ui/theme.js'
import { agentSnapshotState, statusTone } from './WorkflowDetailDialog.js'
import { useAgentTranscriptView } from './useAgentTranscriptView.js'


export type PhaseBucket<A> = PhaseBucketOf<A>

export function groupByPhase<
  A extends { index: number; phaseIndex?: number; phaseTitle?: string },
>(planned: readonly WorkflowPhase[] | undefined, agents: readonly A[]): PhaseBucket<A>[] {
  return groupAgentsByPhase(planned, [], agents)
}

export function settledCount(
  groups: readonly { agents: readonly { state: string }[] }[],
): number {
  return groups.filter(
    g =>
      g.agents.length > 0 &&
      g.agents.every(a => a.state === 'done' || a.state === 'skipped'),
  ).length
}

export function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}


function shortModel(m: string | undefined): string | undefined {
  return m?.replace(/^claude-/, '')
}

function LaneStateGlyph({
  state,
  runLive,
}: {
  state: WorkflowRunAgentSummary['state']
  runLive: boolean
}): React.ReactNode {
  if (state === 'progress') return <WorkingGlyph color={runLive ? TEAL : AMBER} active={runLive} />
  const s = STATE_STYLE[agentSnapshotState(state)]
  const glyph = state === 'start' ? GLYPH.pending : s.glyph
  const color = state === 'start' ? FAINT : s.color
  return <Text color={color}>{glyph}</Text>
}

function laneStateWord(state: WorkflowRunAgentSummary['state']): string {
  switch (state) {
    case 'done':
      return 'done'
    case 'error':
      return 'error'
    case 'stopped':
      return 'stopped'
    case 'skipped':
      return 'skipped'
    case 'progress':
      return 'running'
    default:
      return 'queued'
  }
}


type LaneRow =
  | { kind: 'sep'; group: PhaseBucket<WorkflowRunAgentSummary>; num: number }
  | { kind: 'agent'; agent: WorkflowRunAgentSummary; flat: number }

function PhaseSeparator({
  group,
  num,
  width,
}: {
  group: PhaseBucket<WorkflowRunAgentSummary>
  num: number
  width: number
}): React.ReactNode {
  const total = group.agents.length
  const done = group.agents.filter(a => a.state === 'done').length
  const errs = group.agents.filter(a => a.state === 'error').length
  const running = group.agents.some(a => a.state === 'progress' || a.state === 'start')
  const tone = group.planned
    ? FAINT
    : errs > 0
      ? CRIMSON
      : total > 0 && done === total
        ? TEAL
        : running
          ? AMBER
          : FAINT
  const glyph = group.planned ? GLYPH.diamond : GLYPH.mission
  const status = group.planned
    ? 'planned'
    : total === 0
      ? 'no agents yet'
      : `${done}/${total} done`
  const errText = errs > 0 ? ` · ${errs} ${plural(errs, 'error')}` : ''
  const plain = `── ${glyph} ${num} · ${group.title} ─ ${status}${errText} `
  const fill = Math.max(0, width - displayWidth(plain))
  return (
    <Box height={1} overflow="hidden">
      <Text wrap="truncate-end">
        <Text color={FAINT}>{'── '}</Text>
        <Text color={tone}>{glyph}</Text>
        <Text color={FAINT}>{` ${num} · `}</Text>
        <Text bold={!group.planned} color={group.planned ? SECOND : IVORY}>
          {group.title}
        </Text>
        <Text color={FAINT}>{' ─ '}</Text>
        <Text color={tone}>{status}</Text>
        {errs > 0 ? <Text color={CRIMSON}>{errText}</Text> : null}
        <Text color={FAINT}>{` ${'─'.repeat(fill)}`}</Text>
      </Text>
    </Box>
  )
}

export function agentRuntime(agent: WorkflowRunAgentSummary, now: number): string | undefined {
  if (typeof agent.durationMs === 'number' && agent.durationMs > 0)
    return formatDuration(agent.durationMs)
  if (agent.state === 'progress' && typeof agent.startedAt === 'number')
    return formatDuration(Math.max(0, now - agent.startedAt))
  if (agent.state === 'start' && typeof agent.queuedAt === 'number')
    return `queued ${formatDuration(Math.max(0, now - agent.queuedAt))}`
  return undefined
}

function AgentLane({
  agent,
  selected,
  accent,
  now,
  runLive,
}: {
  agent: WorkflowRunAgentSummary
  selected: boolean
  accent: string
  now: number
  runLive: boolean
}): React.ReactNode {
  const head = agentHeadAt(agent.index)
  const meta: string[] = []
  const model = shortModel(agent.model)
  if (model) meta.push(agent.effort ? `${model} @${agent.effort}` : model)
  if (typeof agent.tokens === 'number' && agent.tokens > 0)
    meta.push(`${GLYPH.tokens} ${formatTokens(agent.tokens)}`)
  if (typeof agent.toolCalls === 'number' && agent.toolCalls > 0)
    meta.push(`${agent.toolCalls} ${plural(agent.toolCalls, 'tool')}`)
  const runtime = agentRuntime(agent, now)
  if (runtime) meta.push(runtime)
  if (agent.cached) meta.push('cached')
  const pulse = agentPulse(agent, now)
  const live =
    agent.state === 'progress'
      ? pulse.kind === 'working'
        ? pulse.toolLine
        : agentPulseWord(pulse)
      : undefined
  return (
    <Box height={1} overflow="hidden">
      <Text wrap="truncate-end">
        <Text color={selected ? accent : FAINT}>{selected ? `${GLYPH.cursor} ` : '  '}</Text>
        <LaneStateGlyph state={agent.state} runLive={runLive} />
        <Text color={head.hue}>{` ${GLYPH.sparkFaint} `}</Text>
        <Text bold={selected} color={IVORY}>
          {agent.label}
        </Text>
        {meta.length > 0 ? <Text color={FAINT}>{` · ${meta.join(' · ')}`}</Text> : null}
        {live ? <Text color={SECOND}>{` · ${live}`}</Text> : null}
        {agent.state === 'error' && agent.error ? (
          <Text color={CRIMSON}>{` · ${agent.error}`}</Text>
        ) : null}
        {
}
        {agent.state === 'stopped' || agent.state === 'skipped' ? (
          <Text color={FAINT}>{` · ${laneStateWord(agent.state)}`}</Text>
        ) : null}
      </Text>
    </Box>
  )
}


function estWrappedLines(text: string | undefined, width: number, cap: number): number {
  if (!text) return 1
  let lines = 0
  for (const seg of text.split('\n')) lines += Math.max(1, Math.ceil(displayWidth(seg) / width))
  return Math.max(1, Math.min(cap, lines))
}

function DossierCard({
  agent,
  transcriptDir,
  fallbackDirs,
  version,
  inCeil,
  outCeil,
  activityRows,
  width,
  now,
}: {
  agent: WorkflowRunAgentSummary
  transcriptDir: string
  fallbackDirs?: readonly string[]
  version: number | undefined
  inCeil: number
  outCeil: number
  activityRows: number
  width: number
  now: number
}): React.ReactNode {
  const read = useAgentTranscriptView({
    transcriptDir,
    fallbackDirs,
    agentId: agent.agentId,
    enabled: true,
    liveState: agent.state,
    version,
  })
  const head = agentHeadAt(agent.index)
  const s = STATE_STYLE[agentSnapshotState(agent.state)]
  const view = read.view

  const inText = view?.prompt ?? agent.promptPreview
  const lastCall = view?.toolCalls?.length
    ? view.toolCalls[view.toolCalls.length - 1]
    : undefined
  const pulse = agentPulse(agent, now)
  const pulseOverride =
    pulse.kind === 'backoff' || pulse.kind === 'first-token' || pulse.kind === 'quiet'
      ? agentPulseWord(pulse)
      : undefined
  const nowText =
    agent.state === 'progress' || agent.state === 'start'
      ? (pulseOverride ??
        (lastCall
          ? `${lastCall.name}(${lastCall.inputSummary})${lastCall.resultPreview ? ` → ${lastCall.resultPreview}` : ''}`
          : agent.lastToolName
            ? `${agent.lastToolName}(${agent.lastToolSummary ?? ''})`
            : agent.state === 'start'
              ? 'waiting for a worker slot'
              :
                'working…'))
      : `settled · ${agent.toolCalls ?? view?.toolCallsTotal ?? 0} ${plural(agent.toolCalls ?? view?.toolCallsTotal ?? 0, 'tool call')}`
  const attemptCalls = view?.toolCallsTotal
  const totalCalls = agent.toolCalls
  const toolsBit =
    typeof attemptCalls === 'number' && typeof totalCalls === 'number' && attemptCalls !== totalCalls
      ? `${attemptCalls} of ${totalCalls} tool ${plural(totalCalls, 'call')} this attempt`
      : typeof totalCalls === 'number' && totalCalls > 0
        ? `${totalCalls} tool ${plural(totalCalls, 'call')}`
        : undefined
  const outText =
    view?.finalText ??
    agent.resultPreview ??
    (agent.state === 'error'
      ? (agent.error ?? 'errored')
      : agent.state === 'done'
        ? 'done — output not captured'
        : agent.state === 'start'
          ? 'not started'
          : 'still working')

  const contentWidth = Math.max(16, width - 8)
  const inEst = estWrappedLines(inText ?? undefined, contentWidth, inCeil + 1)
  const inH = Math.min(inCeil, inEst)
  const outEst = estWrappedLines(outText, contentWidth, outCeil + 1)
  const outH = Math.min(outCeil, outEst)
  const tailSource =
    agent.state === 'progress' || agent.state === 'start'
      ? (view?.toolCalls ?? []).slice(0, -1)
      : (view?.toolCalls ?? [])
  const activityShown = activityRows > 0 ? tailSource.slice(-activityRows) : []
  const clipped =
    inEst > inCeil ||
    outEst > outCeil ||
    (view ? view.toolCallsTotal > activityShown.length + 1 : false)
  const model = shortModel(agent.model) ?? shortModel(view?.model)

  const metaBits: string[] = []
  if (typeof agent.tokens === 'number' && agent.tokens > 0)
    metaBits.push(`${GLYPH.tokens} ${formatTokens(agent.tokens)}`)
  if (toolsBit) metaBits.push(toolsBit)
  if (view?.usage)
    metaBits.push(
      `${formatTokens(view.usage.inputTokens)} in / ${formatTokens(view.usage.outputTokens)} out`,
    )
  if (read.meta?.agentType) metaBits.push(read.meta.agentType)
  if (read.meta?.worktreePath) metaBits.push('worktree')
  if (typeof agent.attempt === 'number' && agent.attempt > 1)
    metaBits.push(`attempt ${agent.attempt}`)
  if (agent.cached) metaBits.push('cached')

  const label = (t: string): React.ReactNode => <Text color={FAINT}>{t.padEnd(4)}</Text>

  return (
    <Box borderStyle="round" borderColor={FAINT} paddingX={1} flexShrink={0} overflow="hidden">
      {
}
      <Box flexDirection="column" flexGrow={1} overflow="hidden">
        <Box height={1} overflow="hidden">
          <Text wrap="truncate-end">
            <Text color={head.hue}>{`${GLYPH.sparkFaint} `}</Text>
            <Text color={s.color}>{s.glyph} </Text>
            <Text bold color={IVORY}>
              {agent.label}
            </Text>
            <Text color={head.hue}>{` · ${head.name}`}</Text>
            <Text color={s.color}>{` · ${laneStateWord(agent.state)}`}</Text>
            {model ? (
              <Text color={FAINT}>
                {` · ${model}`}
                {agent.effort ? ` @${agent.effort}` : ''}
              </Text>
            ) : null}
            {agentRuntime(agent, now) ? (
              <Text color={FAINT}>{` · ${agentRuntime(agent, now)}`}</Text>
            ) : null}
            {clipped ? (
              <Text color={FAINT}>{' · clipped — ↵ inspect'}</Text>
            ) : null}
          </Text>
        </Box>
        <Box height={inH} overflow="hidden">
          <Text wrap="wrap">
            {label('in')}
            <Text color={SECOND}>{inText ?? '— prompt not captured —'}</Text>
          </Text>
        </Box>
        <Box height={1} overflow="hidden">
          <Text wrap="truncate-end">
            {label('now')}
            <Text color={agent.state === 'progress' ? IVORY : SECOND}>{nowText}</Text>
          </Text>
        </Box>
        {
}
        {activityShown.map((c, i) => (
          <Box key={`act:${i}`} height={1} overflow="hidden">
            <Text wrap="truncate-end">
              {label(i === 0 ? 'act' : '')}
              <Text color={c.isError ? CRIMSON : SECOND}>{c.name}</Text>
              <Text color={FAINT}>({c.inputSummary})</Text>
              {c.resultPreview ? <Text color={FAINT}> → {c.resultPreview}</Text> : null}
            </Text>
          </Box>
        ))}
        <Box height={outH} overflow="hidden">
          <Text wrap="wrap">
            {label('out')}
            <Text
              color={
                agent.state === 'error' ? CRIMSON : agent.state === 'done' ? IVORY : FAINT
              }
            >
              {outText}
            </Text>
          </Text>
        </Box>
        <Box height={1} overflow="hidden">
          <Text color={FAINT} wrap="truncate-end">
            {metaBits.length > 0 ? metaBits.join(' · ') : ' '}
          </Text>
        </Box>
      </Box>
    </Box>
  )
}


export type RunDetailPaneProps = {
  runId: string
  task?: DeepImmutable<LocalWorkflowTaskState>
  manifest?: WorkflowRunManifest & { mtimeMs: number }
  onBack: () => void
  onOpenAgent: (agentIndex: number) => void
}

export function RunDetailPane({
  runId,
  task,
  manifest,
  onBack,
  onOpenAgent,
}: RunDetailPaneProps): React.ReactNode {
  const { columns, rows } = useTerminalSize()
  const accent = useSessionAccent().accent
  const tokens = useMercuryTokens()
  const setAppState = useSetAppState()
  const pastBuffer = useOpenEventGate()
  const [note, setNote] = useState<string | null>(null)
  const savingRef = useRef(false)

  const isLive = !!task
  const status = isLive ? task.status : (manifest?.status ?? 'running')
  const startTime = isLive ? task.startTime : (manifest?.startTime ?? Date.now())
  const endTime = isLive ? task.endTime : manifest?.endTime
  const liveness =
    !isLive && manifest
      ? runLiveness(manifest, manifest.mtimeMs, Date.now(), pidAlive)
      : ('live' as const)
  const orphaned = liveness === 'orphaned'
  const wedged = liveness === 'wedged'
  const isRunning = !orphaned && !wedged && (status === 'running' || status === 'pending')
  const now = useNowTick(isRunning ? 1000 : null)
  const clockNow = isRunning ? now : (endTime ?? manifest?.mtimeMs ?? startTime)
  const elapsed = useElapsedTime(startTime, isRunning, 1000, 0, isRunning ? endTime : clockNow)

  const name = isLive
    ? (task.workflowName ?? task.title ?? task.summary ?? task.description ?? 'Dynamic workflow')
    : (manifest?.workflowName ?? manifest?.title ?? manifest?.description ?? 'Dynamic workflow')

  const tone = statusTone(status)
  const headerState: SnapshotState = orphaned
    ? 'failed'
    : wedged
      ? 'gated'
      : status === 'completed'
        ? 'live'
        : status === 'failed' || status === 'killed'
          ? 'failed'
          : status === 'running'
            ? 'gated'
            : 'off'
  const headerWord = orphaned ? 'stale' : wedged ? 'wedged?' : tone.word

  const plannedPhases = isLive ? task.phases : manifest?.phases
  const phaseEvents = isLive
    ? (task.workflowProgress ?? [])
        .filter(ev => ev.type === 'workflow_phase')
        .map(ev => ({ index: ev.index, title: ev.title || `Phase ${ev.index + 1}` }))
    : []
  const agentSummaries: WorkflowRunAgentSummary[] = isLive
    ? buildAgentSummaries(task.workflowProgress)
    : (manifest?.agents ?? [])
  const groups = groupAgentsByPhase(plannedPhases, phaseEvents, agentSummaries)

  const agents: WorkflowRunAgentSummary[] = []
  const lanes: LaneRow[] = []
  for (const [gi, g] of groups.entries()) {
    lanes.push({ kind: 'sep', group: g, num: gi + 1 })
    for (const a of g.agents) {
      lanes.push({ kind: 'agent', agent: a, flat: agents.length })
      agents.push(a)
    }
  }
  const laneSel = useStableSelection(agents, a => String(a.agentId ?? `i${a.index}`))
  const selClamped = laneSel.index
  const selected: WorkflowRunAgentSummary | undefined = agents[selClamped]

  const scriptPathRaw = isLive ? task.scriptPath : manifest?.scriptPath
  const scriptPath = React.useMemo(
    () => (scriptPathRaw && existsSync(scriptPathRaw) ? scriptPathRaw : undefined),
    [scriptPathRaw],
  )
  const transcriptDir = manifest?.transcriptDir ?? getWorkflowTranscriptDir(runId)
  const fallbackDirs = manifest?.transcriptDirs
  const version = isLive ? task.progressVersion : manifest?.mtimeMs
  const selectedInFlight =
    isLive &&
    !!selected?.agentId &&
    (selected.state === 'start' || selected.state === 'progress')

  const agentCount = isLive ? task.agentCount : (manifest?.agentCount ?? agentSummaries.length)
  const totalTokens = isLive ? task.totalTokens : (manifest?.totalTokens ?? 0)
  const totalToolCalls = isLive ? task.totalToolCalls : (manifest?.totalToolCalls ?? 0)
  const model = isLive ? shortModel(task.defaultModel) : undefined
  const runError = isLive ? task.error : manifest?.error

  const metrics: string[] = []
  metrics.push(`${GLYPH.mission} ${settledCount(groups)}/${groups.length}`)
  metrics.push(`${agentCount} ${plural(agentCount, 'agent')}`)
  if (totalTokens > 0) metrics.push(`${GLYPH.tokens} ${formatTokens(totalTokens)}`)
  if (totalToolCalls > 0) metrics.push(`${totalToolCalls} ${plural(totalToolCalls, 'tool')}`)
  if (model) metrics.push(model)

  const doSave = (): void => {
    if (!scriptPath || savingRef.current) return
    savingRef.current = true
    void saveWorkflowToProject({ scriptPath, name, cwd: getCwd() }).then(r => {
      savingRef.current = false
      setNote(
        r.ok
          ? r.already
            ? `already saved — ${r.savedPath}`
            : `saved — ${r.savedPath} · run it by name anytime`
          : `save failed: ${r.error}`,
      )
    })
  }

  useInput((input, key) => {
    const action = decodeNavKey(input, key, { orientation: 'vertical', hierarchy: true })
    if (action === 'cancel' || action === 'leaveChild') {
      onBack()
      return
    }
    if (action === 'movePrevious') {
      laneSel.select(selClamped - 1)
      setNote(null)
      return
    }
    if (action === 'moveNext') {
      laneSel.select(selClamped + 1)
      setNote(null)
      return
    }
    if (!pastBuffer()) return
    if ((action === 'activate' || action === 'enterChild') && selected) {
      onOpenAgent(selected.index)
      return
    }
    if (input === 's' && selectedInFlight && task && selected?.agentId) {
      const receipt = skipWorkflowAgent(task.id, selected.agentId, setAppState)
      setNote(
        receipt === 'applied'
          ? `skipping ${selected.label} — its agent() call resolves null`
          : receipt === 'not-in-flight'
            ? `${selected.label} already settled — nothing to skip`
            : 'the run already settled — nothing to skip',
      )
      return
    }
    if (input === 'r' && selectedInFlight && task && selected?.agentId) {
      const receipt = retryWorkflowAgent(task.id, selected.agentId, setAppState)
      setNote(
        receipt === 'applied'
          ? `retrying ${selected.label} — a fresh attempt starts now`
          : receipt === 'not-in-flight'
            ? `${selected.label} already settled — nothing to retry`
            : 'the run already settled — nothing to retry',
      )
      return
    }
    if (input === 'p' && isLive && task.status === 'running') {
      const receipt = pauseWorkflowTask(task.id, setAppState)
      setNote(
        receipt === 'applied'
          ? `paused — finished agents stay cached${chatOnlyBoot() ? '' : '; R on the board resumes it'}`
          : 'the run already settled — nothing to pause',
      )
      return
    }
    if (input === 'x' && isLive && task.status === 'running') {
      const receipt = killWorkflowTask(task.id, setAppState)
      setNote(
        receipt === 'applied'
          ? 'stopping — the row settles when the tree is down'
          : 'the run already settled — nothing to stop',
      )
      return
    }
    if (input === 'S' && scriptPath) {
      doSave()
      return
    }
  })

  if (!task && !manifest) {
    return (
      <Box flexDirection="column" borderStyle="round" paddingX={1} width="100%">
        <Text color={FAINT}>
          Run {runId} is no longer available (no live task, no saved run record).
        </Text>
        <Box marginTop={1}>
          <Text color={FAINT}>esc / ← back</Text>
        </Box>
      </Box>
    )
  }

  const tall = rows >= 30
  const inBase = tall ? 2 : 1
  const outBase = tall ? 2 : 1
  const dossierH = selected ? Math.max(3 + inBase + outBase, 4) + 2 : 0
  const laneBudget = Math.max(
    3,
    rows -
      (2  +
        2  +
        (runError ? 1 : 0) +
        1  +
        (selected ? 1 : 0)  +
        dossierH +
        (note ? 1 : 0) +
        1) ,
  )

  const selPos = Math.max(
    0,
    lanes.findIndex(l => l.kind === 'agent' && l.flat === selClamped),
  )
  let visible: LaneRow[] = lanes
  let clippedAbove = 0
  let clippedBelow = 0
  if (lanes.length > laneBudget) {
    const span = Math.max(1, laneBudget - 2)
    let start = Math.max(0, Math.min(selPos - (span >> 1), lanes.length - span))
    clippedAbove = start
    clippedBelow = lanes.length - (start + span)
    visible = lanes.slice(start, start + span)
  }

  const innerWidth = Math.max(20, columns - 4)

  const lanesUsed =
    visible.length + (clippedAbove > 0 ? 1 : 0) + (clippedBelow > 0 ? 1 : 0)
  const spare = Math.max(0, laneBudget - lanesUsed)
  const outCeil = Math.min(10, outBase + Math.ceil(spare * 0.4))
  const inCeil = Math.min(6, inBase + Math.ceil(spare * 0.2))
  const activityRows = Math.min(
    10,
    Math.max(0, spare - (outCeil - outBase) - (inCeil - inBase)),
  )

  const hints = [
    agents.length > 0 ? '↑↓ agent' : undefined,
    agents.length > 0 ? '↵ inspect' : undefined,
    selectedInFlight ? 's skip · r retry' : undefined,
    isLive && task?.status === 'running' ? 'p pause · x stop' : undefined,
    scriptPath ? 'S save' : undefined,
    'esc back',
  ]
    .filter(Boolean)
    .join(' · ')

  return (
    <AlternateScreen>
      <Box
        flexDirection="column"
        borderStyle="round"
        borderColor={tokens.borderSubtle}
        paddingX={1}
        width="100%"
        flexShrink={0}
        minHeight={Math.max(0, rows - 1)}
      >
        {}
        <Box flexShrink={0}>
          <Crab />
          <Text> </Text>
          <Wordmark />
          <Text color={FAINT}> — run · </Text>
          <Text bold color={IVORY}>
            {truncateToWidth(String(name), Math.max(8, innerWidth - 18))}
          </Text>
        </Box>
        <Box height={1} overflow="hidden" flexShrink={0}>
          <Text wrap="truncate-end">
            <StateBadge state={headerState} label={headerWord} />
            <Text color={FAINT}>{` · ${elapsed} · ${metrics.join(' · ')}`}</Text>
          </Text>
        </Box>
        {runError ? (
          <Box height={1} overflow="hidden" flexShrink={0}>
            <Text color={CRIMSON} wrap="truncate-end">
              {GLYPH.fail} {runError}
            </Text>
          </Box>
        ) : null}

        {}
        <Box flexDirection="column" marginTop={1} flexShrink={0}>
          {groups.length === 0 ? (
            <EmptyState
              title={isRunning ? 'Starting…' : 'No phases reported'}
              hint={isRunning ? 'agents appear here as the workflow fans out' : undefined}
              glyph={GLYPH.pending}
              tone={isRunning ? 'gated' : 'idle'}
            />
          ) : (
            <>
              {clippedAbove > 0 ? (
                <Text color={FAINT}>{`  … ${clippedAbove} ${plural(clippedAbove, 'row')} above`}</Text>
              ) : null}
              {visible.map(l =>
                l.kind === 'sep' ? (
                  <PhaseSeparator
                    key={`sep:${l.group.index}`}
                    group={l.group}
                    num={l.num}
                    width={innerWidth}
                  />
                ) : (
                  <AgentLane
                    key={`ag:${l.agent.phaseIndex ?? -1}:${l.agent.index}`}
                    agent={l.agent}
                    selected={l.flat === selClamped}
                    accent={accent}
                    now={clockNow}
                    runLive={isRunning}
                  />
                ),
              )}
              {clippedBelow > 0 ? (
                <Text color={FAINT}>{`  … ${clippedBelow} ${plural(clippedBelow, 'row')} below`}</Text>
              ) : null}
            </>
          )}
        </Box>

        {
}
        {selected ? (
          <Box flexDirection="column" marginTop={1} flexShrink={0}>
            <DossierCard
              key={selected.agentId ?? `idx:${selected.index}`}
              agent={selected}
              transcriptDir={transcriptDir}
              fallbackDirs={fallbackDirs}
              version={version}
              inCeil={inCeil}
              outCeil={outCeil}
              activityRows={activityRows}
              width={innerWidth}
              now={clockNow}
            />
          </Box>
        ) : null}

        <Box flexGrow={1} />

        {note ? (
          <Box height={1} overflow="hidden" flexShrink={0}>
            <Text color={AMBER} wrap="truncate-end">
              {note}
            </Text>
          </Box>
        ) : null}

        {}
        <Box flexShrink={0} height={1} overflow="hidden">
          <Text color={FAINT} wrap="truncate-end">
            {truncateToWidth(hints, Math.max(10, columns - 4))}
          </Text>
        </Box>
      </Box>
    </AlternateScreen>
  )
}
