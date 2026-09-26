#!/usr/bin/env bun
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { z } from 'zod/v4'
import type { WorkRowV1 } from '../../src/services/engine-connector/types.ts'

const ROOT = join(import.meta.dir, '..', '..')
const scratch = mkdtempSync(join(tmpdir(), 'pause-wire-'))
process.env.MERCURY_CONFIG_DIR = join(scratch, 'home')
mkdirSync(process.env.MERCURY_CONFIG_DIR, { recursive: true })
const daemonDir = join(scratch, 'daemon')
mkdirSync(daemonDir, { recursive: true })
process.env.MERCURY_DAEMON_DIR = daemonDir
process.env.MERCURY_TEAMS_DIR = join(scratch, 'teams')
mkdirSync(process.env.MERCURY_TEAMS_DIR, { recursive: true })
process.env.MERCURY_CREDENTIAL_STORE = 'file'
process.env.ANTHROPIC_API_KEY = 'proof-key-ci-gate-not-a-real-key'
delete process.env.MERCURY_HOME
for (const k of ['MERCURY_BARE', 'MERCURY_EFFORT_LEVEL', 'MERCURY_MAX_OUTPUT_TOKENS', 'MERCURY_BLOCKING_LIMIT_OVERRIDE', 'MERCURY_RELEVANT_RECALL', 'CLAUDE_TEAM_NAME', 'CLAUDE_AGENT_NAME', 'MERCURY_COMPACT', 'MERCURY_AUTO_COMPACT', 'NODE_ENV', 'MERCURY_SCRIPTED_STREAM']) {
  delete process.env[k]
}

let failures = 0
let checks = 0
function check(label: string, cond: boolean, detail = ''): void {
  checks++
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail.slice(0, 400)}` : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t)
}
const j = (v: unknown): string => JSON.stringify(v)
const settle = (ms = 30): Promise<void> => new Promise(resolve => setTimeout(resolve, ms))
async function until(cond: () => boolean, what: string, ms = 6_000): Promise<boolean> {
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
const read = (rel: string): string => readFileSync(join(ROOT, rel), 'utf8')

const guard = setTimeout(() => {
  console.log('\nTIMEOUT — the pause-wire proof exceeded 120s')
  process.exit(1)
}, 120_000)
guard.unref?.()

const { query } = await import('../../src/query.ts')
const bootstrap = await import('../../src/bootstrap/state.ts')
bootstrap.setIsInteractive(false)
const { enableConfigs } = await import('../../src/utils/config/globalConfig.ts')
enableConfigs()
const { getDefaultAppState } = await import('../../src/state/AppStateStore.ts')
const { createAssistantMessage, createUserMessage } = await import('../../src/utils/messages.ts')
const { createFileStateCacheWithSizeLimit } = await import('../../src/utils/fileStateCache.ts')
const gateModule = await import('../../src/run-core/pauseGate.ts')
const door = await import('../../src/components/mercury-ui/screens/crewPauseDoor.ts')
const seat = await import('../../src/daemon/sessionSeat.ts')
const { updateConcourseWorkers } = await import('../../src/daemon/concourseSupervisor.ts')
const { sessionFactsToWire } = await import('../../src/services/engine-connector/seatWire.ts')
const { DaemonSessionConnector } = await import('../../src/services/engine-connector/daemonConnector.ts')
const crew = await import('../../src/services/engine-connector/crewFacts.ts')
const protocol = await import('../../src/daemon/protocol.ts')
const schemas = await import('../../src/entrypoints/sdk/controlSchemas.ts')
const runControl = await import('../../src/tools/WorkflowTool/runControl.ts')

type SeatModule = typeof seat & {
  pauseSessionGate?: (sessionId: string, paused: boolean, roster: unknown, dir?: string, opts?: { deadlineMs?: number }) => Promise<{ outcome: string; detail?: string }>
}
type DoorModule = typeof door & {
  pressCrewPause: (reach: unknown, gate: unknown) => unknown
  CREW_PAUSE_HOSTED_REFUSAL?: string
}
type SchemaModule = typeof schemas & { SDKControlPauseGateRequestSchema?: () => { safeParse: (v: unknown) => { success: boolean } } }
type RunControlModule = typeof runControl & {
  runnerHostsOnlyRun?: (taskId: string, tasks: Record<string, { status: string }>) => boolean
  workflowGateRide?: (gate: unknown) => { close: (hostsOnly: boolean) => boolean; open: () => boolean; closed: () => boolean; release: () => void }
}
const seatMod = seat as SeatModule
const doorMod = door as DoorModule
const schemaMod = schemas as SchemaModule
const runControlMod = runControl as RunControlModule
const gate = gateModule.operatorPauseGate

const RUNNER = 'concourse-pw1'
const SESSION = 'aaaaaaaa-bbbb-4ccc-8ddd-pausewire001'
const MODEL = 'claude-opus-4-8'
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

type Frame = { type: string; request_id: string; request: { subtype: string; paused?: boolean } }
const frames: Frame[] = []
const answered: Array<{ requestId: string; subtype: string; response: unknown }> = []
let channelOpen = true
let runnerAnswers = true
let runnerAnswersUnsupported = false
let rowsNow: () => WorkRowV1[] = () => []
let factsSeq = 0

function factsAnswer(): Record<string, unknown> {
  const state = gate.state()
  return sessionFactsToWire({
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
    pauseGate: { paused: state.paused, parked: state.parked },
  } as never)
}

function answerFrame(frame: Frame): void {
  if (!runnerAnswers) return
  const line = (response: Record<string, unknown>): string => JSON.stringify({ type: 'control_response', response: { subtype: 'success', request_id: frame.request_id, response } })
  if (frame.request.subtype === 'session_facts') {
    factsSeq++
    const response = factsAnswer()
    answered.push({ requestId: frame.request_id, subtype: 'session_facts', response })
    seat.onSeatLine(RUNNER, line(response), roster as never, daemonDir)
    return
  }
  if (frame.request.subtype === 'pause_gate') {
    if (runnerAnswersUnsupported) {
      seat.onSeatLine(RUNNER, JSON.stringify({ type: 'control_response', response: { subtype: 'error', request_id: frame.request_id, error: 'unsupported control request subtype: pause_gate' } }), roster as never, daemonDir)
      return
    }
    const changed = frame.request.paused === true ? gate.pause() : gate.resume()
    const response = { paused: gate.paused(), parked: gate.parked().length, changed }
    answered.push({ requestId: frame.request_id, subtype: 'pause_gate', response })
    seat.onSeatLine(RUNNER, line(response), roster as never, daemonDir)
  }
}

const roster = {
  control: (short: string, raw: string): boolean => {
    if (!channelOpen || short !== RUNNER) return false
    const frame = JSON.parse(raw) as Frame
    frames.push(frame)
    queueMicrotask(() => answerFrame(frame))
    return true
  },
  list: () => [],
  patchSeatModel: () => true,
  patchSeatEffort: () => true,
}
const pauseFrames = (): Frame[] => frames.filter(f => f.type === 'control_request' && f.request.subtype === 'pause_gate')
const factsFrames = (): Frame[] => frames.filter(f => f.type === 'control_request' && f.request.subtype === 'session_facts')

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
const allowAll = async (_tool: unknown, input: Record<string, unknown>) => ({ behavior: 'allow', updatedInput: input, decisionReason: { type: 'other', reason: 'rig' } }) as never

type Loop = {
  wait: () => string | null
  calls: number
  toolStarts: number
  modelLatch: (n: number) => Latch
  toolLatch: (n: number) => Latch
  controller: AbortController
  done: Promise<Record<string, unknown>>
}

function startLoop(): Loop {
  const modelLatches = new Map<number, Latch>()
  const toolLatches = new Map<number, Latch>()
  const latchIn = (map: Map<number, Latch>, n: number): Latch => {
    let l = map.get(n)
    if (l === undefined) {
      l = latch()
      map.set(n, l)
    }
    return l
  }
  const loop: Loop = {
    wait: () => waitWords,
    calls: 0,
    toolStarts: 0,
    modelLatch: n => latchIn(modelLatches, n),
    toolLatch: n => latchIn(toolLatches, n),
    controller: new AbortController(),
    done: Promise.resolve({}),
  }
  let waitWords: string | null = null
  const tool = {
    name: 'SerialTool',
    async description() { return 'rig tool' },
    async prompt() { return 'rig tool' },
    inputSchema: z.object({ text: z.string() }),
    userFacingName: () => 'SerialTool',
    isEnabled: () => true,
    isConcurrencySafe: () => false,
    isReadOnly: () => true,
    isMcp: false,
    needsPermissions: () => false,
    async validateInput() { return { result: true } },
    call: async (input: Record<string, unknown>, ctx: Record<string, unknown>) => {
      loop.toolStarts++
      await abortable((ctx.abortController as AbortController).signal, loop.toolLatch(Number(String(input.text).split('-')[1])).promise)
      return { data: `slow:${String(input.text)}` }
    },
    mapToolResultToToolResultBlockParam: (data: unknown, toolUseId: string) => ({ type: 'tool_result', tool_use_id: toolUseId, content: String(data) }),
  } as never
  async function* callModel(req: { messages: unknown[]; signal: AbortSignal }): AsyncGenerator<unknown, void> {
    const ordinal = ++loop.calls
    yield { type: 'stream_event', event: { type: 'ping' } }
    await abortable(req.signal, loop.modelLatch(ordinal).promise)
    if (req.signal.aborted) return
    if (ordinal >= 3) {
      yield createAssistantMessage({ content: 'scout done.' })
      return
    }
    const message = createAssistantMessage({ content: [{ type: 'tool_use', id: `scout_tu${ordinal}`, name: 'SerialTool', input: { text: `scout-${ordinal}` } }] as never })
    message.message.stop_reason = 'tool_use'
    yield message
  }
  let appState: Record<string, unknown> = { ...(getDefaultAppState() as unknown as Record<string, unknown>), effortValue: 'high' }
  const ctx: Record<string, unknown> = {
    abortController: loop.controller,
    options: {
      commands: [],
      tools: [tool],
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
    agentId: 'agent-scout',
    seatHolder: 'scout',
    onSeatWait: (words: string | null) => { waitWords = words },
  }
  const gen = query({
    messages: [createUserMessage({ content: 'hello from scout' })] as never,
    systemPrompt: ['rig system prompt'] as never,
    userContext: {},
    systemContext: {},
    canUseTool: allowAll as never,
    toolUseContext: ctx as never,
    querySource: 'agent:builtin:scout' as never,
    deps: {
      callModel: callModel as never,
      autocompact: (async () => ({ wasCompacted: false })) as never,
      microcompact: (async (messages: unknown[]) => ({ messages })) as never,
      uuid: ((): (() => string) => { let n = 0; return () => `00000000-0000-4000-8000-5${String(++n).padStart(11, '0')}` })(),
    },
  })
  loop.done = (async () => {
    let r = await gen.next()
    while (!r.done) r = await gen.next()
    return r.value as Record<string, unknown>
  })()
  return loop
}

const t0 = Date.now() - 30_000
const rowOf = (loop: Loop): WorkRowV1 => ({
  id: 'agent-scout',
  agentId: 'agent-scout',
  kind: 'agent',
  name: 'scout the release notes',
  status: 'running',
  startTime: t0,
  agentType: 'mercury-general',
  model: MODEL,
  ...(loop.wait() !== null ? { wait: loop.wait() as string } : {}),
})

console.log('pause wire — one control verb across the connector, the daemon seat and the runner')
console.log(`  daemon relay: ${typeof seatMod.pauseSessionGate === 'function' ? 'present' : 'ABSENT (no pauseSessionGate on sessionSeat.ts — no pause_gate request can reach the wire)'}`)

section('D1 THE DOOR — a blank chat refuses; a hosted chat sends the verb through the connector; an in-process carrier toggles the local gate')
{
  const sent: boolean[] = []
  const send = async (paused: boolean): Promise<{ outcome: 'applied' | 'refused'; detail?: string }> => {
    sent.push(paused)
    return { outcome: 'applied', detail: j({ paused, parked: 0, changed: true }) }
  }
  const blank = await doorMod.pressCrewPause({ kind: 'blank' }, gate) as { outcome: string; detail?: string }
  check('a blank chat refuses with the one sentence and sends nothing', blank.outcome === 'refused' && blank.detail === door.CREW_PAUSE_BLANK_REFUSAL && sent.length === 0, j(blank))
  const hosted = await doorMod.pressCrewPause({ kind: 'carrier', carrier: 'daemon', hostedPaused: false, send }, gate) as { outcome: string; detail?: string; paused?: boolean }
  check('a hosted chat: the press sends pauseGate(true) through the connector and answers applied, paused', hosted.outcome === 'applied' && hosted.paused === true && j(sent) === '[true]', `${j(hosted)} · sent=${j(sent)}${doorMod.CREW_PAUSE_HOSTED_REFUSAL !== undefined && hosted.detail === doorMod.CREW_PAUSE_HOSTED_REFUSAL ? ' (the refusal note: no verb carries a pause)' : ''}`)
  check('the local gate stays open: a hosted press never toggles the face\'s own gate', !gate.paused())
  const again = await doorMod.pressCrewPause({ kind: 'carrier', carrier: 'daemon', hostedPaused: true, send }, gate) as { outcome: string; paused?: boolean }
  check('a second press on a paused hosted chat sends pauseGate(false) and answers resumed', again.outcome === 'applied' && again.paused === false && j(sent) === '[true,false]', `${j(again)} · sent=${j(sent)}`)
  const refusing = async (): Promise<{ outcome: 'applied' | 'refused'; detail?: string }> => ({ outcome: 'refused', detail: "the session's runner predates the pause gate · /daemon restart, then reopen the session" })
  const refused = await doorMod.pressCrewPause({ kind: 'carrier', carrier: 'daemon', hostedPaused: false, send: refusing }, gate) as { outcome: string; detail?: string }
  check("the runner's refusal reaches the note verbatim", refused.outcome === 'refused' && (refused.detail ?? '').includes('predates the pause gate'), j(refused))
  const sentBefore = sent.length
  const local = await doorMod.pressCrewPause({ kind: 'carrier', carrier: 'in-process', hostedPaused: false, send }, gate) as { outcome: string; paused?: boolean }
  check('an in-process carrier toggles the local gate directly and sends nothing', local.outcome === 'applied' && local.paused === true && gate.paused() && sent.length === sentBefore, j(local))
  gate.resume()
  const note = door.crewPauseDoorNote({ outcome: 'applied', paused: true })
  check('the notes are the ones the in-process carrier already paints', note.text === door.CREW_PAUSED_NOTE && door.crewPauseDoorNote({ outcome: 'applied', paused: false }).text === door.CREW_RESUMED_NOTE)
}

section('D2 THE DAEMON SEAT — pauseSessionGate relays { subtype: pause_gate, paused } to the session\'s runner and answers its word')
if (typeof seatMod.pauseSessionGate !== 'function') {
  check('sessionSeat.ts exports pauseSessionGate (the relay of the one control verb)', false, 'absent — no pause_gate request ever reaches the wire')
} else {
  const relay = seatMod.pauseSessionGate
  const before = pauseFrames().length
  const pending = relay(SESSION, true, roster, daemonDir)
  await settle(10)
  const sentFrames = pauseFrames()
  check('the seat wrote ONE control_request of subtype pause_gate carrying paused: true', sentFrames.length === before + 1 && sentFrames.at(-1)?.request.paused === true, j(sentFrames.at(-1)))
  check("the request id wears the seat's agent-verb family (the crew doors' road)", (sentFrames.at(-1)?.request_id ?? '').startsWith('mercury-seat-agent-pause-gate-'), sentFrames.at(-1)?.request_id ?? '')
  const out = await pending
  check("the runner's success answer settles applied with its word (paused, parked, changed) as the detail", out.outcome === 'applied' && typeof out.detail === 'string' && JSON.parse(out.detail).paused === true && JSON.parse(out.detail).changed === true, j(out))
  check("the runner's gate closed through the wire", gate.paused())
  await settle(20)
  check('the verb\'s answer re-asks the facts at once (the seat\'s own law for a settled verb)', factsFrames().length >= 1, `${factsFrames().length} facts request(s)`)
  const resumed = await relay(SESSION, false, roster, daemonDir)
  check('paused: false relays the same way and reopens the gate', resumed.outcome === 'applied' && !gate.paused() && pauseFrames().at(-1)?.request.paused === false, j(resumed))
  const twice = await relay(SESSION, false, roster, daemonDir)
  check('a resume of an open gate is applied, unchanged (the runner says so)', twice.outcome === 'applied' && typeof twice.detail === 'string' && JSON.parse(twice.detail).changed === false, j(twice))
  const stranger = await relay('no-such-session', true, roster, daemonDir)
  check('an unknown session refuses typed, no frame written', stranger.outcome === 'refused' && (stranger.detail ?? '').includes('unknown-session'), j(stranger))
  channelOpen = false
  const closed = await relay(SESSION, true, roster, daemonDir)
  check('a runner with no control channel refuses typed', closed.outcome === 'refused' && (closed.detail ?? '').includes('no live control channel'), j(closed))
  channelOpen = true
  runnerAnswers = false
  const late = await relay(SESSION, true, roster, daemonDir, { deadlineMs: 60 })
  check('a runner silent past the deadline refuses typed, naming the wait', late.outcome === 'refused' && (late.detail ?? '').includes('did not answer the pause-gate'), j(late))
  runnerAnswers = true
  runnerAnswersUnsupported = true
  const older = await relay(SESSION, true, roster, daemonDir)
  check("an older runner's unsupported-subtype refusal names the gap and the restart", older.outcome === 'refused' && (older.detail ?? '').includes('predates the pause gate') && (older.detail ?? '').includes('/daemon restart'), j(older))
  runnerAnswersUnsupported = false
  check('no waiter is left behind', seat._pendingAgentVerbWaitersForTesting() === 0)
  check('the gate is open before the three layers run', !gate.paused() && gate.parked().length === 0)
}

section('P1 THE THREE LAYERS — p on a hosted chat parks a real loop in the runner; the rows carry the parked words; the chip reads the runner\'s fact; p again reopens')
{
  const connector = new DaemonSessionConnector({
    sessionId: SESSION,
    runnerId: RUNNER,
    title: 'pause wire',
    projectLabel: 'proof',
    workspaceId: ROOT,
    home: scratch,
    modelKey: MODEL,
  })
  type Guts = { rpc: (req: Record<string, unknown>) => Promise<Record<string, unknown>>; readFacts: () => void }
  const guts = connector as unknown as Guts
  const rpcLog: Record<string, unknown>[] = []
  guts.rpc = async req => {
    rpcLog.push(req)
    if (req.op !== 'sessionControl' || req.action !== 'pause-gate') return { ok: false, code: 'EUNKNOWN', error: `unexpected rpc ${String(req.op)}/${String(req.action)}` }
    if (typeof req.paused !== 'boolean') return { ok: true, op: 'sessionControl', outcome: 'refused', detail: 'pause-gate requires paused' }
    if (typeof seatMod.pauseSessionGate !== 'function') return { ok: true, op: 'sessionControl', outcome: 'refused', detail: 'no relay on this tree' }
    const out = await seatMod.pauseSessionGate(String(req.sessionId), req.paused, roster, daemonDir)
    return { ok: true, op: 'sessionControl', outcome: out.outcome, ...(out.detail !== undefined ? { detail: out.detail } : {}) }
  }
  const rosterOf = (): { rows: readonly WorkRowV1[]; pauseGate?: { paused: boolean; parked: number } } => {
    guts.readFacts()
    return connector.workRoster() as never
  }
  const chipOf = (): string | null => {
    const r = rosterOf()
    return crew.crewPauseChipWords(crew.crewAgentsOf(r.rows, SESSION), r.pauseGate ?? { paused: false, parked: 0 })
  }
  const press = async (): Promise<{ outcome: string; detail?: string; paused?: boolean }> => {
    const hostedPaused = rosterOf().pauseGate?.paused ?? false
    const connectorDoor = (connector as unknown as { pauseGate?: (paused: boolean) => Promise<{ outcome: 'applied' | 'refused'; detail?: string }> }).pauseGate
    const send = async (paused: boolean): Promise<{ outcome: 'applied' | 'refused'; detail?: string }> =>
      connectorDoor === undefined ? { outcome: 'refused', detail: 'the connector has no pauseGate door on this tree' } : connectorDoor.call(connector, paused)
    return (await doorMod.pressCrewPause({ kind: 'carrier', carrier: connector.carrier, hostedPaused, send }, gate)) as never
  }

  const loop = startLoop()
  rowsNow = () => [rowOf(loop)]
  await until(() => loop.calls === 1, 'the first model call in flight')
  check('a real loop runs in the scripted runner: its first model call is in flight, its row reads running with no wait', loop.calls === 1 && loop.wait() === null)
  seat.requestSessionFacts(RUNNER, roster as never, { immediate: true })
  await settle(20)
  const idle = rosterOf()
  check("before the press: the runner's facts reach the face — one running row, the gate fact open (never a face-side latch)", idle.rows.length === 1 && idle.rows[0]?.status === 'running' && idle.pauseGate?.paused === false, j(idle))
  check('before the press: no chip', chipOf() === null, chipOf() ?? '')

  const pauseCount = pauseFrames().length
  const receipt = await press()
  check('p: the door answers applied, paused (the runner\'s word relayed by the daemon)', receipt.outcome === 'applied' && receipt.paused === true, j(receipt))
  check('p: the RPC carried sessionControl/pause-gate with paused: true', rpcLog.some(r => r.action === 'pause-gate' && r.paused === true), j(rpcLog))
  check('p: ONE pause_gate control request crossed the wire to the runner', pauseFrames().length === pauseCount + 1 && pauseFrames().at(-1)?.request.paused === true, `${pauseFrames().length - pauseCount} request(s)`)
  check("p: the runner's gate is closed", gate.paused())
  await settle(30)
  const closedRoster = rosterOf()
  check("p: the face reads the gate's state from the runner's facts — pauseGate.paused true on the roster", closedRoster.pauseGate?.paused === true, j(closedRoster.pauseGate))
  check('p: the chip reads paused by the operator before any loop parked', chipOf() === 'paused by the operator', chipOf() ?? 'null')

  loop.modelLatch(1).open()
  await until(() => loop.wait() !== null, 'the loop parks at the tool seam after its stream finishes')
  check('the stream in flight finished and the loop parked at its next safe point (the tool seam), no tool started', loop.wait() === gateModule.pauseGateToolWords('SerialTool') && loop.toolStarts === 0 && j(gate.parked()) === '["scout"]', `wait=${loop.wait()} tools=${loop.toolStarts} parked=${j(gate.parked())}`)
  seat.requestSessionFacts(RUNNER, roster as never, { immediate: true })
  await settle(30)
  const parkedRoster = rosterOf()
  const parkedRow = crew.crewAgentsOf(parkedRoster.rows, SESSION)[0]
  check("the roster row carries the parked words from the seam: the status cell reads paused by the operator, the tail names the tool", parkedRow !== undefined && crew.crewStatusWords(parkedRow, Date.now()) === 'paused by the operator' && crew.crewOperatorPauseParts(parkedRow)?.detail === 'at a tool (SerialTool)', j(parkedRow?.wait))
  check("the runner's fact counts the parked loop: pauseGate { paused: true, parked: 1 }", parkedRoster.pauseGate?.paused === true && parkedRoster.pauseGate?.parked === 1, j(parkedRoster.pauseGate))
  check('the chip reads paused by the operator · 1 parked', chipOf() === 'paused by the operator · 1 parked', chipOf() ?? 'null')

  const again = await press()
  check('p again: the door answers applied, resumed', again.outcome === 'applied' && again.paused === false, j(again))
  check('p again: the request crossed with paused: false and the runner\'s gate is open', pauseFrames().at(-1)?.request.paused === false && !gate.paused(), j(pauseFrames().at(-1)))
  await until(() => loop.toolStarts === 1, 'the parked tool starts after the resume')
  check('the parked loop continues from where it stopped: its tool starts with the input the model asked for, the wait clears', loop.toolStarts === 1 && loop.wait() === null, `tools=${loop.toolStarts} wait=${loop.wait()}`)
  seat.requestSessionFacts(RUNNER, roster as never, { immediate: true })
  await settle(30)
  const openRoster = rosterOf()
  check('the face reads the gate open again from the facts: no chip, the row runs', openRoster.pauseGate?.paused === false && openRoster.pauseGate?.parked === 0 && chipOf() === null && openRoster.rows[0]?.wait === undefined, j(openRoster.pauseGate))

  loop.toolLatch(1).open()
  loop.modelLatch(2).open()
  loop.toolLatch(2).open()
  loop.modelLatch(3).open()
  const terminal = await Promise.race([loop.done, settle(8_000).then(() => ({ reason: 'timeout' }))])
  check('the loop completes (three calls, two tools) once every latch opens', terminal.reason === 'completed' && loop.calls === 3 && loop.toolStarts === 2, j(terminal))
  rowsNow = () => [{ ...rowOf(loop), status: 'completed', endTime: Date.now() }]
  seat.requestSessionFacts(RUNNER, roster as never, { immediate: true })
  await settle(20)
}

section('W1 THE WIRE — the verb\'s ceremony at each layer, pinned in source')
{
  check('the daemon verb sessionControl/pause-gate is born at proto 12 and the wire is at least there', protocol.DAEMON_VERB_BORN_AT['sessionControl/pause-gate'] === 12 && protocol.verbBornAt('sessionControl', 'pause-gate') === 12 && protocol.MERCURY_DAEMON_PROTO >= 12, `born ${String(protocol.DAEMON_VERB_BORN_AT['sessionControl/pause-gate'])} · proto ${protocol.MERCURY_DAEMON_PROTO}`)
  const server = read('src/daemon/controlServer.ts')
  check('the control server admits the action, names it in its refusal and forwards paused as a boolean', server.includes("raw.action === 'pause-gate'") && /requires \{ action: [^']*\|pause-gate(\|[a-z-]+)*, sessionId, by \}/.test(server) && server.includes("typeof raw.paused === 'boolean' ? { paused: raw.paused }"))
  const main = read('src/daemon/main.ts')
  check("the daemon's action arm relays through the seat's relay and requires the boolean", main.includes("if (action === 'pause-gate')") && main.includes('pauseSessionGate(sessionId, paused, roster)') && main.includes("'pause-gate requires paused'"))
  const seatSource = read('src/daemon/sessionSeat.ts')
  check("the seat delivers the runner's pause_gate control request and awaits its word under the agent-verb deadline", seatSource.includes("request: { subtype: 'pause_gate', paused }") && seatSource.includes('export function pauseSessionGate('))
  const parse = schemaMod.SDKControlPauseGateRequestSchema
  check('the runner accepts { subtype: pause_gate, paused: boolean } and refuses a missing boolean', typeof parse === 'function' && parse().safeParse({ subtype: 'pause_gate', paused: true }).success && parse().safeParse({ subtype: 'pause_gate', paused: false }).success && !parse().safeParse({ subtype: 'pause_gate' }).success, typeof parse)
  const types = read('src/entrypoints/sdk/controlTypes.ts')
  check('the control request union carries the subtype', types.includes("subtype: 'pause_gate'") && types.includes('| SDKControlPauseGateRequest'))
  const runner = read('src/cli/print.ts')
  const armAt = runner.indexOf("case 'pause_gate': {")
  const arm = armAt < 0 ? '' : runner.slice(armAt, runner.indexOf("case 'background_shell': {"))
  check("the runner's switch owns the subtype: paused closes the one gate, false opens it, the answer is the gate's word", armAt >= 0 && arm.includes('operatorPauseGate.pause()') && arm.includes('operatorPauseGate.resume()') && arm.includes('paused: operatorPauseGate.paused()'), armAt < 0 ? 'no pause_gate arm in print.ts' : arm.slice(0, 200))
  check("the runner's facts answer publishes the gate's state (pauseGate: paused, parked)", runner.includes('pauseGate: { paused:') && runner.includes('parked:'))
  const wire = read('src/services/engine-connector/seatWire.ts')
  check('the facts wire spells the fact pause_gate (snake_case at every depth)', wire.includes("pauseGate: 'pause_gate'"))
  const connectorSource = read('src/services/engine-connector/daemonConnector.ts')
  check("the connector's door rides the seat's verb chain and re-reads the facts on the applied word", connectorSource.includes("pauseGate(paused: boolean): Promise<AgentControlReceiptV1>") && connectorSource.includes("action: 'pause-gate'"))
  check('the roster snapshot carries the gate fact, content-keyed with the rows', connectorSource.includes('pauseGate') && connectorSource.includes('const stamp = JSON.stringify([reported, rows, mission, samples, pauseGate])'))
  const view = read('src/components/mercury-ui/screens/CrewView.tsx')
  check("the crew view sends the press through the focused connector's door and reads the chip from the roster's fact for a hosted chat", view.includes('getFocusedSessionConnector().pauseGate(paused)') && view.includes('roster.pauseGate'))
  const doorSource = read('src/components/mercury-ui/screens/crewPauseDoor.ts')
  check('the hosted refusal is gone from the door (the verb exists)', !doorSource.includes('no control verb carries a pause'))
}

section('R1 THE WORKFLOW RIDE — a run pause closes the gate for the run\'s agents only when the runner hosts nothing but that run; a resume or the run\'s end opens it only if the run closed it')
if (typeof runControlMod.runnerHostsOnlyRun !== 'function' || typeof runControlMod.workflowGateRide !== 'function') {
  check('runControl.ts exports runnerHostsOnlyRun and workflowGateRide', false, 'absent — a run pause never reaches the gate')
} else {
  const hostsOnly = runControlMod.runnerHostsOnlyRun
  const ride = runControlMod.workflowGateRide
  check('a runner whose only live task is the run hosts nothing but it', hostsOnly('wf-1', { 'wf-1': { status: 'running' }, 'ag-old': { status: 'completed' }, 'sh-old': { status: 'killed' } }))
  check('another running or pending task means the runner hosts other work', !hostsOnly('wf-1', { 'wf-1': { status: 'running' }, 'ag-2': { status: 'running' } }) && !hostsOnly('wf-1', { 'wf-1': { status: 'running' }, 'wf-2': { status: 'pending' } }))
  const own = gateModule.createPauseGate()
  const r = ride(own)
  check('a run pause while the runner hosts other work leaves the gate open and says so', r.close(false) === false && !own.paused() && !r.closed())
  check('a run pause while the runner hosts only the run closes the gate', r.close(true) === true && own.paused() && r.closed())
  check('the run\'s resume opens the gate it closed', r.open() === true && !own.paused() && !r.closed())
  own.pause()
  const r2 = ride(own)
  check('a run pause over a gate the operator already closed takes no ownership', r2.close(true) === false && own.paused() && !r2.closed())
  check("the run's resume never opens the operator's gate", r2.open() === false && own.paused())
  own.resume()
  const r3 = ride(own)
  r3.close(true)
  own.resume()
  own.pause()
  check("a gate the operator re-closed since the run's own close is not the run's to open", r3.open() === false && own.paused())
  own.resume()
  const source = read('src/tools/WorkflowTool/WorkflowTool.tsx')
  const arm = source.slice(source.indexOf("case 'pause':"), source.indexOf("case 'kill-agent': {"))
  check("the tool's pause arm closes the gate synchronously with the run pause (before the manifest's await) on a run-level pause alone, and opens it on the resume that lifts the run pause", arm.includes('const ride = paused && request.agentId === undefined ? gateRide.close(runnerHostsOnlyRun(taskId, context.getAppState().tasks)) : null') && arm.includes('if (!paused && !executionPause.runPaused()) gateRide.open()') && arm.includes('gateRide.close(') && arm.includes('await writeManifest()') && arm.indexOf('gateRide.close(') < arm.indexOf('await writeManifest()'))
  check("the answer names which road the run's agents park on", arm.includes('WORKFLOW_GATE_CLOSED_WORDS : WORKFLOW_GATE_OPEN_WORDS'))
  check("the run's end opens the gate it closed and releases the ride", source.includes('workflowGateRide(operatorPauseGate)') && (source.match(/gateRide\.open\(\)/g) ?? []).length >= 2 && source.includes('gateRide.release()'))

  section('R2 THE RIDE PARKS A REAL LOOP — the run\'s agent parks at the seam under the run pause and continues on the resume')
  const runRide = ride(gate)
  const agent = startLoop()
  await until(() => agent.calls === 1, "the run's agent has its first model call in flight")
  check('a run pause with the runner hosting only the run closes the process gate', runRide.close(hostsOnly('wf-1', { 'wf-1': { status: 'running' } })) === true && gate.paused())
  agent.modelLatch(1).open()
  await until(() => agent.wait() !== null, "the run's agent parks at the tool seam")
  check("the run's agent parks at its next safe point with the gate words, no tool started", agent.wait() === gateModule.pauseGateToolWords('SerialTool') && agent.toolStarts === 0 && j(gate.parked()) === '["scout"]', `wait=${agent.wait()} tools=${agent.toolStarts}`)
  check("the run's resume opens the gate", runRide.open() === true && !gate.paused())
  await until(() => agent.toolStarts === 1, "the run's agent continues")
  check("the run's agent continues from where it stopped", agent.toolStarts === 1 && agent.wait() === null)
  agent.toolLatch(1).open()
  agent.modelLatch(2).open()
  agent.toolLatch(2).open()
  agent.modelLatch(3).open()
  const end = await Promise.race([agent.done, settle(8_000).then(() => ({ reason: 'timeout' }))])
  check("the run's agent completes", end.reason === 'completed', j(end))
  runRide.release()
}

clearTimeout(guard)
rmSync(scratch, { recursive: true, force: true })
console.log('─'.repeat(76))
console.log(failures === 0 ? `ALL PASS — ${checks} checks` : `FAILURES: ${failures} of ${checks} checks`)
process.exit(failures === 0 ? 0 : 1)
