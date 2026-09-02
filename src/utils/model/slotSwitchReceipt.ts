import { getFocusedSessionConnector } from '../../services/engine-connector/focusedConnector.js'
import type { SlotSwitchOutcome } from '../../services/providers/slotSwitch.js'
import type { Message } from '../../types/message.js'
import { createSeatReceiptMessage } from '../messages/systemMessages.js'

export function paintSlotSwitchReceipt(outcome: SlotSwitchOutcome): boolean {
  const focused = getFocusedSessionConnector() as { addDisplayRow?: (row: Message) => void }
  if (typeof focused.addDisplayRow !== 'function') return false
  focused.addDisplayRow(createSeatReceiptMessage(outcome.receipt, outcome.switched ? 'info' : 'warning'))
  return true
}
