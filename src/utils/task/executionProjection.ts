
import type { TaskState } from '../../tasks/types.js'
import type { TaskStatus, TaskType } from '../../Task.js'
import type { ExecutionKind, ExecutionState } from '../../services/primitives/execution.js'
import { projectExternalState } from '../../services/primitives/externalProjection.js'
import { processMainOwner } from '../../services/run/resolveOwner.js'

export function taskExecutionKind(type: TaskType): ExecutionKind {
  switch (type) {
    case 'local_bash':
    case 'monitor_mcp':
      return 'background-job'
    case 'local_workflow':
      return 'workflow-worker'
    case 'local_agent':
    case 'remote_agent':
    case 'in_process_teammate':
    case 'dream':
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
