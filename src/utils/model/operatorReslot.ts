import { reconfigureSeat } from '../scribe/reconfigureImplementer.js'
import { resolvedScribeModel, scribeSeatEffort } from '../scribe/scribeModelPin.js'
import { isScribeModeOn } from '../scribeMode.js'
import { composeAppliedReceipt, mintImmediateReceipt } from './seatReceipts.js'
import {
  setOperatorSeatSlot,
  type SlotRole,
} from './seatSlots.js'

export type ReslotSessionStore = {
  getState: () => Record<string, unknown>
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  setState: (updater: (prev: any) => any) => void
}

export async function applyOperatorReslot(
  role: SlotRole,
  patch: { model?: string; effort?: string },
  store?: ReslotSessionStore,
): Promise<string> {
  if (role === 'implementer' && isScribeModeOn()) {
    return reconfigureSeat('implementer', patch)
  }
  const saved = setOperatorSeatSlot(role, patch)
  if (!saved.ok) return saved.message
  if (role === 'scribe' && isScribeModeOn()) {
    if (!store) return `${saved.message} — live session unchanged (no store handle); re-engage to apply`
    const model = resolvedScribeModel()
    const effort = scribeSeatEffort()
    store.setState(prev => ({ ...prev, mainLoopModelForSession: model, effortValue: effort }))
    mintImmediateReceipt(composeAppliedReceipt({ role, model, effort: String(effort) }))
    return `${saved.message} · applied to the live Scribe session now`
  }
  return `${saved.message} — applies at the next engage`
}
