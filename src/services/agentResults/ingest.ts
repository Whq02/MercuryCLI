
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
