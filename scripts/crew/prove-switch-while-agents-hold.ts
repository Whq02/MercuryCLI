#!/usr/bin/env bun
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.MERCURY_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'switch-hold-home-'))
process.env.MERCURY_CREDENTIAL_STORE = 'file'

const seat = await import('../../src/daemon/sessionSeat.ts')
const { updateConcourseWorkers, readSessionWorkers } = await import('../../src/daemon/concourseSupervisor.ts')
const { readSessionFacts } = await import('../../src/services/engine-connector/seatProjections.ts')

let failures = 0
const check = (label: string, ok: boolean, detail = ''): void => {
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${!ok && detail ? ` — ${detail}` : ''}`)
  if (!ok) failures++
}
const section = (t: string): void => {
  console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
}
const until = async (pred: () => boolean, ms: number): Promise<boolean> => {
  const t0 = Date.now()
  while (Date.now() - t0 < ms) {
    if (pred()) return true
    await new Promise(r => setTimeout(r, 50))
  }
  return pred()
}

console.log('============================================================')
console.log(' a switch while agents hold the turn — applies now, parks only mid-stream')
console.log('============================================================')

section('S1 · the pure law')
check('a closed turn applies', seat.switchAppliesWhileAgentsHold(false, null) === true)
check('an open turn held by its agents alone applies', seat.switchAppliesWhileAgentsHold(true, 'waiting-on-agents') === true)
check('an open turn with a stream in flight parks', seat.switchAppliesWhileAgentsHold(true, null) === false)
check('an open turn mid-compaction parks', seat.switchAppliesWhileAgentsHold(true, 'compacting') === false)

section('S2 · the seat\'s set-model verb through the real seat')
const dir = mkdtempSync(join(tmpdir(), 'switch-hold-daemon-'))
const sid = 'aaaaaaaa-bbbb-4ccc-8ddd-switchhold01'
const SHORT = 'concourse-sh1'
updateConcourseWorkers(workers => {
  workers[SHORT] = {
    schema: 1,
    runnerId: SHORT,
    sessionId: sid,
    workspaceId: 'ws-sh',
    isolation: 'exclusive',
    modelKey: 'claude-fable-5-1',
    effort: 'high',
    spawnedAt: Date.now(),
    lastLiveAt: Date.now(),
    settingsSnapshot: { schema: 1, snapshotId: 's', sessionId: sid, profileRevision: 0, profileDigest: 'd', resolvedAt: Date.now(), rows: [] } as never,
    workspaceKind: 'plain-folder',
  } as never
}, dir)
const controls: string[] = []
let turnActive = true
const roster = {
  control: (_short: string, frame: string) => {
    controls.push(frame)
    return true
  },
  list: () => [{ short: SHORT, turnActive }],
  patchSeatModel: () => true,
  patchSeatEffort: () => true,
}
const status = (value: unknown): string => JSON.stringify({ type: 'system', subtype: 'status', status: value, uuid: 'u', session_id: sid })
const record = () => readSessionWorkers(dir)[SHORT] as { modelKey?: string; pendingModelKey?: string; effort?: string; pendingEffort?: string } | undefined
const lastRequestId = (): string => (JSON.parse(controls[controls.length - 1] ?? '{}') as { request_id?: string }).request_id ?? ''
const runnerAnswers = (at: 'now' | 'turn-boundary', payload: Record<string, unknown>): string => {
  const requestId = lastRequestId()
  seat.onSeatLine(SHORT, JSON.stringify({ type: 'control_response', response: { subtype: 'success', request_id: requestId, response: { ...payload, at } } }), roster as never, dir)
  return requestId
}
const runnerLands = (requestId: string, landed: Record<string, unknown>): void => {
  seat.onSeatLine(SHORT, JSON.stringify({ type: 'system', subtype: 'seat_verb_applied', request_id: requestId, ...landed, uuid: 'u', session_id: sid }), roster as never, dir)
}

seat.onSeatLine(SHORT, status({ waiting_on_agents: 2 }), roster as never, dir)
const appliedCall = seat.setSessionModel(sid, 'claude-opus-5', roster as never, dir)
runnerAnswers('now', { model: 'claude-opus-5' })
const applied = await appliedCall
check('with agents holding the turn, set-model APPLIES', applied.outcome === 'applied', JSON.stringify(applied))
check('…the set_model control reached the child', controls.some(f => f.includes('"subtype":"set_model"') && f.includes('claude-opus-5')), controls.join(' | ').slice(0, 200))
check('…and the record flips to the new model with nothing parked', record()?.modelKey === 'claude-opus-5' && record()?.pendingModelKey === undefined, JSON.stringify(record()))

seat.onSeatLine(SHORT, status(null), roster as never, dir)
const queuedCall = seat.setSessionModel(sid, 'claude-fable-5-1', roster as never, dir)
const heldId = runnerAnswers('turn-boundary', { model: 'claude-fable-5-1' })
const queued = await queuedCall
check('with a stream in flight, set-model PARKS (queued) — the control is forwarded and the runner holds it', queued.outcome === 'queued' && controls.filter(f => f.includes('"subtype":"set_model"')).length === 2, JSON.stringify(queued))
check('…the record carries the parked model and keeps the applied one', record()?.modelKey === 'claude-opus-5' && record()?.pendingModelKey === 'claude-fable-5-1', JSON.stringify(record()))

seat.onSeatIdle(SHORT, roster as never, dir)
check('…the idle edge sends nothing for a verb the runner holds', controls.filter(f => f.includes('"subtype":"set_model"')).length === 2, String(controls.length))
runnerLands(heldId, { verb: 'set_model', model: 'claude-fable-5-1' })
check("…the runner's applied frame lands the parked model on the record with nothing parked", record()?.modelKey === 'claude-fable-5-1' && record()?.pendingModelKey === undefined, JSON.stringify(record()))
const settledFacts = await until(() => readSessionFacts(sid, dir)?.modelSettled?.to === 'claude-fable-5-1' && readSessionFacts(sid, dir)?.pendingModel === null, 4000)
check('…and stamps the settle receipt the chat paints as the turn-boundary note (the facts publish is ordered and lands within its window)', settledFacts, JSON.stringify(readSessionFacts(sid, dir)?.modelSettled))

turnActive = false
const closedCall = seat.setSessionModel(sid, 'claude-sonnet-5', roster as never, dir)
runnerAnswers('now', { model: 'claude-sonnet-5' })
const closed = await closedCall
check('with the turn closed, set-model applies', closed.outcome === 'applied' && record()?.modelKey === 'claude-sonnet-5', JSON.stringify(closed))

const racedCall = seat.setSessionModel(sid, 'claude-opus-5', roster as never, dir)
runnerAnswers('turn-boundary', { model: 'claude-opus-5' })
const raced = await racedCall
check("a switch the seat read as idle that the runner holds (a turn started under it) parks truthfully: 'queued', the record carries it", raced.outcome === 'queued' && record()?.modelKey === 'claude-sonnet-5' && record()?.pendingModelKey === 'claude-opus-5', JSON.stringify({ raced, record: record() }))

section('S3 · the effort sibling')
turnActive = true
seat.onSeatLine(SHORT, status({ waiting_on_agents: 1 }), roster as never, dir)
const effortCall = seat.setSessionEffort(sid, 'low', roster as never, dir)
runnerAnswers('now', { effort: 'low' })
const effortApplied = await effortCall
check('with agents holding the turn, set-effort APPLIES', effortApplied.outcome === 'applied' && record()?.effort === 'low', JSON.stringify(effortApplied))
seat.onSeatLine(SHORT, status(null), roster as never, dir)
const effortQueuedCall = seat.setSessionEffort(sid, 'max', roster as never, dir)
const heldEffortId = runnerAnswers('turn-boundary', { effort: 'max' })
const effortQueued = await effortQueuedCall
check('with a stream in flight, set-effort PARKS', effortQueued.outcome === 'queued' && record()?.pendingEffort === 'max', JSON.stringify(effortQueued))
runnerLands(heldEffortId, { verb: 'set_effort', effort: 'max' })
check("…the runner's applied frame lands the parked effort", record()?.effort === 'max' && record()?.pendingEffort === undefined, JSON.stringify(record()))

console.log(failures === 0 ? '\nprove-switch-while-agents-hold: ALL LAWS HOLD' : `\nprove-switch-while-agents-hold: ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
