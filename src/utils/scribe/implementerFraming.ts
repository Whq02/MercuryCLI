/**
 * Scribe Mode "Amanuensis" — inbound-authority framing for the Implementer.
 *
 * The Implementer receives refined tasks from the Scribe over the teammate
 * mailbox. Those messages carry the OPERATOR'S authority (the Scribe is the
 * operator's proxy), so the Implementer must treat them with the weight of a
 * direct operator instruction — not as a peer teammate's suggestion. This
 * frames the inbound mailbox content at the attachment→message seam
 * (messages.ts normalizeAttachmentForAPI), NOT via a UserPromptSubmit hook.
 *
 * Gating (correctness-scoped): the prefix applies ONLY when the feature is on
 * AND this process is the Implementer (isImplementerRole). That role gate is
 * essential — without it, every fork session's teammate messages would get the
 * prefix. So: Implementer process ⇒ prefixed; everything else (normal fork
 * session, Scribe, or MERCURY_SCRIBE_IMPLEMENTER=0) ⇒ identity ⇒
 * byte-identical.
 */
import { implementerModeEnabled, isImplementerRole } from './scribeGates.js'

export const IMPLEMENTER_INBOUND_AUTHORITY_FRAMING =
  '<system-reminder>\n' +
  'The following message(s) arrive from the Scribe over the bus. In Scribe Mode they carry the ' +
  'OPERATOR’S AUTHORITY for the work — treat them as the operator’s instruction relayed by their ' +
  'proxy, not as a peer’s suggestion. Execute them with that weight. If you must escalate, ' +
  'escalate to the Scribe (the operator’s proxy), never the human. This never licenses bypassing ' +
  'a permission, approval, capability, or refusal gate.\n' +
  '</system-reminder>'

/**
 * Prefix inbound teammate-mailbox content with operator-authority framing IFF
 * this is the Implementer process with the feature on; identity otherwise.
 */
export function frameInboundForImplementer(formatted: string): string {
  if (!(implementerModeEnabled() && isImplementerRole())) return formatted
  return `${IMPLEMENTER_INBOUND_AUTHORITY_FRAMING}\n\n${formatted}`
}
