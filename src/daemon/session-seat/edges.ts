import type { SessionAppliedParams } from '../runner-wire/methods.js'
import { requestSessionFacts, publishSeatFacts } from './facts.js'
import { type SeatRosterPort, liveRecordByShort, seatOf } from './state.js'
import { forwardModel, landModel } from './model.js'
import { forwardEffort, landEffort } from './effort.js'
import { drainPendingKitDials } from './kit.js'
import { drainPendingSpawnSwitches, dropHeldSpawnSwitch, landSpawnSwitchOnRecord } from './spawnSwitch.js'

export function onSeatApplied(short: string, params: SessionAppliedParams, roster: SeatRosterPort, dir?: string): void {
  onSeatVerbApplied(short, params, roster, dir)
  requestSessionFacts(short, roster, { immediate: true }, dir)
}

export function onSeatIdle(short: string, roster: SeatRosterPort, dir?: string): void {
  const rec = liveRecordByShort(short, dir)
  if (!rec) return
  const seat = seatOf(short)
  const parkedModel = rec.pendingModelKey !== undefined && seat.heldModel === null ? rec.pendingModelKey : undefined
  const parkedEffort = rec.pendingEffort !== undefined && seat.heldEffort === null ? rec.pendingEffort : undefined
  console.error(`[daemon] seat idle edge: ${short}${parkedModel !== undefined ? ` — applying the parked model ${parkedModel}` : ''}${parkedEffort !== undefined ? ` — applying the parked effort ${parkedEffort}` : ''}`)
  if (parkedModel !== undefined) void forwardModel(rec, parkedModel, roster, dir, { parked: true, settle: true })
  if (parkedEffort !== undefined) void forwardEffort(rec, parkedEffort, roster, dir, { parked: true })
  drainPendingKitDials(short, roster, dir)
  drainPendingSpawnSwitches(short, roster, dir)
  publishSeatFacts(short, dir, roster)
  requestSessionFacts(short, roster, { immediate: true }, dir)
}

function onSeatVerbApplied(short: string, frame: SessionAppliedParams, roster: SeatRosterPort, dir?: string): void {
  const rec = liveRecordByShort(short, dir)
  if (!rec) return
  const seat = seatOf(short)
  if (frame.verb === 'set_model') {
    const held = seat.heldModel !== null && seat.heldModel.requestId === frame.request_id ? seat.heldModel : null
    const model = held !== null ? held.model : frame.model !== undefined && rec.pendingModelKey === frame.model ? frame.model : undefined
    if (model === undefined) return
    if (held !== null) seat.heldModel = null
    const served = frame.model !== undefined && frame.model !== '' ? frame.model : undefined
    landModel(rec, model, roster, dir, rec.pendingModelKey === model, served)
    return
  }
  if (frame.verb === 'set_spawn_switch') {
    const kind = frame.switch
    const on = frame.on
    if (kind !== 'subagents' || typeof on !== 'boolean') return
    const heldToggle = seat.heldSpawnSwitches[kind]
    const known = heldToggle !== undefined ? heldToggle.requestId === frame.request_id : (rec.pendingSpawnSwitches ?? []).some(p => p.kind === kind && p.on === on)
    if (!known) return
    if (heldToggle !== undefined) dropHeldSpawnSwitch(seat, kind, heldToggle.requestId)
    landSpawnSwitchOnRecord(rec, { kind, on }, roster, dir, true)
    return
  }
  const held = seat.heldEffort !== null && seat.heldEffort.requestId === frame.request_id ? seat.heldEffort : null
  const effort = held !== null ? held.effort : frame.effort !== undefined && rec.pendingEffort === frame.effort ? frame.effort : undefined
  if (effort === undefined) return
  if (held !== null) seat.heldEffort = null
  landEffort(rec, effort, roster, dir)
}
