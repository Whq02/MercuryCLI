#!/usr/bin/env bun
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { execSync } from 'node:child_process'
import { existsSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { bootRunner, bound, childEnv, DIST, exportWorld, isSession, j, makeTally, removeWorld, type Runner, SCRATCH_ROOT, seedHome, sleep } from './dupline-world.ts'

const { check, section, finish } = makeTally('prove-dead-watch-first-request')
section("a watch that did not survive the session's pause is named in the FIRST request after the resume, riding the operator's words — never a turn later")

const HOME = join(SCRATCH_ROOT, `mercury-dead-watch-first-${process.pid}`)
const CWD = join(HOME, 'fixture-repo')
const WATCHED = join(HOME, 'watched.log')
const ARM_ASK = 'arm the watch on the log'
const HELLO_ASK = 'hello after the resume'
const SECOND_ASK = 'and again after the resume'
const ARMED = 'the watch is armed'
const WATCH_NAME = 'the appended log'
const DEAD_WORDS = 'did not survive'
const REARM_WORDS = 'Start it again by calling Monitor with the same command'

type Block = { type?: string; text?: string; content?: unknown }
type Item = { role?: string; content?: unknown }
type Wire = { n: number; at: number; ask: string; step: number; results: string[]; lastUser: string }
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
const wholeUser = (content: unknown): string => {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return (content as Block[]).map(part => (part.type === 'text' && typeof part.text === 'string' ? part.text : '')).join('\n')
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
  res.write(sse('message_start', { type: 'message_start', message: { id: `msg_dw_${n}`, type: 'message', role: 'assistant', model, content: [], stop_reason: null, stop_sequence: null, usage: { ...usage, output_tokens: 1 } } }))
  res.write(sse('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }))
  res.write(sse('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } }))
  res.write(sse('content_block_stop', { type: 'content_block_stop', index: 0 }))
  res.write(sse('message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage }))
  res.end(sse('message_stop', { type: 'message_stop' }))
}
function answerTool(res: ServerResponse, n: number, model: string, id: string, name: string, input: Record<string, unknown>): void {
  res.writeHead(200, { 'content-type': 'text/event-stream' })
  res.write(sse('message_start', { type: 'message_start', message: { id: `msg_dw_${n}`, type: 'message', role: 'assistant', model, content: [], stop_reason: null, stop_sequence: null, usage: { ...usage, output_tokens: 1 } } }))
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
    const lastUser = [...items].reverse().find(item => item.role === 'user' && !isToolResultItem(item))
    const step = askIndex === -1 ? 0 : items.slice(askIndex + 1).filter(isToolResultItem).length
    const results = items.filter(isToolResultItem).flatMap(it => resultTexts(it.content))
    wire.push({ n, at: Date.now(), ask: ask.slice(0, 800), step, results, lastUser: lastUser === undefined ? '' : wholeUser(lastUser.content) })
    if (ask.trim() === ARM_ASK) {
      if (step === 0) return answerTool(res, n, model, `toolu_dw_c${n}`, 'Monitor', { description: WATCH_NAME, command: `tail -n0 -F ${WATCHED}`, persistent: true })
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
const env = { ...childEnv(HOME, port), MERCURY_TASKS: '1', MERCURY_ANTHROPIC_OAUTH_BASE: 'http://127.0.0.1:1' }
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

if (!existsSync(DIST)) {
  check('the built bundle is present (the proof boots the BUILT product)', false, DIST)
} else {
  const runner = bootRunner({ cwd: CWD, env })
  void runner.prompt(ARM_ASK, 'u-arm')
  const init = await runner.waitFor('the session row', isSession, bound(90_000))
  check('the headless session booted on the fixture', init !== null, runner.stderr().slice(-400))
  const sessionId = String((init as { session_id?: string } | null)?.session_id ?? '')
  const armed = await waitWire('the watch armed', w => w.ask.trim() === ARM_ASK && w.step >= 1, bound(60_000))
  const taskId = taskIdOf()
  check('the model armed a persistent watch on the log and the tool named its task', armed !== null && taskId !== '', j(wire.slice(-2).map(w => [w.n, w.step, w.results])))
  await sleep(1_500)
  check("the watch's process is alive while the session is", tailAlive() !== '')

  const parkedAt = Date.now()
  const exit = await park(runner)
  await sleep(1_000)
  const tailAfterPark = tailAlive()
  check("the park ends the runner, and the watch's process ends with it", !exit.late && tailAfterPark === '', j({ exit, tailAfterPark }))
  if (tailAfterPark !== '') reapTail()

  const resumed = bootRunner({ cwd: CWD, env, extraArgv: ['--resume', sessionId] })
  void resumed.prompt(HELLO_ASK, 'u-hello')
  const first = await waitWire('the first request after the resume', w => w.at > parkedAt, bound(60_000))
  check('the resumed session sent its first request', first !== null, resumed.stderr().slice(-400))
  const firstCarriesWords = first !== null && first.ask.trim() === HELLO_ASK
  const firstCarriesWatch = first !== null && first.lastUser.includes(`<monitor task=${JSON.stringify(taskId)} name=${JSON.stringify(WATCH_NAME)}>`) && first.lastUser.includes(`(task ${taskId})`) && first.lastUser.includes(DEAD_WORDS) && first.lastUser.includes(REARM_WORDS)
  check("the FIRST request after the resume is the operator's words", firstCarriesWords, first === null ? 'no request' : j({ n: first.n, ask: first.ask.slice(0, 80) }))
  check('…and that same request names the watch that did not survive the pause, its task and how to arm it again', firstCarriesWatch, first === null ? 'no request' : first.lastUser.slice(0, 600))
  check('the dead-watch line says the process ended with the session (nothing was left behind to end)', first !== null && first.lastUser.includes('its process ended with the session'), first === null ? 'no request' : first.lastUser.slice(0, 600))

  void resumed.prompt(SECOND_ASK, 'u-second')
  const second = await waitWire('the second request after the resume', w => w.ask.trim() === SECOND_ASK, bound(60_000))
  await sleep(3_000)
  const deadRequests = wire.filter(w => w.at > parkedAt && w.lastUser.includes(DEAD_WORDS))
  check('the watch is named once, in that first request, and no later request repeats it', second !== null && deadRequests.length === 1 && deadRequests[0]!.n === first?.n, j(wire.filter(w => w.at > parkedAt).map(w => [w.n, w.ask.slice(0, 40), w.lastUser.includes(DEAD_WORDS)])))
  check('no request after the resume is a lone notice turn without the operator\'s words', wire.filter(w => w.at > parkedAt).every(w => w.ask.trim() === HELLO_ASK || w.ask.trim() === SECOND_ASK), j(wire.filter(w => w.at > parkedAt).map(w => [w.n, w.ask.slice(0, 60)])))
  check('no watch process outlives the park into the resumed session', tailAlive() === '', tailAlive())

  await resumed.stop(bound(8_000))
  server.close()
  reapTail()
  exportWorld('dead-watch-first-request', HOME, { 'wire.json': JSON.stringify(wire, null, 2) })
  await removeWorld(HOME)
}
finish()
