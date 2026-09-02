// One-line description of any background task kind: the row body
// the footer and the tasks board share. Each kind derives its line from its
// own state — command, description, @name + activity, workflow roll-up, or
// the consolidation phase — with the shared dim status parenthetical.

import React from 'react'
import { Text } from '../../ink.js'
import type { TaskState } from '../../tasks/types.js'
import type { LocalShellTaskState } from '../../tasks/LocalShellTask/guards.js'
import type { LocalAgentTaskState } from '../../tasks/LocalAgentTask/LocalAgentTask.js'
import type { InProcessTeammateTaskState } from '../../tasks/InProcessTeammateTask/types.js'
import type { LocalWorkflowTaskState } from '../../tasks/LocalWorkflowTask/LocalWorkflowTask.js'
import type { DreamTaskState } from '../../tasks/DreamTask/DreamTask.js'
import { plural } from '../../utils/stringUtils.js'
import { truncateToWidth } from '../mercury-ui/glyphs.js'
import { describeTeammateActivity, teammateRole } from './taskStatusUtils.js'
import { ShellProgress, TaskStatusText } from './ShellProgress.js'

/** Default activity truncation budget; the tasks board raises it. */
const DEFAULT_ACTIVITY_WIDTH = 40

/** Substitute a completion word for the raw status (agent/monitor rows). */
function completionWord(status: string): string {
  return status === 'completed' ? 'done' : status
}

function ShellLine({
  shell,
  width,
}: {
  shell: LocalShellTaskState
  width: number
}): React.ReactNode {
  const body = shell.kind === 'monitor' ? shell.description : shell.command
  return (
    <Text wrap="truncate-end">
      {truncateToWidth(body, width)} <ShellProgress shell={shell} />
    </Text>
  )
}

function AgentLine({
  task,
  width,
}: {
  task: LocalAgentTaskState | (TaskState & { description: string })
  width: number
}): React.ReactNode {
  // Unread: a completed result the operator has not been notified of yet.
  const unread =
    task.status === 'completed' &&
    (task as { retrieved?: boolean }).retrieved !== true
  return (
    <Text wrap="truncate-end">
      {truncateToWidth(task.description, width)}{' '}
      <TaskStatusText
        status={task.status}
        label={completionWord(task.status)}
        suffix={unread ? '· unread' : undefined}
      />
    </Text>
  )
}

function TeammateLine({
  teammate,
}: {
  teammate: InProcessTeammateTaskState
}): React.ReactNode {
  return (
    <Text wrap="truncate-end">
      <Text color={teammateRole(teammate.identity.color)}>
        @{teammate.identity.agentName}
      </Text>
      <Text dimColor>: </Text>
      {describeTeammateActivity(teammate)}
    </Text>
  )
}

function WorkflowLine({
  workflow,
  width,
}: {
  workflow: LocalWorkflowTaskState
  width: number
}): React.ReactNode {
  const name =
    workflow.workflowName ?? workflow.summary ?? workflow.description
  const running = workflow.status === 'running' || workflow.status === 'pending'
  return (
    <Text wrap="truncate-end">
      {truncateToWidth(name, width)}{' '}
      {running ? (
        <Text dimColor>
          ({workflow.agentCount} {plural(workflow.agentCount, 'agent')})
        </Text>
      ) : (
        <TaskStatusText
          status={workflow.status}
          label={completionWord(workflow.status)}
        />
      )}
    </Text>
  )
}

function DreamLine({ task }: { task: DreamTaskState }): React.ReactNode {
  // Detail count: files touched while updating, else sessions under review.
  const detail =
    task.phase === 'updating' && task.filesTouched.length > 0
      ? `${task.filesTouched.length} ${plural(task.filesTouched.length, 'file')}`
      : `${task.sessionsReviewing} ${plural(task.sessionsReviewing, 'session')}`
  return (
    <Text wrap="truncate-end">
      {task.description} <Text dimColor>{task.phase}</Text>{' '}
      <Text dimColor>· {detail}</Text>{' '}
      <TaskStatusText status={task.status} label={completionWord(task.status)} />
    </Text>
  )
}

export function BackgroundTask({
  task,
  maxActivityWidth = DEFAULT_ACTIVITY_WIDTH,
}: {
  task: TaskState
  maxActivityWidth?: number
}): React.ReactNode {
  switch (task.type) {
    case 'local_bash':
      return <ShellLine shell={task} width={maxActivityWidth} />
    case 'local_agent':
      return <AgentLine task={task} width={maxActivityWidth} />
    case 'in_process_teammate':
      return <TeammateLine teammate={task} />
    case 'local_workflow':
      return <WorkflowLine workflow={task} width={maxActivityWidth} />
    case 'dream':
      return <DreamLine task={task} />
    default:
      // MCP monitors (harness-delivered any-typed member) land here.
      return (
        <AgentLine
          task={task as TaskState & { description: string }}
          width={maxActivityWidth}
        />
      )
  }
}
