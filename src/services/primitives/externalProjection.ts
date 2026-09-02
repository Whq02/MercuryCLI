
import {
  isTerminalExecutionState,
  type ExecutionSpec,
  type ExecutionState,
} from './execution.js'
import { canTransitionExecution, legalExecutionTransitions } from './execution.js'
import {
  getExecution,
  registerExecution,
  settleExecution,
  transitionExecution,
  type TransitionOptions,
} from './executionPlane.js'
import type { OwnerKey } from '../run/ownerKey.js'

export interface ExternalProjectionSpec {
  id: string
  kind: ExecutionSpec['kind']
  label: string
  lifecycle: ExecutionSpec['lifecycle']
  cwd?: string
  startedBy?: string
  metadata?: Record<string, unknown>
}

const REGISTERABLE = new Set<ExecutionState>(['queued', 'starting', 'running', 'ready'])

export function projectExternalState(
  owner: OwnerKey,
  spec: ExternalProjectionSpec,
  target: ExecutionState,
  opts: Pick<TransitionOptions, 'outcome' | 'externalIdentity' | 'outputRef'> = {},
): void {
  try {
    const current = getExecution(owner, spec.id)

    if (!current || isTerminalExecutionState(current.state)) {
      if (isTerminalExecutionState(target)) return
      const initial = REGISTERABLE.has(target) ? target : 'running'
      registerExecution({
        owner,
        id: spec.id,
        kind: spec.kind,
        label: spec.label,
        lifecycle: spec.lifecycle,
        ...(spec.cwd !== undefined && { cwd: spec.cwd }),
        ...(spec.startedBy !== undefined && { startedBy: spec.startedBy }),
        ...(spec.metadata !== undefined && { metadata: spec.metadata }),
        ...(opts.externalIdentity !== undefined && { externalIdentity: opts.externalIdentity }),
        ...(opts.outputRef !== undefined && { outputRef: opts.outputRef }),
        initialState: initial as 'queued' | 'starting' | 'running' | 'ready',
      })
      if (target !== initial) {
        transitionExecution(owner, spec.id, target)
      }
      return
    }

    if (current.state === target) return
    const path = legalPath(current.state, target)
    if (!path) return
    for (let i = 0; i < path.length; i++) {
      const step = path[i]!
      const last = i === path.length - 1
      if (last && isTerminalExecutionState(step)) {
        settleExecution(owner, spec.id, step, opts)
      } else {
        transitionExecution(owner, spec.id, step, last ? opts : {})
      }
    }
  } catch {
  }
}

function legalPath(from: ExecutionState, to: ExecutionState): ExecutionState[] | null {
  if (canTransitionExecution(from, to)) return [to]
  const prev = new Map<ExecutionState, ExecutionState>()
  const queue: ExecutionState[] = [from]
  const seen = new Set<ExecutionState>([from])
  while (queue.length > 0) {
    const node = queue.shift()!
    for (const next of legalExecutionTransitions(node)) {
      if (seen.has(next)) continue
      seen.add(next)
      prev.set(next, node)
      if (next === to) {
        const path: ExecutionState[] = [to]
        let cursor: ExecutionState = node
        while (cursor !== from) {
          path.unshift(cursor)
          cursor = prev.get(cursor)!
        }
        return path
      }
      if (!isTerminalExecutionState(next)) queue.push(next)
    }
  }
  return null
}
