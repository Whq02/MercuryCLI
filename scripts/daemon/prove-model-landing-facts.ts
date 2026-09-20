#!/usr/bin/env bun
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.MERCURY_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'model-landing-home-'))
process.env.MERCURY_CREDENTIAL_STORE = 'file'

const seat = await import('../../src/daemon/sessionSeat.ts')
const { updateConcourseWorkers, readSessionWorkers } = await import('../../src/daemon/concourseSupervisor.ts')
const { readSessionFacts } = await import('../../src/services/engine-connector/seatProjections.ts')
const { sessionFactsToWire } = await import('../../src/services/engine-connector/seatWire.ts')

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
    await new Promise(r => setTimeout(r, 25))
  }
  return pred()
}
const pause = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms))

console.log('============================================================')
console.log(' the facts published when a model switch lands name the switched model')
console.log('============================================================')

const dir = mkdtempSync(join(tmpdir(), 'model-landing-daemon-'))
const sid = 'aaaaaaaa-bbbb-4ccc-8ddd-modelland001'
const SHORT = 'concourse-ml1'
const cwd = join(dir, 'fixture-repo')
updateConcourseWorkers(workers => {
  workers[SHORT] = {
    schema: 1,
    runnerId: SHORT,
    sessionId: sid,
    workspaceId: cwd,
    isolation: 'exclusive',
    modelKey: 'gpt-5.6-sol',
    effort: 'high',
    spawnedAt: Date.now(),
    lastLiveAt: Date.now(),
    settingsSnapshot: { schema: 1, snapshotId: 's', sessionId: sid, profileRevision: 0, profileDigest: 'd', resolvedAt: Date.now(), rows: [] } as never,
    workspaceKind: 'plain-folder',
  } as never
}, dir)
const controls: string[] = []
let turnActive = false
const roster = {
  control: (_short: string, frame: string) => {
    controls.push(frame)
    return true
  },
  list: () => [{ short: SHORT, turnActive }],
  patchSeatModel: () => true,
  patchSeatEffort: () => true,
}
const record = () => readSessionWorkers(dir)[SHORT] as { modelKey?: string; pendingModelKey?: string } | undefined
const facts = () => readSessionFacts(sid, dir)
const modelRow = (): string => JSON.stringify({ model: facts()?.model, pendingModel: facts()?.pendingModel, settled: facts()?.modelSettled })
const setModelRequestId = (): string => {
  const frame = controls.slice().reverse().find(f => f.includes('"subtype":"set_model"')) ?? '{}'
  return (JSON.parse(frame) as { request_id?: string }).request_id ?? ''
}
const runnerAnswers = (at: 'now' | 'turn-boundary', payload: Record<string, unknown>): string => {
  const requestId = setModelRequestId()
  seat.onSeatLine(SHORT, JSON.stringify({ type: 'control_response', response: { subtype: 'success', request_id: requestId, response: { ...payload, at } } }), roster as never, dir)
  return requestId
}
const runnerRefuses = (error: string): void => {
  seat.onSeatLine(SHORT, JSON.stringify({ type: 'control_response', response: { subtype: 'error', request_id: setModelRequestId(), error } }), roster as never, dir)
}
const runnerLands = (requestId: string, model: string): void => {
  seat.onSeatLine(SHORT, JSON.stringify({ type: 'system', subtype: 'seat_verb_applied', request_id: requestId, verb: 'set_model', model, uuid: 'u', session_id: sid }), roster as never, dir)
}
let factsSeq = 0
const runnerFacts = (effective: string, setting: string | null, costUSD: number): void => {
  const answer = {
    model: { effective, setting },
    usage: { totalCostUSD: costUSD, totalAPIDurationMs: 0, totalDurationMs: 0, totalLinesAdded: 0, totalLinesRemoved: 0, totalInputTokens: 0, totalOutputTokens: 0, totalCacheReadInputTokens: 0, totalCacheCreationInputTokens: 0, hasUnknownModelCost: false },
    identity: { firstPartyApi: false, consoleBilling: false, claudeAiBilling: false, accountEmail: null },
    skills: [],
    mcp: [],
    permissionMode: 'default',
    workspace: { cwd, originalCwd: cwd, projectRoot: cwd, instructionRoots: [] },
    queue: [],
  }
  factsSeq += 1
  seat.onSeatLine(SHORT, JSON.stringify({ type: 'control_response', response: { subtype: 'success', request_id: `mercury-session-facts-${SHORT}-${factsSeq}`, response: sessionFactsToWire(answer as never) } }), roster as never, dir)
}

section('L1 · the idle landing publishes the switched model before the runner answers again')
runnerFacts('gpt-5.6-sol', 'gpt-5.6-sol', 0.42)
check('the runner has answered once, naming the home model', await until(() => facts()?.model.effective === 'gpt-5.6-sol' && facts()?.model.setting === 'gpt-5.6-sol', 3000), modelRow())
const homeAtMs = facts()?.atMs ?? 0
const fableCall = seat.setSessionModel(sid, 'claude-fable-5-1', roster as never, dir)
runnerAnswers('now', { model: 'claude-fable-5-1' })
const fable = await fableCall
check('the runner acknowledges the switch applied now', fable.outcome === 'applied', JSON.stringify(fable))
check('the record carries the switched model with nothing parked', record()?.modelKey === 'claude-fable-5-1' && record()?.pendingModelKey === undefined, JSON.stringify(record()))
const landed = await until(() => (facts()?.atMs ?? 0) > homeAtMs && facts()?.model.effective === 'claude-fable-5-1', 3000)
check('the facts published at the landing name the switched model as effective, with no fresh runner answer fed', landed, modelRow())
check('…and as the setting', facts()?.model.setting === 'claude-fable-5-1', modelRow())
check('…with no pending switch', facts()?.pendingModel === null, modelRow())
check("…and the runner's other answer rows untouched (the usage figure it answered stands)", facts()?.usage.totalCostUSD === 0.42, JSON.stringify(facts()?.usage))
check('no publish after the landing names the replaced model', facts()?.model.effective !== 'gpt-5.6-sol' && facts()?.model.setting !== 'gpt-5.6-sol', modelRow())

section("L2 · the runner's fresh answer agrees with the landing's publish")
const landedAtMs = facts()?.atMs ?? 0
runnerFacts('claude-fable-5-1', 'claude-fable-5-1', 0.5)
check('the fresh answer is published', await until(() => (facts()?.atMs ?? 0) > landedAtMs && facts()?.usage.totalCostUSD === 0.5, 3000), modelRow())
check('…and its model row is the one the landing published', facts()?.model.effective === 'claude-fable-5-1' && facts()?.model.setting === 'claude-fable-5-1' && facts()?.pendingModel === null, modelRow())

section('L3 · an alias keeps its distinction: the setting is the asked word, the effective is the runner\'s resolved id')
const freshAtMs = facts()?.atMs ?? 0
const sonnetCall = seat.setSessionModel(sid, 'sonnet', roster as never, dir)
runnerAnswers('now', { model: 'claude-sonnet-5' })
const sonnet = await sonnetCall
check('the alias switch applies', sonnet.outcome === 'applied' && record()?.modelKey === 'sonnet', JSON.stringify({ sonnet, record: record() }))
check("the landing publishes the runner's resolved id as effective", await until(() => (facts()?.atMs ?? 0) > freshAtMs && facts()?.model.effective === 'claude-sonnet-5', 3000), modelRow())
check('…and the asked alias as the setting', facts()?.model.setting === 'sonnet', modelRow())
const aliasAtMs = facts()?.atMs ?? 0
runnerFacts('claude-sonnet-5', 'claude-sonnet-5', 0.6)
check("the runner's fresh answer keeps the effective word", await until(() => (facts()?.atMs ?? 0) > aliasAtMs && facts()?.usage.totalCostUSD === 0.6, 3000) && facts()?.model.effective === 'claude-sonnet-5', modelRow())

section('L4 · a parked switch keeps the served model until the runner lands it, then the landing publishes the parked model')
turnActive = true
const parkedAtMs = facts()?.atMs ?? 0
const opusCall = seat.setSessionModel(sid, 'claude-opus-5', roster as never, dir)
const heldId = runnerAnswers('turn-boundary', { model: 'claude-opus-5' })
const opus = await opusCall
check('the switch parks (queued) while the turn runs', opus.outcome === 'queued' && record()?.pendingModelKey === 'claude-opus-5', JSON.stringify({ opus, record: record() }))
check('the park publishes the pending switch beside the served model, which stays', await until(() => (facts()?.atMs ?? 0) > parkedAtMs && facts()?.pendingModel === 'claude-opus-5', 3000) && facts()?.model.effective === 'claude-sonnet-5', modelRow())
const heldAtMs = facts()?.atMs ?? 0
runnerLands(heldId, 'claude-opus-5')
check("the runner's applied frame lands the parked model on the record", record()?.modelKey === 'claude-opus-5' && record()?.pendingModelKey === undefined, JSON.stringify(record()))
check('the landing publishes the parked model as effective with nothing pending', await until(() => (facts()?.atMs ?? 0) > heldAtMs && facts()?.model.effective === 'claude-opus-5' && facts()?.pendingModel === null, 3000), modelRow())
check('…and the settle receipt reads from the model served before the landing to the parked word', facts()?.modelSettled?.from === 'claude-sonnet-5' && facts()?.modelSettled?.to === 'claude-opus-5', modelRow())
turnActive = false

section('L5 · a refused switch changes no model word')
const refusedAtMs = facts()?.atMs ?? 0
const haikuCall = seat.setSessionModel(sid, 'claude-haiku-4-5-20251001', roster as never, dir)
runnerRefuses('the runner refused the switch: no such model here')
const haiku = await haikuCall
check('the runner\'s refusal is the receipt', haiku.outcome === 'refused', JSON.stringify(haiku))
await pause(300)
check('the record and the facts keep the served model', record()?.modelKey === 'claude-opus-5' && facts()?.model.effective === 'claude-opus-5' && facts()?.pendingModel === null && (facts()?.atMs ?? 0) === refusedAtMs, modelRow())

section('L6 · an acknowledgement that names no model word lands the asked word as both')
const bareAtMs = facts()?.atMs ?? 0
const bareCall = seat.setSessionModel(sid, 'claude-fable-5-1', roster as never, dir)
runnerAnswers('now', {})
const bare = await bareCall
check('the switch applies', bare.outcome === 'applied', JSON.stringify(bare))
check('the landing publishes the asked word as effective and setting', await until(() => (facts()?.atMs ?? 0) > bareAtMs && facts()?.model.effective === 'claude-fable-5-1' && facts()?.model.setting === 'claude-fable-5-1', 3000), modelRow())

section('L7 · a seat with no runner answer yet publishes the record\'s model as before')
seat.onSeatSpawned(SHORT, roster as never, dir)
const spawnedAtMs = facts()?.atMs ?? 0
const gptCall = seat.setSessionModel(sid, 'gpt-5.6-sol', roster as never, dir)
runnerAnswers('now', { model: 'gpt-5.6-sol' })
const gpt = await gptCall
check('the switch applies on the fresh runner', gpt.outcome === 'applied' && record()?.modelKey === 'gpt-5.6-sol', JSON.stringify(gpt))
check("the skeleton publish names the record's model", await until(() => (facts()?.atMs ?? 0) > spawnedAtMs && facts()?.model.effective === 'gpt-5.6-sol' && facts()?.model.setting === 'gpt-5.6-sol' && facts()?.pendingModel === null, 3000), modelRow())

console.log(failures === 0 ? '\nprove-model-landing-facts: ALL LAWS HOLD' : `\nprove-model-landing-facts: ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
