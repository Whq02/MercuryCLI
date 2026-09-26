#!/usr/bin/env bun
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const SCRATCH = mkdtempSync(join(process.env.SCRATCHPAD ?? tmpdir(), 'mcp-elicitation-pause-'))
process.env.MERCURY_CONFIG_DIR = join(SCRATCH, 'home')
mkdirSync(process.env.MERCURY_CONFIG_DIR, { recursive: true })
process.env.MERCURY_DAEMON_DIR = join(SCRATCH, 'daemon')
process.env.MERCURY_TEAMS_DIR = join(SCRATCH, 'teams')
delete process.env.MERCURY_HOME
delete process.env.MERCURY_MCP_MAX_RISK
delete process.env.MERCURY_MCP_UNTRUSTED_HARDENING
delete process.env.MERCURY_MCP_TRUSTED_SERVERS
if (process.env.NODE_ENV === 'test') delete process.env.NODE_ENV
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

const ROOT = join(import.meta.dir, '..', '..')
const SRC = process.env.PROVE_SRC ?? join(ROOT, 'src')
const FIXTURE = join(import.meta.dir, '_fixture-estate-server.mjs')

const LIMIT_MINUTES = '0.01'
const LIMIT_MS = 600
const HOLD_MS = 1500

let failures = 0
let checks = 0
const check = (label: string, ok: boolean, detail = ''): void => {
  checks++
  if (!ok) failures++
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${detail && !ok ? ` — ${detail}` : ''}`)
}
const section = (title: string): void => console.log(`\n${title}`)
const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms))
const stalledLine = /stalled: no result and no progress for /
const knob = /MERCURY_MCP_CALL_IDLE_MINUTES/

const proofWatchdog = setTimeout(() => {
  console.log('\nTIMEOUT — the elicitation-pause prover exceeded 90s')
  process.exit(1)
}, 90_000)
proofWatchdog.unref?.()

type Outcome = { result?: unknown; error?: unknown; settleMs: number }
const settle = async (call: Promise<unknown>, startedAt: number): Promise<Outcome> => {
  try {
    const result = await call
    return { result, settleMs: Date.now() - startedAt }
  } catch (error) {
    return { error, settleMs: Date.now() - startedAt }
  }
}
const messageOf = (outcome: Outcome): string =>
  outcome.error instanceof Error ? outcome.error.message : outcome.error === undefined ? '' : String(outcome.error)
const textOf = (outcome: Outcome): string => {
  const content = (outcome.result as { content?: unknown } | undefined)?.content
  if (typeof content === 'string') return content
  if (Array.isArray(content)) return content.map(block => String((block as { text?: unknown }).text ?? '')).join('')
  return JSON.stringify(outcome.result ?? null)
}

type Question = { serverName: string; requestId: unknown; params: Record<string, unknown>; signal: AbortSignal; respond: (result: unknown) => void }
function captureQueue(): { setAppState: (updater: (prev: never) => never) => void; questions: () => Question[] } {
  let state: Record<string, unknown> = { elicitation: { queue: [] } }
  return {
    setAppState: updater => {
      state = updater(state as never) as unknown as Record<string, unknown>
    },
    questions: () => ((state.elicitation as { queue?: Question[] } | undefined)?.queue ?? []),
  }
}
async function waitForQuestions(questions: () => Question[], count: number, timeoutMs = 5000): Promise<Question[]> {
  const deadline = Date.now() + timeoutMs
  while (questions().length < count && Date.now() < deadline) await sleep(10)
  return questions()
}
const parentFor = (id: string, name: string): unknown => ({ message: { content: [{ type: 'tool_use', id, name, input: {} }] } })

const { enableConfigs } = await import(join(SRC, 'utils/config/globalConfig.ts'))
enableConfigs()
const bootstrap = await import(join(SRC, 'bootstrap/state.ts'))
bootstrap.setIsInteractive(false)
const mcp = await import(join(SRC, 'services/mcp/client.ts'))
const handlerModule = await import(join(SRC, 'services/mcp/elicitationHandler.ts'))
const { registerElicitationHandler } = handlerModule
const { armInactivityDeadline } = await import(join(SRC, 'utils/deadline.ts'))
const pauseApi = handlerModule as {
  enterElicitation?: (client: unknown) => () => void
  watchElicitations?: (client: unknown, listener: (phase: string, question: symbol) => void) => () => void
  elicitationPausedClock?: (client: unknown, base?: () => number) => { now: () => number; readonly paused: boolean; release: () => void }
}
const pauseApiPresent = typeof pauseApi.enterElicitation === 'function' && typeof pauseApi.elicitationPausedClock === 'function' && typeof pauseApi.watchElicitations === 'function'

process.env.MERCURY_MCP_CALL_IDLE_MINUTES = LIMIT_MINUTES
check(`the idle knob reads ${LIMIT_MS}ms for this proof`, mcp.mcpCallIdleLimitMs() === LIMIT_MS, String(mcp.mcpCallIdleLimitMs()))

section('A. the pause primitive on an injected clock (the watchdog reads only unpaused time; the spent time is kept)')
check('the elicitation ledger and the paused clock are exported by the handler module', pauseApiPresent, 'enterElicitation / watchElicitations / elicitationPausedClock missing')
if (pauseApiPresent) {
  let t = 1000
  const base = (): number => t
  const key = {}
  const other = {}
  const clock = pauseApi.elicitationPausedClock!(key, base)
  check('a fresh clock reads the base clock', clock.now() === 1000 && !clock.paused, `now=${clock.now()}`)
  t = 4000
  check('unpaused time flows through', clock.now() === 4000, `now=${clock.now()}`)
  const leaveFirst = pauseApi.enterElicitation!(key)
  check('a question entering pauses the clock', clock.paused, 'not paused')
  t = 9000
  check('the clock is frozen while the question is open (the 3s already spent are kept, not reset)', clock.now() === 4000, `now=${clock.now()}`)
  const leaveSecond = pauseApi.enterElicitation!(key)
  leaveFirst()
  check('answering the first of two open questions does not resume', clock.paused && clock.now() === 4000, `paused=${clock.paused} now=${clock.now()}`)
  leaveSecond()
  check('answering the last open question resumes with the spent time kept', !clock.paused && clock.now() === 4000, `paused=${clock.paused} now=${clock.now()}`)
  t = 9500
  check('after the pause the clock counts on from where it stopped', clock.now() === 4500, `now=${clock.now()}`)
  leaveSecond()
  check('a second leave for the same question is a no-op', !clock.paused && clock.now() === 4500, `paused=${clock.paused} now=${clock.now()}`)
  const leaveOther = pauseApi.enterElicitation!(other)
  check('a question on another server never pauses this clock', !clock.paused, 'paused by a stranger')
  leaveOther()
  const stale = pauseApi.enterElicitation!(key)
  const later = pauseApi.elicitationPausedClock!(key, base)
  check('a question already open when a call starts is not that call\'s (a stale card never pauses a later call)', !later.paused, 'paused by a stale question')
  stale()
  check('the stale question leaving does not disturb the later clock', !later.paused && later.now() === 9500, `paused=${later.paused} now=${later.now()}`)
  later.release()
  clock.release()
  const afterRelease = pauseApi.enterElicitation!(key)
  check('a released clock ignores later questions', !clock.paused, 'paused after release')
  afterRelease()

  const liveKey = {}
  const live = pauseApi.elicitationPausedClock!(liveKey)
  const deadline = armInactivityDeadline({ seam: 'prover', limitMs: 100, now: live.now })
  const leaveLive = pauseApi.enterElicitation!(liveKey)
  await sleep(260)
  check('the deadline primitive on the paused clock does not fire while a question is open (260ms past a 100ms limit)', !deadline.fired, 'fired during the pause')
  leaveLive()
  await sleep(40)
  check('after the answer the limit has not yet been reached', !deadline.fired, 'fired too early')
  await sleep(160)
  check('the limit fires once the unpaused silence reaches it', deadline.fired, 'never fired after the resume')
  deadline.cancel()
  live.release()
}

section('B. the stdio fixture through the real connect road (the operator answers late)')
const SERVER = 'pause-fixture'
const stdioConfig = { type: 'stdio', command: process.execPath, args: [FIXTURE], env: {}, scope: 'local', name: SERVER }
await mcp.clearServerCache(SERVER, stdioConfig as never)
const connected = (await mcp.connectToServer(SERVER, stdioConfig as never)) as { type: string; client: unknown; cleanup?: () => Promise<void> }
check('the fixture connected over stdio', connected.type === 'connected', String(connected.type))
const capture = captureQueue()
registerElicitationHandler(connected.client as never, SERVER, capture.setAppState as never)
let redText = ''
{
  const startedAt = Date.now()
  const pending = settle(
    mcp.callMCPToolWithUrlElicitationRetry({ client: connected as never, tool: 'ask', args: {}, signal: new AbortController().signal, parentMessage: parentFor('tu-ask-late', 'ask') as never }),
    startedAt,
  )
  const questions = await waitForQuestions(capture.questions, 1)
  check('the server raised a form question through the handler', questions.length === 1 && String(questions[0]?.params.message).includes('colour'), JSON.stringify(questions[0]?.params ?? null))
  await sleep(HOLD_MS)
  questions[0]?.respond({ action: 'accept', content: { colour: 'blue' } })
  const outcome = await pending
  redText = messageOf(outcome)
  check(`row 1: a consent answered ${HOLD_MS}ms past a ${LIMIT_MS}ms idle limit completes the call — no stalled error is minted while the question is open`, outcome.error === undefined && /"colour":"blue"/.test(textOf(outcome)), redText || textOf(outcome))
  check('the answer the operator gave is what the server received', /answer:.*"action":"accept"/.test(textOf(outcome)), textOf(outcome))
  check('the call settled only after the answer landed (the clock waited, it did not race the operator)', outcome.settleMs >= HOLD_MS, `settled at ${outcome.settleMs}ms`)
}
{
  const startedAt = Date.now()
  const outcome = await settle(
    mcp.callMCPToolWithUrlElicitationRetry({ client: connected as never, tool: 'slow', args: { ms: 5000 }, signal: new AbortController().signal, parentMessage: parentFor('tu-silent', 'slow') as never }),
    startedAt,
  )
  const message = messageOf(outcome)
  check('row 3: a silent server with no question outstanding stalls exactly as today (the typed stalled line)', stalledLine.test(message), message || textOf(outcome))
  check('the stalled line still names the knob', knob.test(message), message)
  check('the stall settles at the idle limit, not later', outcome.settleMs < 5000, `${outcome.settleMs}ms`)
}
{
  const turn = new AbortController()
  const startedAt = Date.now()
  const pending = settle(
    mcp.callMCPToolWithUrlElicitationRetry({ client: connected as never, tool: 'ask', args: {}, signal: turn.signal, parentMessage: parentFor('tu-ask-aborted', 'ask') as never }),
    startedAt,
  )
  const questions = await waitForQuestions(capture.questions, 2)
  check('a second question is open on the same server', questions.length === 2, String(questions.length))
  await sleep(120)
  turn.abort()
  const outcome = await pending
  const message = messageOf(outcome)
  check('row 4: the turn\'s abort while the question is open ends the call promptly, never as a stall', !stalledLine.test(message) && outcome.settleMs < LIMIT_MS + 1000, `${outcome.settleMs}ms ${message}`)
  const stale = questions[1]
  check('this fixture never cancels its question, so the card stays open after the abort (the stale-card shape)', stale !== undefined && !stale.signal.aborted, 'the fixture cancelled')
  const silentStart = Date.now()
  const silent = await settle(
    mcp.callMCPToolWithUrlElicitationRetry({ client: connected as never, tool: 'slow', args: { ms: 5000 }, signal: new AbortController().signal, parentMessage: parentFor('tu-silent-after-stale', 'slow') as never }),
    silentStart,
  )
  const silentMessage = messageOf(silent)
  check('a later silent call on the same server is not paused by the stale card — it stalls exactly as today', stalledLine.test(silentMessage) && silent.settleMs < 5000, `${silent.settleMs}ms ${silentMessage || textOf(silent)}`)
  stale?.respond({ action: 'cancel' })
}
await connected.cleanup?.()

section('C. an in-process loopback server (the same client road, the SDK server asking through its own elicitation)')
{
  const { Client } = await import('@modelcontextprotocol/client')
  const { InMemoryTransport, Server } = await import('@modelcontextprotocol/server')
  const server = new Server({ name: 'asker', version: '1.0.0' }, { capabilities: { tools: {} } })
  const question = { message: 'Which colour?', requestedSchema: { type: 'object', properties: { colour: { type: 'string' } }, required: ['colour'] } } as never
  const text = (t: string): { content: Array<{ type: 'text'; text: string }> } => ({ content: [{ type: 'text', text: t }] })
  server.setRequestHandler('tools/list', async () => ({
    tools: [
      { name: 'ask', description: 'asks once', inputSchema: { type: 'object' } },
      { name: 'ask_then_stall', description: 'asks, then never answers', inputSchema: { type: 'object' } },
      { name: 'ask_twice', description: 'asks two questions at once', inputSchema: { type: 'object' } },
    ],
  }))
  server.setRequestHandler('tools/call', async (request, ctx) => {
    const elicit = (): Promise<unknown> => ctx.mcpReq.elicitInput(question, { signal: ctx.mcpReq.signal })
    const name = request.params.name
    if (name === 'ask') return text(`answer:${JSON.stringify(await elicit())}`)
    if (name === 'ask_then_stall') {
      await elicit()
      await new Promise(() => {})
    }
    if (name === 'ask_twice') {
      const answers = await Promise.all([elicit(), elicit()])
      return text(`answers:${JSON.stringify(answers)}`)
    }
    return text('unknown')
  })
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  await server.connect(serverTransport)
  const client = new Client({ name: 'prover', version: '1.0.0' }, { capabilities: { elicitation: { form: {}, url: {} } }, versionNegotiation: { mode: 'legacy' } })
  await client.connect(clientTransport)
  const loop = captureQueue()
  registerElicitationHandler(client as never, 'asker', loop.setAppState as never)
  const connection = { type: 'connected', name: 'asker', client, capabilities: {}, config: { type: 'host', name: 'asker', scope: 'session' }, cleanup: async () => {} }
  const callLoop = (tool: string, id: string, signal: AbortSignal): Promise<unknown> =>
    mcp.callMCPToolWithUrlElicitationRetry({ client: connection as never, tool, args: {}, signal, parentMessage: parentFor(id, tool) as never })

  {
    const startedAt = Date.now()
    const pending = settle(callLoop('ask_then_stall', 'tu-ask-then-stall', new AbortController().signal), startedAt)
    const questions = await waitForQuestions(loop.questions, 1)
    await sleep(HOLD_MS)
    questions[0]?.respond({ action: 'accept', content: { colour: 'green' } })
    const outcome = await pending
    const message = messageOf(outcome)
    check('row 2: answered late, then silent for a further limit — the typed deadline still fires', stalledLine.test(message), message || textOf(outcome))
    check('…and its advice still names the knob', knob.test(message), message)
    check('…and it fired after the answer, not while the question was open', outcome.settleMs >= HOLD_MS, `settled at ${outcome.settleMs}ms (the answer landed at ${HOLD_MS}ms)`)
  }
  {
    const startedAt = Date.now()
    const pending = settle(callLoop('ask_twice', 'tu-ask-twice', new AbortController().signal), startedAt)
    const questions = await waitForQuestions(loop.questions, 3)
    check('two questions on one call reach the handler together', questions.length === 3, String(questions.length))
    await sleep(LIMIT_MS + 300)
    questions[1]?.respond({ action: 'accept', content: { colour: 'red' } })
    await sleep(LIMIT_MS + 300)
    questions[2]?.respond({ action: 'accept', content: { colour: 'gold' } })
    const outcome = await pending
    check('the pause holds until the LAST question is answered — the call completes with both answers', outcome.error === undefined && /"colour":"red"/.test(textOf(outcome)) && /"colour":"gold"/.test(textOf(outcome)), messageOf(outcome) || textOf(outcome))
  }
  {
    const phases: string[] = []
    const unwatch = pauseApi.watchElicitations?.(client, phase => phases.push(phase)) ?? (() => {})
    const turn = new AbortController()
    const startedAt = Date.now()
    const pending = settle(callLoop('ask', 'tu-ask-cancelled', turn.signal), startedAt)
    const questions = await waitForQuestions(loop.questions, 4)
    await sleep(120)
    turn.abort()
    const outcome = await pending
    await sleep(50)
    unwatch()
    const message = messageOf(outcome)
    check('row 4: a well-behaved server cancels its question when the turn aborts — the card\'s signal aborts', questions[3]?.signal.aborted === true, 'the question stayed open')
    check('…the call ends promptly and never as a stall', !stalledLine.test(message) && outcome.settleMs < LIMIT_MS + 1000, `${outcome.settleMs}ms ${message}`)
    check('…and the pause ends with it (the ledger saw the question enter and leave)', phases.join(',') === 'entered,left', phases.join(',') || '(no ledger on this tree)')
  }
  await client.close().catch(() => {})
  await server.close().catch(() => {})
}

section('D. every road that parks on the operator is under the ledger')
{
  const handlerSrc = readFileSync(join(SRC, 'services/mcp/elicitationHandler.ts'), 'utf8')
  const printSrc = readFileSync(join(SRC, 'cli/print.ts'), 'utf8')
  const clientSrc = readFileSync(join(SRC, 'services/mcp/client.ts'), 'utf8')
  check('the interactive consent-card handler enters the ledger for its whole park', /setRequestHandler\('elicitation\/create', \(request, ctx\) =>\s*withElicitationEntered\(client,/.test(handlerSrc))
  check('the print/SDK structured-IO handler enters the same ledger', /withElicitationEntered\(client\.client,/.test(printSrc))
  check('the call watchdog reads the paused clock', /elicitationPausedClock\(connected\.client\)/.test(clientSrc) && /now: clock\.now/.test(clientSrc))
}

delete process.env.MERCURY_MCP_CALL_IDLE_MINUTES
rmSync(SCRATCH, { recursive: true, force: true })
if (redText) console.log(`\nrow 1 error text: ${redText || '(none)'}`)
console.log(failures === 0 ? `\nALL GREEN (${checks} checks)` : `\n${failures} FAILURE(S) of ${checks}`)
process.exit(failures === 0 ? 0 : 1)
