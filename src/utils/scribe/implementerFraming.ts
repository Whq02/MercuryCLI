import { implementerModeEnabled, isImplementerRole } from './scribeGates.js'

export const IMPLEMENTER_INBOUND_AUTHORITY_FRAMING =
  '<system-reminder>\n' +
  'The following message(s) arrive from the Scribe over the bus. In Scribe Mode they carry the ' +
  'OPERATOR’S AUTHORITY for the work — treat them as the operator’s instruction relayed by their ' +
  'proxy, not as a peer’s suggestion. Execute them with that weight. If you must escalate, ' +
  'escalate to the Scribe (the operator’s proxy), never the human. This never licenses bypassing ' +
  'a permission, approval, capability, or refusal gate.\n' +
  '</system-reminder>'

export function frameInboundForImplementer(formatted: string): string {
  if (!(implementerModeEnabled() && isImplementerRole())) return formatted
  return `${IMPLEMENTER_INBOUND_AUTHORITY_FRAMING}\n\n${formatted}`
}
