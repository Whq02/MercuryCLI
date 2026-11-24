#!/usr/bin/env bun
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { z } from 'zod/v4'
import type { WorkRowV1 } from '../../src/engine/connector/types.ts'

const ROOT = join(import.meta.dir, '..', '..')
const scratch = mkdtempSync(join(tmpdir(), 'pause-wire-'))
process.env.MERCURY_CONFIG_DIR = join(scratch, 'home')
mkdirSync(process.env.MERCURY_CONFIG_DIR, { recursive: true })
const daemonDir = join(scratch, 'daemon')
mkdirSync(daemonDir, { recursive: true })
process.env.MERCURY_DAEMON_DIR = daemonDir
process.env.MERCURY_CREDENTIAL_STORE = 'file'
process.env.ANTHROPIC_API_KEY = 'proof-key-ci-gate-not-a-real-key'
delete process.env.MERCURY_HOME
for (const k of ['MERCURY_BARE', 'MERCURY_EFFORT_LEVEL', 'MERCURY_MAX_OUTPUT_TOKENS', 'MERCURY_BLOCKING_LIMIT_OVERRIDE', 'MERCURY_COMPACT', 'MERCURY_AUTO_COMPACT', 'NODE_ENV', 'MERCURY_SCRIPTED_STREAM']) {
  delete process.env[k]
}

let failures = 0
let checks = 0
function check(label: string, cond: boolean, detail = ''): void {
  checks++
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail.slice(0, 900)}` : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t)
}
const j = (v: unknown): string => JSON.stringify(v)
const doorAt = 'pressCrewPause in src/screen/widgets/faces/crewPauseDoor.ts'
const relayAt = 'pauseSessionGate in src/daemon/session-seat/verbs.ts'
const gateAt = 'operatorPauseGate in src/engine/loop/pauseGate.ts'
const chipAt = 'crewPauseChipWords / crewStatusWords in src/engine/connector/crewFacts.ts'
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

const guard = setTimeout(() => {
  console.log('\nTIMEOUT — the pause-wire proof exceeded 120s; a step is waiting on a runner answer, a latch or a facts re-ask: read the last [PASS] or [WAIT TIMEOUT] line above and the check after it in scripts/crew/prove-pause-wire.ts')
  process.exit(1)
}, 120_000)
guard.unref?.()

const { turnDoor } = await import('../../src/engine/turnDoor.ts')
const bootstrap = await import('../../src/boot/process-state/processState.ts')
bootstrap.setIsInteractive(false)
const { enableConfigs } = await import('../../src/platform/config/globalConfig.ts')
enableConfigs()
const { getDefaultAppState } = await import('../../src/screen/app-state/AppStateStore.ts')
const { createAssistantMessage, createUserMessage } = await import('../../src/engine/messages/messages.ts')
const { createFileStateCacheWithSizeLimit } = await import('../../src/platform/files/fileStateCache.ts')
const gateModule = await import('../../src/engine/loop/pauseGate.ts')
const door = await import('../../src/screen/widgets/faces/crewPauseDoor.ts')
const seat = await import('../../src/daemon/session-seat/sessionSeat.ts')
const { updateConcourseWorkers } = await import('../../src/daemon/concourse-workers/concourseWorkers.ts')
const { sessionFactsToWire } = await import('../../src/engine/connector/seatWire.ts')
const { DaemonSessionConnector } = await import('../../src/engine/connector/daemonConnector.ts')
const crew = await import('../../src/engine/connector/crewFacts.ts')
const protocol = await import('../../src/daemon/control/protocol.ts')
const { METHODS } = await import('../../src/daemon/runner-wire/methods.ts')

type SeatModule = typeof seat & {
  pauseSessionGate?: (sessionId: string, paused: boolean, roster: unknown, dir?: string, opts?: { deadlineMs?: number }) => Promise<{ outcome: string; detail?: string }>
}
type DoorModule = typeof door & {
  pressCrewPause: (reach: unknown, gate: unknown) => unknown
  CREW_PAUSE_HOSTED_REFUSAL?: string
}
const seatMod = seat as SeatModule
const doorMod = door as DoorModule
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

const { standInRunner } = await import('../lib/seatDoor.ts')
const { RPC_METHOD_NOT_FOUND } = await import('../../src/daemon/runner-wire/errors.ts')
const answered: Array<{ requestId: number; method: string; response: unknown }> = []
let channelOpen = true
let runnerAnswers = true
let runnerAnswersUnsupported = false
let rowsNow: () => WorkRowV1[] = () => []

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

const stand = standInRunner({ autoAnswer: null })
const answerRequest = (request: { id: number; method: string; params: unknown; answer(result: unknown): void; refuse(code: number, message: string, data?: unknown): void }): void => {
  if (!runnerAnswers) return
  if (request.method === 'session/facts') {
    const response = factsAnswer()
    answered.push({ requestId: request.id, method: 'session/facts', response })
    request.answer(response)
    return
  }
  if (request.method === 'session/pause_gate') {
    if (runnerAnswersUnsupported) {
      request.refuse(RPC_METHOD_NOT_FOUND, 'unknown method session/pause_gate', { method: 'session/pause_gate' })
      return
    }
    const changed = (request.params as { paused: boolean }).paused ? gate.pause() : gate.resume()
    const response = { paused: gate.paused(), parked: gate.parked().length, changed }
    answered.push({ requestId: request.id, method: 'session/pause_gate', response })
    request.answer(response)
    return
  }
  request.answer({})
}
void (async () => {
  for (;;) {
    const request = await stand.nextRequest(undefined, 600_000).catch(() => null)
    if (request === null) return
    queueMicrotask(() => answerRequest(request))
  }
})()
const roster = stand.roster({ door: () => (channelOpen ? stand.connection : undefined) })
const pauseFrames = () => stand.requests.filter(r => r.method === 'session/pause_gate').map(r => ({ paused: (r.params as { paused: boolean }).paused }))
const factsFrames = () => stand.requests.filter(r => r.method === 'session/facts')

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

function startLoop(extras: Record<string, unknown> = {}): Loop {
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
    agentId: 'agent-scout',
    seatHolder: 'scout',
    onSeatWait: (words: string | null) => { waitWords = words },
    ...extras,
  }
  const gen = turnDoor({
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
  agentType: 'mercury-crew',
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
  check('a blank chat refuses with the one sentence and sends nothing', blank.outcome === 'refused' && blank.detail === door.CREW_PAUSE_BLANK_REFUSAL && sent.length === 0, `${doorAt} must refuse a blank chat with CREW_PAUSE_BLANK_REFUSAL and call no send · ${j(blank)}`)
  const hosted = await doorMod.pressCrewPause({ kind: 'carrier', carrier: 'daemon', hostedPaused: false, send }, gate) as { outcome: string; detail?: string; paused?: boolean }
  check('a hosted chat: the press sends pauseGate(true) through the connector and answers applied, paused', hosted.outcome === 'applied' && hosted.paused === true && j(sent) === '[true]', `${doorAt} must send pauseGate(true) for a hosted carrier and answer applied, paused · ${j(hosted)} · sent=${j(sent)}${doorMod.CREW_PAUSE_HOSTED_REFUSAL !== undefined && hosted.detail === doorMod.CREW_PAUSE_HOSTED_REFUSAL ? ' (the refusal note: no verb carries a pause)' : ''}`)
  check('the local gate stays open: a hosted press never toggles the face\'s own gate', !gate.paused(), `${doorAt} must not call the local gate's pause for a daemon carrier`)
  const again = await doorMod.pressCrewPause({ kind: 'carrier', carrier: 'daemon', hostedPaused: true, send }, gate) as { outcome: string; paused?: boolean }
  check('a second press on a paused hosted chat sends pauseGate(false) and answers resumed', again.outcome === 'applied' && again.paused === false && j(sent) === '[true,false]', `${doorAt} must send pauseGate(false) when hostedPaused is true and answer resumed · ${j(again)} · sent=${j(sent)}`)
  const refusing = async (): Promise<{ outcome: 'applied' | 'refused'; detail?: string }> => ({ outcome: 'refused', detail: "the session's runner predates the pause gate · /daemon restart, then reopen the session" })
  const refused = await doorMod.pressCrewPause({ kind: 'carrier', carrier: 'daemon', hostedPaused: false, send: refusing }, gate) as { outcome: string; detail?: string }
  check("the runner's refusal reaches the note verbatim", refused.outcome === 'refused' && (refused.detail ?? '').includes('predates the pause gate'), `${doorAt} must pass the runner's refusal detail through unchanged · ${j(refused)}`)
  const sentBefore = sent.length
  const local = await doorMod.pressCrewPause({ kind: 'carrier', carrier: 'in-process', hostedPaused: false, send }, gate) as { outcome: string; paused?: boolean }
  check('an in-process carrier toggles the local gate directly and sends nothing', local.outcome === 'applied' && local.paused === true && gate.paused() && sent.length === sentBefore, `${doorAt} must toggle the local gate and send nothing for an in-process carrier · ${j(local)}`)
  gate.resume()
  const note = door.crewPauseDoorNote({ outcome: 'applied', paused: true })
  check('the notes are the ones the in-process carrier already paints', note.text === door.CREW_PAUSED_NOTE && door.crewPauseDoorNote({ outcome: 'applied', paused: false }).text === door.CREW_RESUMED_NOTE, 'crewPauseDoorNote in src/screen/widgets/faces/crewPauseDoor.ts must return CREW_PAUSED_NOTE for paused and CREW_RESUMED_NOTE for resumed')
}

section('D2 THE DAEMON SEAT — pauseSessionGate asks session/pause_gate { paused } of the session\'s runner and answers its word')
if (typeof seatMod.pauseSessionGate !== 'function') {
  check('sessionSeat.ts exports pauseSessionGate (the relay of the one control verb)', false, 'absent — no pause_gate request ever reaches the wire')
} else {
  const relay = seatMod.pauseSessionGate
  const before = pauseFrames().length
  const pending = relay(SESSION, true, roster, daemonDir)
  await settle(10)
  const sentFrames = pauseFrames()
  check('the seat sent ONE session/pause_gate request carrying paused: true', sentFrames.length === before + 1 && sentFrames.at(-1)?.paused === true, `${relayAt} must write exactly one session/pause_gate request with the paused flag · ${j(sentFrames.at(-1))}`)
  const out = await pending
  check("the runner's success answer settles applied with its word (paused, parked, changed) as the detail", out.outcome === 'applied' && typeof out.detail === 'string' && JSON.parse(out.detail).paused === true && JSON.parse(out.detail).changed === true, `${relayAt} must settle applied with the runner's answer as a JSON detail · ${j(out)}`)
  check("the runner's gate closed through the wire", gate.paused(), `the stand-in runner in this proof pauses ${gateAt} when it receives session/pause_gate; ${relayAt} must have sent it`)
  await settle(20)
  check('the verb\'s answer re-asks the facts at once (the seat\'s own law for a settled verb)', factsFrames().length >= 1, `${factsFrames().length} facts request(s) — a settled pause verb must re-ask session/facts (see requestSessionFacts in src/daemon/session-seat/facts.ts and the verb in ${relayAt})`)
  const resumed = await relay(SESSION, false, roster, daemonDir)
  check('paused: false relays the same way and reopens the gate', resumed.outcome === 'applied' && !gate.paused() && pauseFrames().at(-1)?.paused === false, `${relayAt} must relay paused: false the same way and the gate must reopen · ${j(resumed)}`)
  const twice = await relay(SESSION, false, roster, daemonDir)
  check('a resume of an open gate is applied, unchanged (the runner says so)', twice.outcome === 'applied' && typeof twice.detail === 'string' && JSON.parse(twice.detail).changed === false, `${relayAt} must return the runner's answer (changed: false) when the gate was already open · ${j(twice)}`)
  const stranger = await relay('no-such-session', true, roster, daemonDir)
  check('an unknown session refuses typed, no frame written', stranger.outcome === 'refused' && (stranger.detail ?? '').includes('unknown-session'), `${relayAt} must refuse an unknown session with 'unknown-session' and write no frame · ${j(stranger)}`)
  channelOpen = false
  const closed = await relay(SESSION, true, roster, daemonDir)
  check('a seat with no live runner door refuses typed', closed.outcome === 'refused' && (closed.detail ?? '').includes('no live runner door'), `${relayAt} must refuse with 'no live runner door' when the session has no open runner channel · ${j(closed)}`)
  channelOpen = true
  runnerAnswers = false
  const late = await relay(SESSION, true, roster, daemonDir, { deadlineMs: 60 })
  check('a runner silent past the deadline refuses typed, naming the wait', late.outcome === 'refused' && (late.detail ?? '').includes('did not answer the pause-gate'), `${relayAt} must refuse with 'did not answer the pause-gate' when the runner stays silent past deadlineMs · ${j(late)}`)
  runnerAnswers = true
  runnerAnswersUnsupported = true
  const older = await relay(SESSION, true, roster, daemonDir)
  check("an older runner's unknown method names the gap and the restart", older.outcome === 'refused' && (older.detail ?? '').includes('predates the pause gate') && (older.detail ?? '').includes('/daemon restart'), `${relayAt} must turn an unknown-method refusal into words naming 'predates the pause gate' and '/daemon restart' · ${j(older)}`)
  runnerAnswersUnsupported = false
  await settle(30)
  check('nothing is left pending on the door once the facts re-ask is answered', stand.connection.peer.pendingCount === 0, `${String(stand.connection.peer.pendingCount)} request(s) still pending — every request the seat sends in ${relayAt} and requestSessionFacts (src/daemon/session-seat/facts.ts) must be answered or settled`)
  check('the gate is open before the three layers run', !gate.paused() && gate.parked().length === 0, `${gateAt} is still closed or holds parked seats — an earlier check left it paused; the last relay(SESSION, false) must reopen it`)
}

section('P1 THE THREE LAYERS — p on a hosted chat parks a real loop in the runner; the rows carry the parked words; the chip reads the runner\'s fact; p again reopens')
{
  const rpcLog: Record<string, unknown>[] = []
  let factsFeedReads: () => void = () => {}
  const connector = new DaemonSessionConnector({
    sessionId: SESSION,
    runnerId: RUNNER,
    title: 'pause wire',
    projectLabel: 'proof',
    workspaceId: ROOT,
    home: scratch,
    modelKey: MODEL,
  }, {
    rpc: async (req: Record<string, unknown>) => {
      rpcLog.push(req)
      if (req.op !== 'sessionControl' || req.action !== 'pause-gate') return { ok: false, code: 'EUNKNOWN', error: `unexpected rpc ${String(req.op)}/${String(req.action)}` }
      if (typeof req.paused !== 'boolean') return { ok: true, op: 'sessionControl', outcome: 'refused', detail: 'pause-gate requires paused' }
      if (typeof seatMod.pauseSessionGate !== 'function') return { ok: true, op: 'sessionControl', outcome: 'refused', detail: 'no relay on this tree' }
      const out = await seatMod.pauseSessionGate(String(req.sessionId), req.paused, roster, daemonDir)
      return { ok: true, op: 'sessionControl', outcome: out.outcome, ...(out.detail !== undefined ? { detail: out.detail } : {}) }
    },
    factsRead: (read: () => void) => {
      factsFeedReads = read
    },
  })
  const rosterOf = (): { rows: readonly WorkRowV1[]; pauseGate?: { paused: boolean; parked: number } } => {
    factsFeedReads()
    return connector.workRoster() as never
  }
  const chipOf = (): string | null => {
    const r = rosterOf()
    return crew.crewPauseChipWords(crew.crewmatesOf(r.rows, SESSION), r.pauseGate ?? { paused: false, parked: 0 })
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
  check('a real loop runs in the scripted runner: its first model call is in flight, its row reads running with no wait', loop.calls === 1 && loop.wait() === null, 'the rig loop (startLoop in this file, query in src/engine/turnDoor.ts) did not make its first model call, or already carries a wait')
  seat.requestSessionFacts(RUNNER, roster as never, { immediate: true })
  await settle(20)
  const idle = rosterOf()
  check("before the press: the runner's facts reach the face — one running row, the gate fact open (never a face-side latch)", idle.rows.length === 1 && idle.rows[0]?.status === 'running' && idle.pauseGate?.paused === false, `the seat facts (sessionFactsToWire in src/engine/connector/seatWire.ts) and the connector's workRoster (src/engine/connector/daemonConnector.ts) must carry the runner's rows and gate fact · ${j(idle)}`)
  check('before the press: no chip', chipOf() === null, `${chipAt} must return null while the gate is open and nothing is parked · ${chipOf() ?? ''}`)

  const pauseCount = pauseFrames().length
  const receipt = await press()
  check('p: the door answers applied, paused (the runner\'s word relayed by the daemon)', receipt.outcome === 'applied' && receipt.paused === true, `${doorAt} and the connector's pauseGate (src/engine/connector/daemonConnector.ts) must answer applied, paused · ${j(receipt)}`)
  check('p: the RPC carried sessionControl/pause-gate with paused: true', rpcLog.some(r => r.action === 'pause-gate' && r.paused === true), `the connector's pauseGate in src/engine/connector/daemonConnector.ts must send an rpc with op sessionControl, action pause-gate and paused: true · ${j(rpcLog)}`)
  check('p: ONE session/pause_gate request crossed the wire to the runner', pauseFrames().length === pauseCount + 1 && pauseFrames().at(-1)?.paused === true, `${pauseFrames().length - pauseCount} request(s) — ${relayAt} must send exactly one session/pause_gate frame per press`)
  check("p: the runner's gate is closed", gate.paused(), `the runner side of session/pause_gate must pause ${gateAt}`)
  await settle(30)
  const closedRoster = rosterOf()
  check("p: the face reads the gate's state from the runner's facts — pauseGate.paused true on the roster", closedRoster.pauseGate?.paused === true, `the roster's pauseGate must come from the runner's session/facts (sessionFactsToWire in src/engine/connector/seatWire.ts, workRoster in daemonConnector.ts) · ${j(closedRoster.pauseGate)}`)
  check('p: the chip reads paused by the operator before any loop parked', chipOf() === 'paused by the operator', `${chipAt} must read 'paused by the operator' when the gate is closed with nothing parked · ${chipOf() ?? 'null'}`)

  loop.modelLatch(1).open()
  await until(() => loop.wait() !== null, 'the loop parks at the tool seam after its stream finishes')
  check('the stream in flight finished and the loop parked at its next safe point (the tool seam), no tool started', loop.wait() === gateModule.pauseGateToolWords('SerialTool') && loop.toolStarts === 0 && j(gate.parked()) === '["scout"]', `${gateAt} must park the loop at the tool seam (pauseGateToolWords) with no tool started · wait=${loop.wait()} tools=${loop.toolStarts} parked=${j(gate.parked())}`)
  seat.requestSessionFacts(RUNNER, roster as never, { immediate: true })
  await settle(30)
  const parkedRoster = rosterOf()
  const parkedRow = crew.crewmatesOf(parkedRoster.rows, SESSION)[0]
  check("the roster row carries the parked words from the seam: the status cell reads paused by the operator, the tail names the tool", parkedRow !== undefined && crew.crewStatusWords(parkedRow, Date.now()) === 'paused by the operator' && crew.crewOperatorPauseParts(parkedRow)?.detail === 'at a tool (SerialTool)', `${chipAt} (crewStatusWords, crewOperatorPauseParts) must read the parked wait words as 'paused by the operator' with the tool in the detail · ${j(parkedRow?.wait)}`)
  check("the runner's fact counts the parked loop: pauseGate { paused: true, parked: 1 }", parkedRoster.pauseGate?.paused === true && parkedRoster.pauseGate?.parked === 1, `the runner's facts (sessionFactsToWire in src/engine/connector/seatWire.ts) must carry pauseGate { paused, parked } from ${gateAt} · ${j(parkedRoster.pauseGate)}`)
  check('the chip reads paused by the operator · 1 parked', chipOf() === 'paused by the operator · 1 parked', `${chipAt} must append '· N parked' when loops are parked · ${chipOf() ?? 'null'}`)

  const again = await press()
  check('p again: the door answers applied, resumed', again.outcome === 'applied' && again.paused === false, `${doorAt} must send pauseGate(false) from a paused hosted chat and answer resumed · ${j(again)}`)
  check('p again: the request crossed with paused: false and the runner\'s gate is open', pauseFrames().at(-1)?.paused === false && !gate.paused(), `${relayAt} must send paused: false and the runner must reopen ${gateAt} · ${j(pauseFrames().at(-1))}`)
  await until(() => loop.toolStarts === 1, 'the parked tool starts after the resume')
  check('the parked loop continues from where it stopped: its tool starts with the input the model asked for, the wait clears', loop.toolStarts === 1 && loop.wait() === null, `resuming ${gateAt} must release the parked loop so its tool starts and onSeatWait clears · tools=${loop.toolStarts} wait=${loop.wait()}`)
  seat.requestSessionFacts(RUNNER, roster as never, { immediate: true })
  await settle(30)
  const openRoster = rosterOf()
  check('the face reads the gate open again from the facts: no chip, the row runs', openRoster.pauseGate?.paused === false && openRoster.pauseGate?.parked === 0 && chipOf() === null && openRoster.rows[0]?.wait === undefined, `the facts re-ask after resume must show the gate open, nothing parked, no chip (${chipAt}) · ${j(openRoster.pauseGate)}`)

  loop.toolLatch(1).open()
  loop.modelLatch(2).open()
  loop.toolLatch(2).open()
  loop.modelLatch(3).open()
  const terminal = await Promise.race([loop.done, settle(8_000).then(() => ({ reason: 'timeout' }))])
  check('the loop completes (three calls, two tools) once every latch opens', terminal.reason === 'completed' && loop.calls === 3 && loop.toolStarts === 2, `the resumed loop (query in src/engine/turnDoor.ts, gate in ${gateAt}) must run to completion after the pause · ${j(terminal)}`)
  rowsNow = () => [{ ...rowOf(loop), status: 'completed', endTime: Date.now() }]
  seat.requestSessionFacts(RUNNER, roster as never, { immediate: true })
  await settle(20)
}

section('W1 THE WIRE — the verb\'s ceremony at each layer, pinned in source')
{
  check('the daemon verb sessionControl/pause-gate is born at proto 12 and the wire is at least there', protocol.DAEMON_VERB_BORN_AT['sessionControl/pause-gate'] === 12 && protocol.verbBornAt('sessionControl', 'pause-gate') === 12 && protocol.MERCURY_DAEMON_PROTO >= 12, `DAEMON_VERB_BORN_AT and MERCURY_DAEMON_PROTO in src/daemon/control/protocol.ts must register sessionControl/pause-gate at proto 12 · born ${String(protocol.DAEMON_VERB_BORN_AT['sessionControl/pause-gate'])} · proto ${protocol.MERCURY_DAEMON_PROTO}`)
  const parse = METHODS['session/pause_gate'].params()
  check('the runner door accepts { paused: boolean } for session/pause_gate and refuses a missing boolean', parse.safeParse({ paused: true }).success && parse.safeParse({ paused: false }).success && !parse.safeParse({}).success, "the params schema of 'session/pause_gate' in src/daemon/runner-wire/sessionVerbs.ts must be { paused: boolean } with paused required")
  const { liveFactsOf, withLiveRunner } = await import('../lib/builtProduct.ts')
  const gate = await withLiveRunner(async runner => {
    const rest = (await liveFactsOf(runner)).pauseGate
    const closed = await runner.request('session/pause_gate', { paused: true })
    const again = await runner.request('session/pause_gate', { paused: true })
    const held = (await liveFactsOf(runner)).pauseGate
    const opened = await runner.request('session/pause_gate', { paused: false })
    return { rest, closed, again, held, opened, open: (await liveFactsOf(runner)).pauseGate }
  })
  check("the runner's arm owns the method: paused closes the one gate, false opens it, the answer is the gate's word", j(gate.closed) === j({ paused: true, parked: 0, changed: true }) && j(gate.again) === j({ paused: true, parked: 0, changed: false }) && j(gate.opened) === j({ paused: false, parked: 0, changed: true }), `the runner's session/pause_gate arm must close and open ${gateAt} and answer { paused, parked, changed } · ${j(gate)}`)
  check("the runner's facts answer publishes the gate's state (pauseGate: paused, parked)", j(gate.rest) === j({ paused: false, parked: 0 }) && j(gate.held) === j({ paused: gate.closed.paused, parked: gate.closed.parked }) && j(gate.open) === j({ paused: gate.opened.paused, parked: gate.opened.parked }), `the runner's session/facts answer must publish pauseGate { paused, parked } from ${gateAt} (sessionFactsToWire in src/engine/connector/seatWire.ts) · ${j(gate)}`)
  {
    const { WorkPart } = await import('../../src/engine/connector/daemon/work.ts')
    let seatFacts: Record<string, unknown> = { work: [], pauseGate: { paused: false, parked: 0 }, swarm: { on: true, snapshot: { seq: 1 } } }
    const roster = new WorkPart({ facts: () => seatFacts as never, carrierGone: () => false })
    let wakes = 0
    roster.subscribeWork(() => wakes++)
    const reread = (next: Record<string, unknown>): number => {
      const before = wakes
      seatFacts = next
      roster.refreshWork()
      return wakes - before
    }
    const first = reread(seatFacts)
    const same = reread({ ...seatFacts })
    const gateMoved = reread({ ...seatFacts, pauseGate: { paused: true, parked: 2 } })
    const carried = j((roster.workRoster() as { pauseGate?: unknown }).pauseGate)
    const swarmMoved = reread({ ...seatFacts, swarm: { on: true, snapshot: { seq: 2 } } })
    const swarmOff = reread({ ...seatFacts, swarm: { on: false, snapshot: { seq: 2 } } })
    check('the roster snapshot carries the gate fact and the live swarm snapshot, content-keyed with the rows', first === 1 && same === 0 && gateMoved === 1 && carried === j({ paused: true, parked: 2 }) && swarmMoved === 1 && swarmOff === 1, `WorkPart in src/engine/connector/daemon/work.ts (refreshWork, workRoster) must wake subscribers only when the rows, the gate fact or the swarm snapshot change, and carry the gate fact on the roster · ${j({ first, same, gateMoved, carried, swarmMoved, swarmOff })}`)
  }
}

clearTimeout(guard)
rmSync(scratch, { recursive: true, force: true })
console.log('─'.repeat(76))
console.log(failures === 0 ? `ALL PASS — ${checks} checks` : `FAILURES: ${failures} of ${checks} checks`)
stand.close()
process.exit(failures === 0 ? 0 : 1)
