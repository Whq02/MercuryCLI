// ============================================================================
//  agentResults/ingest — the side-channel that carries a built envelope from
//  an async completion boundary to its sync presentation seam (
// Same WeakMap idiom as FileRead's anchor: no output-schema
//  field, auto-GC'd after rendering, exactly one envelope per data object.
// ============================================================================

import type { AgentResultEnvelope } from './contracts.js'

const envelopes = new WeakMap<object, AgentResultEnvelope>()

export function attachAgentEnvelope(
  data: object,
  envelope: AgentResultEnvelope,
): void {
  envelopes.set(data, envelope)
}

export function envelopeFor(data: object): AgentResultEnvelope | undefined {
  return envelopes.get(data)
}
