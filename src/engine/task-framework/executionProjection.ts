import type { TaskState } from '../tasks/taskState.js'
import type { TaskStatus, TaskType } from '../tasks/taskBase.js'
import type { ExecutionKind, ExecutionState } from '../execution-plane/execution.js'
import { projectExternalState } from '../execution-plane/externalProjection.js'
import { processMainOwner } from '../run-owner/resolveOwner.js'

export function taskExecutionKind(type: TaskType): ExecutionKind {
  switch (type) {
    case 'local_bash':
    case 'monitor_mcp':
      return 'background-job'
    case 'local_agent':
    case 'remote_agent':
      return 'agent'
  }
}

export function taskExecutionState(status: TaskStatus): ExecutionState {
  switch (status) {
    case 'pending':
      return 'queued'
    case 'running':
      return 'running'
    case 'completed':
      return 'succeeded'
    case 'failed':
      return 'failed'
    case 'killed':
      return 'stopped'
  }
}

export function projectTaskExecution(task: TaskState): void {
  projectExternalState(
    processMainOwner(),
    {
      id: task.id,
      kind: taskExecutionKind(task.type),
      label: task.description,
      lifecycle: 'session',
      metadata: { taskType: task.type },
    },
    taskExecutionState(task.status),
    { outputRef: `mercury://task/${task.id}` },
  )
}
