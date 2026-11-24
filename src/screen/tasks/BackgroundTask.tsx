import React from 'react'
import { Text } from '../themedRenderer.js'
import type { TaskState } from '../../engine/tasks/taskState.js'
import type { LocalShellTaskState } from '../../engine/tasks/local-shell/shellTaskState.js'
import type { CrewmateTaskState } from '../../engine/tasks/local-agent/crewmateTask.js'
import { truncateToWidth } from '../theme/glyphs.js'
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

function CrewmateLine({
  task,
  width,
}: {
  task: CrewmateTaskState | (TaskState & { description: string })
  width: number
}): React.ReactNode {
  const unread =
    task.status === 'completed' &&
    !(task.type === 'local_agent' && task.retrieved === true)
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
  return <CrewmateLine task={task} width={maxActivityWidth} />
}
