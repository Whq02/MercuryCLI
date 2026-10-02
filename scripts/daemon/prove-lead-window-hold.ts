#!/usr/bin/env bun
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { bootRunner, bound, childEnv, DIST, exportWorld, isSession, j, makeTally, removeWorld, SCRATCH_ROOT, seedHome, sleep, user } from './dupline-world.ts'

const { check, section, finish } = makeTally('prove-lead-window-hold')
section("a crew lead whose background shell ends inside a closed usage window: the notice waits at the seat while the seat stays awake — the operator's next line is answered at once, the process never stalls, and the notice lands once after the window")

const HOME = join(SCRATCH_ROOT, `mercury-lead-window-hold-${process.pid}`)
const CWD = join(HOME, 'fixture-repo')
const DEBUG_FILE = join(HOME, 'debug.log')
const LEAD_ASK = 'take the lead'
const ARM_ASK = 'start the slow shell'
const HELLO_ASK = 'hello there'
const AGAIN_ASK = 'hello again'
const DONE_ASK = 'that is all'
const LEAD_READY = 'the lead is ready'
const ARMED = 'the shell is armed'
const SHELL_DESCRIPTION = 'the slow shell'
const SHELL_NOTICE = `Background command "${SHELL_DESCRIPTION}"`
const SHELL_SECONDS = 6
const AGAIN_AFTER_MS = 9_000
const WALL_SECONDS = 30
const STALL_LIMIT_MS = 5_000

type Block = { type?: string; text?: string; content?: unknown }
type Item = { role?: string; content?: unknown }
type Wire = { n: number; at: number; kind: 'request' | 'walled'; ask: string; step: number; notices: number; crewCreate: boolean; results: string[] }
const wire: Wire[] = []
let wallUntilMs = 0
let calls = 0

const sse = (event: string, obj: unknown): string => `event: ${event}\ndata: ${JSON.stringify(obj)}\n\n`
const askOf = (content: unknown): string => {
  if (typeof content === 'string') return content.trimStart().startsWith('<system-reminder>') ? '' : content
  if (!Array.isArray(content)) return ''
  for (let i = content.length - 1; i >= 0; i--) {
    const part = content[i] as Block
    if (part.type === 'text' && typeof part.text === 'string' && !part.text.trimStart().startsWith('<system-reminder>')) return part.text
  }
  return ''
}
const wholeAsk = (content: unknown): string => {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return (content as Block[]).map(p => (p.type === 'text' && typeof p.text === 'string' ? p.text : '')).join('\n')
}
const resultTexts = (content: unknown): string[] => {
  if (!Array.isArray(content)) return []
  const out: string[] = []
  for (const part of content as Block[]) {
    if (part.type !== 'tool_result') continue
    if (typeof part.content === 'string') out.push(part.content)
    else if (Array.isArray(part.content)) out.push((part.content as Block[]).map(b => (typeof b.text === 'string' ? b.text : '')).join('\n'))
  }
  return out
}
const isToolResultItem = (item: Item): boolean => item.role === 'user' && Array.isArray(item.content) && (item.content as Block[]).some(p => p.type === 'tool_result')
const countOf = (hay: string, word: string): number => hay.split(word).length - 1
const usage = { input_tokens: 21, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 9 }
function answerText(res: ServerResponse, n: number, model: string, text: string): void {
  res.writeHead(200, { 'content-type': 'text/event-stream' })
  res.write(sse('message_start', { type: 'message_start', message: { id: `msg_lead_${n}`, type: 'message', role: 'assistant', model, content: [], stop_reason: null, stop_sequence: null, usage: { ...usage, output_tokens: 1 } } }))
  res.write(sse('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }))
  res.write(sse('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } }))
  res.write(sse('content_block_stop', { type: 'content_block_stop', index: 0 }))
  res.write(sse('message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage }))
  res.end(sse('message_stop', { type: 'message_stop' }))
}
function answerTool(res: ServerResponse, n: number, model: string, tool: { id: string; name: string; input: Record<string, unknown> }): void {
  res.writeHead(200, { 'content-type': 'text/event-stream' })
  res.write(sse('message_start', { type: 'message_start', message: { id: `msg_lead_${n}`, type: 'message', role: 'assistant', model, content: [], stop_reason: null, stop_sequence: null, usage: { ...usage, output_tokens: 1 } } }))
  res.write(sse('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: tool.id, name: tool.name, input: {} } }))
  res.write(sse('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: JSON.stringify(tool.input) } }))
  res.write(sse('content_block_stop', { type: 'content_block_stop', index: 0 }))
  res.write(sse('message_delta', { type: 'message_delta', delta: { stop_reason: 'tool_use', stop_sequence: null }, usage }))
  res.end(sse('message_stop', { type: 'message_stop' }))
}
function answerWalled(res: ServerResponse): void {
  const resetSeconds = Math.ceil(wallUntilMs / 1000)
  res.writeHead(429, {
    'content-type': 'application/json',
    'anthropic-ratelimit-unified-status': 'rejected',
    'anthropic-ratelimit-unified-representative-claim': 'five_hour',
    'anthropic-ratelimit-unified-reset': String(resetSeconds),
    'retry-after': String(Math.max(1, resetSeconds - Math.floor(Date.now() / 1000))),
    'x-should-retry': 'false',
  })
  res.end(JSON.stringify({ type: 'error', error: { type: 'rate_limit_error', message: 'Rate limit exceeded' } }))
}

const server = createServer((req: IncomingMessage, res: ServerResponse) => {
  const chunks: Buffer[] = []
  req.on('data', c => chunks.push(c as Buffer))
  req.on('end', () => {
    const url = (req.url ?? '').split('?')[0] ?? ''
    if (!(req.method === 'POST' && url.endsWith('/v1/messages'))) {
      res.writeHead(404, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: { message: `no fixture route for ${req.method} ${url}` } }))
      return
    }
    let body: Record<string, unknown> = {}
    try {
      body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>
    } catch {
    }
    const n = ++calls
    const model = typeof body.model === 'string' ? body.model : 'fixture'
    const items = Array.isArray(body.messages) ? (body.messages as Item[]) : []
    const crewCreate = Array.isArray(body.tools) && (body.tools as Array<{ name?: string }>).some(tool => tool.name === 'TeamCreate')
    let askIndex = -1
    for (let i = items.length - 1; i >= 0; i--) {
      if (items[i]!.role === 'user' && askOf(items[i]!.content) !== '') {
        askIndex = i
        break
      }
    }
    const ask = askIndex === -1 ? '' : askOf(items[askIndex]!.content)
    const whole = askIndex === -1 ? '' : wholeAsk(items[askIndex]!.content)
    const step = askIndex === -1 ? 0 : items.slice(askIndex + 1).filter(isToolResultItem).length
    const results = items.filter(isToolResultItem).flatMap(it => resultTexts(it.content))
    const walled = Date.now() < wallUntilMs
    wire.push({ n, at: Date.now(), kind: walled ? 'walled' : 'request', ask: ask.slice(0, 600), step, notices: countOf(whole, SHELL_NOTICE), crewCreate, results })
    if (walled) return answerWalled(res)
    if (ask.trim() === LEAD_ASK) {
      if (crewCreate && step === 0) return answerTool(res, n, model, { id: `toolu_lead_crew_${n}`, name: 'TeamCreate', input: { crew_name: 'hold-crew' } })
      return answerText(res, n, model, LEAD_READY)
    }
    if (ask.trim() === ARM_ASK) {
      if (step === 0) return answerTool(res, n, model, { id: `toolu_lead_shell_${n}`, name: 'Bash', input: { command: `sleep ${SHELL_SECONDS}; echo the slow shell is done`, description: SHELL_DESCRIPTION, run_in_background: true } })
      return answerText(res, n, model, ARMED)
    }
    return answerText(res, n, model, `heard: ${ask.trim().split('\n')[0]!.slice(0, 60)} (#${n})`)
  })
})
const port = await new Promise<number>(resolve => {
  server.listen(0, '127.0.0.1', () => {
    const address = server.address()
    resolve(typeof address === 'object' && address !== null ? address.port : 0)
  })
})

seedHome(HOME, CWD)
writeFileSync(
  join(HOME, '.credentials.json'),
  JSON.stringify({ claudeAiOauth: { accessToken: 'sk-ant-oat01-fixture', refreshToken: 'sk-ant-ort01-fixture', expiresAt: Date.now() + 3600_000, scopes: ['user:inference'], subscriptionType: 'max' } }),
)
const env = { ...childEnv(HOME, port), MERCURY_TASKS: '1', MERCURY_CUSTOM_OAUTH_URL: 'http://127.0.0.1:1' }
delete env.ANTHROPIC_API_KEY

const waitWire = async (label: string, test: (w: Wire) => boolean, timeoutMs: number): Promise<Wire | null> => {
  const until = Date.now() + timeoutMs
  while (Date.now() < until) {
    const hit = wire.find(test)
    if (hit !== undefined) return hit
    await sleep(100)
  }
  console.log(`  [wait] ${label}: nothing on the wire within ${timeoutMs} ms`)
  return null
}
const brief = (): string => j(wire.map(w => [w.n, w.kind, w.step, w.notices, w.ask.slice(0, 40)]))
const resultText = (frame: unknown): string => JSON.stringify(frame)
const stallsOf = (log: string): number[] => [...log.matchAll(/\[event-loop-stall\] blocked for (\d+)ms/g)].map(m => Number(m[1]))

if (!existsSync(DIST)) {
  check('the built bundle is present (the drive boots the BUILT product)', false, DIST)
} else {
  const runner = bootRunner({ cwd: CWD, env, extraArgv: ['--log-file', DEBUG_FILE] })
  const refusals = (): number => runner.frames.filter(f => f.type === 'outcome' && /limit is reached/.test(resultText(f))).length
  runner.send(user(LEAD_ASK, 'u-lead'))
  const init = await runner.waitFor('the session row', isSession, bound(90_000))
  check('the headless session booted on the fixture', init !== null, runner.stderr().slice(-400))
  const leadReady = await runner.waitFor('the lead is ready', f => f.type === 'outcome' && resultText(f).includes(LEAD_READY), bound(60_000))
  const leadWire = wire.filter(w => w.ask.trim() === LEAD_ASK)
  const crewMade = leadWire.some(w => w.crewCreate) ? leadWire.some(w => w.step === 1 && w.results.some(text => /hold-crew/.test(text) && !/error/i.test(text))) : true
  check('the session is a crew lead (born as one, or made one by the crew tool the bundle still offers)', leadReady !== null && crewMade, `${j(leadWire.map(w => [w.step, w.crewCreate, w.results.slice(-1)]))} ${brief()}`)

  runner.send(user(ARM_ASK, 'u-arm'))
  const armed = await runner.waitFor('the shell is armed', f => f.type === 'outcome' && resultText(f).includes(ARMED), bound(60_000))
  const armedAt = Date.now()
  check('the model started a background shell and answered', armed !== null, brief())

  wallUntilMs = armedAt + WALL_SECONDS * 1000
  runner.send(user(HELLO_ASK, 'u-hello'))
  const refused = await waitWire('the usage window refusal', w => w.kind === 'walled' && w.ask.trim() === HELLO_ASK, bound(20_000))
  check('the provider refused a turn for the usage window', refused !== null, brief())
  const firstRow = await runner.waitFor('the first refusal row', f => f.type === 'outcome' && /limit is reached/.test(resultText(f)), bound(20_000))
  check("the session's own row says the limit is reached", firstRow !== null, j(runner.frames.filter(f => f.type === 'outcome').slice(-1)))
  check('the shell ends inside the window by construction', wallUntilMs > armedAt + SHELL_SECONDS * 1000 + AGAIN_AFTER_MS + 5_000)

  await sleep(Math.max(0, armedAt + AGAIN_AFTER_MS - Date.now()))
  const before = refusals()
  const againAt = Date.now()
  runner.send(user(AGAIN_ASK, 'u-again'))
  const againRow = await runner.waitFor('the second refusal row', f => f.type === 'outcome' && /limit is reached/.test(resultText(f)) && refusals() > before, bound(10_000))
  const againMs = Date.now() - againAt
  check("the operator's next line inside the window is answered at once — refused like any other request, its row within the bound while the shell's notice waits at the seat", againRow !== null && againMs < bound(10_000), `${againMs} ms; ${brief()}`)

  const landed = await waitWire('the notice after the window', w => w.kind === 'request' && w.notices >= 1, bound(WALL_SECONDS * 1000 + 30_000))
  check("the shell's notice reaches the model after the window reopened", landed !== null && landed.at >= wallUntilMs, landed === null ? brief() : `${landed.at - wallUntilMs} ms after the reopen`)
  await sleep(1_500)
  const carriers = wire.filter(w => w.kind === 'request' && w.notices >= 1)
  check('the notice reached the model exactly once, in one request', carriers.length === 1 && carriers[0]!.notices === 1, brief())
  check('no request inside the window carried the notice', !wire.some(w => w.kind === 'walled' && w.notices >= 1), brief())

  runner.send(user(DONE_ASK, 'u-done'))
  const done = await runner.waitFor('the session still answers', f => f.type === 'outcome' && resultText(f).includes(DONE_ASK), bound(30_000))
  check('the session still answers after the window', done !== null, brief())
  await runner.stop(bound(8_000))

  const debug = existsSync(DEBUG_FILE) ? readFileSync(DEBUG_FILE, 'utf8') : ''
  const stalls = stallsOf(debug)
  check(`the seat never stalled its event loop for ${STALL_LIMIT_MS} ms or longer while the notice waited`, debug !== '' && !stalls.some(ms => ms >= STALL_LIMIT_MS), debug === '' ? `no debug file at ${DEBUG_FILE}` : `stalls: ${j(stalls)} ms`)

  exportWorld('lead-window-hold', HOME, { 'wire.json': JSON.stringify(wire, null, 2), 'frames.json': JSON.stringify(runner.frames, null, 2) })
  await removeWorld(HOME)
}
server.close()
finish()
