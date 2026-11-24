
import * as path from 'node:path'
import {
  getExecution,
  registerExecution,
  registerExecutionDomain,
  settleExecution,
  transitionExecution,
} from '../../../engine/execution-plane/executionPlane.js'
import { recordCanonicalEvidence } from '../../../engine/runtime-kernel/evidencePlane.js'
import { isTerminalExecutionState, type ExecutionState } from '../../../engine/execution-plane/execution.js'
import { projectOwner } from '../../../engine/execution-plane/owner.js'
import type { OwnerKey } from '../../../engine/run-owner/ownerKey.js'
import type { ServiceRecord } from './contracts.js'
import { errorMessage } from '../../../platform/errors/errors.js'
import { logError } from '../../../platform/logs/errorLog.js'
import { passedOver } from '../../../platform/errors/passedOver.js'
export function serviceExecutionId(name: string): string {
  return `service:${name}`
}

export function serviceExecutionOwner(cwd: string): OwnerKey {
  return projectOwner(path.resolve(cwd))
}

const REGISTERABLE = new Set<ExecutionState>(['queued', 'starting', 'running', 'ready'])

export function projectServiceExecution(cwd: string, record: ServiceRecord): void {
  try {
    const owner = serviceExecutionOwner(cwd)
    const id = serviceExecutionId(record.spec.name)
    const target = record.state as ExecutionState
    const current = getExecution(owner, id)
    const externalIdentity = {
      ...(record.pid !== null && { pid: record.pid }),
      ...(record.startToken !== null && { startToken: record.startToken }),
    }
    const outcome = {
      ...(record.lastExitCode !== null && { code: record.lastExitCode }),
      reason: record.explicitStop ? 'explicit stop' : `service ${record.state}`,
    }

    if (!current || isTerminalExecutionState(current.state)) {
      if (isTerminalExecutionState(target)) return
      const initial = REGISTERABLE.has(target) ? target : 'running'
      const registered = registerExecution({
        owner,
        id,
        kind: 'service',
        label: record.spec.name,
        lifecycle: record.spec.lifecycle === 'project' ? 'project' : 'session',
        cwd,
        ...(record.ownerSessionId !== null && { startedBy: record.ownerSessionId }),
        metadata: { name: record.spec.name, command: record.spec.command },
        externalIdentity,
        initialState: initial as 'queued' | 'starting' | 'running' | 'ready',
      })
      if (target !== registered.state) {
        transitionExecution(owner, id, target)
      }
      return
    }

    if (current.state === target) return
    if (isTerminalExecutionState(target)) {
      settleExecution(owner, id, target, { outcome, externalIdentity })
    } else {
      transitionExecution(owner, id, target, { externalIdentity })
      if (target === 'ready') {
        recordCanonicalEvidence({
          owner,
          kind: 'check',
          origin: 'observed',
          claim: `service ${record.spec.name} readiness met (${record.spec.readinessMode} of ${record.spec.readiness.length} condition(s))`,
          refs: [`mercury://execution/${id}`, `mercury://service/${record.spec.name}`],
          dedupeKey: `service-ready:${record.spec.name}`,
        })
      }
    }
  } catch (error) {
    logError(error)
    passedOver(error)
  }
}

export function installServiceExecutionDomain(hooks: {
  stop: (cwd: string, name: string) => Promise<unknown>
}): void {
  registerExecutionDomain('service', {
    requestStop: planeRecord => {
      const cwd = planeRecord.spec.cwd
      const name = planeRecord.spec.metadata?.name
      if (!cwd || typeof name !== 'string') return
      const recordFailure = (reason: string): void => {
        logError(new Error(`service ${name} stop failed: ${reason}`))
        const latest = getExecution(planeRecord.spec.owner, planeRecord.spec.id)
        if (latest && !isTerminalExecutionState(latest.state)) {
          settleExecution(planeRecord.spec.owner, planeRecord.spec.id, 'indeterminate', {
            outcome: { reason },
          })
        }
      }
      void hooks.stop(cwd, name).then(
        result => {
          if (result && typeof result === 'object' && 'error' in result && typeof (result as { error?: unknown }).error === 'string') {
            recordFailure((result as { error: string }).error)
          }
        },
        error => {
          recordFailure(errorMessage(error))
        },
      )
    },
  })
}
