
import React from 'react'
import { Text } from '../../ink.js'
import type { TaskState } from '../../tasks/types.js'
import type { LocalShellTaskState } from '../../tasks/LocalShellTask/guards.js'
import type { LocalAgentTaskState } from '../../tasks/LocalAgentTask/LocalAgentTask.js'
import type { LocalWorkflowTaskState } from '../../tasks/LocalWorkflowTask/LocalWorkflowTask.js'
import { plural } from '../../utils/stringUtils.js'
import { truncateToWidth } from '../mercury-ui/glyphs.js'
import { ShellProgress, TaskStatusText } from './ShellProgress.js'

const DEFAULT_ACTIVITY_WIDTH = 40

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
    case 'local_workflow':
      return <WorkflowLine workflow={task} width={maxActivityWidth} />
    default:
      return (
        <AgentLine
          task={task as TaskState & { description: string }}
          width={maxActivityWidth}
        />
      )
  }
}
