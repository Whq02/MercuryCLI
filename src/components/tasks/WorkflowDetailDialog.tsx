
import * as React from 'react'
import type { DeepImmutable } from 'src/types/utils.js'
import { useElapsedTime } from '../../hooks/useElapsedTime.js'
import type { KeyboardEvent } from '../../ink/events/keyboard-event.js'
import { Box, Text } from '../../ink.js'
import { useKeybindings } from '../../keybindings/useKeybinding.js'
import type {
  LocalWorkflowTaskState,
  WorkflowProgressEvent,
} from '../../tasks/LocalWorkflowTask/LocalWorkflowTask.js'
import {
  formatQuietAge,
  workflowPulse,
} from '../../tools/WorkflowTool/livePulse.js'
import {
  buildAgentSummaries,
  groupAgentsByPhase,
  type WorkflowPhaseEventLite,
} from '../../tools/WorkflowTool/runManifest.js'
import { formatDuration } from '../../utils/format.js'
import { plural } from '../../utils/stringUtils.js'
import { Byline } from '../design-system/Byline.js'
import { KeyboardShortcutHint } from '../design-system/KeyboardShortcutHint.js'
import { Panel, StateBadge, EmptyState } from '../mercury-ui/components.js'
import { GLYPH } from '../mercury-ui/glyphs.js'
import { useSessionAccent } from '../mercury-ui/sessionAccent.js'
import {
  FAINT,
  IVORY,
  SECOND,
  TEAL,
  AMBER,
  CRIMSON,
} from '../mercuryPalette.js'
import { STATE_STYLE, type SnapshotState } from '../mercury-ui/theme.js'

type WorkflowTask = DeepImmutable<LocalWorkflowTaskState>

type Props = {
  workflow: WorkflowTask
  onDone: () => void
  onBack?: () => void
  onKill?: () => void
  onSkipAgent?: (agentId: string) => void
  onRetryAgent?: (agentId: string) => void
}

const MAX_AGENTS_PER_PHASE = 12

export type AgentNode = {
  index: number
  label: string
  state: 'start' | 'progress' | 'done' | 'error' | 'stopped' | 'skipped'
  tokens?: number
  toolCalls?: number
  durationMs?: number
  error?: string
  cached?: boolean
}

export type PhaseGroup = {
  index: number
  title: string
  detail?: string
  model?: string
  planned: boolean
  agents: AgentNode[]
}

export function agentSnapshotState(state: AgentNode['state']): SnapshotState {
  switch (state) {
    case 'done':
      return 'live'
    case 'error':
      return 'failed'
    case 'stopped':
      return 'off'
    case 'skipped':
      return 'excluded'
    case 'progress':
    case 'start':
    default:
      return 'gated'
  }
}

function agentStateLabel(state: AgentNode['state']): string {
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
    case 'start':
    default:
      return 'queued'
  }
}

export function statusTone(status: WorkflowTask['status'] | 'completed_with_failures'): {
  color: string
  word: string
} {
  switch (status) {
    case 'completed':
      return { color: TEAL, word: 'done' }
    case 'completed_with_failures':
      return { color: AMBER, word: 'partial' }
    case 'running':
      return { color: TEAL, word: 'running' }
    case 'pending':
      return { color: AMBER, word: 'pending' }
    case 'paused':
      return { color: AMBER, word: 'paused' }
    case 'failed':
      return { color: CRIMSON, word: 'failed' }
    case 'killed':
      return { color: CRIMSON, word: 'killed' }
    default:
      return { color: FAINT, word: status }
  }
}

export function buildTree(workflow: WorkflowTask): PhaseGroup[] {
  const events = (workflow.workflowProgress ??
    []) as readonly WorkflowProgressEvent[]
  const phaseEvents: WorkflowPhaseEventLite[] = []
  for (const ev of events) {
    if (ev.type === 'workflow_phase') {
      phaseEvents.push({ index: ev.index, title: ev.title || `Phase ${ev.index + 1}` })
    }
  }
  const agents = buildAgentSummaries(events)
  return groupAgentsByPhase(workflow.phases, phaseEvents, agents).map(g => ({
    index: g.index,
    title: g.title,
    detail: g.detail,
    model: g.model,
    planned: g.planned,
    agents: g.agents.map(s => ({
      index: s.index,
      label: s.label,
      state: s.state,
      tokens: s.tokens,
      toolCalls: s.toolCalls,
      durationMs: s.durationMs,
      error: s.error,
      cached: s.cached,
    })),
  }))
}

function AgentMetrics({ agent }: { agent: AgentNode }): React.ReactNode {
  const parts: string[] = []
  if (typeof agent.tokens === 'number' && agent.tokens > 0)
    parts.push(`${agent.tokens.toLocaleString()} tok`)
  if (typeof agent.toolCalls === 'number' && agent.toolCalls > 0)
    parts.push(`${agent.toolCalls} ${plural(agent.toolCalls, 'tool')}`)
  if (typeof agent.durationMs === 'number' && agent.durationMs > 0)
    parts.push(formatDuration(agent.durationMs))
  if (agent.cached) parts.push('cached')
  if (parts.length === 0) return null
  return <Text color={FAINT}> · {parts.join(' · ')}</Text>
}

export function AgentLine({
  agent,
  last,
}: {
  agent: AgentNode
  last: boolean
}): React.ReactNode {
  const tState = agentSnapshotState(agent.state)
  const s = STATE_STYLE[tState]
  const connector = last ? '└─' : '├─'
  return (
    <Box flexDirection="column">
      <Text>
        <Text color={FAINT}>{`  ${connector} `}</Text>
        <Text color={s.color}>{s.glyph} </Text>
        <Text color={agent.state === 'done' ? IVORY : SECOND}>
          {agent.label}
        </Text>
        <Text color={FAINT}> · </Text>
        <Text color={s.color}>{agentStateLabel(agent.state)}</Text>
        <AgentMetrics agent={agent} />
      </Text>
      {agent.state === 'error' && agent.error ? (
        <Text color={CRIMSON}>{`     ${agent.error}`}</Text>
      ) : null}
    </Box>
  )
}

export function PhaseBlock({
  group,
  number,
}: {
  group: PhaseGroup
  number: number
}): React.ReactNode {
  const shown = group.agents.slice(0, MAX_AGENTS_PER_PHASE)
  const hiddenAgents = group.agents.slice(MAX_AGENTS_PER_PHASE)
  const hidden = hiddenAgents.length
  const hiddenErrs = hiddenAgents.filter(a => a.state === 'error')
  const hiddenDone = hiddenAgents.filter(a => a.state === 'done').length
  const settled =
    group.agents.length > 0 &&
    group.agents.every(a => a.state === 'done')
  const errored = group.agents.some(a => a.state === 'error')
  const headColor = group.planned
    ? SECOND
    : errored
      ? CRIMSON
      : settled
        ? TEAL
        : AMBER
  const headGlyph = group.planned
    ? STATE_STYLE.planned.glyph
    : GLYPH.mission
  return (
    <Box flexDirection="column" marginTop={1}>
      <Text>
        <Text color={headColor}>{headGlyph} </Text>
        <Text color={FAINT}>{`${number}. `}</Text>
        <Text bold color={group.planned ? SECOND : IVORY}>
          {group.title}
        </Text>
        {group.model ? <Text color={FAINT}>{`  ${group.model}`}</Text> : null}
        {group.planned ? <Text color={SECOND}> · planned</Text> : null}
      </Text>
      {group.detail ? (
        <Text color={FAINT}>{`     ${group.detail}`}</Text>
      ) : null}
      {group.agents.length === 0 && !group.planned ? (
        <Text color={FAINT}>{'  └─ waiting for agents…'}</Text>
      ) : null}
      {shown.map((a, i) => (
        <AgentLine
          key={a.index}
          agent={a}
          last={i === shown.length - 1 && hidden <= 0}
        />
      ))}
      {hidden > 0 ? (
        <Text>
          <Text color={FAINT}>{`  └─ (+${hidden} more ${plural(hidden, 'agent')}`}</Text>
          {hiddenDone > 0 ? <Text color={FAINT}>{` · ${hiddenDone} done`}</Text> : null}
          {hiddenErrs.length > 0 ? (
            <Text color={CRIMSON}>{` · ${GLYPH.fail} ${hiddenErrs.map(a => `#${a.index}`).join(' ')} ${plural(hiddenErrs.length, 'error')}`}</Text>
          ) : null}
          <Text color={FAINT}>{')'}</Text>
        </Text>
      ) : null}
    </Box>
  )
}

export function WorkflowDetailDialog({
  workflow,
  onDone,
  onBack,
  onKill,
}: Props): React.ReactNode {
  const accent = useSessionAccent().accent
  const isRunning =
    workflow.status === 'running' || workflow.status === 'pending'
  const elapsed = useElapsedTime(
    workflow.startTime,
    isRunning,
    1000,
    0,
    workflow.endTime,
  )

  useKeybindings(
    { 'confirm:yes': onDone, 'confirm:no': onDone },
    { context: 'Confirmation' },
  )
  const handleKeyDown = (e: KeyboardEvent) => {
    if (e.key === 'escape') {
      e.preventDefault()
      onDone()
    } else if (e.key === ' ') {
      e.preventDefault()
      onDone()
    } else if (e.key === 'left' && onBack) {
      e.preventDefault()
      onBack()
    } else if (e.key === 'x' && isRunning && onKill) {
      e.preventDefault()
      onKill()
    }
  }

  const tree = buildTree(workflow)
  const tone = statusTone(workflow.status)
  const name =
    workflow.workflowName ??
    workflow.title ??
    workflow.summary ??
    workflow.description ??
    'Dynamic workflow'

  const headerState: SnapshotState =
    workflow.status === 'completed'
      ? 'live'
      : workflow.status === 'failed' || workflow.status === 'killed'
        ? 'failed'
        : workflow.status === 'running'
          ? 'gated'
          : 'off'

  const metrics: string[] = []
  metrics.push(`${tree.length} ${plural(tree.length, 'phase')}`)
  metrics.push(`${workflow.agentCount} ${plural(workflow.agentCount, 'agent')}`)
  if (workflow.totalTokens > 0)
    metrics.push(`${workflow.totalTokens.toLocaleString()} tok`)
  if (workflow.totalToolCalls > 0)
    metrics.push(
      `${workflow.totalToolCalls} ${plural(workflow.totalToolCalls, 'tool')}`,
    )
  if (workflow.defaultModel) metrics.push(workflow.defaultModel)

  return (
    <Box
      flexDirection="column"
      tabIndex={0}
      autoFocus
      onKeyDown={handleKeyDown}
    >
      {
}
      <Panel title="Workflow">
        <Box flexDirection="column">
          {}
          <Text>
            <Text bold color={accent}>
              {name}
            </Text>
            <Text> </Text>
            <StateBadge state={headerState} label={tone.word} />
          </Text>

          {
}
          <Text color={FAINT}>
            {metrics.join(' · ')} · {elapsed}
          </Text>

          {
}
          {isRunning
            ? (() => {
                const pulse = workflowPulse(
                  workflow.workflowProgress ?? [],
                  workflow.startTime,
                  Date.now(),
                )
                return (
                  <Text>
                    {pulse.moving ? (
                      <>
                        <Text color={TEAL}>{GLYPH.inProgress} moving</Text>
                        <Text color={FAINT}>
                          {' '}— last agent signal {formatQuietAge(pulse.quietMs)} ago
                        </Text>
                      </>
                    ) : (
                      <>
                        <Text color={AMBER}>
                          {GLYPH.inProgress} quiet {formatQuietAge(pulse.quietMs)}
                        </Text>
                        <Text color={FAINT}>
                          {' '}— no agent signal; long turns are normal, x stops it
                        </Text>
                      </>
                    )}
                    <Text color={FAINT}>
                      {pulse.running > 0 ? ` · ${pulse.running} running` : ''}
                      {pulse.maxAttempt > 1 ? ` (attempt ${pulse.maxAttempt})` : ''}
                    </Text>
                  </Text>
                )
              })()
            : null}

          {}
          {tree.length === 0 ? (
            <Box marginTop={1}>
              <EmptyState
                title={
                  isRunning ? 'Starting…' : 'No phases reported'
                }
                hint={
                  isRunning
                    ? 'agents will appear here as the workflow fans out'
                    : undefined
                }
                glyph={GLYPH.pending}
                tone={isRunning ? 'gated' : 'idle'}
              />
            </Box>
          ) : (
            tree.map((g, i) => (
              <PhaseBlock key={g.index} group={g} number={i + 1} />
            ))
          )}

          {}
          {workflow.error ? (
            <Box marginTop={1}>
              <Text color={CRIMSON}>
                {GLYPH.fail} {workflow.error}
              </Text>
            </Box>
          ) : null}
        </Box>
      </Panel>

      {}
      <Box paddingX={1}>
        <Byline>
          {onBack ? (
            <KeyboardShortcutHint shortcut={'←'} action="go back" />
          ) : null}
          <KeyboardShortcutHint shortcut="Esc/Enter/Space" action="close" />
          {isRunning && onKill ? (
            <KeyboardShortcutHint shortcut="x" action="stop" />
          ) : null}
        </Byline>
      </Box>
    </Box>
  )
}
