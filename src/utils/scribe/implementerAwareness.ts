// ============================================================================
//  implementerAwareness — the per-turn Implementer-side awareness <system-reminder>.
// ----------------------------------------------------------------------------
//  The symmetric twin of scribeAwareness (W3c): the static pack (implementerPack.ts)
//  bakes in WHO the Implementer is at spawn; this carries the DYNAMIC per-turn
//  discipline. The forensics found the Implementer had NO runtime awareness layer at
//  all (only the Scribe did) — so it was never nudged that (a) it gets ONE bus message
//  per turn, (b) its typed prose reaches no one, (c) a send is not a receipt, (d) a
//  respawn is normal and it must not re-send a pre-restart status. Those gaps are the
//  Implementer half of the double-text / self-unaware / hallucination class.
//
//  Returns RAW content (no <system-reminder> envelope) — the attachment normalizer
//  (messages.ts case 'implementer_awareness') wraps it once via wrapMessagesInSystemReminder.
//
//  Role-gated like scribeAwareness: returns '' (⇒ no attachment ⇒ byte-identical)
//  unless this is the daemon-spawned Implementer process with implementer mode on. The
//  AND is essential — implementerModeEnabled() alone is Mercury-wide; isImplementerRole()
//  (MERCURY_IMPLEMENTER==='1', set only by the daemon spawn) scopes it to the Implementer.
//  Pure + side-effect-free so it is unit-testable under `bun run`.
// ============================================================================
import {
  implementerModeEnabled,
  isImplementerRole,
  scribeChatroomEnabled,
} from './scribeGates.js'

/**
 * Build the Implementer awareness reminder CONTENT for this turn, or '' when this is
 * not the Implementer process / implementer mode is off (⇒ no attachment ⇒ byte-identical).
 */
export function buildImplementerAwarenessReminder(_messages: readonly unknown[]): string {
  if (!(implementerModeEnabled() && isImplementerRole())) return ''

  // Chatroom (default-ON, opt out MERCURY_SCRIBE_CHATROOM=0) renders each envelope
  // DIRECTLY to the operator as a [Mercury-Implement] line, so the "(who relays)"
  // self-model is stale there. Reuse the EXACT same gate the Scribe side uses.
  const chatroom = scribeChatroomEnabled()

  const parts: string[] = [
    // (a) one bus message per turn — the anti-double rule (the relay renders each
    //     envelope as its own [Mercury-Implement] line, so a second one is a double).
    'Your turn produces AT MOST ONE bus message: a single `progress` OR a single `escalate`, never both and never ' +
      'two progress lines. Batch this turn’s phase-status into that one line; a turn with nothing new sends NOTHING ' +
      '(silent work between checkpoints is correct). An escalate REPLACES the progress that turn — it never stacks on it.',
    // (b) no INBOUND operator channel — the self-awareness the Implementer lacked.
    //     Outbound rendering is surface-aware: chatroom renders the envelope directly
    //     to the operator; default mode relays it through the Scribe.
    chatroom
      ? 'You have NO inbound operator channel and cannot be addressed directly: prose you type into your turn is seen ' +
        'by NO ONE. But your `SendMessage` envelope renders DIRECTLY to the operator as a `[Mercury-Implement]` line ' +
        '(and to the Scribe) — so write each one so the operator reads it as-is; put what matters there, and never ' +
        'assume typed prose was read.'
      : 'You have NO operator channel and NO chat: prose you type into your turn is seen by NO ONE. ONLY your ' +
        '`SendMessage` envelope reaches the Scribe (who relays to the operator). So put what matters in the one ' +
        'envelope — never assume typed prose was read.',
    // (c) write != receipt — the hallucination guard, mirrored from the Scribe side.
    'A SEND is WRITTEN to the bus; it is NOT proof the Scribe received or acted on it. Do NOT re-send the same ' +
      'status, and never narrate or invent the Scribe’s reply — if nothing has come back, nothing has come back.',
    // (d) respawn is normal — the anti-re-narrate rule for a fresh transcript.
    'A respawn / fresh transcript is NORMAL (the supervisor restarts or reconfigures you) — re-orient from disk and ' +
      'your inbox, and do NOT re-narrate or re-send a status you may have already sent before the restart. (This is ' +
      'about your OWN progress messages; the at-least-once EXECUTION dedup of dispatched work is separate.)',
  ]
  return parts.join('\n\n')
}
