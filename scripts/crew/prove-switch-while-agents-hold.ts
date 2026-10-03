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
const { standInRunner } = await import('../lib/seatDoor.ts')
let turnActive = true
const stand = standInRunner({
  hooks: {
    onRow: row => seat.onSeatRow(SHORT, row, roster as never, dir),
    onApplied: params => seat.onSeatApplied(SHORT, params, roster as never, dir),
  },
})
const roster = stand.roster({ list: () => [{ short: SHORT, turnActive }] })
const tick = (): Promise<void> => new Promise(resolve => setTimeout(resolve, 20))
const waiting = (agents: number): Record<string, unknown> => ({ type: 'turn', seq: 1, timestamp: 't', session_id: sid, turn: 1, state: 'waiting', turn_id: 't-hold', agents })
const record = () => readSessionWorkers(dir)[SHORT] as { modelKey?: string; pendingModelKey?: string; effort?: string; pendingEffort?: string } | undefined
const switches = (): number => stand.requests.filter(r => r.method === 'session/set_model').length
const runnerAnswers = async (method: 'session/set_model' | 'session/set_effort', at: 'now' | 'turn_end', payload: Record<string, unknown>): Promise<number> => {
  const request = await stand.nextRequest(method)
  request.answer({ ...payload, at })
  return request.id
}
const runnerLands = async (requestId: number, landed: { verb: 'set_model'; model: string } | { verb: 'set_effort'; effort: string }): Promise<void> => {
  stand.applied({ request_id: requestId, ...landed })
  await tick()
}

seat.onSeatRow(SHORT, waiting(2) as never, roster as never, dir)
const appliedCall = seat.setSessionModel(sid, 'claude-opus-5', roster as never, dir)
await runnerAnswers('session/set_model', 'now', { model: 'claude-opus-5' })
const applied = await appliedCall
check('with agents holding the turn, set-model APPLIES', applied.outcome === 'applied', JSON.stringify(applied))
check('…the session/set_model request reached the child', stand.requests.some(r => r.method === 'session/set_model' && (r.params as { model?: string }).model === 'claude-opus-5'), JSON.stringify(stand.requests.map(r => r.method)))
check('…and the record flips to the new model with nothing parked', record()?.modelKey === 'claude-opus-5' && record()?.pendingModelKey === undefined, JSON.stringify(record()))

seat.onSeatRow(SHORT, waiting(0) as never, roster as never, dir)
const queuedCall = seat.setSessionModel(sid, 'claude-fable-5-1', roster as never, dir)
const heldId = await runnerAnswers('session/set_model', 'turn_end', { model: 'claude-fable-5-1' })
const queued = await queuedCall
check('with a stream in flight, set-model PARKS (queued) — the request is sent and the runner holds it', queued.outcome === 'queued' && switches() === 2, JSON.stringify(queued))
check('…the record carries the parked model and keeps the applied one', record()?.modelKey === 'claude-opus-5' && record()?.pendingModelKey === 'claude-fable-5-1', JSON.stringify(record()))

seat.onSeatIdle(SHORT, roster as never, dir)
check('…the idle edge sends nothing for a verb the runner holds', switches() === 2, String(stand.requests.length))
await runnerLands(heldId, { verb: 'set_model', model: 'claude-fable-5-1' })
check("…the runner's applied frame lands the parked model on the record with nothing parked", record()?.modelKey === 'claude-fable-5-1' && record()?.pendingModelKey === undefined, JSON.stringify(record()))
const settledFacts = await until(() => readSessionFacts(sid, dir)?.modelSettled?.to === 'claude-fable-5-1' && readSessionFacts(sid, dir)?.pendingModel === null, 4000)
check('…and stamps the settle receipt the chat paints as the turn-boundary note (the facts publish is ordered and lands within its window)', settledFacts, JSON.stringify(readSessionFacts(sid, dir)?.modelSettled))

turnActive = false
const closedCall = seat.setSessionModel(sid, 'claude-sonnet-5', roster as never, dir)
await runnerAnswers('session/set_model', 'now', { model: 'claude-sonnet-5' })
const closed = await closedCall
check('with the turn closed, set-model applies', closed.outcome === 'applied' && record()?.modelKey === 'claude-sonnet-5', JSON.stringify(closed))

const racedCall = seat.setSessionModel(sid, 'claude-opus-5', roster as never, dir)
await runnerAnswers('session/set_model', 'turn_end', { model: 'claude-opus-5' })
const raced = await racedCall
check("a switch the seat read as idle that the runner holds (a turn started under it) parks truthfully: 'queued', the record carries it", raced.outcome === 'queued' && record()?.modelKey === 'claude-sonnet-5' && record()?.pendingModelKey === 'claude-opus-5', JSON.stringify({ raced, record: record() }))

section('S3 · the effort sibling')
turnActive = true
seat.onSeatRow(SHORT, waiting(1) as never, roster as never, dir)
const effortCall = seat.setSessionEffort(sid, 'low', roster as never, dir)
await runnerAnswers('session/set_effort', 'now', { effort: 'low' })
const effortApplied = await effortCall
check('with agents holding the turn, set-effort APPLIES', effortApplied.outcome === 'applied' && record()?.effort === 'low', JSON.stringify(effortApplied))
seat.onSeatRow(SHORT, waiting(0) as never, roster as never, dir)
const effortQueuedCall = seat.setSessionEffort(sid, 'max', roster as never, dir)
const heldEffortId = await runnerAnswers('session/set_effort', 'turn_end', { effort: 'max' })
const effortQueued = await effortQueuedCall
check('with a stream in flight, set-effort PARKS', effortQueued.outcome === 'queued' && record()?.pendingEffort === 'max', JSON.stringify(effortQueued))
await runnerLands(heldEffortId, { verb: 'set_effort', effort: 'max' })
check("…the runner's applied frame lands the parked effort", record()?.effort === 'max' && record()?.pendingEffort === undefined, JSON.stringify(record()))

stand.close()
console.log(failures === 0 ? '\nprove-switch-while-agents-hold: ALL LAWS HOLD' : `\nprove-switch-while-agents-hold: ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
