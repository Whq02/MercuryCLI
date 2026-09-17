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
}, bound(360_000))
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
    const continuation3 = firstRequestWith(api, resultOf('tu-hold-3'))
    const drained = firstRequestWith(api, 'the drained words')
    tally.check(`R4d THE STANDING LAW: words sent before a tool boundary join the running turn at that boundary and run on its model (${MODEL}) — not as a turn of their own`, continuation3 !== undefined && drained !== undefined && drained === continuation3 && bodyOf(drained).model === MODEL, describeRequests(api))
    await sleep(500)
    tally.check('R4e no second turn opened for the drained words', resultsSoFar() === results4 + 1 && indexOf(isTurnStarted, indexOf(isTurnStarted, before4) + 1) === -1, timeline(before4))
    runner.send(user('afterwards say yes', randomUUID()))
    tally.check('R4f the next ask settles', await waitResults(results4 + 2, bound(60_000)), describeRequests(api))
    const afterwards = firstRequestWith(api, 'afterwards say yes')
    tally.check(`R4g the held switch applied at that turn's end: the next ask runs on ${NEW_MODEL}`, afterwards !== undefined && bodyOf(afterwards).model === NEW_MODEL, describeRequests(api))
    const result7 = indexOf(isResultFrame, before4)
    const applied4 = indexOf(appliedFrameFor('sb-model-3'), before4)
    tally.check("R4h the applied frame followed the held turn's result", result7 !== -1 && applied4 !== -1 && result7 < applied4, `result ${result7} · applied ${applied4} · ${timeline(before4)}`)
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
    const record = (): { modelKey?: string; pendingModelKey?: string; effort?: string; pendingEffort?: string; pid?: number } | undefined => sup.readSessionWorkers(daemonDir)[runnerId]
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

    tally.section("D·E the connector's facts after the boundary")
    const seat = await import('../../src/services/engine-connector/daemonConnector.ts')
    const paths = await import('../../src/utils/sessionStorage/paths.ts')
    const conn = seat.daemonSessionConnectorFor({ sessionId, runnerId, title: 'A', projectLabel: basename(work), workspaceId: work, home: paths.getProjectDir(work), modelKey: OLD_SEAT_MODEL })
    await conn.attach()
    tally.check('DE1 the connector reads the applied model with no pending switch and the applied effort', await untilAsync(() => conn.modelFacts().effective === OLD_SEAT_MODEL && conn.modelFacts().pendingSwitch === null && conn.modelFacts().effort === 'low', bound(15_000), 50), JSON.stringify(conn.modelFacts()))
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
