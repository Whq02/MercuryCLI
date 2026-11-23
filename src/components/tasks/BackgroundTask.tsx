import React from 'react'
import { Text } from '../../ink.js'
import type { TaskState } from '../../tasks/types.js'
import type { LocalShellTaskState } from '../../tasks/LocalShellTask/guards.js'
import { truncateToWidth } from '../../utils/glyphs.js'
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
  task: TaskState
  width: number
}): React.ReactNode {
  const retrieved = task.type === 'local_agent' && task.retrieved === true
  const unread = task.status === 'completed' && !retrieved
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

export function BackgroundTask({
  task,
  maxActivityWidth = DEFAULT_ACTIVITY_WIDTH,
}: {
  task: TaskState
  maxActivityWidth?: number
}): React.ReactNode {
  if (task.type === 'local_bash') {
    return <ShellLine shell={task} width={maxActivityWidth} />
  }
  return <AgentLine task={task} width={maxActivityWidth} />
}
