
import * as path from 'node:path'
import {
  getExecution,
  registerExecution,
  registerExecutionDomain,
  settleExecution,
  transitionExecution,
} from '../primitives/executionPlane.js'
import { recordCanonicalEvidence } from '../primitives/evidencePlane.js'
import { isTerminalExecutionState, type ExecutionState } from '../primitives/execution.js'
import { projectOwner } from '../primitives/owner.js'
import type { OwnerKey } from '../run/ownerKey.js'
import type { ServiceRecord } from './contracts.js'

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
  } catch {
  }
}

export function serviceExecutionDrift(
  cwd: string,
  record: ServiceRecord,
): { planeState: ExecutionState; recordState: string; agree: boolean } | null {
  const planeRecord = getExecution(serviceExecutionOwner(cwd), serviceExecutionId(record.spec.name))
  if (!planeRecord) return null
  return {
    planeState: planeRecord.state,
    recordState: record.state,
    agree: planeRecord.state === record.state,
  }
}

export function installServiceExecutionDomain(hooks: {
  reconcile: (cwd: string, name: string) => ServiceRecord | null
  stop: (cwd: string, name: string) => Promise<unknown>
}): void {
  registerExecutionDomain('service', {
    reconcile: planeRecord => {
      const cwd = planeRecord.spec.cwd
      const name = planeRecord.spec.metadata?.name
      if (!cwd || typeof name !== 'string') return null
      const record = hooks.reconcile(cwd, name)
      if (!record) return { state: 'indeterminate', outcome: { reason: 'service record gone' } }
      return {
        state: record.state as ExecutionState,
        outcome: {
          ...(record.lastExitCode !== null && { code: record.lastExitCode }),
          reason: record.explicitStop ? 'explicit stop' : `service ${record.state}`,
        },
      }
    },
    requestStop: planeRecord => {
      const cwd = planeRecord.spec.cwd
      const name = planeRecord.spec.metadata?.name
      if (!cwd || typeof name !== 'string') return
      void hooks.stop(cwd, name).catch(() => {
      })
    },
  })
}
