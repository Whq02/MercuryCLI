import { logForDebugging } from '../../platform/logs/debugLog.js'
import { SESSION_VERBS } from '../runner-wire/sessionVerbs.js'
import { updateConcourseWorkers, type ConcourseWorkerRecordV1 } from '../concourse-workers/concourseWorkers.js'
import { PeerClosed } from '../runner-wire/peer.js'
import { spawnSwitchOfRecord, spawnSwitchToggleReceipt, type SpawnSwitchKind, SPAWN_SWITCH_KINDS } from '../switchboard/spawnSwitches.js'
import { liveRecordBySession, seatBusy, type SeatRosterPort, type SeatState, seatOf, liveRecordByShort } from './state.js'
import { publishSeatFacts, requestSessionFacts } from './facts.js'
import { type SeatVerbOutcome, SEAT_VERB_ANSWER_DEADLINE_MS, doorFailureOf, runnerAnswered, seatVerbAnswerOf } from './door.js'

export async function setSessionSpawnSwitch(
  sessionId: string,
  toggle: { kind: SpawnSwitchKind; on: boolean },
  by: string,
  roster: SeatRosterPort,
  dir?: string,
): Promise<SeatVerbOutcome> {
  const rec = liveRecordBySession(sessionId, dir)
  if (!rec) return { outcome: 'refused', detail: 'unknown-session: no live worker record owns this session' }
  const parkedForKind = (rec.pendingSpawnSwitches ?? []).filter(p => p.kind === toggle.kind)
  const parked = parkedForKind[parkedForKind.length - 1]
  const effectiveOn = parked !== undefined ? parked.on : spawnSwitchOfRecord(rec, toggle.kind).on
  if (effectiveOn === toggle.on) return { outcome: 'noop', detail: spawnSwitchToggleReceipt(toggle.kind, toggle.on, 'noop') }
  if (seatBusy(rec.runnerId, roster)) {
    parkSpawnSwitch(rec, toggle, by, dir)
    console.error(`[daemon] seat ${SESSION_VERBS.setSpawnSwitch.daemon.action} parked (the session is mid-turn): ${rec.runnerId} → ${toggle.kind} ${toggle.on ? 'on' : 'off'}`)
    publishSeatFacts(rec.runnerId, dir, roster)
    return forwardSpawnSwitchToBoundary(rec, toggle, by, roster, dir, { parked: true })
  }
  return forwardSpawnSwitchToBoundary(rec, toggle, by, roster, dir, { parked: false })
}

function parkSpawnSwitch(rec: ConcourseWorkerRecordV1, toggle: { kind: SpawnSwitchKind; on: boolean }, by: string, dir?: string): void {
  updateConcourseWorkers(workers => {
    const w = workers[rec.runnerId]
    if (w && w.endedAt === undefined) {
      w.pendingSpawnSwitches = [...(w.pendingSpawnSwitches ?? []).filter(p => p.kind !== toggle.kind), { kind: toggle.kind, on: toggle.on, by }]
    }
  }, dir)
}

function unparkSpawnSwitch(rec: ConcourseWorkerRecordV1, kind: SpawnSwitchKind, dir?: string): void {
  updateConcourseWorkers(workers => {
    const w = workers[rec.runnerId]
    if (!w || w.endedAt !== undefined) return
    const rest = (w.pendingSpawnSwitches ?? []).filter(p => p.kind !== kind)
    if (rest.length > 0) w.pendingSpawnSwitches = rest
    else delete w.pendingSpawnSwitches
  }, dir)
}

export function dropHeldSpawnSwitch(seat: SeatState, kind: SpawnSwitchKind, requestId: number): void {
  const held = seat.heldSpawnSwitches[kind]
  if (held === undefined || held.requestId !== requestId) return
  const rest: SeatState['heldSpawnSwitches'] = { ...seat.heldSpawnSwitches }
  delete rest[kind]
  seat.heldSpawnSwitches = rest
}

async function forwardSpawnSwitchToBoundary(
  rec: ConcourseWorkerRecordV1,
  toggle: { kind: SpawnSwitchKind; on: boolean },
  by: string,
  roster: SeatRosterPort,
  dir: string | undefined,
  opts: { parked: boolean },
): Promise<SeatVerbOutcome> {
  const queued: SeatVerbOutcome = { outcome: 'queued', detail: spawnSwitchToggleReceipt(toggle.kind, toggle.on, 'queued') }
  const door = roster.door(rec.runnerId)
  if (door === undefined || door.closed) return opts.parked ? queued : landSpawnSwitchOnRecord(rec, toggle, roster, dir, false)
  const sent = door.send(SESSION_VERBS.setSpawnSwitch.runner.name, { switch: toggle.kind, on: toggle.on }, { deadlineMs: SEAT_VERB_ANSWER_DEADLINE_MS })
  const seat = seatOf(rec.runnerId)
  seat.heldSpawnSwitches = { ...seat.heldSpawnSwitches, [toggle.kind]: { requestId: sent.id, on: toggle.on } }
  const asked = await sent.answer.then(result => ({ ok: true as const, result, id: sent.id }), (error: unknown) => ({ ok: false as const, failure: doorFailureOf(error, 'spawn-switch', SEAT_VERB_ANSWER_DEADLINE_MS), id: sent.id }))
  if (runnerAnswered(asked)) requestSessionFacts(rec.runnerId, roster, { immediate: true }, dir)
  const word = seatVerbAnswerOf(asked)
  if ('at' in word && word.at === 'turn_end') {
    if (!opts.parked) {
      parkSpawnSwitch(rec, toggle, by, dir)
      publishSeatFacts(rec.runnerId, dir, roster)
    }
    logForDebugging(`[daemon] seat ${SESSION_VERBS.setSpawnSwitch.daemon.action} held by the runner for its turn boundary: ${rec.runnerId} → ${toggle.kind} ${toggle.on ? 'on' : 'off'}`)
    return queued
  }
  dropHeldSpawnSwitch(seat, toggle.kind, sent.id)
  if ('refused' in word) {
    if (opts.parked) {
      unparkSpawnSwitch(rec, toggle.kind, dir)
      publishSeatFacts(rec.runnerId, dir, roster)
    }
    return { outcome: 'refused', detail: spawnSwitchToggleReceipt(toggle.kind, toggle.on, 'refused', word.refused) }
  }
  if ('silent' in word && opts.parked) return queued
  return landSpawnSwitchOnRecord(rec, toggle, roster, dir, true)
}

export function landSpawnSwitchOnRecord(
  rec: ConcourseWorkerRecordV1,
  toggle: { kind: SpawnSwitchKind; on: boolean },
  roster: SeatRosterPort,
  dir: string | undefined,
  delivered: boolean,
): SeatVerbOutcome {
  updateConcourseWorkers(workers => {
    const w = workers[rec.runnerId]
    if (!w || w.endedAt !== undefined) return
    w.spawnSwitches = { ...(w.spawnSwitches ?? {}), [toggle.kind]: toggle.on ? 'on' : 'off' }
    const rest = (w.pendingSpawnSwitches ?? []).filter(p => p.kind !== toggle.kind)
    if (rest.length > 0) w.pendingSpawnSwitches = rest
    else delete w.pendingSpawnSwitches
  }, dir)
  console.error(`[daemon] seat ${SESSION_VERBS.setSpawnSwitch.daemon.action} applied: ${rec.runnerId} → ${toggle.kind} ${toggle.on ? 'on' : 'off'}${delivered ? '' : ' (no live runner door; the record holds it)'}`)
  publishSeatFacts(rec.runnerId, dir, roster)
  requestSessionFacts(rec.runnerId, roster, { immediate: true }, dir)
  const receipt = spawnSwitchToggleReceipt(toggle.kind, toggle.on, 'applied')
  return delivered
    ? { outcome: 'applied', detail: receipt }
    : { outcome: 'applied', detail: `${receipt} — no live runner door; the record holds the switch and the session's next boot applies it` }
}

function forwardSpawnSwitch(short: string, toggle: { kind: SpawnSwitchKind; on: boolean }, roster: SeatRosterPort): boolean {
  const door = roster.door(short)
  if (door === undefined || door.closed) return false
  door.request(SESSION_VERBS.setSpawnSwitch.runner.name, { switch: toggle.kind, on: toggle.on }, { deadlineMs: SEAT_VERB_ANSWER_DEADLINE_MS }).catch((error: unknown) => {
    if (!(error instanceof PeerClosed)) logForDebugging(`[daemon] seat spawn-switch re-forward for ${short}: ${error instanceof Error ? error.message : String(error)}`)
  })
  return true
}

export function forwardRecordSpawnSwitches(short: string, roster: SeatRosterPort, dir?: string): void {
  const rec = liveRecordByShort(short, dir)
  if (!rec?.spawnSwitches) return
  for (const kind of SPAWN_SWITCH_KINDS) {
    const held = rec.spawnSwitches[kind]
    if (held !== undefined) forwardSpawnSwitch(short, { kind, on: held === 'on' }, roster)
  }
}

export function drainPendingSpawnSwitches(short: string, roster: SeatRosterPort, dir?: string): void {
  const rec = liveRecordByShort(short, dir)
  if (!rec) return
  const seat = seatOf(short)
  const parked = (rec.pendingSpawnSwitches ?? []).flatMap(p => (p.kind === 'subagents' && seat.heldSpawnSwitches[p.kind] === undefined ? [{ ...p, kind: p.kind }] : []))
  if (parked.length === 0) return
  console.error(`[daemon] seat ${SESSION_VERBS.setSpawnSwitch.daemon.action} applying ${parked.length} parked toggle${parked.length === 1 ? '' : 's'} at the turn's end: ${short}`)
  for (const entry of parked) {
    const fresh = liveRecordByShort(short, dir)
    if (fresh) void forwardSpawnSwitchToBoundary(fresh, { kind: entry.kind, on: entry.on }, entry.by, roster, dir, { parked: true })
  }
}
