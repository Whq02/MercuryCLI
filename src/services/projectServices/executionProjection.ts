// ============================================================================
//  projectServices/executionProjection — services on the canonical execution
//  plane.
//
//  ServiceRecord stays the DOMAIN truth (readiness, restart policy, byte
//  cursors, platform stop semantics, durable storage); the execution plane
//  holds the canonical lifecycle projection every cross-domain consumer
//  reads. The projection is driven from serviceManager's ONE record
//  chokepoint (writeRecord) — a service record and its plane record are
//  written by the same call and can never disagree silently (the slice-12
//  doctor row re-checks the invariant).
//
//  Owner model: services are PROJECT-scoped — the owner is
//  projectOwner(cwd), so two sessions in one process project the same
//  service into the same owner, and session disposal never tears down a
//  project service's record.
//
//  Vocabulary: ServiceState ⊂ the Law-3 execution vocabulary verbatim —
//  the mapping is identity (proved in scripts/primitives-kernel/).
// ============================================================================

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

/** The states a plane record may be REGISTERED in (first sighting). */
const REGISTERABLE = new Set<ExecutionState>(['queued', 'starting', 'running', 'ready'])

/**
 * Project one just-written service record into the execution plane. Called
 * from serviceManager.writeRecord — every durable service publication and
 * its plane projection are the same call. Never throws (projection must
 * never break the domain write); projection problems surface through the
 * doctor drift row, not through service operations.
 */
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
      // First sighting of a new service generation.
      if (isTerminalExecutionState(target)) return // settled before we ever saw it live
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
        transitionExecution(owner, id, target) // e.g. first sighting mid-stop
      }
      return
    }

    if (current.state === target) return // readiness/pid refresh, no lifecycle move
    if (isTerminalExecutionState(target)) {
      settleExecution(owner, id, target, { outcome, externalIdentity })
    } else {
      transitionExecution(owner, id, target, { externalIdentity })
      if (target === 'ready') {
        // readiness is an observed check — evidence points
        // at the execution; the per-condition detail stays domain-owned.
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
    /* projection never breaks the domain write; drift is doctor-visible */
  }
}

/** Compare the domain record with its plane projection (doctor drift row +
 *  proofs). null = no live plane record to compare. */
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

// ── domain hooks: the plane's stop + reconcile truth for 'service' ──────────
// Registered lazily by serviceManager (the module that owns the real
// operations) to keep import direction clean.
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
        /* settlement arrives through the domain's own record chain */
      })
    },
  })
}
