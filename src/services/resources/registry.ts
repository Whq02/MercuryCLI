// ============================================================================
//  resources/registry — the ONE resolver for mercury:// refs (
// Every consumer — the Inspect tool, UI inspectors, Workshop's
//  mercury.inspect bridge — resolves through here; there is no second
//  ref-to-storage mapping anywhere.
//
//  Built-in adapters register at module init; feature slices that own a
//  durable object
//  register theirs from their own modules so the registry never imports a
//  subsystem that isn't built.
// ============================================================================

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

// TDZ-safe lazy map (the house §DEPS-TDZ class): feature slices register
// their adapters from their own modules, and an import cycle can evaluate
// such a module BEFORE this file's body — so the holder must be `var`
// (hoisted-initialized at instantiation; `let`/`const` would throw
// "cannot access before initialization") and the accessor a hoisted
// function declaration.
// eslint-disable-next-line no-var
var adaptersMap: Map<string, ResourceAdapter> | undefined
function adapters(): Map<string, ResourceAdapter> {
  return (adaptersMap ??= new Map())
}

export function registerResourceAdapter(adapter: ResourceAdapter): void {
  adapters().set(adapter.kind, adapter)
}

export function resourceAdapterKinds(): { kind: string; describe: string }[] {
  return [...adapters().values()]
    .map(a => ({ kind: a.kind, describe: a.describe }))
    .sort((a, b) => a.kind.localeCompare(b.kind))
}

export function getResourceAdapter(kind: string): ResourceAdapter | undefined {
  return adapters().get(kind)
}

/**
 * Resolve a mercury:// ref. Never throws: adapter failures degrade to an
 * explicit 'unavailable' with the error named — a broken adapter must never
 * masquerade as an absent or empty resource.
 */
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

/** Kind-level listing for `mercury://<kind>` refs with no id. */
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

/** TEST-ONLY: adapter census (health fast row + proofs). */
export function _resourceAdapterCountForTesting(): number {
  return adapters().size
}

// ── built-in adapter registration (side-effectful imports, bounded) ─────────
// Feature-owned kinds register from
// their own modules.
import { fileAdapter } from './adapters/file.js'
import { runAdapter } from './adapters/run.js'
import { receiptAdapter } from './adapters/receipt.js'
import { taskAdapter } from './adapters/task.js'
import { teamAdapter } from './adapters/team.js'
import { workflowAdapter } from './adapters/workflow.js'
import { artifactAdapter } from './adapters/artifact.js'
import { healthAdapter, doctorAliasAdapter } from './adapters/health.js'
import { agentAdapter } from './adapters/agent.js'
import { ownerAdapter } from './adapters/owner.js'
import { executionAdapter } from './adapters/execution.js'
import { transactionAdapter } from './adapters/transaction.js'
import { evidenceAdapter } from './adapters/evidence.js'
import { crewAdapter } from './adapters/crew.js'

for (const adapter of [
  fileAdapter,
  runAdapter,
  receiptAdapter,
  taskAdapter,
  teamAdapter,
  workflowAdapter,
  artifactAdapter,
  healthAdapter,
  doctorAliasAdapter,
  agentAdapter,
  ownerAdapter,
  executionAdapter,
  transactionAdapter,
  evidenceAdapter,
  crewAdapter,
]) {
  registerResourceAdapter(adapter)
}
