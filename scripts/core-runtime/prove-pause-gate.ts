#!/usr/bin/env bun
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { z } from 'zod/v4'
import type { WorkRowV1 } from '../../src/services/engine-connector/types.ts'

const ROOT = join(import.meta.dir, '..', '..')
process.env.MERCURY_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'pause-gate-laws-'))
const daemonDir = mkdtempSync(join(tmpdir(), 'pause-gate-daemon-'))
process.env.MERCURY_DAEMON_DIR = daemonDir
process.env.MERCURY_CREDENTIAL_STORE = 'file'
process.env.ANTHROPIC_API_KEY = 'proof-key-ci-gate-not-a-real-key'
for (const k of ['MERCURY_BARE', 'MERCURY_EFFORT_LEVEL', 'MERCURY_MAX_OUTPUT_TOKENS', 'MERCURY_BLOCKING_LIMIT_OVERRIDE', 'MERCURY_COMPACT', 'MERCURY_AUTO_COMPACT', 'NODE_ENV', 'MERCURY_SCRIPTED_STREAM']) {
  delete process.env[k]
}

const { query } = await import('../../src/query.ts')
const bootstrap = await import('../../src/bootstrap/state.ts')
bootstrap.setIsInteractive(false)
const { enableConfigs } = await import('../../src/utils/config/globalConfig.ts')
enableConfigs()
const { getDefaultAppState } = await import('../../src/state/AppStateStore.ts')
const { createAssistantMessage, createUserMessage } = await import('../../src/utils/messages.ts')
const { createFileStateCacheWithSizeLimit } = await import('../../src/utils/fileStateCache.ts')
const { drainRows } = await import('../../src/utils/sdkEventQueue.ts')
const seat = await import('../../src/daemon/sessionSeat.ts')
const { updateConcourseWorkers } = await import('../../src/daemon/concourseWorkers.ts')
const { sessionFactsToWire } = await import('../../src/services/engine-connector/seatWire.ts')
const { readSessionFacts } = await import('../../src/services/engine-connector/seatProjections.ts')

type GateModule = typeof import('../../src/run-core/pauseGate.ts')
const gateModule: GateModule | null = await import('../../src/run-core/pauseGate.ts').catch(() => null)
const gate = gateModule?.operatorPauseGate ?? null
let failures = 0
let checks = 0
function check(label: string, cond: boolean, detail = ''): void {
  checks++
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}
function section(t: string): void {
  console.log('─'.repeat(76) + '\n' + t)
}
const j = (v: unknown): string => JSON.stringify(v)
const read = (rel: string): string => readFileSync(join(ROOT, rel), 'utf8')

const guard = setTimeout(() => {
  console.log('\nTIMEOUT — the pause-gate proof exceeded 180s')
  process.exit(1)
}, 180_000)
guard.unref?.()

console.log('pause gate — one process-wide park at the two safe points')
console.log(`  gate module: ${gateModule === null ? 'ABSENT (no src/run-core/pauseGate.ts — pause is a no-op here)' : 'present'}`)

type Latch = { promise: Promise<void>; open: () => void; opened: boolean }
function latch(): Latch {
  let open = (): void => {}
  const out: Latch = { promise: new Promise<void>(resolve => { open = resolve }), open: () => { out.opened = true; open() }, opened: false }
  return out
}
const abortable = (signal: AbortSignal, waited: Promise<void>): Promise<void> =>
  signal.aborted ? Promise.resolve() : new Promise<void>(resolve => {
    const done = (): void => { signal.removeEventListener('abort', done); resolve() }
    signal.addEventListener('abort', done, { once: true })
    void waited.then(done)
  })
const settle = (ms = 40): Promise<void> => new Promise(resolve => setTimeout(resolve, ms))
async function until(cond: () => boolean, what: string, ms = 8_000): Promise<boolean> {
  const t0 = Date.now()
  while (!cond()) {
    if (Date.now() - t0 > ms) {
      console.log(`  [WAIT TIMEOUT] ${what}`)
      return false
    }
    await settle(5)
  }
  return true
}

type AnyMsg = Record<string, unknown> & { type?: string }
function stripMsg(m: unknown): unknown {
  const msg = m as AnyMsg
  if (!msg || typeof msg !== 'object') return msg
  const t = msg.type
  if (t === 'user' || t === 'assistant') {
    const inner = msg.message as { content?: unknown } | undefined
    const c = inner?.content
    return {
      t,
      meta: msg.isMeta === true ? true : undefined,
      c: typeof c === 'string' ? c : ((c as AnyMsg[] | undefined) ?? []).map(b => ({ bt: b.type, text: b.text, id: b.id, name: b.name, tuid: b.tool_use_id, e: b.is_error, bc: typeof b.content === 'string' ? b.content : undefined, input: b.input })),
    }
  }
  if (t === 'attachment') return { t, at: (msg.attachment as AnyMsg | undefined)?.type }
  if (t === 'system') return { t, text: msg.content ?? msg.text }
  return { t }
}
const digest = (msgs: unknown[]): string => JSON.stringify(msgs.filter(m => (m as AnyMsg).type !== 'attachment').map(stripMsg))

const RUNS = ['main', 'scout', 'reviewer'] as const
type RunName = (typeof RUNS)[number]
const MODEL = 'claude-opus-4-8'

type ToolName = 'SerialTool' | 'ReadishTool'
type LoopSpec = { name: string; seat: string | null; tool: ToolName }
const DEFAULT_SPECS: LoopSpec[] = RUNS.map(run => ({ name: run, seat: run === 'main' ? null : run, tool: run === 'main' ? 'SerialTool' : 'ReadishTool' }))

type CallRecord = { run: string; ordinal: number; messages: unknown[] }
type ToolStart = { run: string; tool: string; input: Record<string, unknown> }
type TaskLike = Record<string, unknown> & { id: string; type: string; status: string }

type Rig = {
  calls: CallRecord[]
  toolStarts: ToolStart[]
  tasks: Record<string, TaskLike>
  modelLatch: (run: string, ordinal: number) => Latch
  toolLatch: (run: string, ordinal: number) => Latch
  yieldsOf: (run: string) => unknown[]
  terminalOf: (run: string) => Record<string, unknown> | null
  controllerOf: (run: string) => AbortController
  done: (run: string) => Promise<void>
  seatOf: (run: string) => string
  waitOf: (run: string) => string | null
  waitAt: (run: string) => number | null
  start: (spec: LoopSpec) => void
}

const allowAll = async (_tool: unknown, input: Record<string, unknown>) => ({ behavior: 'allow', updatedInput: input, decisionReason: { type: 'other', reason: 'rig' } }) as never

function toolUseOf(run: string, ordinal: number, tool: ToolName = run === 'main' ? 'SerialTool' : 'ReadishTool'): { id: string; name: string; input: Record<string, unknown> } {
  return { id: `${run}_tu${ordinal}`, name: tool, input: { text: `${run}-${ordinal}` } }
}

function buildRig(specs: LoopSpec[] = DEFAULT_SPECS, tasks: Record<string, TaskLike> = {}): Rig {
  const calls: CallRecord[] = []
  const toolStarts: ToolStart[] = []
  const modelLatches = new Map<string, Latch>()
  const toolLatches = new Map<string, Latch>()
  const latchIn = (map: Map<string, Latch>, key: string): Latch => {
    let l = map.get(key)
    if (l === undefined) {
      l = latch()
      map.set(key, l)
    }
    return l
  }
  const modelLatch = (run: string, ordinal: number): Latch => latchIn(modelLatches, `${run}:${ordinal}`)
  const toolLatch = (run: string, ordinal: number): Latch => latchIn(toolLatches, `${run}:${ordinal}`)
  const runOf = (text: string): string => text.split('-')[0] as string
  const ordinalOf = (text: string): number => Number(text.split('-')[1])

  function makeTool(name: string, concurrencySafe: boolean): never {
    return {
      name,
      async description() { return 'rig tool' },
      async prompt() { return 'rig tool' },
      inputSchema: z.object({ text: z.string() }),
      userFacingName: () => name,
      isEnabled: () => true,
      isConcurrencySafe: () => concurrencySafe,
      isReadOnly: () => true,
      isMcp: false,
      needsPermissions: () => false,
      async validateInput() { return { result: true } },
      call: async (input: Record<string, unknown>, ctx: Record<string, unknown>) => {
        const text = String(input.text)
        toolStarts.push({ run: runOf(text), tool: name, input: { ...input } })
        await abortable((ctx.abortController as AbortController).signal, toolLatch(runOf(text), ordinalOf(text)).promise)
        return { data: `slow:${text}` }
      },
      mapToolResultToToolResultBlockParam: (data: unknown, toolUseId: string) => ({ type: 'tool_result', tool_use_id: toolUseId, content: String(data) }),
    } as never
  }
  const tools = [makeTool('SerialTool', false), makeTool('ReadishTool', true)]

  const yields = new Map<string, unknown[]>()
  const terminals = new Map<string, Record<string, unknown>>()
  const controllers = new Map<string, AbortController>()
  const dones = new Map<string, Promise<void>>()
  const seats = new Map<string, string>()
  const waits = new Map<string, string | null>()
  const waitAts = new Map<string, number>()

  const start = (spec: LoopSpec): void => {
    const run = spec.name
    seats.set(run, spec.seat ?? 'main')
    const ordinals = { n: 0 }
    async function* callModel(req: { messages: unknown[]; signal: AbortSignal; options: Record<string, unknown> }): AsyncGenerator<unknown, void> {
      const ordinal = ++ordinals.n
      calls.push({ run, ordinal, messages: [...req.messages] })
      yield { type: 'stream_event', event: { type: 'ping' } }
      await abortable(req.signal, modelLatch(run, ordinal).promise)
      if (req.signal.aborted) return
      if (ordinal >= 3) {
        yield createAssistantMessage({ content: `${run} done.` })
        return
      }
      const use = toolUseOf(run, ordinal, spec.tool)
      const message = createAssistantMessage({ content: [{ type: 'tool_use', id: use.id, name: use.name, input: use.input }] as never })
      message.message.stop_reason = 'tool_use'
      yield message
    }
    let appState: Record<string, unknown> = { ...(getDefaultAppState() as unknown as Record<string, unknown>), effortValue: 'high', tasks }
    const controller = new AbortController()
    controllers.set(run, controller)
    const ctx: Record<string, unknown> = {
      abortController: controller,
      options: {
        commands: [],
        tools,
        engineModel: MODEL,
        thinkingConfig: { type: 'disabled' },
        mcpClients: [],
        mcpResources: {},
        isNonInteractiveSession: true,
        debug: false,
        verbose: false,
        agentDefinitions: { activeAgents: [], allAgents: [] },
      },
      getAppState: () => appState,
      setAppState: (f: (prev: never) => never) => { appState = f(appState as never) as unknown as Record<string, unknown> },
      messages: [],
      readFileState: createFileStateCacheWithSizeLimit(100),
      setInProgressToolUseIDs: () => {},
      setResponseLength: () => {},
      updateFileHistoryState: () => {},
      updateAttributionState: () => {},
      agentId: spec.seat === null ? undefined : `agent-${run}`,
      ...(spec.seat === null ? {} : { seatHolder: spec.seat }),
      onSeatWait: (words: string | null) => {
        waits.set(run, words)
        waitAts.set(run, Date.now())
      },
    }
    const gen = query({
      messages: [createUserMessage({ content: `hello from ${run}` })] as never,
      systemPrompt: ['rig system prompt'] as never,
      userContext: {},
      systemContext: {},
      canUseTool: allowAll as never,
      toolUseContext: ctx as never,
      querySource: (spec.seat === null ? 'sdk' : `agent:builtin:${run}`) as never,
      deps: {
        callModel: callModel as never,
        autocompact: (async () => ({ wasCompacted: false })) as never,
        microcompact: (async (messages: unknown[]) => ({ messages })) as never,
        uuid: ((): (() => string) => { let n = 0; return () => `00000000-0000-4000-8000-${run.length}${String(++n).padStart(11, '0')}` })(),
      },
    })
    const collected: unknown[] = []
    yields.set(run, collected)
    dones.set(run, (async () => {
      let r = await gen.next()
      while (!r.done) {
        collected.push(r.value)
        r = await gen.next()
      }
      terminals.set(run, r.value as Record<string, unknown>)
    })())
  }
  for (const spec of specs) start(spec)

  return {
    calls,
    toolStarts,
    tasks,
    modelLatch,
    toolLatch,
    yieldsOf: run => yields.get(run) ?? [],
    terminalOf: run => terminals.get(run) ?? null,
    controllerOf: run => controllers.get(run)!,
    done: run => dones.get(run)!,
    seatOf: run => seats.get(run) ?? 'main',
    waitOf: run => waits.get(run) ?? null,
    waitAt: run => waitAts.get(run) ?? null,
    start,
  }
}

const callsOf = (rig: Rig, run: string): CallRecord[] => rig.calls.filter(c => c.run === run)
const startsOf = (rig: Rig, run: string): ToolStart[] => rig.toolStarts.filter(s => s.run === run)
const assistantToolUses = (rig: Rig, run: string): number => rig.yieldsOf(run).filter(m => (m as AnyMsg).type === 'assistant' && JSON.stringify((m as AnyMsg).message).includes('tool_use')).length
const toolResults = (rig: Rig, run: string): number => rig.yieldsOf(run).filter(m => (m as AnyMsg).type === 'user' && JSON.stringify((m as AnyMsg).message).includes('tool_result')).length

section('C0 CONTROL — the same three loops with no pause: their requests are the yardstick')
const control = buildRig()
for (const run of RUNS) for (const n of [1, 2, 3]) { control.modelLatch(run, n).open(); if (n < 3) control.toolLatch(run, n).open() }
await Promise.all(RUNS.map(run => control.done(run)))
check('control: every loop completes', RUNS.every(run => control.terminalOf(run)?.reason === 'completed'), RUNS.map(run => `${run}=${control.terminalOf(run)?.reason}`).join(' '))
check('control: three model calls and two tool starts per loop', RUNS.every(run => callsOf(control, run).length === 3 && startsOf(control, run).length === 2), RUNS.map(run => `${run}: ${callsOf(control, run).length} calls, ${startsOf(control, run).length} tools`).join(' · '))

section('P1 A PAUSE PARKS EVERY LOOP AT ITS NEXT SAFE POINT — a stream in flight finishes its tokens, no tool starts')
const rig = buildRig()
const pause = (): boolean => gate?.pause() ?? false
const resume = (): boolean => gate?.resume() ?? false
const parked = (): string[] => [...(gate?.parked() ?? [])]
await until(() => RUNS.every(run => callsOf(rig, run).length === 1), 'the three first model calls in flight')
check('three model calls in flight before the pause (one per loop)', RUNS.every(run => callsOf(rig, run).length === 1))
const pausedNow = pause()
check('the pause closes the gate', pausedNow && gate?.paused() === true, gateModule === null ? 'no gate module: pause() is a no-op' : String(gate?.state()))
for (const run of RUNS) rig.modelLatch(run, 1).open()
await until(() => RUNS.every(run => assistantToolUses(rig, run) === 1), 'the three in-flight streams finish their tokens')
check('every in-flight stream finished its tokens after the pause (the tool_use assistant settled in each loop)', RUNS.every(run => assistantToolUses(rig, run) === 1), RUNS.map(run => `${run}=${assistantToolUses(rig, run)}`).join(' '))
await until(() => parked().length === RUNS.length, 'the three loops park at the tool seam')
check('no tool starts while paused (the tool seam parks each block)', rig.toolStarts.length === 0, `${rig.toolStarts.length} tool call(s) proceeded while paused: ${rig.toolStarts.map(s => `${s.run}:${s.tool}(${String(s.input.text)})`).join(', ')}`)
check('the three loops are parked, each under its own seat (main, scout, reviewer)', JSON.stringify([...parked()].sort()) === JSON.stringify(['main', 'reviewer', 'scout']), `parked=${JSON.stringify(parked())}`)
check('no further model call starts while paused', rig.calls.length === 3, `${rig.calls.length} model calls`)

section('P2 RESUME RELEASES THEM ALL FROM WHERE THEY STOPPED — the next tool is the one the model asked for, byte-identical')
const resumedNow = resume()
check('the resume opens the gate and releases every parked wait', resumedNow && parked().length === 0, `resumed=${resumedNow} parked=${JSON.stringify(parked())}`)
await until(() => rig.toolStarts.length === 3, 'the three tools start after the resume')
check('the three tools started after the resume, one per loop', rig.toolStarts.length === 3 && RUNS.every(run => startsOf(rig, run).length === 1), rig.toolStarts.map(s => `${s.run}:${s.tool}`).join(', '))
check('each tool ran with the exact input its loop\'s model asked for', RUNS.every(run => JSON.stringify(startsOf(rig, run)[0]?.input) === JSON.stringify(toolUseOf(run, 1).input) && startsOf(rig, run)[0]?.tool === toolUseOf(run, 1).name), RUNS.map(run => `${run}: ${JSON.stringify(startsOf(rig, run)[0])}`).join(' · '))

section('P3 A SECOND PAUSE WHILE THE TOOLS RUN — a running tool finishes; no model call starts; the loops park before their next call')
pause()
check('the gate is closed again', gate?.paused() === true, gateModule === null ? 'no gate module' : '')
for (const run of RUNS) rig.toolLatch(run, 1).open()
await until(() => RUNS.every(run => toolResults(rig, run) === 1), 'the three running tools finish and their results settle')
check('every running tool finished and its tool_result settled after the pause', RUNS.every(run => toolResults(rig, run) === 1), RUNS.map(run => `${run}=${toolResults(rig, run)}`).join(' '))
await until(() => parked().length === RUNS.length, 'the three loops park at the model seam')
check('no model call starts while paused (the model seam parks before the permit and the request)', rig.calls.length === 3, `${rig.calls.length} model calls — ${rig.calls.length - 3} further call(s) proceeded while paused: ${rig.calls.filter(c => c.ordinal > 1).map(c => `${c.run}.c${c.ordinal}`).join(', ')}`)
check('the three loops are parked at the model seam under their seats', JSON.stringify([...parked()].sort()) === JSON.stringify(['main', 'reviewer', 'scout']), `parked=${JSON.stringify(parked())}`)

section('P4 AN ABORT OF ONE RUN UNWINDS IT WHILE THE REST STAY PARKED')
rig.controllerOf('reviewer').abort('crew-stop')
await rig.done('reviewer')
check('the aborted run unwound through its own abort road (terminal aborted_streaming, the park released by its signal)', rig.terminalOf('reviewer')?.reason === 'aborted_streaming', JSON.stringify(rig.terminalOf('reviewer')))
check('the aborted run made no further model call', callsOf(rig, 'reviewer').length === 1, String(callsOf(rig, 'reviewer').length))
check('the gate stays closed after the abort', gate?.paused() === true, gateModule === null ? 'no gate module' : '')
check('the other two loops stay parked (main, scout) and made no call', JSON.stringify([...parked()].sort()) === JSON.stringify(['main', 'scout']) && callsOf(rig, 'main').length === 1 && callsOf(rig, 'scout').length === 1, `parked=${JSON.stringify(parked())} main=${callsOf(rig, 'main').length} scout=${callsOf(rig, 'scout').length}`)

section('P5 RESUME AGAIN — the two survivors make the exact call they were about to make, then run to completion')
resume()
await until(() => callsOf(rig, 'main').length === 2 && callsOf(rig, 'scout').length === 2, 'the two survivors make their second call')
check('the survivors made their second model call after the resume', callsOf(rig, 'main').length === 2 && callsOf(rig, 'scout').length === 2, `main=${callsOf(rig, 'main').length} scout=${callsOf(rig, 'scout').length}`)
for (const run of ['main', 'scout'] as const) {
  const pausedDigest = digest(callsOf(rig, run)[1]!.messages)
  const controlDigest = digest(callsOf(control, run)[1]!.messages)
  let at = 0
  while (at < pausedDigest.length && pausedDigest[at] === controlDigest[at]) at++
  check(`${run}: the resumed request's conversation rows (user, assistant, tool_result) are byte-identical to the unpaused control's second request`, pausedDigest === controlDigest, `first difference at ${at}: paused=…${pausedDigest.slice(Math.max(0, at - 60), at + 120)} control=…${controlDigest.slice(Math.max(0, at - 60), at + 120)}`)
}
for (const run of ['main', 'scout'] as const) for (const n of [2, 3]) { rig.modelLatch(run, n).open(); if (n < 3) rig.toolLatch(run, n).open() }
await Promise.all([rig.done('main'), rig.done('scout')])
check('the survivors complete (terminal completed) with three calls and two tools each', (['main', 'scout'] as const).every(run => rig.terminalOf(run)?.reason === 'completed' && callsOf(rig, run).length === 3 && startsOf(rig, run).length === 2), (['main', 'scout'] as const).map(run => `${run}: ${rig.terminalOf(run)?.reason} ${callsOf(rig, run).length} calls ${startsOf(rig, run).length} tools`).join(' · '))
check('every request of a survivor equals the control\'s request of the same ordinal (nothing was re-sent, nothing was skipped)', (['main', 'scout'] as const).every(run => callsOf(rig, run).every((c, i) => digest(c.messages) === digest(callsOf(control, run)[i]!.messages))))
check('the gate is open and nothing is parked at the end', gate?.paused() === false && parked().length === 0, gateModule === null ? 'no gate module' : JSON.stringify(gate?.state()))

section('G1 THE GATE\'S OWN LAWS — park is immediate while open, releases all on resume, releases one on its own abort')
if (gateModule === null) {
  check('the gate module exists (src/run-core/pauseGate.ts)', false, 'absent on this tree')
} else {
  const g = gateModule.createPauseGate()
  let immediate = false
  await Promise.race([g.park(new AbortController().signal, 'x').then(() => { immediate = true }), settle(20)])
  check('park resolves at once while the gate is open', immediate)
  check('pause() reports the change; a second pause() does not', g.pause() === true && g.pause() === false)
  const a = new AbortController()
  const b = new AbortController()
  const events: string[] = []
  const unsubscribe = g.subscribe(s => events.push(`${s.paused ? 'closed' : 'open'}:${s.parked}`))
  let aDone = false
  let bDone = false
  void g.park(a.signal, 'a').then(() => { aDone = true })
  void g.park(b.signal, 'b').then(() => { bDone = true })
  await settle(10)
  check('two parked waits are listed by seat', JSON.stringify(g.parked()) === JSON.stringify(['a', 'b']) && g.state().parked === 2, JSON.stringify(g.parked()))
  a.abort()
  await settle(10)
  check('an abort releases its own wait alone; the gate stays closed with the other parked', aDone && !bDone && g.paused() && JSON.stringify(g.parked()) === JSON.stringify(['b']))
  const already = new AbortController()
  already.abort()
  let alreadyDone = false
  await Promise.race([g.park(already.signal, 'c').then(() => { alreadyDone = true }), settle(20)])
  check('a park on an already-aborted signal resolves at once', alreadyDone)
  check('resume() reports the change and releases every parked wait', g.resume() === true && g.resume() === false)
  await settle(10)
  check('the remaining wait was released by the resume', bDone && g.parked().length === 0 && !g.paused())
  check('toggle() closes then opens, answering the new state', g.toggle() === true && g.paused() && g.toggle() === false && !g.paused())
  unsubscribe()
  check('subscribers heard the parks, the abort release and the opens', events.length >= 4 && events[0] === 'closed:1' && events.includes('closed:2') && events.includes('open:0'), events.join(','))
  check('the words: the model seat, the tool seat, the chip, and the wait recogniser agree on one spelling', gateModule.pauseGateModelWords().startsWith(gateModule.OPERATOR_PAUSE_WORDS) && gateModule.pauseGateToolWords('Read').includes('(Read)') && gateModule.isOperatorPauseWait(gateModule.pauseGateToolWords('Read')) && !gateModule.isOperatorPauseWait('waiting for a seat — 3 of 3 held') && gateModule.pauseGateChipWords({ paused: true, parked: 2 }) === 'paused by the operator · 2 parked' && gateModule.pauseGateChipWords({ paused: false, parked: 0 }) === null)
}

section('G2 A LIFT FOR ONE SEAT — a message to one seat releases that seat\'s wait and exempts it while the gate stays closed; the others stay parked; the lift ends when the gate reopens')
if (gateModule === null) {
  check('the gate module exists (src/run-core/pauseGate.ts)', false, 'absent on this tree')
} else {
  const g = gateModule.createPauseGate()
  check('the gate carries lift() and holds()', typeof g.lift === 'function' && typeof g.holds === 'function')
  check('lift() on an open gate changes nothing', g.lift('agent-a') === false && !g.holds('agent-a'))
  g.pause()
  const a = new AbortController()
  const b = new AbortController()
  const events: string[] = []
  const unsubscribe = g.subscribe(s => events.push(`${s.paused ? 'closed' : 'open'}:${s.parked}`))
  let aDone = false
  let bDone = false
  void g.park(a.signal, 'a', 'agent-a').then(() => { aDone = true })
  void g.park(b.signal, 'b', 'agent-b').then(() => { bDone = true })
  await settle(10)
  check('two seats park under their labels and are held by their keys', j(g.parked()) === j(['a', 'b']) && g.holds('agent-a') && g.holds('agent-b'), j(g.parked()))
  const heardBefore = events.length
  const liftedA = g.lift('agent-a')
  await settle(10)
  check('lift(agent-a) reports the change, releases a alone and leaves b parked under a closed gate', liftedA && aDone && !bDone && g.paused() && j(g.parked()) === j(['b']), `aDone=${aDone} bDone=${bDone} parked=${j(g.parked())}`)
  check('the lifted seat is no longer held; the other still is', !g.holds('agent-a') && g.holds('agent-b'))
  check('subscribers heard the lift as a parked count change under the closed gate', events.length === heardBefore + 1 && events.at(-1) === 'closed:1', events.join(','))
  let aAgain = false
  await Promise.race([g.park(new AbortController().signal, 'a', 'agent-a').then(() => { aAgain = true }), settle(20)])
  check('a lifted seat\'s next park resolves at once while the gate stays closed', aAgain && g.paused())
  check('a second lift of the same seat changes nothing', g.lift('agent-a') === false)
  check('a lift of a seat with no wait still exempts it', g.lift('agent-c') === true && !g.holds('agent-c') && g.paused())
  check('a key defaults to its seat label: park(signal, seat) is lifted by that label', (() => { void g.park(new AbortController().signal, 'd'); return g.holds('d') && g.lift('d') === true && !g.holds('d') })())
  check('resume() releases the rest', g.resume() === true)
  await settle(10)
  check('the remaining wait was released and the gate is open', bDone && g.parked().length === 0 && !g.paused())
  g.pause()
  check('a fresh pause holds every seat again, the lifted ones included', g.holds('agent-a') && g.holds('agent-c') && g.holds('d') && g.holds('main'))
  unsubscribe()
  check('the context key is the agent id, the context seat its holder label, and the chat is main for both', gateModule.pauseGateKeyOf({ agentId: 'agent-scout' }) === 'agent-scout' && gateModule.pauseGateSeatOf({ agentId: 'agent-scout', seatHolder: 'scout' }) === 'scout' && gateModule.pauseGateKeyOf({}) === gateModule.PAUSE_GATE_MAIN_SEAT && gateModule.pauseGateSeatOf({}) === gateModule.PAUSE_GATE_MAIN_SEAT)
}

section('L1 ONE LOOP LIFTED BY A MESSAGE — the addressed loop runs on from exactly where it stopped, byte-identical to the control, while the others stay parked and the gate stays closed; the resume releases the rest')
{
  const one = buildRig()
  await until(() => RUNS.every(run => callsOf(one, run).length === 1), 'the three first model calls in flight')
  check('the pause closes the gate', pause() && gate?.paused() === true, gateModule === null ? 'no gate module: pause() is a no-op' : String(gate?.state()))
  for (const run of RUNS) one.modelLatch(run, 1).open()
  await until(() => parked().length === RUNS.length, 'the three loops park at the tool seam')
  check('the three loops are parked at the tool seam, no tool started', JSON.stringify([...parked()].sort()) === JSON.stringify(['main', 'reviewer', 'scout']) && one.toolStarts.length === 0, `parked=${JSON.stringify(parked())} tools=${one.toolStarts.length}`)
  const liftedScout = gate?.lift('agent-scout') ?? false
  await until(() => startsOf(one, 'scout').length === 1, "scout's tool starts after the lift")
  check("lift(agent-scout) — the message's key is the loop's agent id — releases scout's wait alone: its tool starts with the exact input its model asked for", liftedScout && startsOf(one, 'scout').length === 1 && JSON.stringify(startsOf(one, 'scout')[0]?.input) === JSON.stringify(toolUseOf('scout', 1).input), JSON.stringify(startsOf(one, 'scout')))
  check('the gate stays closed with main and reviewer parked; neither started a tool', gate?.paused() === true && JSON.stringify([...parked()].sort()) === JSON.stringify(['main', 'reviewer']) && startsOf(one, 'main').length === 0 && startsOf(one, 'reviewer').length === 0, `parked=${JSON.stringify(parked())}`)
  check("scout's wait words cleared (its row reads running again); main and reviewer keep theirs", one.waitOf('scout') === null && one.waitOf('main') !== null && one.waitOf('reviewer') !== null, `scout=${j(one.waitOf('scout'))} main=${j(one.waitOf('main'))} reviewer=${j(one.waitOf('reviewer'))}`)
  for (const n of [1, 2, 3]) { one.modelLatch('scout', n).open(); if (n < 3) one.toolLatch('scout', n).open() }
  await one.done('scout')
  check('scout completes under the closed gate: three calls and two tools, every request byte-identical to the unpaused control\'s', one.terminalOf('scout')?.reason === 'completed' && callsOf(one, 'scout').length === 3 && startsOf(one, 'scout').length === 2 && callsOf(one, 'scout').every((c, i) => digest(c.messages) === digest(callsOf(control, 'scout')[i]!.messages)), `${one.terminalOf('scout')?.reason} ${callsOf(one, 'scout').length} calls ${startsOf(one, 'scout').length} tools`)
  check('main and reviewer stayed parked the whole while: one call each, no tool, the gate closed', gate?.paused() === true && callsOf(one, 'main').length === 1 && callsOf(one, 'reviewer').length === 1 && one.toolStarts.filter(s => s.run !== 'scout').length === 0 && JSON.stringify([...parked()].sort()) === JSON.stringify(['main', 'reviewer']), `parked=${JSON.stringify(parked())}`)
  check('the resume releases the rest', resume() && parked().length === 0)
  for (const run of ['main', 'reviewer'] as const) for (const n of [1, 2, 3]) { one.modelLatch(run, n).open(); if (n < 3) one.toolLatch(run, n).open() }
  await Promise.all([one.done('main'), one.done('reviewer')])
  check('main and reviewer complete after the resume with three calls and two tools each; the gate is open and nothing is parked', (['main', 'reviewer'] as const).every(run => one.terminalOf(run)?.reason === 'completed' && callsOf(one, run).length === 3 && startsOf(one, run).length === 2) && gate?.paused() === false && parked().length === 0, (['main', 'reviewer'] as const).map(run => `${run}: ${one.terminalOf(run)?.reason} ${callsOf(one, run).length}/${startsOf(one, run).length}`).join(' · '))
}

const taskRow = (id: string, type: string, extra: Record<string, unknown> = {}): TaskLike => ({ id, type, status: 'running', description: `${id} description`, startTime: Date.now() - 5_000, totalTokens: 0, totalToolCalls: 0, ...extra })

section('F1 THE FRAME PER PARK — the row\'s words reach the daemon\'s facts within a quarter second of the park, never at the next work poll')
{
  const RUNNER = 'concourse-pg1'
  const SESSION = 'aaaaaaaa-bbbb-4ccc-8ddd-pausegate001'
  updateConcourseWorkers(workers => {
    workers[RUNNER] = {
      schema: 1,
      runnerId: RUNNER,
      sessionId: SESSION,
      workspaceId: ROOT,
      isolation: 'exclusive',
      modelKey: MODEL,
      spawnedAt: Date.now(),
      lastLiveAt: Date.now(),
      workspaceKind: 'plain-folder',
    } as never
  }, daemonDir)
  const { standInRunner } = await import('../lib/seatDoor.ts')
  let rowsNow: () => WorkRowV1[] = () => []
  const factsAnswer = (): Record<string, unknown> =>
    sessionFactsToWire({
      model: { effective: MODEL, setting: null },
      usage: { totalCostUSD: 0, totalAPIDurationMs: 0, totalDurationMs: 0, totalLinesAdded: 0, totalLinesRemoved: 0, totalInputTokens: 0, totalOutputTokens: 0, totalCacheReadInputTokens: 0, totalCacheCreationInputTokens: 0, hasUnknownModelCost: false },
      identity: { firstPartyApi: true, consoleBilling: false, claudeAiBilling: true, accountEmail: null },
      skills: [],
      mcp: [],
      permissionMode: 'default',
      workspace: { cwd: ROOT, originalCwd: ROOT, projectRoot: ROOT, instructionRoots: [] },
      queue: [],
      work: rowsNow(),
      mission: [],
      pauseGate: { paused: gate?.paused() ?? false, parked: gate?.parked().length ?? 0 },
    } as never)
  const stand = standInRunner({ autoAnswer: { 'session/facts': () => factsAnswer() } })
  const requests = stand.requests
  const roster = stand.roster()
  const framesOut: Array<Record<string, unknown> & { at: number }> = []
  const QUARTER_SECOND_MS = 250
  const RELAY_ALLOWANCE_MS = 50
  const WORK_POLL_MS = 1000
  type Reference = { frameAt: number; firedAt: number | null }
  const references: Reference[] = []
  const stdout = setInterval(() => {
    for (const event of drainRows()) {
      framesOut.push({ ...(event as Record<string, unknown>), at: Date.now() })
      seat.onSeatRow(RUNNER, event as never, roster as never, daemonDir)
      if ((event as { type?: unknown; state?: unknown }).type === 'task' && (event as { state?: unknown }).state === 'progress') {
        const reference: Reference = { frameAt: Date.now(), firedAt: null }
        references.push(reference)
        setTimeout(() => { reference.firedAt = Date.now() }, QUARTER_SECOND_MS)
      }
    }
  }, 5)
  const factsRows = (): WorkRowV1[] => (readSessionFacts(SESSION, daemonDir)?.work ?? []) as WorkRowV1[]
  const factsStamp = (): number => readSessionFacts(SESSION, daemonDir)?.atMs ?? 0
  const t0 = Date.now() - 30_000

  type Landing = { landed: boolean; frameAt: number | null; requestAt: number | null; referenceFiredAt: number | null; stampAt: number; noticedAt: number }
  const landing = async (since: number, rowsLanded: (rows: WorkRowV1[]) => boolean, what: string): Promise<Landing> => {
    const landed = await until(() => rowsLanded(factsRows()), what, 3_000)
    const noticedAt = Date.now()
    const stampAt = landed ? factsStamp() : noticedAt
    const reference = references.find(r => r.frameAt >= since) ?? null
    if (reference !== null) await until(() => reference.firedAt !== null, `${what}: the prover's own quarter-second timer fires`, 3_000)
    const request = requests.find(r => r.at >= since && r.method === 'session/facts') ?? null
    return { landed, frameAt: reference?.frameAt ?? null, requestAt: request?.at ?? null, referenceFiredAt: reference?.firedAt ?? null, stampAt, noticedAt }
  }
  const offset = (at: number | null, since: number): string => (at === null ? 'never' : `+${at - since} ms`)
  const segments = (since: number, l: Landing): string =>
    `the frame at the seat ${offset(l.frameAt, since)} · the seat's re-ask ${offset(l.requestAt, since)} · the prover's quarter-second timer fired ${offset(l.referenceFiredAt, since)} · the daemon's stamp ${offset(l.landed ? l.stampAt : null, since)} · the file read back ${offset(l.noticedAt, since)}; facts requests since: ${requests.filter(r => r.at >= since).map(r => `${r.method}@${offset(r.at, since)}`).join(', ') || 'none'}`

  type Measured = { parkedAt: number; landedAt: number; clearedAt: number; clearLandedAt: number; frames: Array<Record<string, unknown> & { at: number }> }
  const measure = async (label: string, two: Rig, run: string, rowOf: () => WorkRowV1, parkedRow: (row: WorkRowV1) => boolean, doPause: () => boolean, doResume: () => boolean): Promise<Measured | null> => {
    rowsNow = () => [rowOf()]
    requests.length = 0
    framesOut.length = 0
    references.length = 0
    seat.requestSessionFacts(RUNNER, roster as never, { immediate: true })
    const primedAt = Date.now()
    await settle(20)
    const primed = factsRows()
    check(`${label}: the seat holds a running row before the pause (its 1 s work poll is armed)`, primed.length === 1 && primed[0]?.status === 'running' && !primed.some(parkedRow), j(primed))
    const beatSeen = await until(() => requests.some(r => r.at > primedAt + 20), `${label}: the seat's work poll beats once before the pause`, WORK_POLL_MS * 2 + 500)
    const beatAt = beatSeen ? requests.filter(r => r.at > primedAt + 20).at(-1)!.at : Date.now()
    check(`${label}: the seat's work poll beat once before the pause (${beatAt - primedAt} ms after the primed answer), so its next beat is a full second away and the window belongs to the park's own frame`, beatSeen, `no poll request within ${WORK_POLL_MS * 2 + 500} ms of the primed answer`)
    check(`${label}: the pause verb applies`, doPause())
    two.modelLatch(run, 1).open()
    const reached = await until(() => two.waitOf(run) !== null, `${label}: the loop parks at the tool seam`)
    if (!reached) return null
    const parkedAt = two.waitAt(run)!
    const words = two.waitOf(run)!
    const park = await landing(parkedAt, rows => rows.some(parkedRow), `${label}: the parked words reach the published facts`)
    check(`${label}: the parked words reached the published facts at all`, park.landed, `words=${j(words)} rows=${j(factsRows())}`)
    const parkFrames = framesOut.filter(f => f.type === 'task' && f.state === 'progress' && f.at >= parkedAt - 5)
    check(`${label}: the park itself put one progress task row on the runner's wire for the parked row's task (the daemon re-asks the facts on it) — at the seat ${offset(park.frameAt, parkedAt)} after the park`, parkFrames.length >= 1, `frames since the park: ${j(framesOut.filter(f => f.at >= parkedAt - 5).map(f => f.subtype))}`)
    const nextBeatAt = beatAt + WORK_POLL_MS
    const window = parkedAt < nextBeatAt ? `the park came ${parkedAt - beatAt} ms after the beat, ${nextBeatAt - parkedAt} ms before the poll's next beat was due` : `the park itself came ${parkedAt - beatAt} ms after the beat, ${parkedAt - nextBeatAt} ms after the poll's next beat was already due: a box this slow cannot tell the two roads apart`
    check(`${label}: the seat re-asked the facts on the park's frame within its debounce, never at the work poll — the request ${offset(park.requestAt, parkedAt)}, beside the prover's own quarter-second timer armed with the frame (fired ${offset(park.referenceFiredAt, parkedAt)}); ${window}`, park.requestAt !== null && park.referenceFiredAt !== null && park.requestAt <= park.referenceFiredAt + RELAY_ALLOWANCE_MS && park.requestAt < nextBeatAt, segments(parkedAt, park))
    check(`${label}: the row's words land within a quarter second of the park — the daemon stamped them ${offset(park.landed ? park.stampAt : null, parkedAt)} (the seat's debounce, ${QUARTER_SECOND_MS} ms, plus ${RELAY_ALLOWANCE_MS} ms of relay, on the box's own quarter-second clock: the prover's reference timer fired ${offset(park.referenceFiredAt, parkedAt)}; the file read back ${offset(park.noticedAt, parkedAt)}, the box's transport and this prover's poll, not the mechanism)`, park.landed && park.referenceFiredAt !== null && park.stampAt <= park.referenceFiredAt + RELAY_ALLOWANCE_MS, segments(parkedAt, park))
    check(`${label}: never the next poll — the words landed ${park.stampAt < nextBeatAt ? `${nextBeatAt - park.stampAt} ms before the poll's next beat was due` : `${park.stampAt - nextBeatAt} ms after the poll's next beat was due`}`, park.landed && park.stampAt < nextBeatAt, `${window}; ${segments(parkedAt, park)}`)
    check(`${label}: the resume verb applies`, doResume())
    await until(() => two.waitOf(run) === null, `${label}: the wait clears when the tool starts`)
    const clearedAt = two.waitAt(run)!
    const clear = await landing(clearedAt, rows => rows.length === 1 && !rows.some(parkedRow), `${label}: the cleared row reaches the published facts`)
    check(`${label}: the clear lands within the same bound — the daemon stamped it ${offset(clear.landed ? clear.stampAt : null, clearedAt)} (the prover's reference timer fired ${offset(clear.referenceFiredAt, clearedAt)}; the file read back ${offset(clear.noticedAt, clearedAt)})`, clear.landed && clear.referenceFiredAt !== null && clear.stampAt <= clear.referenceFiredAt + RELAY_ALLOWANCE_MS, segments(clearedAt, clear))
    return { parkedAt, landedAt: park.noticedAt, clearedAt, clearLandedAt: clear.noticedAt, frames: parkFrames }
  }

  {
    const tasks: Record<string, TaskLike> = { 'agent-scout': taskRow('agent-scout', 'local_agent', { toolUseId: 'toolu_scout', progress: { tokenCount: 12, toolUseCount: 1 } }) }
    const two = buildRig([{ name: 'scout', seat: 'scout', tool: 'SerialTool' }], tasks)
    await until(() => callsOf(two, 'scout').length === 1, 'the chat sub-agent has its first model call in flight')
    const rowOf = (): WorkRowV1 => ({
      id: 'agent-scout',
      agentId: 'agent-scout',
      kind: 'agent',
      name: 'scout the release notes',
      status: 'running',
      startTime: t0,
      agentType: 'mercury-crew',
      model: MODEL,
      ...(two.waitOf('scout') !== null ? { wait: two.waitOf('scout') as string } : {}),
    })
    const parkedRow = (row: WorkRowV1): boolean => row.id === 'agent-scout' && typeof row.wait === 'string' && row.wait.startsWith('paused by ')
    const measured = await measure("a chat sub-agent under the operator's p", two, 'scout', rowOf, parkedRow, () => gate?.pause() ?? false, () => gate?.resume() ?? false)
    check("the park's frame names the sub-agent's own task (task_id agent-scout)", measured !== null && measured.frames.some(f => f.task_id === 'agent-scout'), j(measured?.frames.map(f => f.task_id)))
    for (const n of [1, 2, 3]) { two.modelLatch('scout', n).open(); if (n < 3) two.toolLatch('scout', n).open() }
    await two.done('scout')
    gate?.resume()
  }
  clearInterval(stdout)
  stand.close()
}

clearTimeout(guard)
console.log('─'.repeat(76))
console.log(failures === 0 ? `ALL PASS — ${checks} checks` : `FAILURES: ${failures} of ${checks} checks`)
process.exit(failures === 0 ? 0 : 1)
