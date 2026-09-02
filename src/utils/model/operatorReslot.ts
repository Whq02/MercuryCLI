// ============================================================================
//  operatorReslot — the ONE foreground apply helper for role-seat reslots
// Pickers/boards call this; it routes each role to its
//  owning apply seam — never a second table, never a raw pass-through:
//
//    · the daemon seat ENGAGED (implementer ⇐ scribe mode)
//        → reconfigureSeat (persists the slot, rides the roster's
//          respawn-if-idle-else-queue, registers the receipt expectation).
//    · the LOCAL seat ENGAGED (scribe = THIS session)
//        → persist, then re-pin the live session from the POST-PERSIST
//          resolution (env pins keep winning — display truth), mint the
//          immediate receipt.
//    · anything DISENGAGED → persist only; the saved slot applies at the
//          next engage (the resolvers read it at every spawn/engage seam).
//
//  All validation lives in seatSlots.ts (setOperatorSeatSlot /
//  reconfigureSeat→setOperatorSeatSlot); a refusal returns the honest message
//  and NOTHING changes anywhere.
// ============================================================================
import { reconfigureSeat } from '../scribe/reconfigureImplementer.js'
import { resolvedScribeModel, scribeSeatEffort } from '../scribe/scribeModelPin.js'
import { isScribeModeOn } from '../scribeMode.js'
import { composeAppliedReceipt, mintImmediateReceipt } from './seatReceipts.js'
import {
  setOperatorSeatSlot,
  type SlotRole,
} from './seatSlots.js'

/** Minimal structural AppState store view — keeps this module loadable +
 *  provable under `bun run` with a fake store. */
export type ReslotSessionStore = {
  getState: () => Record<string, unknown>
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  setState: (updater: (prev: any) => any) => void
}

/**
 * Apply an operator reslot for `role`. Returns the one operator-facing line.
 * `store` is required only for the LOCAL live apply (scribe) — the
 * command/picker layer passes its AppState store; omitting it degrades that
 * role to persist-only with an honest note.
 */
export async function applyOperatorReslot(
  role: SlotRole,
  patch: { model?: string; effort?: string },
  store?: ReslotSessionStore,
): Promise<string> {
  // Daemon-hosted seats while their surface is engaged: the reconfigure seam
  // owns persist + expectation + the idle-boundary apply.
  if (role === 'implementer' && isScribeModeOn()) {
    return reconfigureSeat('implementer', patch)
  }
  // Everything else: persist first (validated, fail-closed — refusal = done).
  const saved = setOperatorSeatSlot(role, patch)
  if (!saved.ok) return saved.message
  // LOCAL live applies — this session IS the seat.
  if (role === 'scribe' && isScribeModeOn()) {
    if (!store) return `${saved.message} — live session unchanged (no store handle); re-engage to apply`
    // Re-pin from the POST-PERSIST resolution: an env pin keeps winning (the
    // saved message already names it), and the 1M-context preference rides
    // resolvedScribeModel — display truth = dispatch truth.
    const model = resolvedScribeModel()
    const effort = scribeSeatEffort()
    store.setState(prev => ({ ...prev, mainLoopModelForSession: model, effortValue: effort }))
    mintImmediateReceipt(composeAppliedReceipt({ role, model, effort: String(effort) }))
    return `${saved.message} · applied to the live Scribe session now`
  }
  // Disengaged: the persisted slot IS the outcome — it applies at the next
  // engage through the ONE resolver (spawn specs, engage pins, respawns).
  return `${saved.message} — applies at the next engage`
}
