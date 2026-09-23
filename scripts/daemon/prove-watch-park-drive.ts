#!/usr/bin/env bun
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { execSync } from 'node:child_process'
import { appendFileSync, existsSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { bootRunner, bound, carriersOf, childEnv, DIST, exportWorld, isInit, j, makeTally, removeWorld, type Runner, SCRATCH_ROOT, seedHome, sleep, user } from './dupline-world.ts'

const { check, section, finish } = makeTally('prove-watch-park-drive')
section("a persistent watch through the session's park: the watch ends with the runner, and the first turn after the resume is told so once, with the way to arm it again")

const HOME = join(SCRATCH_ROOT, `mercury-watch-park-${process.pid}`)
const CWD = join(HOME, 'fixture-repo')
const WATCHED = join(HOME, 'watched.log')
const ARM_ASK = 'arm the watch on the log'
const HELLO_ASK = 'hello after the resume'
const AGAIN_ASK = 'hello after the second resume'
const ARMED = 'the watch is armed'
const WATCH_NAME = 'the appended log'
const BEFORE_LINE = 'the line before the park'
const PARKED_LINES = ['the first line while parked', 'the second line while parked', 'the third line while parked']
const DEAD_WORDS = 'did not survive'
const REARM_WORDS = 'calling Monitor again with the same command'

type Block = { type?: string; text?: string; content?: unknown }
type Item = { role?: string; content?: unknown }
type Wire = { n: number; at: number; ask: string; step: number; results: string[] }
const wire: Wire[] = []
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
const usage = { input_tokens: 21, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 9 }
function answerText(res: ServerResponse, n: number, model: string, text: string): void {
  res.writeHead(200, { 'content-type': 'text/event-stream' })
  res.write(sse('message_start', { type: 'message_start', message: { id: `msg_park_${n}`, type: 'message', role: 'assistant', model, content: [], stop_reason: null, stop_sequence: null, usage: { ...usage, output_tokens: 1 } } }))
  res.write(sse('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }))
  res.write(sse('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } }))
  res.write(sse('content_block_stop', { type: 'content_block_stop', index: 0 }))
  res.write(sse('message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage }))
  res.end(sse('message_stop', { type: 'message_stop' }))
}
function answerTool(res: ServerResponse, n: number, model: string, id: string, name: string, input: Record<string, unknown>): void {
  res.writeHead(200, { 'content-type': 'text/event-stream' })
  res.write(sse('message_start', { type: 'message_start', message: { id: `msg_park_${n}`, type: 'message', role: 'assistant', model, content: [], stop_reason: null, stop_sequence: null, usage: { ...usage, output_tokens: 1 } } }))
  res.write(sse('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id, name, input: {} } }))
  res.write(sse('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: JSON.stringify(input) } }))
  res.write(sse('content_block_stop', { type: 'content_block_stop', index: 0 }))
  res.write(sse('message_delta', { type: 'message_delta', delta: { stop_reason: 'tool_use', stop_sequence: null }, usage }))
  res.end(sse('message_stop', { type: 'message_stop' }))
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
    let askIndex = -1
    for (let i = items.length - 1; i >= 0; i--) {
      if (items[i]!.role === 'user' && askOf(items[i]!.content) !== '') {
        askIndex = i
        break
      }
    }
    const ask = askIndex === -1 ? '' : askOf(items[askIndex]!.content)
    const step = askIndex === -1 ? 0 : items.slice(askIndex + 1).filter(isToolResultItem).length
    const results = items.filter(isToolResultItem).flatMap(it => resultTexts(it.content))
    wire.push({ n, at: Date.now(), ask: ask.slice(0, 800), step, results })
    if (ask.trim() === ARM_ASK) {
      if (step === 0) return answerTool(res, n, model, `toolu_park_c${n}`, 'Monitor', { description: WATCH_NAME, command: `tail -n0 -F ${WATCHED}`, persistent: true })
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
const tailAlive = (): string => {
  try {
    return execSync(`pgrep -fl ${JSON.stringify(`[t]ail -n0 -F ${WATCHED}`)}`).toString().trim()
  } catch {
    return ''
  }
}
const reapTail = (): void => {
  try {
    execSync(`pkill -f ${JSON.stringify(`[t]ail -n0 -F ${WATCHED}`)}`)
  } catch {
  }
}
const taskIdOf = (): string => {
  for (const w of wire) {
    for (const text of w.results) {
      const m = /Monitor started \(task (\S+?)[,)]/.exec(text)
      if (m) return m[1]!
    }
  }
  return ''
}
const park = async (runner: Runner): Promise<{ code: number | null; late: boolean }> => {
  runner.proc.kill('SIGTERM')
  const code = await Promise.race([runner.exited, sleep(bound(20_000)).then(() => 'late' as const)])
  if (code === 'late') {
    runner.kill()
    return { code: null, late: true }
  }
  return { code, late: false }
}
const deadTurns = (): Wire[] => wire.filter(w => w.ask.includes(DEAD_WORDS))

if (!existsSync(DIST)) {
  check('the built bundle is present (the drive boots the BUILT product)', false, DIST)
} else {
  const runner = bootRunner({ cwd: CWD, env })
  runner.send(user(ARM_ASK, 'u-arm'))
  const init = await runner.waitFor('the session init frame', isInit, bound(90_000))
  check('the headless session booted on the fixture', init !== null, runner.stderr().slice(-400))
  const sessionId = String((init as { session_id?: string } | null)?.session_id ?? '')
  const armed = await waitWire('the watch armed', w => w.ask.trim() === ARM_ASK && w.step >= 1, bound(60_000))
  const taskId = taskIdOf()
  check('the model armed a persistent watch on the log and the tool named its task', armed !== null && taskId !== '', j(wire.slice(-2).map(w => [w.n, w.step, w.results])))
  await sleep(1_500)
  appendFileSync(WATCHED, `${BEFORE_LINE}\n`)
  const before = await waitWire('the line before the park', w => w.ask.includes(BEFORE_LINE), bound(20_000))
  check('a line appended while the session is live wakes it through the watch', before !== null)
  check("the watch's process is alive while the session is", tailAlive() !== '')

  const parkedAt = Date.now()
  const exit = await park(runner)
  await sleep(1_000)
  const tailAfterPark = tailAlive()
  check("the park ends the runner, and the watch's process ends with it", !exit.late && tailAfterPark === '', j({ exit, tailAfterPark }))
  if (tailAfterPark !== '') reapTail()
  for (const line of PARKED_LINES) appendFileSync(WATCHED, `${line}\n`)
  await sleep(500)

  const resumed = bootRunner({ cwd: CWD, env, extraArgv: ['--resume', sessionId] })
  resumed.send(user(HELLO_ASK, 'u-hello'))
  const hello = await waitWire('the resumed turn', w => w.ask.trim() === HELLO_ASK, bound(60_000))
  check('the resumed session answers', hello !== null, resumed.stderr().slice(-400))
  const told = await waitWire('the turn that names the dead watch', w => w.ask.includes(DEAD_WORDS) && w.at > parkedAt, bound(30_000))
  await sleep(3_000)
  check('exactly one turn after the resume names the watch that did not survive the pause', told !== null && deadTurns().length === 1, j(wire.map(w => [w.n, w.ask.slice(0, 60)])))
  const ask = told?.ask ?? ''
  check('that turn is the monitor block of that watch, naming its task and how to arm it again, and nothing else', ask.startsWith(`<monitor task=${JSON.stringify(taskId)} name=${JSON.stringify(WATCH_NAME)}>`) && ask.includes(`(task ${taskId})`) && ask.includes(REARM_WORDS) && !ask.includes(HELLO_ASK), ask.slice(0, 300))
  check('the lines appended while parked are not delivered as if the watch had lived', wire.every(w => PARKED_LINES.every(line => !w.ask.includes(line))))
  check('no watch process outlives the park into the resumed session', tailAlive() === '', tailAlive())

  const exitAgain = await park(resumed)
  check('the resumed runner parks the same way', !exitAgain.late, j(exitAgain))
  const again = bootRunner({ cwd: CWD, env, extraArgv: ['--resume', sessionId] })
  again.send(user(AGAIN_ASK, 'u-again'))
  const againTurn = await waitWire('the second resumed turn', w => w.ask.trim() === AGAIN_ASK, bound(60_000))
  await sleep(6_000)
  check('the second resume answers', againTurn !== null, again.stderr().slice(-400))
  check('a later resume repeats nothing: the watch is named dead exactly once across both resumes', deadTurns().length === 1, j(deadTurns().map(w => [w.n, w.at])))
  await again.stop(bound(8_000))
  server.close()
  reapTail()

  const projects = join(HOME, 'projects')
  const records = carriersOf(projects, DEAD_WORDS).filter(c => c.kind === 'input')
  check('the transcript holds the dead-watch notice as ONE input record', records.length === 1, j(records.map(r => [r.file, r.recordId])))

  exportWorld('watch-park', HOME, { 'wire.json': JSON.stringify(wire, null, 2), 'frames.json': JSON.stringify([...runner.frames, ...resumed.frames, ...again.frames], null, 2) })
  await removeWorld(HOME)
}
finish()
