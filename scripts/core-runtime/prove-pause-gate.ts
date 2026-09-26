#!/usr/bin/env bun
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { z } from 'zod/v4'

process.env.MERCURY_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'pause-gate-laws-'))
process.env.MERCURY_DAEMON_DIR = mkdtempSync(join(tmpdir(), 'pause-gate-daemon-'))
process.env.MERCURY_TEAMS_DIR = mkdtempSync(join(tmpdir(), 'pause-gate-teams-'))
process.env.MERCURY_CREDENTIAL_STORE = 'file'
process.env.ANTHROPIC_API_KEY = 'proof-key-ci-gate-not-a-real-key'
for (const k of ['MERCURY_BARE', 'MERCURY_EFFORT_LEVEL', 'MERCURY_MAX_OUTPUT_TOKENS', 'MERCURY_BLOCKING_LIMIT_OVERRIDE', 'MERCURY_RELEVANT_RECALL', 'CLAUDE_TEAM_NAME', 'CLAUDE_AGENT_NAME', 'MERCURY_COMPACT', 'MERCURY_AUTO_COMPACT', 'NODE_ENV', 'MERCURY_SCRIPTED_STREAM']) {
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

const guard = setTimeout(() => {
  console.log('\nTIMEOUT — the pause-gate proof exceeded 120s')
  process.exit(1)
}, 120_000)
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

type CallRecord = { run: RunName; ordinal: number; messages: unknown[] }
type ToolStart = { run: RunName; tool: string; input: Record<string, unknown> }

type Rig = {
  calls: CallRecord[]
  toolStarts: ToolStart[]
  modelLatch: (run: RunName, ordinal: number) => Latch
  toolLatch: (run: RunName, ordinal: number) => Latch
  yieldsOf: (run: RunName) => unknown[]
  terminalOf: (run: RunName) => Record<string, unknown> | null
  controllerOf: (run: RunName) => AbortController
  done: (run: RunName) => Promise<void>
  seatOf: (run: RunName) => string
}

const allowAll = async (_tool: unknown, input: Record<string, unknown>) => ({ behavior: 'allow', updatedInput: input, decisionReason: { type: 'other', reason: 'rig' } }) as never

function toolUseOf(run: RunName, ordinal: number): { id: string; name: string; input: Record<string, unknown> } {
  return { id: `${run}_tu${ordinal}`, name: run === 'main' ? 'SerialTool' : 'ReadishTool', input: { text: `${run}-${ordinal}` } }
}

function buildRig(): Rig {
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
  const modelLatch = (run: RunName, ordinal: number): Latch => latchIn(modelLatches, `${run}:${ordinal}`)
  const toolLatch = (run: RunName, ordinal: number): Latch => latchIn(toolLatches, `${run}:${ordinal}`)
  const runOf = (text: string): RunName => text.split('-')[0] as RunName
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

  const yields = new Map<RunName, unknown[]>()
  const terminals = new Map<RunName, Record<string, unknown>>()
  const controllers = new Map<RunName, AbortController>()
  const dones = new Map<RunName, Promise<void>>()
  const seats: Record<RunName, string> = { main: 'main', scout: 'scout', reviewer: 'reviewer' }

  for (const run of RUNS) {
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
      const use = toolUseOf(run, ordinal)
      const message = createAssistantMessage({ content: [{ type: 'tool_use', id: use.id, name: use.name, input: use.input }] as never })
      message.message.stop_reason = 'tool_use'
      yield message
    }
    let appState: Record<string, unknown> = { ...(getDefaultAppState() as unknown as Record<string, unknown>), effortValue: 'high' }
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
      agentId: run === 'main' ? undefined : `agent-${run}`,
      ...(run === 'main' ? {} : { seatHolder: seats[run] }),
    }
    const gen = query({
      messages: [createUserMessage({ content: `hello from ${run}` })] as never,
      systemPrompt: ['rig system prompt'] as never,
      userContext: {},
      systemContext: {},
      canUseTool: allowAll as never,
      toolUseContext: ctx as never,
      querySource: (run === 'main' ? 'sdk' : `agent:builtin:${run}`) as never,
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

  return {
    calls,
    toolStarts,
    modelLatch,
    toolLatch,
    yieldsOf: run => yields.get(run) ?? [],
    terminalOf: run => terminals.get(run) ?? null,
    controllerOf: run => controllers.get(run)!,
    done: run => dones.get(run)!,
    seatOf: run => seats[run],
  }
}

const callsOf = (rig: Rig, run: RunName): CallRecord[] => rig.calls.filter(c => c.run === run)
const startsOf = (rig: Rig, run: RunName): ToolStart[] => rig.toolStarts.filter(s => s.run === run)
const assistantToolUses = (rig: Rig, run: RunName): number => rig.yieldsOf(run).filter(m => (m as AnyMsg).type === 'assistant' && JSON.stringify((m as AnyMsg).message).includes('tool_use')).length
const toolResults = (rig: Rig, run: RunName): number => rig.yieldsOf(run).filter(m => (m as AnyMsg).type === 'user' && JSON.stringify((m as AnyMsg).message).includes('tool_result')).length

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

clearTimeout(guard)
console.log('─'.repeat(76))
console.log(failures === 0 ? `ALL PASS — ${checks} checks` : `FAILURES: ${failures} of ${checks} checks`)
process.exit(failures === 0 ? 0 : 1)
