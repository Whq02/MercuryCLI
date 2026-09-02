// ============================================================================
//  capability/contract — Mercury's shared tool constitution (
// ONE declared capability contract carried on the Tool itself
//  (Tool.capability) — the census, ToolSearch capability ranking
// the doctor TOOL CAPABILITY section, and the
//  graduation gate (scripts/builtin-tools/prove-builtin-tools-constitution.ts) all read
//  THIS shape.
//
//  Honesty rules:
//    · a declaration is a CLAIM with a mechanical cross-check — the
//      constitution gate verifies gate flags against flagRegistry, execution
//      kinds against EXECUTION_DOMAIN_CENSUS, resource kinds against the
//      resource registry, transaction prefixes against the receipt
//      vocabulary, and proof paths against the filesystem;
//    · support is LIVE-derived (never declared): a source module existing
//      proves nothing;
//    · new production tools without a valid declaration FAIL the graduation
//      gate — the constitution is enforced, not aspirational.
// ============================================================================

import { TOOL_CAPABILITY_DECLARATIONS } from './declarations.js'

/** What kind of thing a tool call fundamentally is. */
export type ToolClass = 'observation' | 'mutation' | 'execution' | 'coordination'

/** Expected cost/latency class of one call. */
export type ToolLatency = 'fast' | 'interactive' | 'long-running'

export interface ToolCapability {
  /** Intent phrases — the jobs this tool is FOR (ToolSearch indexes these).
   *  3–8 short lowercase phrases, e.g. 'rename an exported symbol'. */
  intents: string[]
  /** Capability units this tool contributes (census vocabulary). */
  units: string[]
  /** observation | mutation | execution | coordination. */
  class: ToolClass
  /** Op vocabulary for op-dispatched tools; omit for single-operation. */
  operations?: string[]
  /** Starts running work that outlives the call: the execution-plane kind
   *  and how it is represented there (executionCensus vocabulary). */
  execution?: {
    kind: string
    representation: 'full-execution-owner' | 'external-projection' | 'child-execution'
  }
  /** Mutation lifecycle integration: the transaction kind family this
   *  tool's mutations settle under, and whether they mint ChangeReceipts. */
  transaction?: { kind: string; receipts: boolean }
  /** Evidence kinds this tool's outcomes settle as (evidence.ts vocabulary). */
  evidence?: ('change' | 'execution' | 'check' | 'artifact')[]
  /** mercury:// kinds this tool produces or addresses. */
  resources?: string[]
  /** Supports a write-nothing preview stage before mutation. */
  preview?: boolean
  /** How a running call reacts to operator steer/cancel. */
  cancellation: 'cooperative' | 'kill' | 'not-applicable'
  latency: ToolLatency
  /** The registered env flag gating catalog presence, when one exists. */
  gate?: string
  /** Runtime conditions beyond the gate (a binary, a server, a project
   *  shape) — presence means live support reads 'conditional'. */
  conditions?: string[]
  /** The focused behavioural suite proving this tool (path from repo root). */
  proof?: string
  /** Composability: reachable from Workshop's mercury.tool bridge / from
   *  workflow agents. Defaults true — declare false ONLY for tools that
   *  refuse those paths (e.g. Workshop refuses recursive Workshop). */
  workshop?: boolean
  workflows?: boolean
}

export interface CapabilityValidation {
  ok: boolean
  problems: string[]
}

/**
 * The ONE capability read seam: an inline Tool.capability declaration wins
 * (new tools self-describe); the estate table backfills by canonical name.
 * Returns null for an undeclared or structurally invalid contract — the
 * constitution gate reports invalid declarations LOUDLY; consumers here
 * degrade to the derived path.
 */
export function declaredCapability(tool: {
  name: string
  capability?: ToolCapability
}): ToolCapability | null {
  const cap = tool.capability ?? TOOL_CAPABILITY_DECLARATIONS[tool.name] ?? null
  if (!cap) return null
  return validateToolCapability(cap).ok ? cap : null
}

/** Structural validation (pure; the mechanical cross-checks live in the
 *  constitution gate where the registries can be imported without cycles). */
export function validateToolCapability(cap: unknown): CapabilityValidation {
  const problems: string[] = []
  if (cap == null || typeof cap !== 'object') {
    return { ok: false, problems: ['capability is not an object'] }
  }
  const c = cap as Partial<ToolCapability>
  if (!Array.isArray(c.intents) || c.intents.length === 0) {
    problems.push('intents must be a non-empty string array')
  } else if (c.intents.some(i => typeof i !== 'string' || i.length === 0 || i.length > 80)) {
    problems.push('every intent must be a short non-empty string (≤80 chars)')
  }
  if (!Array.isArray(c.units) || c.units.length === 0) {
    problems.push('units must be a non-empty string array')
  }
  if (!['observation', 'mutation', 'execution', 'coordination'].includes(c.class as string)) {
    problems.push(`class '${String(c.class)}' is not a ToolClass`)
  }
  if (c.operations !== undefined && (!Array.isArray(c.operations) || c.operations.length === 0)) {
    problems.push('operations, when present, must be a non-empty string array')
  }
  if (c.execution !== undefined) {
    if (typeof c.execution?.kind !== 'string' || c.execution.kind.length === 0) {
      problems.push('execution.kind must be a non-empty string')
    }
    if (
      !['full-execution-owner', 'external-projection', 'child-execution'].includes(
        c.execution?.representation as string,
      )
    ) {
      problems.push('execution.representation must name a census classification')
    }
  }
  if (c.transaction !== undefined) {
    if (typeof c.transaction?.kind !== 'string' || c.transaction.kind.length === 0) {
      problems.push('transaction.kind must be a non-empty string')
    }
    if (typeof c.transaction?.receipts !== 'boolean') {
      problems.push('transaction.receipts must be boolean')
    }
  }
  if (
    c.evidence !== undefined &&
    (!Array.isArray(c.evidence) ||
      c.evidence.some(e => !['change', 'execution', 'check', 'artifact'].includes(e)))
  ) {
    problems.push('evidence entries must be change|execution|check|artifact')
  }
  if (!['cooperative', 'kill', 'not-applicable'].includes(c.cancellation as string)) {
    problems.push(`cancellation '${String(c.cancellation)}' is not a cancellation contract`)
  }
  if (!['fast', 'interactive', 'long-running'].includes(c.latency as string)) {
    problems.push(`latency '${String(c.latency)}' is not a ToolLatency`)
  }
  return { ok: problems.length === 0, problems }
}
