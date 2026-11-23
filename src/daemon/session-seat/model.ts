import { logForDebugging } from '../../platform/logs/debugLog.js'
import { SESSION_VERBS } from '../runner-wire/sessionVerbs.js'
import { updateConcourseWorkers, type ConcourseWorkerRecordV1, workerPidAlive, reviveConcourseWorker } from '../concourse-workers/concourseWorkers.js'
import type { RunnerChildSpec } from '../runner-link/headlessRun.js'
import { refreshSignInReads, describeSignInRead } from './signInView.js'
import { validateWorkerModelChoice } from '../../screen/concourse-model/workerModels.js'
import { getMarketingNameForModel } from '../../models/catalogue/engineModel.js'
import { seatOf, type SeatRosterPort, liveRecordByShort, liveRecordBySession, seatBusyForSwitch } from './state.js'
import { publishSeatFacts, requestSessionFacts } from './facts.js'
import { SEAT_VERB_ANSWER_DEADLINE_MS, doorFailureOf, runnerAnswered, seatVerbAnswerOf, type SeatVerbOutcome, NO_DOOR_DETAIL } from './door.js'
import { onSeatSpawned } from './lifecycle.js'

function parkModel(rec: ConcourseWorkerRecordV1, model: string, dir?: string): void {
  updateConcourseWorkers(workers => {
    const w = workers[rec.runnerId]
    if (w && w.endedAt === undefined) {
      if (w.modelKey === model) delete w.pendingModelKey
      else w.pendingModelKey = model
    }
  }, dir)
}

function unparkModel(rec: ConcourseWorkerRecordV1, dir?: string): void {
  updateConcourseWorkers(workers => {
    const w = workers[rec.runnerId]
    if (w && w.endedAt === undefined) delete w.pendingModelKey
  }, dir)
}

export function landModel(rec: ConcourseWorkerRecordV1, model: string, roster: SeatRosterPort, dir: string | undefined, settle: boolean, served?: string): void {
  console.error(`[daemon] seat ${SESSION_VERBS.setModel.daemon.action} applied: ${rec.runnerId} → ${model}`)
  const seat = seatOf(rec.runnerId)
  if (settle) {
    const from = seat.lastAnswer?.model.effective ?? rec.modelKey
    seat.lastModelSettle = { from, to: model, atMs: Date.now() }
  }
  if (seat.lastAnswer !== null) {
    seat.lastAnswer = { ...seat.lastAnswer, model: { effective: served ?? model, setting: model } }
  }
  roster.patchSeatModel(rec.runnerId, model)
  updateConcourseWorkers(workers => {
    const w = workers[rec.runnerId]
    if (w && w.endedAt === undefined) {
      w.modelKey = model
      delete w.pendingModelKey
    }
  }, dir)
  publishSeatFacts(rec.runnerId, dir, roster)
}

export async function forwardModel(rec: ConcourseWorkerRecordV1, model: string, roster: SeatRosterPort, dir: string | undefined, opts: { parked: boolean; settle: boolean; words?: string; replacedDefault?: string }): Promise<SeatVerbOutcome> {
  const queued: SeatVerbOutcome = { outcome: 'queued', detail: `${model} applies when this turn ends` }
  const door = roster.door(rec.runnerId)
  if (door === undefined || door.closed) return opts.parked ? queued : respawnOnModel(rec, model, roster, dir)
  const sent = door.send(SESSION_VERBS.setModel.runner.name, { model, ...(opts.words === undefined ? {} : { words: opts.words }), ...(opts.replacedDefault === undefined ? {} : { replaced_default: opts.replacedDefault }) }, { deadlineMs: SEAT_VERB_ANSWER_DEADLINE_MS })
  const seat = seatOf(rec.runnerId)
  seat.heldModel = { requestId: sent.id, model }
  const asked = await sent.answer.then(result => ({ ok: true as const, result, id: sent.id }), (error: unknown) => ({ ok: false as const, failure: doorFailureOf(error, SESSION_VERBS.setModel.daemon.action, SEAT_VERB_ANSWER_DEADLINE_MS), id: sent.id }))
  if (runnerAnswered(asked)) requestSessionFacts(rec.runnerId, roster, { immediate: true }, dir)
  const word = seatVerbAnswerOf(asked)
  if ('at' in word && word.at === 'turn_end') {
    if (!opts.parked) {
      parkModel(rec, model, dir)
      publishSeatFacts(rec.runnerId, dir, roster)
    }
    logForDebugging(`[daemon] seat ${SESSION_VERBS.setModel.daemon.action} held by the runner for its turn boundary: ${rec.runnerId} → ${model}`)
    return queued
  }
  if (seat.heldModel !== null && seat.heldModel.requestId === sent.id) seat.heldModel = null
  if ('refused' in word) {
    if (opts.parked) {
      unparkModel(rec, dir)
      publishSeatFacts(rec.runnerId, dir, roster)
    }
    return { outcome: 'refused', detail: word.refused }
  }
  if ('silent' in word && opts.parked) return queued
  landModel(rec, model, roster, dir, 'at' in word && opts.settle, 'model' in word ? word.model : undefined)
  return { outcome: 'applied', detail: liveSwitchReceipt(rec, model, dir) }
}

function liveSwitchReceipt(rec: ConcourseWorkerRecordV1, model: string, dir?: string): string {
  const plain = `${rec.runnerId} → ${model}`
  const now = liveRecordByShort(rec.runnerId, dir) ?? rec
  return now.crash === undefined ? plain : `${goneRunnerWords(now, undefined)} and is back — ${plain}`
}

export async function setSessionModel(sessionId: string, model: string, roster: SeatRosterPort, dir?: string, words?: string, replacedDefault?: string): Promise<SeatVerbOutcome> {
  const rec = liveRecordBySession(sessionId, dir)
  if (!rec) return { outcome: 'refused', detail: 'unknown-session: no live worker record owns this session' }
  if (rec.modelKey === model && rec.pendingModelKey === undefined) return { outcome: 'noop', detail: `already on ${model}` }
  const gone = rec.pid !== undefined && !workerPidAlive(rec)
  const parked = !gone && seatBusyForSwitch(rec.runnerId, roster)
  if (parked) {
    parkModel(rec, model, dir)
    console.error(`[daemon] seat ${SESSION_VERBS.setModel.daemon.action} parked (the session is mid-turn): ${rec.runnerId} → ${model}`)
    publishSeatFacts(rec.runnerId, dir, roster)
  }
  return forwardModel(rec, model, roster, dir, { parked, settle: false, ...(words === undefined ? {} : { words }), ...(replacedDefault === undefined ? {} : { replacedDefault }) })
}

function clockOf(atMs: number): string {
  return new Date(atMs).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false })
}

function goneRunnerWords(rec: ConcourseWorkerRecordV1, row: { outcome?: string } | undefined): string {
  if (rec.crash !== undefined) {
    const head = rec.crash.reason.replace(/ · resumed.*$/, '').replace(/ — .*$/, '')
    return `the runner had exited at ${clockOf(rec.crash.at)} (${head})`
  }
  if (row?.outcome === 'killed') return 'the runner had been cut (the stop)'
  return 'the runner had exited'
}

async function respawnOnModel(rec: ConcourseWorkerRecordV1, model: string, roster: SeatRosterPort, dir?: string): Promise<SeatVerbOutcome> {
  const row = roster.list().find(j => j.short === rec.runnerId)
  if (roster.registerLongLived === undefined || roster.has === undefined || roster.kill === undefined) {
    return { outcome: 'refused', detail: `${NO_DOOR_DETAIL}, and this roster cannot respawn its runner` }
  }
  refreshSignInReads(true)
  const validated = await validateWorkerModelChoice(model, 'session')
  if (!validated.ok) {
    const read = validated.reason.startsWith('no-credential:') ? ` — ${describeSignInRead(validated.reason.slice('no-credential:'.length))}` : ''
    return {
      outcome: 'refused',
      detail: `${goneRunnerWords(rec, row)} and cannot restart on ${model}: model refused (${validated.reason})${validated.action !== undefined ? ` · ${validated.action}` : ''}${validated.detail !== undefined ? ` — ${validated.detail}` : ''}${read}`,
    }
  }
  const name = ((): string => {
    try {
      return getMarketingNameForModel(model) ?? model
    } catch {
      return model
    }
  })()
  if (row !== undefined && row.outcome === undefined && row.state === 'spawning') {
    roster.patchSeatModel(rec.runnerId, model)
    updateConcourseWorkers(workers => {
      const w = workers[rec.runnerId]
      if (w && w.endedAt === undefined) {
        w.modelKey = model
        delete w.pendingModelKey
      }
    }, dir)
    const receipt = `${goneRunnerWords(rec, row)} — restarting on ${name}`
    console.error(`[daemon] seat ${SESSION_VERBS.setModel.daemon.action} rides the respawn: ${rec.runnerId} → ${model} (${receipt})`)
    publishSeatFacts(rec.runnerId, dir, roster)
    return { outcome: 'applied', detail: receipt, respawned: true }
  }
  const reviveRoster = {
    kill: (short: string): boolean => roster.kill!(short),
    has: (short: string): { present: boolean } => roster.has!(short),
    registerLongLived: (short: string, spec: RunnerChildSpec): { ok: boolean; pid?: number; error?: string } => roster.registerLongLived!(short, spec),
  }
  const revived = reviveConcourseWorker(rec.sessionId, `operator:${SESSION_VERBS.setModel.daemon.action}`, reviveRoster, { clearCrash: true, modelOverride: model }, dir)
  if (revived.outcome === 'noop') {
    return { outcome: 'refused', detail: `the runner's door is closed while its process (pid ${rec.pid ?? '?'}) still stands — retry in a moment` }
  }
  if (revived.outcome === 'refused') {
    return { outcome: 'refused', detail: `${goneRunnerWords(rec, row)} and could not restart on ${model}: ${revived.detail ?? revived.reason}` }
  }
  const receipt = `${goneRunnerWords(rec, row)} — restarted on ${name}`
  console.error(`[daemon] seat ${SESSION_VERBS.setModel.daemon.action} respawned: ${rec.runnerId} → ${model} (${receipt})`)
  onSeatSpawned(rec.runnerId, roster, dir)
  return { outcome: 'applied', detail: receipt, respawned: true }
}
