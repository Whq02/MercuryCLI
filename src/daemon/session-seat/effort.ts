import { logForDebugging } from '../../platform/logs/debugLog.js'
import { SESSION_VERBS } from '../runner-wire/sessionVerbs.js'
import { normalizeEffortLevelString, EFFORT_LEVELS } from '../../models/effort/effort.js'
import { updateConcourseWorkers, type ConcourseWorkerRecordV1 } from '../concourse-workers/concourseWorkers.js'
import { publishSeatFacts, requestSessionFacts } from './facts.js'
import { type SeatRosterPort, seatOf, liveRecordBySession, seatBusyForSwitch } from './state.js'
import { NO_DOOR_DETAIL, SEAT_VERB_ANSWER_DEADLINE_MS, doorFailureOf, runnerAnswered, seatVerbAnswerOf, type SeatVerbOutcome } from './door.js'

function parkEffort(rec: ConcourseWorkerRecordV1, effort: string, dir?: string): void {
  updateConcourseWorkers(workers => {
    const w = workers[rec.runnerId]
    if (w && w.endedAt === undefined) {
      if (w.effort === effort) delete w.pendingEffort
      else w.pendingEffort = effort
    }
  }, dir)
}

function unparkEffort(rec: ConcourseWorkerRecordV1, dir?: string): void {
  updateConcourseWorkers(workers => {
    const w = workers[rec.runnerId]
    if (w && w.endedAt === undefined) delete w.pendingEffort
  }, dir)
}

export function landEffort(rec: ConcourseWorkerRecordV1, effort: string, roster: SeatRosterPort, dir?: string): void {
  console.error(`[daemon] seat ${SESSION_VERBS.setEffort.daemon.action} applied: ${rec.runnerId} → ${effort}`)
  roster.patchSeatEffort(rec.runnerId, effort)
  updateConcourseWorkers(workers => {
    const w = workers[rec.runnerId]
    if (w && w.endedAt === undefined) {
      w.effort = effort
      delete w.pendingEffort
    }
  }, dir)
  publishSeatFacts(rec.runnerId, dir, roster)
  requestSessionFacts(rec.runnerId, roster, { immediate: true }, dir)
}

export async function forwardEffort(rec: ConcourseWorkerRecordV1, effort: string, roster: SeatRosterPort, dir: string | undefined, opts: { parked: boolean }): Promise<SeatVerbOutcome> {
  const queued: SeatVerbOutcome = { outcome: 'queued', detail: `${effort} applies when this turn ends` }
  const door = roster.door(rec.runnerId)
  if (door === undefined || door.closed) return opts.parked ? queued : { outcome: 'refused', detail: NO_DOOR_DETAIL }
  const sent = door.send(SESSION_VERBS.setEffort.runner.name, { effort }, { deadlineMs: SEAT_VERB_ANSWER_DEADLINE_MS })
  const seat = seatOf(rec.runnerId)
  seat.heldEffort = { requestId: sent.id, effort }
  const asked = await sent.answer.then(result => ({ ok: true as const, result, id: sent.id }), (error: unknown) => ({ ok: false as const, failure: doorFailureOf(error, SESSION_VERBS.setEffort.daemon.action, SEAT_VERB_ANSWER_DEADLINE_MS), id: sent.id }))
  if (runnerAnswered(asked)) requestSessionFacts(rec.runnerId, roster, { immediate: true }, dir)
  const word = seatVerbAnswerOf(asked)
  if ('at' in word && word.at === 'turn_end') {
    if (!opts.parked) {
      parkEffort(rec, effort, dir)
      publishSeatFacts(rec.runnerId, dir, roster)
    }
    logForDebugging(`[daemon] seat ${SESSION_VERBS.setEffort.daemon.action} held by the runner for its turn boundary: ${rec.runnerId} → ${effort}`)
    return queued
  }
  if (seat.heldEffort !== null && seat.heldEffort.requestId === sent.id) seat.heldEffort = null
  if ('refused' in word) {
    if (opts.parked) {
      unparkEffort(rec, dir)
      publishSeatFacts(rec.runnerId, dir, roster)
    }
    return { outcome: 'refused', detail: word.refused }
  }
  if ('silent' in word && opts.parked) return queued
  landEffort(rec, effort, roster, dir)
  return { outcome: 'applied', detail: `${rec.runnerId} → ${effort}` }
}

export async function setSessionEffort(sessionId: string, effort: string, roster: SeatRosterPort, dir?: string): Promise<SeatVerbOutcome> {
  const level = normalizeEffortLevelString(effort)
  if (level === undefined) {
    return { outcome: 'refused', detail: `unknown effort '${effort}' — the levels are ${EFFORT_LEVELS.join(' | ')}` }
  }
  effort = level
  const rec = liveRecordBySession(sessionId, dir)
  if (!rec) return { outcome: 'refused', detail: 'unknown-session: no live worker record owns this session' }
  if (rec.effort === effort && rec.pendingEffort === undefined) return { outcome: 'noop', detail: `already on ${effort}` }
  const parked = seatBusyForSwitch(rec.runnerId, roster)
  if (parked) {
    parkEffort(rec, effort, dir)
    console.error(`[daemon] seat ${SESSION_VERBS.setEffort.daemon.action} parked (the session is mid-turn): ${rec.runnerId} → ${effort}`)
    publishSeatFacts(rec.runnerId, dir, roster)
  }
  return forwardEffort(rec, effort, roster, dir, { parked })
}
