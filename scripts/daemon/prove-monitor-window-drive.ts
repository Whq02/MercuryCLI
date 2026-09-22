#!/usr/bin/env bun
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { execSync } from 'node:child_process'
import { appendFileSync, existsSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { bootRunner, bound, carriersOf, childEnv, DIST, exportWorld, isInit, j, makeTally, removeWorld, SCRATCH_ROOT, seedHome, sleep, user } from './dupline-world.ts'

const { check, section, finish } = makeTally('prove-monitor-window-drive')
section('a persistent watch through a closed usage window: the lines that land meanwhile reach the model together, once, when the window reopens')

const HOME = join(SCRATCH_ROOT, `mercury-monitor-window-${process.pid}`)
const CWD = join(HOME, 'fixture-repo')
const WATCHED = join(HOME, 'watched.log')
const ARM_ASK = 'arm the watch on the log'
const HELLO_ASK = 'hello there'
const DONE_ASK = 'that is all'
const ARMED = 'the watch is armed'
const LINES = ['first line landed while the window was closed', 'second line landed while the window was closed', 'third line landed while the window was closed']
const WALL_SECONDS = 40
const LINE_GAP_MS = 2_500

type Block = { type?: string; text?: string }
type Item = { role?: string; content?: unknown }
type Wire = { n: number; at: number; kind: 'request' | 'walled' | 'hit'; ask: string; step: number; inAsk: number[] }
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
const isToolResultItem = (item: Item): boolean => item.role === 'user' && Array.isArray(item.content) && (item.content as Block[]).some(p => p.type === 'tool_result')
const countOf = (hay: string, word: string): number => hay.split(word).length - 1
const usage = { input_tokens: 21, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 9 }
function answerText(res: ServerResponse, n: number, model: string, text: string): void {
  res.writeHead(200, { 'content-type': 'text/event-stream' })
  res.write(sse('message_start', { type: 'message_start', message: { id: `msg_watch_${n}`, type: 'message', role: 'assistant', model, content: [], stop_reason: null, stop_sequence: null, usage: { ...usage, output_tokens: 1 } } }))
  res.write(sse('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }))
  res.write(sse('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } }))
  res.write(sse('content_block_stop', { type: 'content_block_stop', index: 0 }))
  res.write(sse('message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage }))
  res.end(sse('message_stop', { type: 'message_stop' }))
}
function answerTool(res: ServerResponse, n: number, model: string, id: string, name: string, input: Record<string, unknown>): void {
  res.writeHead(200, { 'content-type': 'text/event-stream' })
  res.write(sse('message_start', { type: 'message_start', message: { id: `msg_watch_${n}`, type: 'message', role: 'assistant', model, content: [], stop_reason: null, stop_sequence: null, usage: { ...usage, output_tokens: 1 } } }))
  res.write(sse('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id, name, input: {} } }))
  res.write(sse('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: JSON.stringify(input) } }))
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
      wire.push({ n: 0, at: Date.now(), kind: 'hit', ask: `${req.method} ${url}`, step: 0, inAsk: [0, 0, 0] })
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
    let askIndex = -1
    for (let i = items.length - 1; i >= 0; i--) {
      if (items[i]!.role === 'user' && askOf(items[i]!.content) !== '') {
        askIndex = i
        break
      }
    }
    const ask = askIndex === -1 ? '' : askOf(items[askIndex]!.content)
    const step = askIndex === -1 ? 0 : items.slice(askIndex + 1).filter(isToolResultItem).length
    const walled = Date.now() < wallUntilMs
    wire.push({ n, at: Date.now(), kind: walled ? 'walled' : 'request', ask: ask.slice(0, 600), step, inAsk: LINES.map(line => countOf(ask, line)) })
    if (walled) return answerWalled(res)
    if (ask.trim() === ARM_ASK) {
      if (step === 0) return answerTool(res, n, model, `toolu_watch_c${n}`, 'Monitor', { description: 'the appended log', command: `tail -n0 -F ${WATCHED}`, persistent: true })
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
writeFileSync(WATCHED, '')
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

if (!existsSync(DIST)) {
  check('the built bundle is present (the drive boots the BUILT product)', false, DIST)
} else {
  const runner = bootRunner({ cwd: CWD, env })
  runner.send(user(ARM_ASK, 'u-arm'))
  const init = await runner.waitFor('the session init frame', isInit, bound(90_000))
  check('the headless session booted on the fixture', init !== null, runner.stderr().slice(-400))
  const armed = await waitWire('the watch armed', w => w.kind === 'request' && w.ask.trim() === ARM_ASK && w.step >= 1, bound(60_000))
  check('the model armed a persistent watch on the log and the tool answered', armed !== null, j(wire.slice(-3)))
  await sleep(1_500)

  wallUntilMs = Date.now() + WALL_SECONDS * 1000
  runner.send(user(HELLO_ASK, 'u-hello'))
  const refused = await waitWire('the usage window refusal', w => w.kind === 'walled' && w.ask.trim() === HELLO_ASK, bound(30_000))
  check('the provider refused a turn for the usage window and the session observed it', refused !== null, j(wire.slice(-2)))
  const refusalRow = await runner.waitFor('the refusal result', f => f.type === 'result' && /limit is reached/.test(JSON.stringify(f)), bound(20_000))
  check("the session's own row says the limit is reached, with the reset", refusalRow !== null, j(runner.frames.filter(f => f.type === 'result').slice(-1)))

  await sleep(1_500)
  const appendedAt: number[] = []
  for (const line of LINES) {
    appendFileSync(WATCHED, `${line}\n`)
    appendedAt.push(Date.now())
    await sleep(LINE_GAP_MS)
  }
  check('the three lines landed while the window was still closed', appendedAt[appendedAt.length - 1]! < wallUntilMs, j({ lastAppend: appendedAt[appendedAt.length - 1], wallUntilMs }))

  const together = await waitWire(
    'one request whose ask carries the three lines',
    w => w.kind === 'request' && w.inAsk.every(n => n >= 1),
    bound(wallUntilMs - Date.now() + 30_000),
  )
  await sleep(2_000)

  runner.send(user(DONE_ASK, 'u-done'))
  const done = await waitWire('the closing ask', w => w.kind === 'request' && w.ask.trim() === DONE_ASK, bound(30_000))
  check('the session still answers after the window', done !== null)
  await runner.stop(bound(8_000))
  server.close()
  try {
    execSync(`pkill -f ${JSON.stringify(`tail -n0 -F ${WATCHED}`)}`)
  } catch {
  }

  const wakesIntoTheWall = wire.filter(w => w.kind === 'walled' && w.inAsk.some(n => n > 0))
  check('no line woke a turn while the window was closed', wakesIntoTheWall.length === 0, j(wakesIntoTheWall.map(w => [w.n, w.inAsk])))
  const withAll = wire.filter(w => w.kind === 'request' && w.inAsk.every(n => n >= 1))
  check('exactly one turn after the window reopened carried the three lines in its ask', together !== null && withAll.length === 1, j(wire.map(w => [w.n, w.kind, w.step, w.inAsk, w.ask.slice(0, 40)])))
  const ask = together?.ask ?? ''
  const i1 = ask.indexOf(LINES[0]!)
  const i2 = ask.indexOf(LINES[1]!)
  const i3 = ask.indexOf(LINES[2]!)
  check('that ask is ONE monitor block, headed by the count of held lines, the lines in the order they landed', countOf(ask, '<monitor task=') === 1 && ask.includes('3 lines arrived while the usage window was closed') && i1 >= 0 && i2 > i1 && i3 > i2, j(ask.slice(0, 400)))
  check('the ask of that turn carries no other line of the session', !ask.includes(HELLO_ASK) && !ask.includes(ARM_ASK))
  const stray = wire.filter(w => w.kind === 'request' && w.inAsk.some(n => n > 0) && !w.inAsk.every(n => n >= 1))
  check('no other turn carried a lone line of the three', stray.length === 0, j(stray.map(w => [w.n, w.inAsk])))

  const projects = join(HOME, 'projects')
  const inputRecordsOf = (line: string): string[] => carriersOf(projects, line).filter(c => c.kind === 'input').map(c => c.recordId)
  const records = LINES.map(inputRecordsOf)
  check('the transcript holds the three lines in ONE input record', records.every(r => r.length === 1) && new Set(records.map(r => r[0])).size === 1, j(records))

  exportWorld('monitor-window', HOME, { 'wire.json': JSON.stringify(wire, null, 2), 'frames.json': JSON.stringify(runner.frames, null, 2) })
  await removeWorld(HOME)
}
finish()
