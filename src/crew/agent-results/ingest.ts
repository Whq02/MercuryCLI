
import type { CrewmateResultEnvelope } from './contracts.js'

const envelopes = new WeakMap<object, CrewmateResultEnvelope>()

export function attachCrewmateEnvelope(
  data: object,
  envelope: CrewmateResultEnvelope,
): void {
  envelopes.set(data, envelope)
}

export function envelopeFor(data: object): CrewmateResultEnvelope | undefined {
  return envelopes.get(data)
}
