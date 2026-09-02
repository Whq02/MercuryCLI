// ============================================================================
//  slotSwitchReceipt — THE DURABLE SWITCH RECEIPT (FN-016 R20).
//
//  A slot flip — accepted on the offer card, performed unattended by the
//  auto posture, or pressed in the /model picker — used to speak once: a
//  footer notification that truncated to the strip's width and expired in
//  eight seconds (the picker's arm: a notice that died with the picker).
//  Nothing in the transcript said which account the session now rides.
//
//  The receipt now lands as ONE transcript row through the chat's
//  display-row door (the screen's own paintScreenRow pattern: display-only,
//  painted after the records on hand, never written to the file), as the
//  seat_receipt subtype — the visible-receipt row that renders above the
//  verbose gate, because a receipt must never be quiet. The footer keeps
//  the transient — the receipt's first clause (slotSwitchTransient) — while
//  the whole sentence lives in the row. A chat without the door keeps the
//  footer as the whole record.
// ============================================================================
import { getFocusedSessionConnector } from '../../services/engine-connector/focusedConnector.js'
import type { SlotSwitchOutcome } from '../../services/providers/slotSwitch.js'
import type { Message } from '../../types/message.js'
import { createSeatReceiptMessage } from '../messages/systemMessages.js'

/** Paint the switch receipt as a transcript row; false when the focused
 *  chat has no display-row door (the caller then keeps the whole receipt in
 *  its own transient). A refusal is a warning-level row: a flip was asked
 *  for and did not happen, and the reason must stand where it can be read. */
export function paintSlotSwitchReceipt(outcome: SlotSwitchOutcome): boolean {
  const focused = getFocusedSessionConnector() as { addDisplayRow?: (row: Message) => void }
  if (typeof focused.addDisplayRow !== 'function') return false
  focused.addDisplayRow(createSeatReceiptMessage(outcome.receipt, outcome.switched ? 'info' : 'warning'))
  return true
}
