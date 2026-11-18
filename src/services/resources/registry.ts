
import { logForDebugging } from '../../utils/debug.js'
import {
  mercuryRefsEnabled,
  parseMercuryRef,
  type ParsedRef,
  type ResourceAdapter,
  type ResourceChild,
  type ResourceContext,
  type ResourceResult,
} from './contracts.js'
import { fileAdapter } from './adapters/file.js'
import { runAdapter } from './adapters/run.js'
import { receiptAdapter } from './adapters/receipt.js'
import { taskAdapter } from './adapters/task.js'
import { artifactAdapter } from './adapters/artifact.js'
import { healthAdapter } from './adapters/health.js'
import { agentAdapter } from './adapters/agent.js'
import { ownerAdapter } from './adapters/owner.js'
import { executionAdapter } from './adapters/execution.js'
import { transactionAdapter } from './adapters/transaction.js'
import { evidenceAdapter } from './adapters/evidence.js'
import { seatAdapter } from './adapters/seat.js'
import { modelsAdapter } from './adapters/models.js'

var adaptersMap: Map<string, ResourceAdapter> | undefined
function adapters(): Map<string, ResourceAdapter> {
  return (adaptersMap ??= new Map(
    [
      fileAdapter,
      runAdapter,
      receiptAdapter,
      taskAdapter,
      artifactAdapter,
      healthAdapter,
      agentAdapter,
      ownerAdapter,
      executionAdapter,
      transactionAdapter,
      evidenceAdapter,
      seatAdapter,
      modelsAdapter,
      ...(require('./kinds.js') as typeof import('./kinds.js')).resourceKinds(),
    ].map((adapter): [string, ResourceAdapter] => [adapter.kind, adapter]),
  ))
}

export async function settleResourceKinds(): Promise<void> {
  await import('./kinds.js')
}

export function resourceAdapterKinds(): { kind: string; describe: string }[] {
  return [...adapters().values()]
    .map(a => ({ kind: a.kind, describe: a.describe }))
    .sort((a, b) => a.kind.localeCompare(b.kind))
}

export function getResourceAdapter(kind: string): ResourceAdapter | undefined {
  return adapters().get(kind)
}

export async function resolveResource(
  raw: string,
  ctx: ResourceContext,
): Promise<ResourceResult & { parsed?: ParsedRef }> {
  if (!mercuryRefsEnabled()) {
    return { state: 'unavailable', note: 'the resource plane is disabled (MERCURY_REFS=0)' }
  }
  const parsed = parseMercuryRef(raw)
  if (!parsed) {
    return {
      state: 'absent',
      note: `not a valid mercury:// ref: '${raw}' — the grammar is mercury://<kind>/<id>[?lines=A-B&q=…&cursor=N&limit=N&child=name]`,
    }
  }
  const adapter = adapters().get(parsed.kind)
  if (!adapter) {
    const kinds = resourceAdapterKinds().map(k => k.kind).join(', ')
    return {
      state: 'absent',
      note: `unknown resource kind '${parsed.kind}' — known kinds: ${kinds}`,
      parsed,
    }
  }
  try {
    const result = await adapter.resolve(parsed, ctx)
    return { ...result, parsed }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    logForDebugging(`resources: adapter '${parsed.kind}' threw: ${msg}`)
    return {
      state: 'unavailable',
      note: `the '${parsed.kind}' adapter failed: ${msg.slice(0, 200)}`,
      parsed,
    }
  }
}

export async function listResourceKind(
  kind: string,
  ctx: ResourceContext,
): Promise<{ state: 'ok'; children: ResourceChild[] } | { state: 'unavailable'; note: string }> {
  const adapter = adapters().get(kind)
  if (!adapter?.list) {
    return { state: 'unavailable', note: `kind '${kind}' has no listing` }
  }
  try {
    return { state: 'ok', children: await adapter.list(ctx) }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return { state: 'unavailable', note: `listing '${kind}' failed: ${msg.slice(0, 200)}` }
  }
}

export function _resourceAdapterCountForTesting(): number {
  return adapters().size
}
