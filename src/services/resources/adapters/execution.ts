// resources/adapters/execution — canonical execution records
// Owner-relative resolution:
// an id is looked up against the conversation owner, then the project
// owner (services), then the process main owner (tasks/LSP) — first match
// wins. The plane's honesty floor carries through: a ring-evicted id reads
// `expired`, an unknown id reads `absent`, and record state is never
// re-derived here (Law 5 — the plane record IS the projection source).

import * as path from 'node:path'
import {
  executionExpired,
  getExecution,
  listExecutions,
} from '../../primitives/executionPlane.js'
import { isTerminalExecutionState } from '../../primitives/execution.js'
import type { ExecutionRecord } from '../../primitives/execution.js'
import { projectOwner } from '../../primitives/owner.js'
import { processMainOwner } from '../../run/resolveOwner.js'
import type { OwnerKey } from '../../run/ownerKey.js'
import {
  formatRef,
  type ParsedRef,
  type ResourceAdapter,
  type ResourceChild,
  type ResourceContext,
  type ResourceResult,
} from '../contracts.js'

function candidateOwners(ctx: ResourceContext): OwnerKey[] {
  const owners: OwnerKey[] = [ctx.owner]
  const project = projectOwner(path.resolve(ctx.cwd))
  if (!owners.includes(project)) owners.push(project)
  try {
    const main = processMainOwner()
    if (!owners.includes(main)) owners.push(main)
  } catch {
    /* main owner may not resolve in exotic harnesses — the two above stand */
  }
  return owners
}

function describeRecord(record: ExecutionRecord): string {
  const settled = record.settledAt !== undefined && record.startedAt !== undefined
    ? ` · ${record.settledAt - record.startedAt}ms`
    : ''
  return (
    `${record.spec.kind} · gen ${record.generation} · ${record.state}` +
    (record.outcome?.reason ? ` — ${record.outcome.reason}` : '') +
    settled
  )
}

function recordChildren(record: ExecutionRecord): ResourceChild[] {
  const children: ResourceChild[] = []
  if (record.outputRef) {
    children.push({ ref: record.outputRef, title: 'output', summary: `output → ${record.outputRef}` })
  }
  for (const ref of record.evidenceRefs.slice(-8)) {
    children.push({ ref, title: 'evidence', summary: `evidence → ${ref}` })
  }
  if (record.spec.kind === 'service') {
    const name = record.spec.metadata?.name
    if (typeof name === 'string') {
      children.push({
        ref: formatRef('service', name),
        title: 'domain record',
        summary: 'the service domain record (readiness, logs, spec)',
      })
    }
  }
  return children
}

/**
 * Debug child sessions, projected as children ON READ from the domain's own
 * tree truth (the workflow-worker precedent: standing plane records per
 * child would be a second ledger of what the session registry already
 * owns). One line per live tree member under the root — the root record
 * stays the plane's one debug-adapter row.
 */
async function debugAdapterChildren(record: ExecutionRecord): Promise<ResourceChild[]> {
  if (record.spec.kind !== 'debug-adapter' || isTerminalExecutionState(record.state)) return []
  const alias = record.spec.metadata?.alias
  if (typeof alias !== 'string') return []
  try {
    // Dynamic import: the dap machinery stays off this adapter's static
    // graph (the read pays only when a debug record is actually opened).
    const { getDapSession } = await import('../../dap/dapClient.js')
    const root = getDapSession(record.spec.owner, alias)
    if (!root) return []
    return root
      .treeSessions()
      .filter(s => s !== root)
      .slice(0, 16)
      .map(child => ({
        ref: formatRef('execution', record.spec.id),
        title: `child session '${child.label}'`,
        summary: child.lastStopped
          ? `stopped — ${child.lastStopped.reason}`
          : child.terminated
            ? 'terminated'
            : child.alive
              ? 'running'
              : 'gone',
      }))
  } catch {
    return []
  }
}

export const executionAdapter: ResourceAdapter = {
  kind: 'execution',
  describe:
    'canonical execution records — services, workshop runtimes, tasks, debug/LSP (mercury://execution/<id>)',
  async resolve(ref: ParsedRef, ctx: ResourceContext): Promise<ResourceResult> {
    if (ref.id === '') {
      const children = await this.list!(ctx)
      return {
        state: 'ok',
        resource: {
          ref: 'mercury://execution',
          kind: 'execution',
          title: 'executions',
          summary: `${children.length} record(s) across this conversation, project, and session`,
          mutable: false,
          children,
        },
      }
    }
    for (const owner of candidateOwners(ctx)) {
      const record = getExecution(owner, ref.id)
      if (record) {
        return {
          state: 'ok',
          resource: {
            ref: ref.canonical,
            kind: 'execution',
            title: `${record.spec.label} (${record.state})`,
            summary: describeRecord(record),
            version: `gen ${record.generation}`,
            mutable: !isTerminalExecutionState(record.state),
            children: [...recordChildren(record), ...(await debugAdapterChildren(record))],
            structured: {
              id: record.spec.id,
              kind: record.spec.kind,
              lifecycle: record.spec.lifecycle,
              state: record.state,
              generation: record.generation,
              startedAt: record.startedAt ?? null,
              settledAt: record.settledAt ?? null,
              outcome: record.outcome ?? null,
              externalIdentity: record.externalIdentity ?? null,
            },
          },
        }
      }
    }
    for (const owner of candidateOwners(ctx)) {
      if (executionExpired(owner, ref.id)) {
        return {
          state: 'expired',
          note: `execution '${ref.id}' had records, but bounded retention dropped them (generation memory survives — a new start continues the sequence)`,
        }
      }
    }
    return { state: 'absent', note: `no execution '${ref.id}' for this conversation, project, or session` }
  },
  async list(ctx: ResourceContext): Promise<ResourceChild[]> {
    const seen = new Set<string>()
    const children: ResourceChild[] = []
    for (const owner of candidateOwners(ctx)) {
      for (const record of listExecutions(owner, { limit: 50 })) {
        if (seen.has(record.spec.id)) continue
        seen.add(record.spec.id)
        children.push({
          ref: formatRef('execution', record.spec.id),
          title: record.spec.label,
          summary: describeRecord(record),
        })
      }
    }
    return children.slice(0, 100)
  },
}
