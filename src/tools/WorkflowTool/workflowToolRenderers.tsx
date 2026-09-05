
import * as React from 'react'

import { Text } from '../../ink.js'
import { AMBER, CRIMSON, FAINT, TEAL } from '../../components/mercuryPalette.js'
import { useNowTick } from '../../components/mercury-ui/components.js'
import { GLYPH } from '../../components/mercury-ui/glyphs.js'
import { formatDuration, formatTokens } from '../../utils/format.js'
import { plural } from '../../utils/stringUtils.js'
import { useFocusedWorkRows } from '../../components/tasks/useFocusedWork.js'
import { workRowRuns } from '../../services/engine-connector/workCounts.js'
import { formatQuietAge, workflowPulseAt } from './livePulse.js'

const BROKEN_SCRIPT_PREVIEW_COLS = 80

export type WorkflowResultContent = {
  status?: 'async_launched'
  taskId?: string
  workflowName?: string
  summary?: string
  runId?: string
  warning?: string
  error?: string
}

export type ParsedForRender =
  | { ok: true; description: string }
  | { ok: false }

export function renderWorkflowToolUseMessage(
  input: { name?: string; script?: string },
  verbose: boolean,
  parse: (script: string) => ParsedForRender,
): React.ReactNode {
  if (input.name) return <Text>dynamic workflow: {input.name}</Text>
  if (!input.script) return null
  if (verbose) return <Text>{input.script}</Text>

  const parsed = parse(input.script)
  if (parsed.ok) return <Text>{parsed.description}</Text>

  const scriptLines = input.script.split('\n')
  const headline =
    scriptLines.find(l => l.trim().length > 0) ?? input.script.slice(0, 40)
  const clipped =
    headline.length > BROKEN_SCRIPT_PREVIEW_COLS
      ? `${headline.slice(0, BROKEN_SCRIPT_PREVIEW_COLS - 1)}…`
      : headline
  const tail = scriptLines.length > 1 ? ` · +${scriptLines.length} lines` : ''
  return (
    <Text>
      <Text color={FAINT}>{clipped}</Text>
      {tail ? <Text color={FAINT}>{tail}</Text> : null}
    </Text>
  )
}

export function WorkflowResultLive({ taskId }: { taskId: string }): React.ReactNode {
  const task = useFocusedWorkRows().find(r => r.id === taskId && r.kind === 'workflow')
  const live = task !== undefined && workRowRuns(task)
  const nowMs = useNowTick(live ? 10_000 : null)

  if (!task) {
    return (
      <Text>
        <Text color={TEAL}>/workflows</Text>
        <Text color={FAINT}> to view dynamic workflow runs</Text>
      </Text>
    )
  }

  const settled =
    task.status === 'completed' ||
    task.status === 'failed' ||
    task.status === 'killed'
  if (task.status === 'paused') {
    return (
      <Text>
        <Text color={AMBER}>{GLYPH.fisheye} </Text>
        <Text>Paused · finished agents stay cached · </Text>
        <Text color={TEAL}>/workflows</Text>
        <Text color={FAINT}> → R resumes it</Text>
      </Text>
    )
  }
  if (!settled) {
    const asks = task.pendingAsks ?? 0
    const pulse = task.pulse ? workflowPulseAt(task.pulse, nowMs) : null
    const agentCount = task.agentCount ?? 0
    const totalTokens = task.totalTokens ?? 0
    const clauses: string[] = []
    if (pulse?.phaseTitle) clauses.push(pulse.phaseTitle)
    if (pulse !== null && pulse.running > 0) clauses.push(`${pulse.running} running`)
    else if (agentCount > 0) clauses.push(`${agentCount} ${plural(agentCount, 'agent')}`)
    if (pulse !== null && pulse.maxAttempt > 1) clauses.push(`attempt ${pulse.maxAttempt}`)
    if (totalTokens > 0) clauses.push(`${GLYPH.tokens} ${formatTokens(totalTokens)}`)
    return (
      <Text>
        {asks > 0 ? (
          <>
            <Text color={AMBER}>{GLYPH.inProgress} </Text>
            <Text>Waiting on {asks} permission {plural(asks, 'ask')} · </Text>
          </>
        ) : (
          <>
            <Text color={TEAL}>{GLYPH.inProgress} </Text>
            <Text>Running · </Text>
          </>
        )}
        {clauses.length > 0 ? <Text color={FAINT}>{clauses.join(' · ')} · </Text> : null}
        {
}
        {pulse !== null ? (
          <>
            <Text color={pulse.moving ? FAINT : AMBER}>
              last event {formatQuietAge(pulse.quietMs)} ago
            </Text>
            <Text color={FAINT}> · </Text>
          </>
        ) : null}
        <Text color={TEAL}>/tasks {taskId}</Text>
        <Text color={FAINT}> to inspect</Text>
      </Text>
    )
  }

  const word =
    task.status === 'failed'
      ? 'Failed'
      : task.status === 'killed'
        ? 'Stopped'
        : 'Completed'
  const tone = task.status === 'completed' ? TEAL : CRIMSON
  const elapsed =
    task.endTime && task.startTime
      ? formatDuration(task.endTime - task.startTime)
      : undefined
  const settledAgents = task.agentCount ?? 0
  const settledTokens = task.totalTokens ?? 0
  const clauses: string[] = []
  if (elapsed) clauses.push(`in ${elapsed}`)
  if (settledAgents > 0) clauses.push(`${settledAgents} ${plural(settledAgents, 'agent')}`)
  if (settledTokens > 0) clauses.push(`${formatTokens(settledTokens)} tokens`)
  const tail = clauses.length > 0 ? ` · ${clauses.join(' · ')}` : ''

  return (
    <Text>
      <Text color={tone}>{GLYPH.done} </Text>
      <Text>{word}</Text>
      <Text color={FAINT}>{tail}</Text>
    </Text>
  )
}

export function renderWorkflowResultMessage(
  content: WorkflowResultContent,
): React.ReactNode {
  if (content.error) {
    return (
      <Text>
        <Text color={CRIMSON}>{GLYPH.fail} </Text>
        <Text>{content.error}</Text>
      </Text>
    )
  }
  if (content.taskId) return <WorkflowResultLive taskId={content.taskId} />
  return (
    <Text>
      <Text color={TEAL}>/workflows</Text>
      <Text color={FAINT}> to view dynamic workflow runs</Text>
    </Text>
  )
}
