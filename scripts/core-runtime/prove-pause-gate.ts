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
process.env.MERCURY_CREWS_DIR = mkdtempSync(join(tmpdir(), 'pause-gate-teams-'))
process.env.MERCURY_CREDENTIAL_STORE = 'file'
process.env.ANTHROPIC_API_KEY = 'proof-key-ci-gate-not-a-real-key'
for (const k of ['MERCURY_BARE', 'MERCURY_EFFORT_LEVEL', 'MERCURY_MAX_OUTPUT_TOKENS', 'MERCURY_BLOCKING_LIMIT_OVERRIDE', 'MERCURY_RELEVANT_RECALL', 'CLAUDE_CREW_NAME', 'CLAUDE_AGENT_NAME', 'MERCURY_COMPACT', 'MERCURY_AUTO_COMPACT', 'NODE_ENV', 'MERCURY_SCRIPTED_STREAM']) {
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
const { drainSdkEvents } = await import('../../src/utils/sdkEventQueue.ts')
const runControl = await import('../../src/tools/WorkflowTool/runControl.ts')
const seat = await import('../../src/daemon/sessionSeat.ts')
const { updateConcourseWorkers } = await import('../../src/daemon/concourseSupervisor.ts')
const { sessionFactsToWire } = await import('../../src/services/engine-connector/seatWire.ts')
const { readSessionFacts } = await import('../../src/services/engine-connector/seatProjections.ts')

type GateModule = typeof import('../../src/run-core/pauseGate.ts')
type PauseGate = ReturnType<GateModule['createPauseGate']> & { pausedBy?: () => string | null }
const gateModule: GateModule | null = await import('../../src/run-core/pauseGate.ts').catch(() => null)
const gate = gateModule?.operatorPauseGate ?? null
type RunSeam = InstanceType<typeof runControl.WorkflowExecutionPause> & { gate?: PauseGate }
type RunControlModule = typeof runControl & {
  runnerHostsOnlyRun?: (taskId: string, tasks: Record<string, { status: string }>) => boolean
  workflowGateRide?: (gate: unknown) => { close: (hostsOnly: boolean) => boolean; open: () => boolean; closed: () => boolean; release: () => void }
}
const runControlMod = runControl as RunControlModule

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

console.log('pause gate — one process-wide park at the two safe points, and a gate per workflow run')
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
type LoopSpec = { name: string; seat: string | null; tool: ToolName; gate?: PauseGate | null }
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
        mainLoopModel: MODEL,
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
      ...(spec.gate ? { pauseGate: spec.gate } : {}),
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
await settle(120)
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
await settle(120)
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

section('R0 A GATE PER WORKFLOW RUN — the tree\'s facts (the seam, the ride, the context) before the two-run rows')
const seamGateOf = (seam: RunSeam): PauseGate | null => (seam.gate !== undefined && seam.gate !== null && typeof seam.gate.paused === 'function' ? seam.gate : null)
const rideExported = typeof runControlMod.workflowGateRide === 'function' && typeof runControlMod.runnerHostsOnlyRun === 'function'
const probeSeam = new runControl.WorkflowExecutionPause() as RunSeam
console.log(`  the run seam's own gate: ${seamGateOf(probeSeam) === null ? 'ABSENT (WorkflowExecutionPause carries no gate — a run pause can only ride the process-wide gate)' : 'present'}`)
console.log(`  the process-wide ride (workflowGateRide + runnerHostsOnlyRun): ${rideExported ? 'EXPORTED (a run pause closes the operator gate when the runner hosts only that run)' : 'absent'}`)
const BY = 'session 9f3a2c11'
const rides = new Map<RunSeam, { close: (hostsOnly: boolean) => boolean; open: () => boolean }>()
const rideOf = (seam: RunSeam): { close: (hostsOnly: boolean) => boolean; open: () => boolean } | null => {
  if (!rideExported || gate === null) return null
  let ride = rides.get(seam)
  if (ride === undefined) {
    ride = runControlMod.workflowGateRide!(gate)
    rides.set(seam, ride)
  }
  return ride
}
const pauseRun = (seam: RunSeam, taskId: string, tasks: Record<string, TaskLike>): { applied: boolean; rode: boolean | null } => {
  const out = seam.change(true, BY)
  const ride = rideOf(seam)
  const rode = out.outcome === 'applied' && ride !== null ? ride.close(runControlMod.runnerHostsOnlyRun!(taskId, tasks)) : null
  return { applied: out.outcome === 'applied', rode }
}
const resumeRun = (seam: RunSeam): boolean => {
  const out = seam.change(false, BY)
  const ride = rideOf(seam)
  if (ride !== null && !seam.runPaused()) ride.open()
  return out.outcome === 'applied'
}
const parkedEverywhere = (...seams: RunSeam[]): string[] => {
  const out = new Set<string>(gate?.parked() ?? [])
  for (const seam of seams) for (const s of seamGateOf(seam)?.parked() ?? []) out.add(s)
  return [...out].sort()
}
const taskRow = (id: string, type: string, extra: Record<string, unknown> = {}): TaskLike => ({ id, type, status: 'running', description: `${id} description`, startTime: Date.now() - 5_000, totalTokens: 0, totalToolCalls: 0, ...extra })

section('R1 TWO RUNS — A is paused while it is the runner\'s only run, then B launches: only A\'s agents may park; B\'s and the chat run on')
{
  const seamA = new runControl.WorkflowExecutionPause() as RunSeam
  const seamB = new runControl.WorkflowExecutionPause() as RunSeam
  const tasks: Record<string, TaskLike> = { 'wf-a': taskRow('wf-a', 'local_workflow', { workflowRunId: 'run-a', agentControllers: new Map<string, AbortController>() }) }
  const two = buildRig([
    { name: 'a1', seat: 'a1', tool: 'SerialTool', gate: seamGateOf(seamA) },
    { name: 'a2', seat: 'a2', tool: 'ReadishTool', gate: seamGateOf(seamA) },
    { name: 'main', seat: null, tool: 'SerialTool' },
  ], tasks)
  await until(() => ['a1', 'a2', 'main'].every(run => callsOf(two, run).length === 1), "run A's two agents and the chat have their first model call in flight")
  const pausedA = pauseRun(seamA, 'wf-a', tasks)
  check("A's pause verb applies while the runner hosts only A", pausedA.applied, j(pausedA))
  tasks['wf-b'] = taskRow('wf-b', 'local_workflow', { workflowRunId: 'run-b', agentControllers: new Map<string, AbortController>() })
  two.start({ name: 'b1', seat: 'b1', tool: 'SerialTool', gate: seamGateOf(seamB) })
  two.start({ name: 'b2', seat: 'b2', tool: 'ReadishTool', gate: seamGateOf(seamB) })
  const bCalled = await until(() => ['b1', 'b2'].every(run => callsOf(two, run).length === 1), "run B's two agents have their first model call in flight under A's pause", 2_500)
  check("run B's agents, launched under A's pause, make their first model call (A's pause is not theirs)", bCalled, `b1 calls=${callsOf(two, 'b1').length} b2 calls=${callsOf(two, 'b2').length} — parked=${j(parkedEverywhere(seamA, seamB))} b1 wait=${j(two.waitOf('b1'))}`)
  for (const run of ['a1', 'a2', 'b1', 'b2', 'main']) two.modelLatch(run, 1).open()
  await until(() => ['a1', 'a2', 'b1', 'b2', 'main'].every(run => assistantToolUses(two, run) === 1), 'every stream finishes its tokens and reaches the tool seam', 2_500)
  await settle(200)
  const parkedNow = parkedEverywhere(seamA, seamB)
  check("pausing run A parks A's agents alone (a1, a2) at the tool seam", j(parkedNow) === j(['a1', 'a2']), `parked=${j(parkedNow)} (seat labels, every gate in the process)`)
  check("run B's agents proceed under A's pause: both their tools started", startsOf(two, 'b1').length === 1 && startsOf(two, 'b2').length === 1, `b1 tools=${startsOf(two, 'b1').length} b2 tools=${startsOf(two, 'b2').length} — parked=${j(parkedNow)}`)
  check("the chat (main) is untouched by A's pause: its tool started", startsOf(two, 'main').length === 1, `main tools=${startsOf(two, 'main').length} wait=${j(two.waitOf('main'))}`)
  check("A's agents made no tool start while parked", startsOf(two, 'a1').length === 0 && startsOf(two, 'a2').length === 0, `a1 tools=${startsOf(two, 'a1').length} a2 tools=${startsOf(two, 'a2').length}`)
  check("the operator's process-wide gate stays open (nobody pressed p)", gate !== null && !gate.paused() && gate.parked().length === 0, `operator gate paused=${gate?.paused()} parked=${j(gate?.parked())}`)
  check("A's rows name the run's pauser at the seam (paused by session 9f3a2c11 · at a tool (SerialTool) — p resumes it), never the operator's p", two.waitOf('a1') === `paused by ${BY} · at a tool (SerialTool) — p resumes it` && two.waitOf('a2') === `paused by ${BY} · at a tool (ReadishTool) — p resumes it`, `a1=${j(two.waitOf('a1'))} a2=${j(two.waitOf('a2'))}`)
  check("B's rows carry no wait words", two.waitOf('b1') === null && two.waitOf('b2') === null, `b1=${j(two.waitOf('b1'))} b2=${j(two.waitOf('b2'))}`)
  check("A's resume verb applies and releases its own parks", resumeRun(seamA) && parkedEverywhere(seamA, seamB).length === 0, `parked=${j(parkedEverywhere(seamA, seamB))}`)
  await until(() => startsOf(two, 'a1').length === 1 && startsOf(two, 'a2').length === 1, "A's tools start after the resume")
  check("A's agents continue from where they stopped: the tools the models asked for, the wait cleared", startsOf(two, 'a1')[0]?.tool === 'SerialTool' && startsOf(two, 'a2')[0]?.tool === 'ReadishTool' && two.waitOf('a1') === null && two.waitOf('a2') === null, `a1=${j(startsOf(two, 'a1')[0])} wait=${j(two.waitOf('a1'))}`)
  for (const run of ['a1', 'a2', 'b1', 'b2', 'main']) for (const n of [1, 2, 3]) { two.modelLatch(run, n).open(); if (n < 3) two.toolLatch(run, n).open() }
  await Promise.all(['a1', 'a2', 'b1', 'b2', 'main'].map(run => two.done(run)))
  check('every loop of both runs and the chat completes with three calls and two tools', ['a1', 'a2', 'b1', 'b2', 'main'].every(run => two.terminalOf(run)?.reason === 'completed' && callsOf(two, run).length === 3 && startsOf(two, run).length === 2), ['a1', 'a2', 'b1', 'b2', 'main'].map(run => `${run}: ${two.terminalOf(run)?.reason} ${callsOf(two, run).length}/${startsOf(two, run).length}`).join(' · '))
  gate?.resume()
}

section('R2 TWO RUNS SIDE BY SIDE — both registered, A is paused: A\'s agents park at their tool blocks all the same; B\'s and the chat run on')
{
  const seamA = new runControl.WorkflowExecutionPause() as RunSeam
  const seamB = new runControl.WorkflowExecutionPause() as RunSeam
  const tasks: Record<string, TaskLike> = {
    'wf-a': taskRow('wf-a', 'local_workflow', { workflowRunId: 'run-a', agentControllers: new Map<string, AbortController>() }),
    'wf-b': taskRow('wf-b', 'local_workflow', { workflowRunId: 'run-b', agentControllers: new Map<string, AbortController>() }),
  }
  const names = ['a1', 'a2', 'b1', 'b2', 'main']
  const two = buildRig([
    { name: 'a1', seat: 'a1', tool: 'SerialTool', gate: seamGateOf(seamA) },
    { name: 'a2', seat: 'a2', tool: 'ReadishTool', gate: seamGateOf(seamA) },
    { name: 'b1', seat: 'b1', tool: 'SerialTool', gate: seamGateOf(seamB) },
    { name: 'b2', seat: 'b2', tool: 'ReadishTool', gate: seamGateOf(seamB) },
    { name: 'main', seat: null, tool: 'SerialTool' },
  ], tasks)
  await until(() => names.every(run => callsOf(two, run).length === 1), 'five first model calls in flight')
  const pausedA = pauseRun(seamA, 'wf-a', tasks)
  check("A's pause verb applies with B beside it", pausedA.applied, j(pausedA))
  for (const run of names) two.modelLatch(run, 1).open()
  await until(() => names.every(run => assistantToolUses(two, run) === 1), 'every stream finishes its tokens and reaches the tool seam')
  await settle(200)
  const parkedNow = parkedEverywhere(seamA, seamB)
  check("A's agents park at their next tool block under A's pause even with B beside it (parked: a1, a2)", j(parkedNow) === j(['a1', 'a2']) && startsOf(two, 'a1').length === 0 && startsOf(two, 'a2').length === 0, `parked=${j(parkedNow)} a1 tools=${startsOf(two, 'a1').length} a2 tools=${startsOf(two, 'a2').length}${pausedA.rode === false ? ' — the ride refused: the runner hosts other work, so the pause never reached the tool seam' : ''}`)
  check("B's agents and the chat run on: their tools started", startsOf(two, 'b1').length === 1 && startsOf(two, 'b2').length === 1 && startsOf(two, 'main').length === 1, `b1=${startsOf(two, 'b1').length} b2=${startsOf(two, 'b2').length} main=${startsOf(two, 'main').length}`)
  check("the operator's gate stays open", gate !== null && !gate.paused(), `paused=${gate?.paused()}`)
  const pausedB = pauseRun(seamB, 'wf-b', tasks)
  check("B's pause verb applies beside A's (two runs paused at once, each its own)", pausedB.applied && seamA.runPaused() && seamB.runPaused(), j(pausedB))
  for (const run of ['b1', 'b2', 'main']) two.toolLatch(run, 1).open()
  await until(() => ['b1', 'b2', 'main'].every(run => callsOf(two, run).length === 2), "B's agents and the chat make their second call (a run pause parks its agents at their tool blocks, the chat parks nowhere)")
  for (const run of ['b1', 'b2', 'main']) two.modelLatch(run, 2).open()
  await until(() => ['b1', 'b2', 'main'].every(run => assistantToolUses(two, run) === 2), 'their second streams finish')
  await settle(200)
  const parkedBoth = parkedEverywhere(seamA, seamB)
  check("with both runs paused, each run's agents park under their own run (a1, a2, b1, b2) and the chat's second tool starts", j(parkedBoth) === j(['a1', 'a2', 'b1', 'b2']) && startsOf(two, 'main').length === 2, `parked=${j(parkedBoth)} main tools=${startsOf(two, 'main').length}`)
  check("B's resume releases B's agents alone; A's stay parked", resumeRun(seamB) && j(parkedEverywhere(seamA, seamB)) === j(['a1', 'a2']), `parked=${j(parkedEverywhere(seamA, seamB))}`)
  await until(() => startsOf(two, 'b1').length === 2 && startsOf(two, 'b2').length === 2, "B's second tools start")
  check("A's resume releases A's agents", resumeRun(seamA) && parkedEverywhere(seamA, seamB).length === 0, `parked=${j(parkedEverywhere(seamA, seamB))}`)
  for (const run of names) for (const n of [1, 2, 3]) { two.modelLatch(run, n).open(); if (n < 3) two.toolLatch(run, n).open() }
  await Promise.all(names.map(run => two.done(run)))
  check('every loop completes with three calls and two tools', names.every(run => two.terminalOf(run)?.reason === 'completed' && callsOf(two, run).length === 3 && startsOf(two, run).length === 2), names.map(run => `${run}: ${two.terminalOf(run)?.reason} ${callsOf(two, run).length}/${startsOf(two, run).length}`).join(' · '))
  gate?.resume()
}

section('R3 THE RUN GATE\'S LAWS — created with the seam, closed by the run\'s pause verb alone, opened by the resume that lifts it; the operator\'s gate never moves')
{
  const seam = new runControl.WorkflowExecutionPause() as RunSeam
  const own = seamGateOf(seam)
  if (own === null) {
    check('the run seam carries its own gate (WorkflowExecutionPause.gate)', false, 'absent on this tree')
  } else {
    check('the gate is open when the seam is born', !own.paused() && own.parked().length === 0)
    check('a run-level pause closes the gate and the gate names the pauser', seam.change(true, BY).outcome === 'applied' && own.paused() && own.pausedBy?.() === BY, `paused=${own.paused()} by=${j(own.pausedBy?.())}`)
    check("the operator's gate did not move", gate !== null && !gate.paused())
    check('the run-level resume opens it', seam.change(false, BY).outcome === 'applied' && !own.paused() && own.pausedBy?.() === null)
    const release = seam.register('agent-x')
    check('a per-agent pause never closes the run gate', seam.change(true, BY, 'agent-x').outcome === 'applied' && !own.paused())
    check('the per-agent resume leaves it open', seam.change(false, BY, 'agent-x').outcome === 'applied' && !own.paused())
    check('a run pause over a registered agent closes the gate', seam.change(true, BY).outcome === 'applied' && own.paused())
    check('the per-agent resume that lifts a run pause opens the gate (the other agents keep the pause, the run word clears)', seam.change(false, BY, 'agent-x').outcome === 'applied' && !seam.runPaused() && !own.paused())
    release()
    const source = read('src/tools/WorkflowTool/WorkflowTool.tsx')
    check("the run's context hands the gate to its agents (pauseGate: executionPause.gate on the run context)", source.includes('pauseGate: executionPause.gate'))
    check('the run pause rides no process-wide gate any more (no workflowGateRide, no runnerHostsOnlyRun in the tool)', !source.includes('workflowGateRide') && !source.includes('runnerHostsOnlyRun'))
    const fork = read('src/utils/forkedAgent.ts')
    check("every sub-agent context inherits its parent's run gate (createSubagentContext copies pauseGate)", fork.includes('pauseGate: parentContext.pauseGate'))
    const orchestration = read('src/services/tools/toolOrchestration.ts')
    check('the tool seam parks through the gate owner, which reads the run gate off the context beside the operator\'s', orchestration.includes('parkBeforeTool(') && !orchestration.includes('operatorPauseGate.park('))
  }
}

section('R4 THE FRAME PER PARK — the row\'s words reach the daemon\'s facts within a quarter second of the park, never at the next work poll')
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
  type Frame = { type: string; request_id: string; request: { subtype: string } }
  const requests: Array<Frame & { at: number }> = []
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
  const roster = {
    control: (short: string, raw: string): boolean => {
      if (short !== RUNNER) return false
      const frame = JSON.parse(raw) as Frame
      requests.push({ ...frame, at: Date.now() })
      if (frame.request.subtype === 'session_facts') {
        const line = JSON.stringify({ type: 'control_response', response: { subtype: 'success', request_id: frame.request_id, response: factsAnswer() } })
        queueMicrotask(() => seat.onSeatLine(RUNNER, line, roster as never, daemonDir))
      }
      return true
    },
    list: () => [],
    patchSeatModel: () => true,
    patchSeatEffort: () => true,
  }
  const framesOut: Array<Record<string, unknown> & { at: number }> = []
  const QUARTER_SECOND_MS = 250
  const RELAY_ALLOWANCE_MS = 50
  const WORK_POLL_MS = 1000
  type Reference = { frameAt: number; firedAt: number | null }
  const references: Reference[] = []
  const stdout = setInterval(() => {
    for (const event of drainSdkEvents()) {
      framesOut.push({ ...(event as Record<string, unknown>), at: Date.now() })
      seat.onSeatLine(RUNNER, JSON.stringify(event), roster as never, daemonDir)
      if ((event as { subtype?: unknown }).subtype === 'task_progress') {
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
    const request = requests.find(r => r.at >= since && r.request.subtype === 'session_facts') ?? null
    return { landed, frameAt: reference?.frameAt ?? null, requestAt: request?.at ?? null, referenceFiredAt: reference?.firedAt ?? null, stampAt, noticedAt }
  }
  const offset = (at: number | null, since: number): string => (at === null ? 'never' : `+${at - since} ms`)
  const segments = (since: number, l: Landing): string =>
    `the frame at the seat ${offset(l.frameAt, since)} · the seat's re-ask ${offset(l.requestAt, since)} · the prover's quarter-second timer fired ${offset(l.referenceFiredAt, since)} · the daemon's stamp ${offset(l.landed ? l.stampAt : null, since)} · the file read back ${offset(l.noticedAt, since)}; facts requests since: ${requests.filter(r => r.at >= since).map(r => `${r.request.subtype}@${offset(r.at, since)}`).join(', ') || 'none'}`

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
    const parkFrames = framesOut.filter(f => f.subtype === 'task_progress' && f.at >= parkedAt - 5)
    check(`${label}: the park itself put one task_progress frame on the runner's wire for the parked row's task (the daemon re-asks the facts on it) — at the seat ${offset(park.frameAt, parkedAt)} after the park`, parkFrames.length >= 1, `frames since the park: ${j(framesOut.filter(f => f.at >= parkedAt - 5).map(f => f.subtype))}`)
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
    const seamA = new runControl.WorkflowExecutionPause() as RunSeam
    const controller = new AbortController()
    const tasks: Record<string, TaskLike> = { 'wf-a': taskRow('wf-a', 'local_workflow', { workflowRunId: 'run-a', toolUseId: 'toolu_wf_a', agentControllers: new Map<string, AbortController>([['agent-a1', controller]]) }) }
    const two = buildRig([{ name: 'a1', seat: 'a1', tool: 'SerialTool', gate: seamGateOf(seamA) }], tasks)
    await until(() => callsOf(two, 'a1').length === 1, "the run's agent has its first model call in flight")
    const rowOf = (): WorkRowV1 => {
      const wait = two.waitOf('a1')
      return {
        id: 'wf-a',
        kind: 'workflow',
        name: 'run a',
        status: 'running',
        startTime: t0,
        workflowRunId: 'run-a',
        agentCount: 1,
        totalTokens: 0,
        phases: [{ title: 'Work', planned: true, agents: [{ index: 1, label: 'a1', state: 'progress', agentId: 'agent-a1', waiting: wait === null ? null : 'operator', pausedBy: wait === null ? null : BY }] }],
      } as WorkRowV1
    }
    const parkedRow = (row: WorkRowV1): boolean => (row.phases ?? []).some(phase => phase.agents.some(agent => agent.agentId === 'agent-a1' && agent.pausedBy === BY))
    const measured = await measure("a workflow agent under its run's pause", two, 'a1', rowOf, parkedRow, () => pauseRun(seamA, 'wf-a', tasks).applied, () => resumeRun(seamA))
    check("the park's frame names the workflow task that owns the parked agent (task_id wf-a)", measured !== null && measured.frames.some(f => f.task_id === 'wf-a'), j(measured?.frames.map(f => f.task_id)))
    for (const n of [1, 2, 3]) { two.modelLatch('a1', n).open(); if (n < 3) two.toolLatch('a1', n).open() }
    await two.done('a1')
    gate?.resume()
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
      agentType: 'mercury-general',
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
}

clearTimeout(guard)
console.log('─'.repeat(76))
console.log(failures === 0 ? `ALL PASS — ${checks} checks` : `FAILURES: ${failures} of ${checks} checks`)
process.exit(failures === 0 ? 0 : 1)
