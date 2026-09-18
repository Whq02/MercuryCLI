#!/usr/bin/env bun
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, openSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { DIST, MODEL, NODE, argAfter, bootRunner, bound, childEnv, makeTally, seedHome, sleep, user, type Frame } from './dupline-world.ts'
import { startFixtureApi, type CapturedRequest, type FixtureApi, type ScriptedTurn } from '../lib/fixtureApi.ts'

const tally = makeTally('prove-switch-boundary')
if (!existsSync(DIST)) {
  console.log(`  [SKIP] ${DIST} absent — build first`)
  process.exit(0)
}
console.log(`build under proof: ${DIST}`)

const ONLY = argAfter('--only')
const HOLD_SECONDS = 3
const PROBE_SECONDS = 6
const STREAM_DELTAS = 40
const STREAM_GAP_MS = 200
const NEW_MODEL = 'claude-sonnet-5'
const OLD_SEAT_MODEL = 'claude-opus-5'
const NOTIFICATION = '<task-notification>'

const SCRATCH = realpathSync(mkdtempSync(join(tmpdir(), 'switch-boundary-')))
const guardPids = new Set<number>()
const guard = setTimeout(() => {
  console.log(`\n❌ TIMEOUT — proof exceeded its budget\n[keep] ${SCRATCH}`)
  for (const pid of guardPids) {
    try {
      process.kill(pid, 'SIGKILL')
    } catch {
    }
  }
  process.exit(1)
}, bound(480_000))
guard.unref?.()

type Body = { model?: string; output_config?: { effort?: string }; messages?: Array<{ role?: string; content?: unknown }> }
const bodyOf = (r: CapturedRequest): Body => r.body as Body
const resultOf = (id: string): string => `"tool_use_id":"${id}"`
const firstRequestWith = (api: FixtureApi, words: string): CapturedRequest | undefined => api.messageRequests().find(r => JSON.stringify(r.body).includes(words))
const askOf = (body: Body): string => {
  const items = body.messages ?? []
  for (let i = items.length - 1; i >= 0; i--) {
    const item = items[i]!
    if (item.role !== 'user') continue
    const content = item.content
    if (typeof content === 'string') return content
    if (!Array.isArray(content)) continue
    const texts = (content as Array<{ type?: string; text?: string }>).filter(b => b.type === 'text' && typeof b.text === 'string').map(b => b.text ?? '')
    if (texts.length > 0) return texts.join(' | ')
  }
  return ''
}
const describeRequests = (api: FixtureApi): string => JSON.stringify(api.messageRequests().map((r, i) => [i + 1, bodyOf(r).model, bodyOf(r).output_config?.effort ?? null, askOf(bodyOf(r)).replace(/\s+/g, ' ').slice(0, 60)]))
const untilAsync = async (pred: () => Promise<boolean> | boolean, ms: number, stepMs = 100): Promise<boolean> => {
  const t0 = Date.now()
  while (Date.now() - t0 < ms) {
    try {
      if (await pred()) return true
    } catch {
    }
    await sleep(stepMs)
  }
  return false
}
const stream = (whenBody: string, word: string): ScriptedTurn => ({ kind: 'paced', deltas: Array.from({ length: STREAM_DELTAS }, () => `${word} `), gapMs: STREAM_GAP_MS, whenBody })
const keepRequests = (api: FixtureApi, name: string): void => {
  try {
    writeFileSync(join(SCRATCH, name), JSON.stringify(api.messageRequests().map((r, i) => ({ n: i + 1, model: bodyOf(r).model, effort: bodyOf(r).output_config?.effort ?? null, ask: askOf(bodyOf(r)) })), null, 2))
  } catch {
  }
}

if (ONLY === undefined || ONLY === 'R') {
  tally.section('R the runner owns the boundary: a headless runner, a switch during its Sleep call, words during the final stream')
  const home = join(SCRATCH, 'runner-home')
  const cwd = join(home, 'work')
  const stamp = join(cwd, 'background-done')
  seedHome(home, cwd)
  const api = await startFixtureApi([
    { kind: 'tool_use', name: 'Sleep', input: { seconds: HOLD_SECONDS }, id: 'tu-hold-1', whenBody: 'hold the line', preText: 'holding. ' },
    stream(resultOf('tu-hold-1'), 'held'),
    { kind: 'text', text: 'more.', whenBody: 'now say more' },
    { kind: 'tool_use', name: 'Bash', input: { command: `sleep 1; touch ${stamp}`, run_in_background: true, description: 'a background wait' }, id: 'tu-bg', whenBody: 'launch a background command', preText: 'launching. ' },
    { kind: 'text', text: 'launched.', whenBody: resultOf('tu-bg') },
    { kind: 'text', text: 'noted.', whenBody: NOTIFICATION },
    { kind: 'tool_use', name: 'Sleep', input: { seconds: HOLD_SECONDS }, id: 'tu-hold-2', whenBody: 'hold again', preText: 'holding again. ' },
    stream(resultOf('tu-hold-2'), 'still'),
    { kind: 'text', text: 'again.', whenBody: 'say again' },
    { kind: 'tool_use', name: 'Sleep', input: { seconds: HOLD_SECONDS + 1 }, id: 'tu-hold-3', whenBody: 'hold and drain', preText: 'holding to drain. ' },
    { kind: 'text', text: 'drained.', whenBody: resultOf('tu-hold-3') },
    { kind: 'text', text: 'yes.', whenBody: 'afterwards say yes' },
    { kind: 'tool_use', name: 'Sleep', input: { seconds: HOLD_SECONDS + 1 }, id: 'tu-hold-4', whenBody: 'hold for the mixed pair', preText: 'holding for the pair. ' },
    { kind: 'text', text: 'the pair held.', whenBody: resultOf('tu-hold-4') },
    { kind: 'tool_use', name: 'Sleep', input: { seconds: HOLD_SECONDS }, id: 'tu-hold-5', whenBody: 'hold for effort', preText: 'holding for effort. ' },
    { kind: 'text', text: 'the effort held.', whenBody: resultOf('tu-hold-5') },
    { kind: 'tool_use', name: 'Sleep', input: { seconds: HOLD_SECONDS }, id: 'tu-hold-6', whenBody: 'hold with nothing held', preText: 'holding plain. ' },
    { kind: 'text', text: 'the plain held.', whenBody: resultOf('tu-hold-6') },
    { kind: 'tool_use', name: 'Sleep', input: { seconds: HOLD_SECONDS }, id: 'tu-hold-7', whenBody: 'hold for the flip', preText: 'holding for the flip. ' },
    { kind: 'text', text: 'flipped.', whenBody: resultOf('tu-hold-7') },
    { kind: 'text', text: 'the late words answered.', whenBody: 'the drained words' },
    { kind: 'text', text: 'the late pair answered.', whenBody: 'the late pair words' },
    { kind: 'text', text: 'the effort words answered.', whenBody: 'the effort words' },
    { kind: 'text', text: 'the flip words answered.', whenBody: 'the flip words' },
    { kind: 'text', text: 'ok.' },
    { kind: 'text', text: 'ok.' },
  ])
  const port = Number(new URL(api.url).port)
  const runner = bootRunner({ cwd, env: { ...childEnv(home, port), MERCURY_EFFORT_LEVEL: 'high', MERCURY_TOOL_SEARCH: '0' }, extraArgv: ['--allowed-tools', 'Bash,Sleep'] })
  if (runner.proc.pid !== undefined) guardPids.add(runner.proc.pid)
  const frames = runner.frames
  const indexOf = (test: (f: Frame) => boolean, after = 0): number => {
    const at = frames.slice(after).findIndex(test)
    return at === -1 ? -1 : at + after
  }
  const isResultFrame = (f: Frame): boolean => f.type === 'result'
  const isTurnStarted = (f: Frame): boolean => f.type === 'system' && f.subtype === 'turn_started'
  const isSleepCall = (f: Frame): boolean => f.type === 'assistant' && JSON.stringify(f).includes('"name":"Sleep"')
  const answerTo = (id: string) => (f: Frame): boolean => f.type === 'control_response' && (f.response as { request_id?: string } | undefined)?.request_id === id
  const appliedFrameFor = (id: string) => (f: Frame): boolean => f.type === 'system' && f.subtype === 'seat_verb_applied' && f.request_id === id
  const payloadOf = (f: Frame | null): Record<string, unknown> => ((f?.response as { response?: Record<string, unknown> } | undefined)?.response ?? {})
  const control = (id: string, request: Record<string, unknown>): void => runner.send({ type: 'control_request', request_id: id, request })
  const resultsSoFar = (): number => frames.filter(isResultFrame).length
  const waitResults = (n: number, ms: number): Promise<boolean> => untilAsync(() => resultsSoFar() >= n, ms, 50)
  const timeline = (from: number): string =>
    frames
      .slice(from)
      .map((f, i) => [i + from, f.type === 'system' ? `system/${String(f.subtype)}${f.subtype === 'seat_verb_applied' ? `(${String(f.request_id)})` : ''}` : f.type === 'control_response' ? `answer(${String((f.response as { request_id?: string }).request_id)})` : String(f.type)] as const)
      .filter(([, word]) => word !== 'stream_event' && word !== 'user' && word !== 'tool_progress')
      .map(([i, word]) => `${i}:${word}`)
      .join(' ')
  const keepFrames = (): void => {
    try {
      writeFileSync(join(SCRATCH, 'runner-frames.jsonl'), frames.map(f => JSON.stringify(f)).join('\n'))
    } catch {
    }
  }

  try {
    const before1 = frames.length
    runner.send(user('hold the line', randomUUID()))
    const sleeping = await runner.waitFor('the Sleep call streams', isSleepCall, bound(60_000), before1)
    tally.check('R0 the first ask calls Sleep and the stream stays open on it', sleeping !== null, runner.stderr().slice(-400))
    await sleep(300)
    control('sb-model-1', { subtype: 'set_model', model: NEW_MODEL })
    const ack1 = await runner.waitFor('the set_model answer', answerTo('sb-model-1'), bound(10_000), before1)
    const resultsAtAck = resultsSoFar()
    tally.check('R1a the runner answers the mid-turn set_model at once and says where it lands: the turn boundary', ack1 !== null && payloadOf(ack1).at === 'turn-boundary' && payloadOf(ack1).model === NEW_MODEL, JSON.stringify(ack1))
    tally.check('R1b the answer came while the stream was still open (no result yet)', ack1 !== null && resultsAtAck === 0, `results at the answer: ${resultsAtAck}`)
    tally.check("R1c the running turn's continuation goes out after the Sleep", await untilAsync(() => firstRequestWith(api, resultOf('tu-hold-1')) !== undefined, bound(30_000), 50), describeRequests(api))
    await sleep(300)
    runner.send(user('now say more', randomUUID()))
    tally.check('R1d both turns settle', await waitResults(2, bound(60_000)), describeRequests(api))
    const continuation = firstRequestWith(api, resultOf('tu-hold-1'))
    const words = firstRequestWith(api, 'now say more')
    tally.check(`R1e the running turn's continuation keeps the old model (${MODEL}) — no verb changes the model inside a turn`, continuation !== undefined && bodyOf(continuation).model === MODEL, describeRequests(api))
    tally.check(`R1f the words sent during the final stream run as the next turn, on the new model (${NEW_MODEL})`, words !== undefined && bodyOf(words).model === NEW_MODEL && !JSON.stringify(continuation?.body ?? null).includes('now say more'), describeRequests(api))
    const result1 = indexOf(isResultFrame, before1)
    const applied1 = indexOf(appliedFrameFor('sb-model-1'), before1)
    const turn2 = indexOf(isTurnStarted, indexOf(isTurnStarted, before1) + 1)
    tally.check("R1g the runner's order on the wire: the turn's result, then the applied frame, then the next turn's open edge", result1 !== -1 && applied1 !== -1 && turn2 !== -1 && result1 < applied1 && applied1 < turn2, `result ${result1} · applied ${applied1} · turn_started ${turn2} · ${timeline(before1)}`)
    tally.check('R1h the applied frame names the verb and the model it landed', applied1 !== -1 && frames[applied1]!.verb === 'set_model' && frames[applied1]!.model === NEW_MODEL, JSON.stringify(frames[applied1] ?? null))

    const before2 = frames.length
    const results2 = resultsSoFar()
    runner.send(user('launch a background command', randomUUID()))
    tally.check('R2a the launch turn settles while its command runs on', await waitResults(results2 + 1, bound(60_000)), describeRequests(api))
    tally.check('R2b the background command lands its stamp', await untilAsync(() => existsSync(stamp), bound(15_000), 25), runner.stderr().slice(-300))
    control('sb-model-2', { subtype: 'set_model', model: MODEL })
    const ack2 = await runner.waitFor('the set_model answer during the hold', answerTo('sb-model-2'), bound(10_000), before2)
    tally.check('R2c a verb landing while no stream is open (the completion hold or the agent wait) applies now — the answer says so', ack2 !== null && payloadOf(ack2).at === 'now' && payloadOf(ack2).model === MODEL, JSON.stringify(ack2))
    tally.check('R2d the completion turn settles', await waitResults(results2 + 2, bound(30_000)), describeRequests(api))
    const notification = firstRequestWith(api, NOTIFICATION)
    tally.check(`R2e the completion turn runs on the model applied during the hold (${MODEL})`, notification !== undefined && bodyOf(notification).model === MODEL, describeRequests(api))
    const ackIndex2 = indexOf(answerTo('sb-model-2'), before2)
    const launchResult = indexOf(isResultFrame, before2)
    const completionTurn = launchResult === -1 ? -1 : indexOf(isTurnStarted, launchResult + 1)
    tally.check("R2f the answer preceded the completion turn's open edge, and no applied frame follows an immediate apply", ackIndex2 !== -1 && completionTurn !== -1 && ackIndex2 < completionTurn && indexOf(appliedFrameFor('sb-model-2')) === -1, `answer ${ackIndex2} · turn_started ${completionTurn} · applied ${indexOf(appliedFrameFor('sb-model-2'))} · ${timeline(before2)}`)

    const before3 = frames.length
    const results3 = resultsSoFar()
    runner.send(user('hold again', randomUUID()))
    const sleeping2 = await runner.waitFor('the second Sleep call streams', isSleepCall, bound(60_000), before3)
    tally.check('R3a the third ask calls Sleep', sleeping2 !== null, describeRequests(api))
    await sleep(300)
    control('sb-effort-1', { subtype: 'set_effort', effort: 'low' })
    control('sb-mode-1', { subtype: 'set_permission_mode', mode: 'strategy' })
    const ack3 = await runner.waitFor('the set_effort answer', answerTo('sb-effort-1'), bound(10_000), before3)
    const modeAnswer = await runner.waitFor('the set_permission_mode answer', answerTo('sb-mode-1'), bound(10_000), before3)
    const resultsAtMode = resultsSoFar()
    tally.check('R3b set_effort mid-turn is held for the boundary — the answer says so at once', ack3 !== null && payloadOf(ack3).at === 'turn-boundary' && payloadOf(ack3).effort === 'low', JSON.stringify(ack3))
    tally.check("R3c set_permission_mode mid-turn applies at once (the mode verb never parks) — answered before the turn's result", modeAnswer !== null && (modeAnswer.response as { subtype?: string }).subtype === 'success' && payloadOf(modeAnswer).mode === 'strategy' && resultsAtMode === results3, JSON.stringify(modeAnswer))
    tally.check("R3d the running turn's continuation goes out after the Sleep", await untilAsync(() => firstRequestWith(api, resultOf('tu-hold-2')) !== undefined, bound(30_000), 50), describeRequests(api))
    await sleep(300)
    runner.send(user('say again', randomUUID()))
    tally.check('R3e both turns settle', await waitResults(results3 + 2, bound(60_000)), describeRequests(api))
    const continuation2 = firstRequestWith(api, resultOf('tu-hold-2'))
    const words2 = firstRequestWith(api, 'say again')
    tally.check("R3f the running turn's continuation keeps the effort it started on (high)", continuation2 !== undefined && bodyOf(continuation2).output_config?.effort === 'high', describeRequests(api))
    tally.check('R3g the words sent during the final stream run at the held effort (low)', words2 !== undefined && bodyOf(words2).output_config?.effort === 'low', describeRequests(api))
    const result5 = indexOf(isResultFrame, before3)
    const applied3 = indexOf(appliedFrameFor('sb-effort-1'), before3)
    const turn6 = indexOf(isTurnStarted, indexOf(isTurnStarted, before3) + 1)
    tally.check("R3h the effort's applied frame sits between the turn's result and the next turn's open edge", result5 !== -1 && applied3 !== -1 && turn6 !== -1 && result5 < applied3 && applied3 < turn6, `result ${result5} · applied ${applied3} · turn_started ${turn6} · ${timeline(before3)}`)

    const before4 = frames.length
    const results4 = resultsSoFar()
    runner.send(user('hold and drain', randomUUID()))
    const sleeping3 = await runner.waitFor('the fourth Sleep call streams', isSleepCall, bound(60_000), before4)
    tally.check('R4a the fourth ask calls Sleep', sleeping3 !== null, describeRequests(api))
    await sleep(300)
    control('sb-model-3', { subtype: 'set_model', model: NEW_MODEL })
    const ack4 = await runner.waitFor('the set_model answer', answerTo('sb-model-3'), bound(10_000), before4)
    runner.send(user('the drained words', randomUUID()))
    tally.check('R4b the switch is held for the boundary', ack4 !== null && payloadOf(ack4).at === 'turn-boundary', JSON.stringify(ack4))
    tally.check('R4c the held turn settles', await waitResults(results4 + 1, bound(60_000)), describeRequests(api))
    const wordsTurnOpened = await waitResults(results4 + 2, bound(30_000))
    const continuation3 = firstRequestWith(api, resultOf('tu-hold-3'))
    const drained = firstRequestWith(api, 'the drained words')
    tally.check(`R4d THE ORDER HONOURED: words sent after the held switch, during the same tool call, do not join the running turn — they wait for its end and run as the next turn on the new model (${NEW_MODEL})`, continuation3 !== undefined && drained !== undefined && drained !== continuation3 && bodyOf(drained).model === NEW_MODEL && !JSON.stringify(continuation3.body).includes('the drained words'), describeRequests(api))
    tally.check(`R4e the running turn's continuation kept its model (${MODEL}) and carried no words`, continuation3 !== undefined && bodyOf(continuation3).model === MODEL && !JSON.stringify(continuation3.body).includes('the drained words'), describeRequests(api))
    tally.check('R4f a second turn opened for the words once the held turn settled', wordsTurnOpened && indexOf(isTurnStarted, indexOf(isTurnStarted, before4) + 1) !== -1, timeline(before4))
    const result7 = indexOf(isResultFrame, before4)
    const applied4 = indexOf(appliedFrameFor('sb-model-3'), before4)
    const turn8 = indexOf(isTurnStarted, indexOf(isTurnStarted, before4) + 1)
    tally.check("R4g on the wire: the held turn's result, then the applied frame, then the words' own open edge", result7 !== -1 && applied4 !== -1 && turn8 !== -1 && result7 < applied4 && applied4 < turn8, `result ${result7} · applied ${applied4} · turn_started ${turn8} · ${timeline(before4)}`)
    runner.send(user('afterwards say yes', randomUUID()))
    tally.check('R4h the next ask settles', await waitResults(results4 + 3, bound(60_000)), describeRequests(api))
    const afterwards = firstRequestWith(api, 'afterwards say yes')
    tally.check(`R4i the next ask runs on ${NEW_MODEL} as well`, afterwards !== undefined && bodyOf(afterwards).model === NEW_MODEL, describeRequests(api))

    const before5 = frames.length
    const results5 = resultsSoFar()
    runner.send(user('hold for the mixed pair', randomUUID()))
    const sleeping4 = await runner.waitFor('the fifth Sleep call streams', isSleepCall, bound(60_000), before5)
    tally.check('R5a the fifth ask calls Sleep', sleeping4 !== null, describeRequests(api))
    await sleep(300)
    runner.send(user('the early pair words', randomUUID()))
    await sleep(200)
    control('sb-model-4', { subtype: 'set_model', model: MODEL })
    const ack5 = await runner.waitFor('the set_model answer', answerTo('sb-model-4'), bound(10_000), before5)
    runner.send(user('the late pair words', randomUUID()))
    tally.check('R5b the switch is held for the boundary', ack5 !== null && payloadOf(ack5).at === 'turn-boundary', JSON.stringify(ack5))
    tally.check('R5c the held turn settles and the late words open a turn of their own', await waitResults(results5 + 2, bound(60_000)), describeRequests(api))
    const continuation4 = firstRequestWith(api, resultOf('tu-hold-4'))
    const early = firstRequestWith(api, 'the early pair words')
    const late = firstRequestWith(api, 'the late pair words')
    tally.check(`R5d words sent BEFORE the switch keep the standing law: they join the running turn at its tool boundary and run on its model (${NEW_MODEL})`, continuation4 !== undefined && early !== undefined && early === continuation4 && bodyOf(early).model === NEW_MODEL, describeRequests(api))
    tally.check(`R5e words sent AFTER the switch wait for the turn's end and run next, on the switched model (${MODEL})`, continuation4 !== undefined && late !== undefined && late !== continuation4 && bodyOf(late).model === MODEL && !JSON.stringify(continuation4.body).includes('the late pair words'), describeRequests(api))
    tally.check('R5f the early words went to the model before the late words', early !== undefined && late !== undefined && api.messageRequests().indexOf(early) < api.messageRequests().indexOf(late), describeRequests(api))

    const before6 = frames.length
    const results6 = resultsSoFar()
    runner.send(user('hold for effort', randomUUID()))
    const sleeping5 = await runner.waitFor('the sixth Sleep call streams', isSleepCall, bound(60_000), before6)
    tally.check('R6a the sixth ask calls Sleep', sleeping5 !== null, describeRequests(api))
    await sleep(300)
    control('sb-effort-2', { subtype: 'set_effort', effort: 'high' })
    const ack6 = await runner.waitFor('the set_effort answer', answerTo('sb-effort-2'), bound(10_000), before6)
    runner.send(user('the effort words', randomUUID()))
    tally.check('R6b the effort verb is held for the boundary', ack6 !== null && payloadOf(ack6).at === 'turn-boundary', JSON.stringify(ack6))
    tally.check('R6c the held turn settles and the words open a turn of their own', await waitResults(results6 + 2, bound(60_000)), describeRequests(api))
    const continuation5 = firstRequestWith(api, resultOf('tu-hold-5'))
    const effortWords = firstRequestWith(api, 'the effort words')
    tally.check("R6d the running turn's continuation kept its effort (low) and carried no words", continuation5 !== undefined && bodyOf(continuation5).output_config?.effort === 'low' && !JSON.stringify(continuation5.body).includes('the effort words'), describeRequests(api))
    tally.check('R6e the words sent after the held effort verb run as the next turn at the held effort (high)', continuation5 !== undefined && effortWords !== undefined && effortWords !== continuation5 && bodyOf(effortWords).output_config?.effort === 'high', describeRequests(api))

    const before7 = frames.length
    const results7 = resultsSoFar()
    runner.send(user('hold with nothing held', randomUUID()))
    const sleeping6 = await runner.waitFor('the seventh Sleep call streams', isSleepCall, bound(60_000), before7)
    tally.check('R7a the seventh ask calls Sleep', sleeping6 !== null, describeRequests(api))
    await sleep(300)
    runner.send(user('the plain words', randomUUID()))
    tally.check('R7b the turn settles', await waitResults(results7 + 1, bound(60_000)), describeRequests(api))
    await sleep(500)
    const continuation6 = firstRequestWith(api, resultOf('tu-hold-6'))
    const plain = firstRequestWith(api, 'the plain words')
    tally.check(`R7c with no verb held the standing law is untouched: words sent during a tool call join the running turn at its boundary and run on its model (${MODEL})`, continuation6 !== undefined && plain !== undefined && plain === continuation6 && bodyOf(plain).model === MODEL, describeRequests(api))
    tally.check('R7d no second turn opened for them', resultsSoFar() === results7 + 1 && indexOf(isTurnStarted, indexOf(isTurnStarted, before7) + 1) === -1, timeline(before7))

    const before8 = frames.length
    const results8 = resultsSoFar()
    runner.send(user('hold for the flip', randomUUID()))
    const sleeping7 = await runner.waitFor('the eighth Sleep call streams', isSleepCall, bound(60_000), before8)
    tally.check('R8a the eighth ask calls Sleep', sleeping7 !== null, describeRequests(api))
    await sleep(300)
    control('sb-spawn-1', { subtype: 'spawn_switch', switch: 'subagents', on: false })
    const ack8 = await runner.waitFor('the spawn_switch answer', answerTo('sb-spawn-1'), bound(10_000), before8)
    const resultsAtAck8 = resultsSoFar()
    runner.send(user('the flip words', randomUUID()))
    tally.check('R8b a spawn switch sent mid-turn is answered at once with where it lands — the turn boundary — naming the switch', ack8 !== null && payloadOf(ack8).at === 'turn-boundary' && payloadOf(ack8).switch === 'subagents' && payloadOf(ack8).on === false && resultsAtAck8 === results8, JSON.stringify(ack8))
    tally.check('R8c the held turn settles', await waitResults(results8 + 1, bound(60_000)), describeRequests(api))
    const applied8 = await runner.waitFor('the spawn switch applied frame', appliedFrameFor('sb-spawn-1'), bound(10_000), before8)
    const result9 = indexOf(isResultFrame, before8)
    const appliedAt8 = indexOf(appliedFrameFor('sb-spawn-1'), before8)
    tally.check("R8d the applied frame follows the held turn's result and names the switch it landed", applied8 !== null && result9 !== -1 && appliedAt8 > result9 && applied8.verb === 'spawn_switch' && applied8.switch === 'subagents' && applied8.on === false, `result ${result9} · applied ${appliedAt8} · ${JSON.stringify(applied8)} · ${timeline(before8)}`)
    const flipWordsTurn = await waitResults(results8 + 2, bound(30_000))
    const continuation7 = firstRequestWith(api, resultOf('tu-hold-7'))
    const flipWords = firstRequestWith(api, 'the flip words')
    tally.check('R8g words sent after the held spawn switch, during the same tool call, do not join the running turn — they wait for its end and run as the next turn', flipWordsTurn && continuation7 !== undefined && flipWords !== undefined && flipWords !== continuation7 && !JSON.stringify(continuation7.body).includes('the flip words'), describeRequests(api))
    const flipTurn = indexOf(isTurnStarted, indexOf(isTurnStarted, before8) + 1)
    tally.check("R8h on the wire: the held turn's result, then the switch's applied frame, then the words' own open edge", result9 !== -1 && appliedAt8 !== -1 && flipTurn !== -1 && result9 < appliedAt8 && appliedAt8 < flipTurn, `result ${result9} · applied ${appliedAt8} · turn_started ${flipTurn} · ${timeline(before8)}`)
    control('sb-facts-1', { subtype: 'session_facts' })
    const facts8 = await runner.waitFor('the facts answer', answerTo('sb-facts-1'), bound(10_000), before8)
    const factsPayload8 = payloadOf(facts8) as { spawn_switches?: { subagents?: { on?: boolean; source?: string } }; spawnSwitches?: { subagents?: { on?: boolean; source?: string } } }
    const switches8 = factsPayload8.spawn_switches ?? factsPayload8.spawnSwitches
    tally.check("R8e the runner's own facts read the switch off, in-session, before any next turn opens", switches8?.subagents?.on === false && switches8?.subagents?.source === 'in-session', JSON.stringify(switches8))
    control('sb-spawn-2', { subtype: 'spawn_switch', switch: 'subagents', on: true })
    const ack9 = await runner.waitFor('the idle spawn_switch answer', answerTo('sb-spawn-2'), bound(10_000), before8)
    await sleep(300)
    tally.check('R8f a spawn switch while no turn runs applies now — the answer says so and no applied frame follows', ack9 !== null && payloadOf(ack9).at === 'now' && payloadOf(ack9).switch === 'subagents' && payloadOf(ack9).on === true && indexOf(appliedFrameFor('sb-spawn-2'), before8) === -1, JSON.stringify(ack9))
  } finally {
    keepFrames()
    keepRequests(api, 'runner-requests.json')
    await runner.stop(bound(5_000))
    await api.close()
  }
}

if (ONLY === undefined || ONLY === 'D') {
  tally.section('D the product end to end: a scratch daemon, a session switched mid-turn, the words sent before the turn ends')
  const home = join(SCRATCH, 'home')
  const daemonDir = join(SCRATCH, 'daemon')
  const work = join(SCRATCH, 'work')
  for (const d of [home, daemonDir, work]) mkdirSync(d, { recursive: true })
  process.env.MERCURY_DAEMON_DIR = daemonDir
  process.env.MERCURY_CONFIG_DIR = home
  delete process.env.MERCURY_HOME
  process.env.MERCURY_CONCOURSE = 'always'
  process.env.ANTHROPIC_API_KEY = 'fixture-key-000'

  const api = await startFixtureApi([
    { kind: 'text', text: 'ready.', whenBody: 'say ready' },
    { kind: 'tool_use', name: 'Sleep', input: { seconds: HOLD_SECONDS }, id: 'tu-a', whenBody: 'hold the line', preText: 'holding. ' },
    stream(resultOf('tu-a'), 'held'),
    { kind: 'text', text: 'the first words.', whenBody: 'now say more' },
    { kind: 'tool_use', name: 'Agent', input: { description: 'a probe', prompt: 'hold the probe', run_in_background: true }, id: 'tu-agent', whenBody: 'workflows-allowed', preText: 'dispatching. ' },
    { kind: 'text', text: 'dispatched.', whenBody: resultOf('tu-agent') },
    { kind: 'tool_use', name: 'Sleep', input: { seconds: PROBE_SECONDS }, id: 'tu-probe', whenBody: 'hold the probe', preText: 'probing. ' },
    { kind: 'text', text: 'probe done.', whenBody: resultOf('tu-probe') },
    { kind: 'text', text: 'noted.', whenBody: NOTIFICATION },
    { kind: 'text', text: 'the second words.', whenBody: 'say more again' },
    { kind: 'tool_use', name: 'Sleep', input: { seconds: HOLD_SECONDS }, id: 'tu-c', whenBody: 'hold once more', preText: 'holding once more. ' },
    stream(resultOf('tu-c'), 'still'),
    { kind: 'text', text: 'the third words.', whenBody: 'say it again' },
    { kind: 'tool_use', name: 'Sleep', input: { seconds: HOLD_SECONDS + 1 }, id: 'tu-d', whenBody: 'hold then switch', preText: 'holding then switching. ' },
    { kind: 'text', text: 'held through.', whenBody: resultOf('tu-d') },
    { kind: 'tool_use', name: 'Sleep', input: { seconds: HOLD_SECONDS + 1 }, id: 'tu-e', whenBody: 'hold then dial', preText: 'holding then dialling. ' },
    { kind: 'text', text: 'dialed through.', whenBody: resultOf('tu-e') },
    { kind: 'tool_use', name: 'Sleep', input: { seconds: HOLD_SECONDS + 1 }, id: 'tu-f', whenBody: 'hold then flip', preText: 'holding then flipping. ' },
    stream(resultOf('tu-f'), 'flipping'),
    { kind: 'tool_use', name: 'Agent', input: { description: 'a second probe', prompt: 'hold the probe two', run_in_background: true }, id: 'tu-agent-2', whenBody: 'spawn a probe now', preText: 'spawning. ' },
    { kind: 'text', text: 'the probe leg done.', whenBody: resultOf('tu-agent-2') },
    { kind: 'tool_use', name: 'Sleep', input: { seconds: HOLD_SECONDS + 1 }, id: 'tu-g', whenBody: 'hold then toggle workflows', preText: 'holding then toggling. ' },
    { kind: 'text', text: 'toggled through.', whenBody: resultOf('tu-g') },
    { kind: 'text', text: 'the late words answered.', whenBody: 'the late words' },
    { kind: 'text', text: 'the late effort words answered.', whenBody: 'the late effort words' },
    { kind: 'text', text: 'the toggle words answered.', whenBody: 'the toggle words' },
    { kind: 'text', text: 'probe two done.', whenBody: 'hold the probe two' },
    { kind: 'text', text: 'done.' },
    { kind: 'text', text: 'done.' },
    { kind: 'text', text: 'done.' },
    { kind: 'text', text: 'done.' },
  ])

  const logFd = openSync(join(SCRATCH, 'daemon.log'), 'a')
  const daemon = spawn(NODE, [DIST, 'daemon', 'run', work], {
    cwd: work,
    env: {
      ...process.env,
      MERCURY_CONFIG_DIR: home,
      MERCURY_DAEMON_DIR: daemonDir,
      MERCURY_CREDENTIAL_STORE: 'file',
      ANTHROPIC_API_KEY: 'fixture-key-000',
      ANTHROPIC_BASE_URL: api.url,
      MERCURY_CACHE_CLOCK: '0',
      MERCURY_PARTY: '0',
      MERCURY_TOOL_SEARCH: '0',
      BROWSER: '/usr/bin/true',
    },
    stdio: ['ignore', logFd, logFd],
  })
  if (daemon.pid !== undefined) guardPids.add(daemon.pid)
  const workerPids: number[] = []
  try {
    const { daemonControlRpc } = await import('../../src/daemon/controlSocket.ts')
    const { clientVersionFacts } = await import('../../src/daemon/handshake.ts')
    const sup = await import('../../src/daemon/concourseSupervisor.ts')
    const proj = await import('../../src/services/engine-connector/seatProjections.ts')
    const rpc = (req: Record<string, unknown>): Promise<Record<string, unknown>> => daemonControlRpc(req as never) as Promise<Record<string, unknown>>
    const client = clientVersionFacts()
    tally.check(
      'D0 the daemon serves and is ready',
      await untilAsync(async () => {
        const hello = (await rpc({ op: 'hello', proto: client.proto, clientVersion: client.version, clientBuildTree: client.buildTree })) as { ok?: boolean; ready?: boolean }
        return hello.ok === true && hello.ready === true
      }, bound(60_000)),
    )
    const dispatched = (await rpc({ op: 'concourseDispatch', clientMessageId: 'switch-boundary-A', prompt: 'say ready', workspaceDir: work, title: 'A', modelKey: OLD_SEAT_MODEL, effort: 'high' })) as { ok?: boolean; sessionId?: string; runnerId?: string }
    tally.check('D0 session A dispatched', dispatched.ok === true && dispatched.sessionId !== undefined, JSON.stringify(dispatched))
    const sessionId = dispatched.sessionId ?? ''
    const runnerId = dispatched.runnerId ?? ''
    const transcript = (): string => {
      const root = join(home, 'projects')
      if (!existsSync(root)) return ''
      for (const entry of readdirSync(root)) {
        const candidate = join(root, entry, `${sessionId}.jsonl`)
        if (existsSync(candidate)) return readFileSync(candidate, 'utf8')
      }
      return ''
    }
    tally.check("D0 A's first turn settles", await untilAsync(() => transcript().includes('ready.'), bound(60_000)))
    const record = (): { modelKey?: string; pendingModelKey?: string; effort?: string; pendingEffort?: string; pid?: number; spawnSwitches?: Partial<Record<'subagents' | 'workflows', 'on' | 'off'>>; pendingSpawnSwitches?: Array<{ kind: string; on: boolean }> } | undefined => sup.readSessionWorkers(daemonDir)[runnerId]
    await untilAsync(() => record()?.pid !== undefined, bound(30_000))
    {
      const p = record()?.pid
      if (p !== undefined) {
        workerPids.push(p)
        guardPids.add(p)
      }
    }
    const facts = () => proj.readSessionFacts(sessionId, daemonDir)
    const tail = () => proj.readSessionTail(sessionId, daemonDir)
    const send = async (words: string, id: string): Promise<boolean> => {
      const reply = (await rpc({ op: 'sessionDispatch', clientMessageId: id, prompt: words, workspaceDir: '', targetSessionId: sessionId, by: 'operator', sentAt: new Date().toISOString() })) as { ok?: boolean }
      return reply.ok === true
    }
    const seatVerb = (action: string, fields: Record<string, unknown>): Promise<{ ok?: boolean; outcome?: string; detail?: string }> => rpc({ op: 'sessionControl', action, sessionId, by: 'operator', ...fields }) as Promise<{ ok?: boolean; outcome?: string; detail?: string }>
    const idle = (): Promise<boolean> => untilAsync(() => facts()?.busy === false, bound(30_000), 50)

    tally.section('D·A the mid-turn switch: parked on the Sleep, applied before the words sent during the final stream')
    tally.check('DA1 the hold turn is taken', await send('hold the line', 'sb-hold-a'))
    tally.check('DA2 the stream holds on the Sleep call', await untilAsync(() => transcript().includes('"callId":"tu-a"'), bound(60_000), 50))
    await sleep(300)
    const switched = await seatVerb('set-model', { model: NEW_MODEL })
    tally.check("DA3 the switch parks: the receipt is 'queued' and says it applies when this turn ends", switched.ok === true && switched.outcome === 'queued' && (switched.detail ?? '').includes('applies when this turn ends'), JSON.stringify(switched))
    tally.check('DA4 the record carries the parked model beside the running one', record()?.modelKey === OLD_SEAT_MODEL && record()?.pendingModelKey === NEW_MODEL, JSON.stringify(record()))
    tally.check("DA5 the running turn's continuation goes out after the Sleep", await untilAsync(() => firstRequestWith(api, resultOf('tu-a')) !== undefined, bound(30_000), 50), describeRequests(api))
    await sleep(300)
    tally.check('DA6 the words are sent during the final stream, before the turn ends', await send('now say more', 'sb-words-a'))
    tally.check("DA7 the words' turn settles", await untilAsync(() => transcript().includes('the first words.'), bound(60_000)), describeRequests(api))
    const continuationA = firstRequestWith(api, resultOf('tu-a'))
    const wordsA = firstRequestWith(api, 'now say more')
    tally.check(`DA8 the running turn's continuation kept the old model (${OLD_SEAT_MODEL})`, continuationA !== undefined && bodyOf(continuationA).model === OLD_SEAT_MODEL, describeRequests(api))
    tally.check(`DA9 THE SYMPTOM: the words sent after the switch run on the new model (${NEW_MODEL})`, wordsA !== undefined && bodyOf(wordsA).model === NEW_MODEL, describeRequests(api))
    tally.check('DA10 once the boundary passed, the record reads the new model with nothing parked', await untilAsync(() => record()?.modelKey === NEW_MODEL && record()?.pendingModelKey === undefined, bound(15_000), 50), JSON.stringify(record()))
    tally.check('DA11 the facts read the new model with no pending switch', await untilAsync(() => facts()?.model.setting === NEW_MODEL && facts()?.pendingModel === null, bound(15_000), 50), JSON.stringify(facts()?.model))

    tally.section('D·B the completion hold: a background agent finishes, the switch lands inside the hold')
    await idle()
    const grant = (await rpc({ op: 'concourseControl', action: 'grant-workflows', sessionId, by: 'operator' })) as { ok?: boolean }
    tally.check('DB1 the delegation grant lands (its notice turn launches the background probe)', grant.ok === true, JSON.stringify(grant))
    tally.check('DB2 the probe is launched and its Sleep runs', await untilAsync(() => firstRequestWith(api, 'hold the probe') !== undefined && firstRequestWith(api, resultOf('tu-agent')) !== undefined, bound(60_000), 50), describeRequests(api))
    tally.check('DB3 the seat reads the agent wait while the probe holds the turn open', await untilAsync(() => tail()?.stateWord === 'waiting-on-agents', bound(30_000), 20), JSON.stringify(tail()))
    const holdSeen = await untilAsync(() => tail()?.stateWord !== 'waiting-on-agents', bound(60_000), 15)
    const switchedBack = await seatVerb('set-model', { model: OLD_SEAT_MODEL })
    const sentB = await send('say more again', 'sb-words-b')
    tally.check('DB4 the agent wait ends into the completion hold (the state word clears while the turn is still held open)', holdSeen && facts()?.busy === true, JSON.stringify({ tail: tail(), busy: facts()?.busy }))
    tally.check("DB5 a switch sent inside the hold is applied at once — the receipt is 'applied', not 'queued'", switchedBack.ok === true && switchedBack.outcome === 'applied', JSON.stringify(switchedBack))
    tally.check('DB6 the words are sent inside the hold', sentB)
    tally.check('DB7 the completion turn and the words settle', await untilAsync(() => transcript().includes('the second words.'), bound(60_000)), describeRequests(api))
    const notificationB = firstRequestWith(api, NOTIFICATION)
    const wordsB = firstRequestWith(api, 'say more again')
    tally.check(`DB8 the completion turn runs on the model applied in the hold (${OLD_SEAT_MODEL})`, notificationB !== undefined && bodyOf(notificationB).model === OLD_SEAT_MODEL, describeRequests(api))
    tally.check(`DB9 THE RECORDED SYMPTOM: the words sent after the switch run on it too (${OLD_SEAT_MODEL})`, wordsB !== undefined && bodyOf(wordsB).model === OLD_SEAT_MODEL, describeRequests(api))
    tally.check('DB10 the record reads the applied model with nothing parked', await untilAsync(() => record()?.modelKey === OLD_SEAT_MODEL && record()?.pendingModelKey === undefined, bound(15_000), 50), JSON.stringify(record()))

    tally.section('D·C effort parks the same way; D·D the permission mode applies at once')
    await idle()
    tally.check('DC1 the third hold turn is taken', await send('hold once more', 'sb-hold-c'))
    tally.check('DC2 the stream holds on the Sleep call', await untilAsync(() => transcript().includes('"callId":"tu-c"'), bound(60_000), 50))
    await sleep(300)
    const effortSwitched = await seatVerb('set-effort', { effort: 'low' })
    const modeSwitched = await seatVerb('set-permission-mode', { mode: 'strategy' })
    tally.check("DC3 the effort verb parks: 'queued', applies when this turn ends", effortSwitched.ok === true && effortSwitched.outcome === 'queued' && (effortSwitched.detail ?? '').includes('applies when this turn ends'), JSON.stringify(effortSwitched))
    tally.check('DC4 the record carries the parked effort beside the running one', record()?.effort === 'high' && record()?.pendingEffort === 'low', JSON.stringify(record()))
    tally.check("DD1 the permission-mode verb applies at once mid-turn — the runner's own word is 'applied'", modeSwitched.ok === true && modeSwitched.outcome === 'applied', JSON.stringify(modeSwitched))
    tally.check('DD2 the facts carry the new mode while the turn still runs', await untilAsync(() => facts()?.permissionMode === 'strategy' && facts()?.busy === true, bound(10_000), 50), JSON.stringify({ mode: facts()?.permissionMode, busy: facts()?.busy }))
    tally.check("DC5 the running turn's continuation goes out after the Sleep", await untilAsync(() => firstRequestWith(api, resultOf('tu-c')) !== undefined, bound(30_000), 50), describeRequests(api))
    await sleep(300)
    tally.check('DC6 the words are sent during the final stream, before the turn ends', await send('say it again', 'sb-words-c'))
    tally.check("DC7 the words' turn settles", await untilAsync(() => transcript().includes('the third words.'), bound(60_000)), describeRequests(api))
    const continuationC = firstRequestWith(api, resultOf('tu-c'))
    const wordsC = firstRequestWith(api, 'say it again')
    tally.check("DC8 the running turn's continuation kept the effort it started on (high)", continuationC !== undefined && bodyOf(continuationC).output_config?.effort === 'high', describeRequests(api))
    tally.check('DC9 THE SYMPTOM FOR EFFORT: the words sent after the switch run at the new effort (low)', wordsC !== undefined && bodyOf(wordsC).output_config?.effort === 'low', describeRequests(api))
    tally.check('DC10 the record reads the new effort with nothing parked', await untilAsync(() => record()?.effort === 'low' && record()?.pendingEffort === undefined, bound(15_000), 50), JSON.stringify(record()))
    tally.check('DC11 the facts read the new effort', await untilAsync(() => facts()?.effort === 'low', bound(15_000), 50), JSON.stringify(facts()?.effort))

    tally.section('D·F the drained shape: the switch during the Sleep, then words during the same Sleep — the words wait for the turn and run on the new model')
    await idle()
    tally.check('DF1 the hold turn is taken', await send('hold then switch', 'sb-hold-f'))
    tally.check('DF2 the stream holds on the Sleep call', await untilAsync(() => transcript().includes('"callId":"tu-d"'), bound(60_000), 50))
    await sleep(300)
    const switchedF = await seatVerb('set-model', { model: NEW_MODEL })
    tally.check("DF3 the switch parks: 'queued', applies when this turn ends", switchedF.ok === true && switchedF.outcome === 'queued' && (switchedF.detail ?? '').includes('applies when this turn ends'), JSON.stringify(switchedF))
    const continuationOutF = firstRequestWith(api, resultOf('tu-d')) !== undefined
    const sentF = await send('the late words', 'sb-words-f')
    tally.check('DF4 the words are sent during the same Sleep, before the continuation goes out', sentF && !continuationOutF, describeRequests(api))
    tally.check('DF5 the held turn settles', await untilAsync(() => transcript().includes('held through.'), bound(60_000)), describeRequests(api))
    const wordsTurnF = await untilAsync(() => transcript().includes('the late words answered.'), bound(30_000))
    const continuationF = firstRequestWith(api, resultOf('tu-d'))
    const wordsF = firstRequestWith(api, 'the late words')
    tally.check(`DF6 THE SYMPTOM: the words sent after the switch do not join the running turn — they wait for its end and run as the next turn on ${NEW_MODEL}`, wordsTurnF && continuationF !== undefined && wordsF !== undefined && wordsF !== continuationF && bodyOf(wordsF).model === NEW_MODEL, describeRequests(api))
    tally.check(`DF7 the running turn's continuation kept ${OLD_SEAT_MODEL} and carried no words`, continuationF !== undefined && bodyOf(continuationF).model === OLD_SEAT_MODEL && !JSON.stringify(continuationF.body).includes('the late words'), describeRequests(api))
    tally.check('DF8 the record reads the new model with nothing parked', await untilAsync(() => record()?.modelKey === NEW_MODEL && record()?.pendingModelKey === undefined, bound(15_000), 50), JSON.stringify(record()))
    tally.check('DF9 the facts read the new model with no pending switch', await untilAsync(() => facts()?.model.setting === NEW_MODEL && facts()?.pendingModel === null, bound(15_000), 50), JSON.stringify(facts()?.model))

    tally.section('D·G the effort twin of the drained shape')
    await idle()
    tally.check('DG1 the hold turn is taken', await send('hold then dial', 'sb-hold-g'))
    tally.check('DG2 the stream holds on the Sleep call', await untilAsync(() => transcript().includes('"callId":"tu-e"'), bound(60_000), 50))
    await sleep(300)
    const dialedG = await seatVerb('set-effort', { effort: 'high' })
    tally.check("DG3 the effort verb parks: 'queued', applies when this turn ends", dialedG.ok === true && dialedG.outcome === 'queued' && (dialedG.detail ?? '').includes('applies when this turn ends'), JSON.stringify(dialedG))
    const continuationOutG = firstRequestWith(api, resultOf('tu-e')) !== undefined
    const sentG = await send('the late effort words', 'sb-words-g')
    tally.check('DG4 the words are sent during the same Sleep, before the continuation goes out', sentG && !continuationOutG, describeRequests(api))
    tally.check('DG5 the held turn settles', await untilAsync(() => transcript().includes('dialed through.'), bound(60_000)), describeRequests(api))
    const wordsTurnG = await untilAsync(() => transcript().includes('the late effort words answered.'), bound(30_000))
    const continuationG = firstRequestWith(api, resultOf('tu-e'))
    const wordsG = firstRequestWith(api, 'the late effort words')
    tally.check('DG6 THE SYMPTOM FOR EFFORT: the words sent after the parked effort wait for the turn and run as the next turn at the new effort (high)', wordsTurnG && continuationG !== undefined && wordsG !== undefined && wordsG !== continuationG && bodyOf(wordsG).output_config?.effort === 'high', describeRequests(api))
    tally.check("DG7 the running turn's continuation kept its effort (low) and carried no words", continuationG !== undefined && bodyOf(continuationG).output_config?.effort === 'low' && !JSON.stringify(continuationG.body).includes('the late effort words'), describeRequests(api))
    tally.check('DG8 the record reads the new effort with nothing parked', await untilAsync(() => record()?.effort === 'high' && record()?.pendingEffort === undefined, bound(15_000), 50), JSON.stringify(record()))

    tally.section("D·H the spawn switches on the boundary: a sub-agents switch made mid-turn lands at the turn's end, before the next turn's launch")
    await idle()
    tally.check('DH1 the hold turn is taken', await send('hold then flip', 'sb-hold-h'))
    tally.check('DH2 the stream holds on the Sleep call', await untilAsync(() => transcript().includes('"callId":"tu-f"'), bound(60_000), 50))
    await sleep(300)
    const flipped = await seatVerb('set-spawn-switch', { spawnSwitch: { kind: 'subagents', on: false } })
    tally.check("DH3 the switch parks: the receipt is 'queued' and says it applies when this turn ends", flipped.ok === true && flipped.outcome === 'queued' && (flipped.detail ?? '').includes('applies when this turn ends'), JSON.stringify(flipped))
    tally.check('DH4 the record parks the toggle beside the running turn', (record()?.pendingSpawnSwitches ?? []).some(p => p.kind === 'subagents' && p.on === false) && record()?.spawnSwitches?.subagents === undefined, JSON.stringify({ parked: record()?.pendingSpawnSwitches, switches: record()?.spawnSwitches }))
    tally.check("DH5 the running turn's continuation goes out after the Sleep", await untilAsync(() => firstRequestWith(api, resultOf('tu-f')) !== undefined, bound(30_000), 50), describeRequests(api))
    await sleep(300)
    tally.check('DH6 the words asking for a spawn are sent during the final stream, before the turn ends', await send('spawn a probe now', 'sb-words-h'))
    tally.check("DH7 the words run as the next turn and its launch settles", await untilAsync(() => transcript().includes('the probe leg done.'), bound(90_000)), describeRequests(api))
    const launchH = firstRequestWith(api, resultOf('tu-agent-2'))
    const launchBodyH = launchH === undefined ? '' : JSON.stringify(launchH.body)
    const launchMetTheSwitch = launchBodyH.includes('sub-agents are off for this session') || launchBodyH.includes('No such tool available: Agent')
    tally.check('DH8 THE SYMPTOM: the switch landed before the next turn, so its launch met the switch — the Agent tool gone from the roster, or the valve\'s receipt — instead of starting a probe', launchH !== undefined && launchMetTheSwitch, launchH === undefined ? describeRequests(api) : launchBodyH.slice(launchBodyH.indexOf('tu-agent-2'), launchBodyH.indexOf('tu-agent-2') + 260))
    tally.check("DH9 the record reads the switch off with nothing parked", await untilAsync(() => record()?.spawnSwitches?.subagents === 'off' && (record()?.pendingSpawnSwitches ?? []).length === 0, bound(15_000), 50), JSON.stringify({ parked: record()?.pendingSpawnSwitches, switches: record()?.spawnSwitches }))
    tally.check('DH10 the facts read the switch off, in-session, with no parked toggle', await untilAsync(() => facts()?.spawnSwitches?.subagents.on === false && facts()?.spawnSwitches?.subagents.source === 'in-session' && facts()?.pendingSpawnSwitches === undefined, bound(15_000), 50), JSON.stringify(facts()?.spawnSwitches))

    tally.section('D·I the drained shape after a spawn switch: a workflows switch during the Sleep, then words during the same Sleep — the words wait for the turn')
    await idle()
    tally.check('DI1 the hold turn is taken', await send('hold then toggle workflows', 'sb-hold-i'))
    tally.check('DI2 the stream holds on the Sleep call', await untilAsync(() => transcript().includes('"callId":"tu-g"'), bound(60_000), 50))
    await sleep(300)
    const toggledI = await seatVerb('set-spawn-switch', { spawnSwitch: { kind: 'workflows', on: false } })
    tally.check("DI3 the switch parks: 'queued', applies when this turn ends", toggledI.ok === true && toggledI.outcome === 'queued' && (toggledI.detail ?? '').includes('applies when this turn ends'), JSON.stringify(toggledI))
    const continuationOutI = firstRequestWith(api, resultOf('tu-g')) !== undefined
    const sentI = await send('the toggle words', 'sb-words-i')
    tally.check('DI4 the words are sent during the same Sleep, before the continuation goes out', sentI && !continuationOutI, describeRequests(api))
    tally.check('DI5 the held turn settles', await untilAsync(() => transcript().includes('toggled through.'), bound(60_000)), describeRequests(api))
    const wordsTurnI = await untilAsync(() => transcript().includes('the toggle words answered.'), bound(30_000))
    const continuationI = firstRequestWith(api, resultOf('tu-g'))
    const wordsI = firstRequestWith(api, 'the toggle words')
    tally.check('DI6 THE SYMPTOM: the words sent after the parked switch do not join the running turn — they wait for its end and run as the next turn', wordsTurnI && continuationI !== undefined && wordsI !== undefined && wordsI !== continuationI, describeRequests(api))
    tally.check("DI7 the running turn's continuation carried no words", continuationI !== undefined && !JSON.stringify(continuationI.body).includes('the toggle words'), describeRequests(api))
    tally.check('DI8 the record reads workflows off with nothing parked', await untilAsync(() => record()?.spawnSwitches?.workflows === 'off' && (record()?.pendingSpawnSwitches ?? []).length === 0, bound(15_000), 50), JSON.stringify({ parked: record()?.pendingSpawnSwitches, switches: record()?.spawnSwitches }))
    tally.check('DI9 the facts read workflows off, in-session, with no parked toggle', await untilAsync(() => facts()?.spawnSwitches?.workflows.on === false && facts()?.spawnSwitches?.workflows.source === 'in-session' && facts()?.pendingSpawnSwitches === undefined, bound(15_000), 50), JSON.stringify(facts()?.spawnSwitches))

    tally.section("D·E the connector's facts after the boundary")
    const seat = await import('../../src/services/engine-connector/daemonConnector.ts')
    const paths = await import('../../src/utils/sessionStorage/paths.ts')
    const conn = seat.daemonSessionConnectorFor({ sessionId, runnerId, title: 'A', projectLabel: basename(work), workspaceId: work, home: paths.getProjectDir(work), modelKey: OLD_SEAT_MODEL })
    await conn.attach()
    tally.check('DE1 the connector reads the applied model with no pending switch and the applied effort', await untilAsync(() => conn.modelFacts().effective === NEW_MODEL && conn.modelFacts().pendingSwitch === null && conn.modelFacts().effort === 'high', bound(15_000), 50), JSON.stringify(conn.modelFacts()))
    conn.detach()
  } finally {
    keepRequests(api, 'daemon-requests.json')
    try {
      await (await import('../../src/daemon/controlSocket.ts')).daemonControlRpc({ op: 'shutdown', reapWorkers: true } as never)
    } catch {
    }
    daemon.kill('SIGTERM')
    await sleep(500)
    for (const pid of workerPids) {
      try {
        process.kill(pid, 'SIGKILL')
      } catch {
      }
    }
    try {
      daemon.kill('SIGKILL')
    } catch {
    }
    await api.close()
  }
}

if (tally.failed() === 0) rmSync(SCRATCH, { recursive: true, force: true })
else console.log(`[keep] ${SCRATCH}`)
tally.finish()
