
import { TOOL_CAPABILITY_DECLARATIONS } from './declarations.js'

export type ToolClass = 'observation' | 'mutation' | 'execution' | 'coordination'

export type ToolLatency = 'fast' | 'interactive' | 'long-running'

export interface ToolCapability {
  intents: string[]
  units: string[]
  class: ToolClass
  operations?: string[]
  execution?: {
    kind: string
    representation: 'full-execution-owner' | 'external-projection' | 'child-execution'
  }
  transaction?: { kind: string; receipts: boolean }
  evidence?: ('change' | 'execution' | 'check' | 'artifact')[]
  resources?: string[]
  preview?: boolean
  cancellation: 'cooperative' | 'kill' | 'not-applicable'
  latency: ToolLatency
  gate?: string
  conditions?: string[]
  proof?: string
  workshop?: boolean
  workflows?: boolean
}

export interface CapabilityValidation {
  ok: boolean
  problems: string[]
}

export function declaredCapability(tool: {
  name: string
  capability?: ToolCapability
}): ToolCapability | null {
  const cap = tool.capability ?? TOOL_CAPABILITY_DECLARATIONS[tool.name] ?? null
  if (!cap) return null
  return validateToolCapability(cap).ok ? cap : null
}

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
