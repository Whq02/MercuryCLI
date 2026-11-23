import { getFocusedSessionConnector } from '../../engine/connector/focusedConnector.js'
import type { SlotSwitchOutcome } from './slotSwitch.js'
import { createSeatReceiptMessage } from '../../engine/message-shapes/systemMessages.js'

export function paintSlotSwitchReceipt(outcome: SlotSwitchOutcome): boolean {
  const focused = getFocusedSessionConnector()
  if (focused.addDisplayRow === undefined) return false
  focused.addDisplayRow(createSeatReceiptMessage(outcome.receipt, outcome.switched ? 'info' : 'warning'))
  return true
}
