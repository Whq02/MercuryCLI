#!/usr/bin/env bun
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { existsSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { bootRunner, bound, carriersOf, childEnv, DIST, exportWorld, isInit, j, makeTally, removeWorld, SCRATCH_ROOT, seedHome, sleep, user } from './dupline-world.ts'

const { check, section, finish } = makeTally('prove-wake-hold-drive')
section('a background shell, a background agent and a self-paced wake through a closed usage window: their notices wait and reach the model together, once, when the window reopens; the wake fires after it')

const HOME = join(SCRATCH_ROOT, `mercury-wake-hold-${process.pid}`)
const CWD = join(HOME, 'fixture-repo')
const ARM_ASK = 'start the slow shell, the slow agent and the wake'
const HELLO_ASK = 'hello there'
const DONE_ASK = 'that is all'
const ARMED = 'all three are armed'
const SHELL_DESCRIPTION = 'the slow shell'
const AGENT_DESCRIPTION = 'the slow agent'
const AGENT_PROMPT = 'count to three slowly and say done'
const AGENT_DONE = 'the slow agent is done'
const WAKE_PROMPT = 'the self-paced wake: carry on with the next unit'
const SHELL_NOTICE = `Background command "${SHELL_DESCRIPTION}"`
const AGENT_NOTICE = `Agent "${AGENT_DESCRIPTION}"`
const SHELL_SECONDS = 20
const AGENT_SHELL_SECONDS = 16
const WAKE_SECONDS = 60
const WALL_SECONDS = 80

type Block = { type?: string; text?: string; content?: unknown }
type Item = { role?: string; content?: unknown }
type Wire = { n: number; at: number; kind: 'request' | 'walled' | 'agent'; ask: string; whole: string; step: number; carries: Record<string, number>; results: string[] }
const wire: Wire[] = []
let wallUntilMs = 0
let calls = 0
const WORDS = { shell: SHELL_NOTICE, agent: AGENT_NOTICE, wake: WAKE_PROMPT }

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
  res.write(sse('message_start', { type: 'message_start', message: { id: `msg_hold_${n}`, type: 'message', role: 'assistant', model, content: [], stop_reason: null, stop_sequence: null, usage: { ...usage, output_tokens: 1 } } }))
  res.write(sse('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }))
  res.write(sse('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } }))
  res.write(sse('content_block_stop', { type: 'content_block_stop', index: 0 }))
  res.write(sse('message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage }))
  res.end(sse('message_stop', { type: 'message_stop' }))
}
function answerTools(res: ServerResponse, n: number, model: string, tools: Array<{ id: string; name: string; input: Record<string, unknown> }>): void {
  res.writeHead(200, { 'content-type': 'text/event-stream' })
  res.write(sse('message_start', { type: 'message_start', message: { id: `msg_hold_${n}`, type: 'message', role: 'assistant', model, content: [], stop_reason: null, stop_sequence: null, usage: { ...usage, output_tokens: 1 } } }))
  tools.forEach((tool, index) => {
    res.write(sse('content_block_start', { type: 'content_block_start', index, content_block: { type: 'tool_use', id: tool.id, name: tool.name, input: {} } }))
    res.write(sse('content_block_delta', { type: 'content_block_delta', index, delta: { type: 'input_json_delta', partial_json: JSON.stringify(tool.input) } }))
    res.write(sse('content_block_stop', { type: 'content_block_stop', index }))
  })
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
    const agentTurn = ask.trim() === AGENT_PROMPT
    const walled = Date.now() < wallUntilMs
    const carries = Object.fromEntries(Object.entries(WORDS).map(([key, word]) => [key, countOf(whole, word)]))
    wire.push({ n, at: Date.now(), kind: walled ? 'walled' : agentTurn ? 'agent' : 'request', ask: ask.slice(0, 600), whole: whole.slice(0, 1600), step, carries, results })
    if (walled) return answerWalled(res)
    if (agentTurn) {
      if (step === 0) return answerTools(res, n, model, [{ id: `toolu_hold_pause_${n}`, name: 'Bash', input: { command: `sleep ${AGENT_SHELL_SECONDS}`, description: 'the agent pauses' } }])
      return answerText(res, n, model, AGENT_DONE)
    }
    if (ask.trim() === ARM_ASK) {
      if (step === 0) {
        return answerTools(res, n, model, [
          { id: `toolu_hold_shell_${n}`, name: 'Bash', input: { command: `sleep ${SHELL_SECONDS}; echo the slow shell is done`, description: SHELL_DESCRIPTION, run_in_background: true } },
          { id: `toolu_hold_agent_${n}`, name: 'Agent', input: { description: AGENT_DESCRIPTION, prompt: AGENT_PROMPT, run_in_background: true } },
          { id: `toolu_hold_wake_${n}`, name: 'ScheduleWakeup', input: { delaySeconds: WAKE_SECONDS, prompt: WAKE_PROMPT } },
        ])
      }
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
const brief = (): string => j(wire.map(w => [w.n, w.kind, w.step, w.carries, w.ask.slice(0, 40)]))

if (!existsSync(DIST)) {
  check('the built bundle is present (the drive boots the BUILT product)', false, DIST)
} else {
  const runner = bootRunner({ cwd: CWD, env })
  runner.send(user(ARM_ASK, 'u-arm'))
  const init = await runner.waitFor('the session init frame', isInit, bound(90_000))
  check('the headless session booted on the fixture', init !== null, runner.stderr().slice(-400))
  const armed = await waitWire('the three tools answered', w => w.ask.trim() === ARM_ASK && w.step >= 1, bound(60_000))
  const armedResults = armed?.results ?? []
  check('the model started a background shell, a background agent and a self-paced wake, and every tool answered without an error', armed !== null && armedResults.length === 3 && armedResults.some(t => t.includes('Wake armed')) && !armedResults.some(t => /error|not found|unknown tool/i.test(t)), j(armedResults))
  await sleep(1_500)

  const t0 = Date.now()
  wallUntilMs = t0 + WALL_SECONDS * 1000
  runner.send(user(HELLO_ASK, 'u-hello'))
  const refused = await waitWire('the usage window refusal', w => w.kind === 'walled' && w.ask.trim() === HELLO_ASK, bound(30_000))
  check('the provider refused a turn for the usage window and the session observed it', refused !== null, brief())
  const refusalRow = await runner.waitFor('the refusal result', f => f.type === 'result' && /limit is reached/.test(JSON.stringify(f)), bound(20_000))
  check("the session's own row says the limit is reached, with the reset", refusalRow !== null, j(runner.frames.filter(f => f.type === 'result').slice(-1)))
  check('the shell, the agent and the wake all land inside the window by construction', wallUntilMs > t0 + Math.max(SHELL_SECONDS, AGENT_SHELL_SECONDS, WAKE_SECONDS) * 1000 + 5_000)

  const together = await waitWire(
    'one request whose ask carries the shell and the agent notices',
    w => w.kind === 'request' && w.carries.shell >= 1 && w.carries.agent >= 1,
    bound(wallUntilMs - Date.now() + 40_000),
  )
  const woke = await waitWire('the wake after the window', w => w.kind === 'request' && w.carries.wake >= 1, bound(Math.max(5_000, wallUntilMs - Date.now() + 40_000)))
  await sleep(2_000)

  runner.send(user(DONE_ASK, 'u-done'))
  const done = await waitWire('the closing ask', w => w.kind === 'request' && w.ask.trim() === DONE_ASK, bound(30_000))
  check('the session still answers after the window', done !== null)
  await runner.stop(bound(8_000))
  server.close()

  const walledWakes = wire.filter(w => w.kind === 'walled' && w.ask.trim() !== AGENT_PROMPT && Object.values(w.carries).some(n => n > 0))
  const agentRefused = wire.filter(w => w.kind === 'walled' && w.ask.trim() === AGENT_PROMPT)
  check('the agent working inside the window was refused like any other request, and its run paused there, its row promising to resume at the reset', agentRefused.length >= 1 && (together?.whole ?? '').includes(`${AGENT_NOTICE} paused`) && (together?.whole ?? '').includes('resumes by itself'), brief())
  check('no completion notice and no wake opened a turn while the window was closed', walledWakes.length === 0, j(walledWakes.map(w => [w.n, w.carries])))
  const withBoth = wire.filter(w => w.kind === 'request' && w.carries.shell >= 1 && w.carries.agent >= 1)
  check('exactly one turn after the window reopened carried the shell and the agent notices together', together !== null && withBoth.length === 1, brief())
  const askTogether = together?.whole ?? ''
  const helloAt = askTogether.indexOf(HELLO_ASK)
  check('that turn carries the two notices as two blocks of one ask, no fresh operator words behind them (a refused ask may precede them as the transcript kept it)', countOf(askTogether, '<task-notification>') === 2 && !askTogether.includes(ARM_ASK) && !askTogether.includes(DONE_ASK) && (helloAt === -1 || helloAt < askTogether.indexOf('<task-notification>')), askTogether.slice(0, 500))
  check('the two notices reached the model at or after the reopen, never before it', together !== null && together.at >= wallUntilMs, j({ at: together?.at, wallUntilMs }))
  const lone = wire.filter(w => w.kind === 'request' && (w.carries.shell > 0) !== (w.carries.agent > 0))
  check("no other turn carried the shell notice or the agent's pause notice alone", lone.every(w => w.carries.shell === 0 && !w.whole.includes(`${AGENT_NOTICE} paused`)), j(lone.map(w => [w.n, w.carries])))
  const resumedTurns = wire.filter(w => w.kind === 'request' && w.whole.includes(`${AGENT_NOTICE} resumed by itself`))
  const completedTurns = wire.filter(w => w.kind === 'request' && w.whole.includes(`${AGENT_NOTICE} completed`))
  check("the paused agent kept its row's promise: it resumed by itself after the reset and completed, each told to the model once, after the reopen, never inside the window", resumedTurns.length === 1 && completedTurns.length === 1 && resumedTurns[0]!.at >= wallUntilMs && completedTurns[0]!.at >= wallUntilMs, j({ resumed: resumedTurns.map(w => [w.n, w.at]), completed: completedTurns.map(w => [w.n, w.at]), wallUntilMs }))
  const wakes = wire.filter(w => w.kind === 'request' && w.carries.wake >= 1)
  check('the self-paced wake fired exactly once, after the window reopened', woke !== null && wakes.length === 1 && woke.at >= wallUntilMs, j(wakes.map(w => [w.n, w.at, wallUntilMs])))
  check("the wake's turn carries its own prompt alone, never the notices", woke !== null && woke.carries.shell === 0 && woke.carries.agent === 0, (woke?.whole ?? '').slice(0, 300))

  const projects = join(HOME, 'projects')
  const inputRecordsOf = (line: string): string[] => carriersOf(projects, line).filter(c => c.kind === 'input' && !c.file.includes('subagents')).map(c => c.recordId)
  const shellRecords = inputRecordsOf(SHELL_NOTICE)
  const pausedRecords = inputRecordsOf(`${AGENT_NOTICE} paused`)
  const completedRecords = inputRecordsOf(`${AGENT_NOTICE} completed`)
  check("the transcript holds the shell notice, the agent's pause notice and its completion in exactly one input record each — written once, never again", shellRecords.length === 1 && pausedRecords.length === 1 && completedRecords.length === 1, j({ shellRecords, pausedRecords, completedRecords }))

  exportWorld('wake-hold', HOME, { 'wire.json': JSON.stringify(wire, null, 2), 'frames.json': JSON.stringify(runner.frames, null, 2) })
  await removeWorld(HOME)
}
finish()
