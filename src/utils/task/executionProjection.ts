import type { TaskState } from '../../tasks/types.js'
import type { TaskStatus, TaskType } from '../../Task.js'
import type { ExecutionKind, ExecutionState } from '../primitives/execution.js'
import { projectExternalState } from '../primitives/externalProjection.js'
import { processMainOwner } from '../run/resolveOwner.js'
import { notBuilt } from '../../pi/holes.js'

export function taskExecutionKind(type: TaskType): ExecutionKind {
  return notBuilt('src/utils/task/executionProjection.ts:8')
}

export function taskExecutionState(status: TaskStatus): ExecutionState {
  return notBuilt('src/utils/task/executionProjection.ts:19')
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
