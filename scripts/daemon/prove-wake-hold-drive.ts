#!/usr/bin/env bun
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { existsSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { bootRunner, bound, carriersOf, childEnv, DIST, exportWorld, isSession, j, makeTally, removeWorld, SCRATCH_ROOT, seedHome, sleep } from './dupline-world.ts'

const { check, section, finish } = makeTally('prove-wake-hold-drive')
section('a background shell, a background agent and a self-paced wake beside a usage-window note: each delivery starts its own request immediately, the provider refuses while closed, and a twice-refused agent waits for a hand resume')

const HOME = join(SCRATCH_ROOT, `mercury-wake-hold-${process.pid}`)
const CWD = join(HOME, 'fixture-repo')
const ARM_ASK = 'start the slow shell, the slow agent and the wake'
const HELLO_ASK = 'hello there'
const DONE_ASK = 'that is all'
const RESUME_ASK = 'resume the slow agent by hand'
const RESUME_PROMPT = 'finish the preserved slow-agent work now'
const RESUMED = 'the hand resume is armed'
const ARMED = 'all three are armed'
const SHELL_DESCRIPTION = 'the slow shell'
const AGENT_DESCRIPTION = 'the slow agent'
const AGENT_NAME = 'slow-agent'
const AGENT_PROMPT = 'count to three slowly and say done'
const AGENT_DONE = 'the slow agent is done'
const WAKE_PROMPT = 'the self-paced wake: carry on with the next unit'
const SHELL_NOTICE = `Background command "${SHELL_DESCRIPTION}"`
const AGENT_NOTICE = `Agent "${AGENT_DESCRIPTION}"`
const SHELL_SECONDS = 30
const AGENT_SHELL_SECONDS = 16
const WAKE_SECONDS = 60
const WALL_SECONDS = 80
const RETRY_AFTER_SECONDS = 2
const AGENT_REFUSAL = 'Rate limit exceeded for the slow-agent fixture'
const DELIVERY_BOUND_MS = 5_000

type Block = { type?: string; text?: string; content?: unknown }
type Item = { role?: string; content?: unknown }
type Wire = { n: number; at: number; kind: 'request' | 'walled' | 'agent'; agent: boolean; ask: string; whole: string; step: number; carries: Record<string, number>; results: string[]; notices: string[]; refusal?: string; refusedAt?: number }
const wire: Wire[] = []
let wallUntilMs = 0
let calls = 0
let agentRefusals = 0
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
function answerWalled(res: ServerResponse, message: string): void {
  const resetSeconds = Math.ceil(wallUntilMs / 1000)
  res.writeHead(429, {
    'content-type': 'application/json',
    'anthropic-ratelimit-unified-status': 'rejected',
    'anthropic-ratelimit-unified-representative-claim': 'five_hour',
    'anthropic-ratelimit-unified-reset': String(resetSeconds),
    'retry-after': String(RETRY_AFTER_SECONDS),
    'x-should-retry': 'false',
  })
  res.end(JSON.stringify({ type: 'error', error: { type: 'rate_limit_error', message } }))
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
    const agentTurn = items.some(item => item.role === 'user' && askOf(item.content).trim() === AGENT_PROMPT)
    const walled = Date.now() < wallUntilMs
    const carries = Object.fromEntries(Object.entries(WORDS).map(([key, word]) => [key, countOf(whole, word)]))
    const refusal = walled ? agentTurn ? `${AGENT_REFUSAL} ${++agentRefusals}` : 'Rate limit exceeded' : undefined
    const notices = [...whole.matchAll(/<task-notification>[\s\S]*?<\/task-notification>/g)].map(match => match[0])
    const hit: Wire = { n, at: Date.now(), kind: walled ? 'walled' : agentTurn ? 'agent' : 'request', agent: agentTurn, ask, whole, step, carries, results, notices, ...(refusal === undefined ? {} : { refusal }) }
    wire.push(hit)
    if (refusal !== undefined) {
      const answer = (): void => {
        hit.refusedAt = Date.now()
        answerWalled(res, refusal)
      }
      if (agentTurn && agentRefusals === 2) setTimeout(answer, bound(2_000))
      else answer()
      return
    }
    if (agentTurn) {
      if (ask.trim() === AGENT_PROMPT && step === 0) return answerTools(res, n, model, [{ id: `toolu_hold_pause_${n}`, name: 'Bash', input: { command: `sleep ${AGENT_SHELL_SECONDS}`, description: 'the agent pauses' } }])
      return answerText(res, n, model, AGENT_DONE)
    }
    if (ask.trim() === RESUME_ASK) {
      if (step === 0) return answerTools(res, n, model, [{ id: `toolu_hold_resume_${n}`, name: 'ResumeAgent', input: { to: AGENT_NAME, message: RESUME_PROMPT } }])
      return answerText(res, n, model, RESUMED)
    }
    if (ask.trim() === ARM_ASK) {
      if (step === 0) {
        return answerTools(res, n, model, [
          { id: `toolu_hold_shell_${n}`, name: 'Bash', input: { command: `sleep ${SHELL_SECONDS}; echo the slow shell is done`, description: SHELL_DESCRIPTION, run_in_background: true } },
          { id: `toolu_hold_agent_${n}`, name: 'Agent', input: { name: AGENT_NAME, description: AGENT_DESCRIPTION, prompt: AGENT_PROMPT, run_in_background: true } },
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
const brief = (): string => j(wire.map(w => [w.n, w.kind, w.agent, w.step, w.carries, w.ask.slice(0, 80)]))
const summaryOf = (text: string): string => /<summary>([\s\S]*?)<\/summary>/.exec(text)?.[1] ?? ''
const triggerSummary = (w: Wire): string => !w.agent && w.ask.trimStart().startsWith('<task-notification>') ? summaryOf(w.ask) : ''
const isWake = (w: Wire): boolean => !w.agent && w.ask.includes(WAKE_PROMPT) && !w.ask.includes('<task-notification>')
const rateLimited = (frame: unknown): boolean => {
  const row = frame as { type?: string; error?: { class?: string } }
  return row.type === 'outcome' && row.error?.class === 'rate_limit'
}

if (!existsSync(DIST)) {
  check('the built bundle is present (the drive boots the BUILT product)', false, DIST)
} else {
  const runner = bootRunner({ cwd: CWD, env })
  void runner.prompt(ARM_ASK, 'u-arm')
  const init = await runner.waitFor('the session row', isSession, bound(90_000))
  check('the headless session booted on the fixture', init !== null, runner.stderr().slice(-400))
  const armed = await waitWire('the three tools answered', w => w.ask.trim() === ARM_ASK && w.step >= 1, bound(60_000))
  const armedResults = armed?.results ?? []
  check('the model started a background shell, a background agent and a self-paced wake, and every tool answered without an error', armed !== null && armedResults.length === 3 && armedResults.some(t => t.includes('Wake armed')) && !armedResults.some(t => /error|not found|unknown tool/i.test(t)), j(armedResults))
  await sleep(1_500)

  const t0 = Date.now()
  wallUntilMs = t0 + WALL_SECONDS * 1000
  void runner.prompt(HELLO_ASK, 'u-hello')
  const refused = await waitWire('the usage window refusal', w => w.kind === 'walled' && w.ask.trim() === HELLO_ASK, bound(30_000))
  check('the provider refused a turn for the usage window and the session observed it', refused !== null, brief())
  const refusalRow = await runner.waitFor('the provider refusal result', rateLimited, bound(20_000))
  check("the session records the provider's typed rate_limit refusal and its stated wait", refusalRow !== null && JSON.stringify(refusalRow).includes('Rate limit exceeded'), j(refusalRow))
  check('the shell, the agent and the wake all land inside the window by construction', wallUntilMs > t0 + Math.max(SHELL_SECONDS, AGENT_SHELL_SECONDS, WAKE_SECONDS) * 1000 + 5_000)

  const shell = await waitWire('the shell notice before the reopen', w => triggerSummary(w).startsWith(SHELL_NOTICE), bound(wallUntilMs - Date.now() + 40_000))
  const firstPause = await waitWire('the first provider pause notice', w => triggerSummary(w).startsWith(`${AGENT_NOTICE} paused`) && triggerSummary(w).includes(`${AGENT_REFUSAL} 1`), bound(40_000))
  const secondPause = await waitWire('the pause after one automatic retry', w => triggerSummary(w).startsWith(`${AGENT_NOTICE} paused`) && triggerSummary(w).includes(`${AGENT_REFUSAL} 2`), bound(40_000))
  const woke = await waitWire('the wake on its own clock', isWake, bound(Math.max(5_000, wallUntilMs - Date.now() + 40_000)))
  await sleep(2_000)

  const mainWalled = wire.filter(w => w.kind === 'walled' && !w.agent)
  const agentRefused = wire.filter(w => w.kind === 'walled' && w.agent)
  const shellTurns = wire.filter(w => triggerSummary(w).startsWith(SHELL_NOTICE))
  const pauseTurns = wire.filter(w => triggerSummary(w).startsWith(`${AGENT_NOTICE} paused`))
  const resumedTurns = wire.filter(w => triggerSummary(w).startsWith(`${AGENT_NOTICE} resumed by itself`))
  const wakes = wire.filter(isWake)
  check('the shell notice starts exactly one request immediately, refused by the provider before the reopen', shell !== null && shell.kind === 'walled' && shell.at < wallUntilMs && shellTurns.length === 1 && shell.at <= (armed?.at ?? 0) + SHELL_SECONDS * 1000 + bound(DELIVERY_BOUND_MS), brief())
  check('each agent pause notice starts its own request immediately, refused by the provider before the reopen', firstPause !== null && secondPause !== null && firstPause.n !== secondPause.n && pauseTurns.length === 2 && pauseTurns.every(w => w.kind === 'walled' && w.at < wallUntilMs) && agentRefused.length === 2 && pauseTurns.every((w, i) => agentRefused[i]!.refusedAt !== undefined && w.at >= agentRefused[i]!.refusedAt! && w.at - agentRefused[i]!.refusedAt! <= bound(DELIVERY_BOUND_MS)), brief())
  check('each new notice is one block of its own ask, not a withheld shell-and-agent batch', shell !== null && firstPause !== null && secondPause !== null && [shell, firstPause, secondPause].every(w => countOf(w.ask, '<task-notification>') === 1 && !w.ask.includes(ARM_ASK) && !w.ask.includes(DONE_ASK)) && shell.n !== firstPause.n && shell.n !== secondPause.n, brief())
  check('retained refused context contains one copy of every notice, never a redelivery', mainWalled.length > 0 && mainWalled.every(w => new Set(w.notices).size === w.notices.length && w.carries.shell <= 1 && w.carries.wake <= 1), brief())
  const refusedOutcomes = runner.frames.filter(frame => frame.type === 'outcome' && frame.status === 'failed')
  check('refusal outcomes carry the provider rate_limit class and words, never a stored-note admission refusal', refusedOutcomes.length > 0 && refusedOutcomes.every(frame => rateLimited(frame) && JSON.stringify(frame).includes('Rate limit exceeded')) && mainWalled.every(w => w.refusal !== undefined && w.refusedAt !== undefined), j({ walled: mainWalled.map(w => w.n), outcomes: refusedOutcomes }))
  const retryGap = agentRefused.length === 2 ? agentRefused[1]!.at - agentRefused[0]!.at : -1
  check('the refused agent retries exactly once at the provider Retry-After, not the usage-window reset', agentRefused.length === 2 && retryGap >= RETRY_AFTER_SECONDS * 1000 && retryGap <= RETRY_AFTER_SECONDS * 1000 + 1_000 + bound(DELIVERY_BOUND_MS) && agentRefused[1]!.at < wallUntilMs && resumedTurns.length === 1 && resumedTurns[0]!.kind === 'walled', j({ retryGap, agentRefused, resumed: resumedTurns.map(w => w.n) }))
  check('the second refusal preserves the provider words and the hand-resume door', secondPause !== null && triggerSummary(secondPause).includes(`${AGENT_REFUSAL} 2`) && triggerSummary(secondPause).includes('ResumeAgent to its id') && !wire.some(w => triggerSummary(w).startsWith(`${AGENT_NOTICE} completed`)), secondPause?.ask ?? brief())
  const armAt = wire.find(w => !w.agent && w.ask.trim() === ARM_ASK && w.step === 0)?.at
  check('the self-paced wake starts exactly one request on its own due clock while the provider still refuses', woke !== null && armAt !== undefined && wakes.length === 1 && woke.kind === 'walled' && woke.at >= armAt + WAKE_SECONDS * 1000 && woke.at <= (armed?.at ?? 0) + WAKE_SECONDS * 1000 + bound(DELIVERY_BOUND_MS) && woke.at < wallUntilMs, j({ armAt, armedAt: armed?.at, wakeAt: woke?.at, wallUntilMs }))
  check('the wake is the new prompt of its own turn, not a replay of the earlier notices', woke !== null && woke.ask.includes(WAKE_PROMPT) && !woke.ask.includes('<task-notification>') && shell !== null && firstPause !== null && woke.n !== shell.n && woke.n !== firstPause.n, woke?.ask ?? brief())

  await sleep(Math.max(0, wallUntilMs - Date.now()) + 2_000)
  check('the reopen starts no held delivery or automatic agent continuation', !wire.some(w => w.at >= wallUntilMs) && wire.filter(w => w.agent && w.kind === 'walled').length === 2, brief())
  void runner.prompt(DONE_ASK, 'u-done')
  const done = await waitWire('the closing ask after the reopen', w => !w.agent && w.kind === 'request' && w.ask.trim() === DONE_ASK, bound(30_000))
  const answered = await runner.waitFor('the operator line answered after the reopen', f => f.type === 'outcome' && JSON.stringify(f).includes(`heard: ${DONE_ASK}`), bound(30_000))
  check('after the reopen the operator line is served without a stored-note refusal', done !== null && done.at >= wallUntilMs && answered !== null, brief())
  check('the served operator turn carries retained notices once, without opening them again', done !== null && new Set(done.notices).size === done.notices.length && done.carries.shell === 1 && done.carries.wake === 1 && wire.filter(w => triggerSummary(w).startsWith(SHELL_NOTICE)).length === 1 && wire.filter(isWake).length === 1, done?.whole ?? brief())

  const handAt = Date.now()
  void runner.prompt(RESUME_ASK, 'u-resume')
  const hand = await waitWire('the hand resume tool result', w => !w.agent && w.ask.trim() === RESUME_ASK && w.step >= 1, bound(30_000))
  const completed = await waitWire('the completion after hand resume', w => triggerSummary(w).startsWith(`${AGENT_NOTICE} completed`), bound(30_000))
  check('the paused agent resumes only through the operator-requested ResumeAgent and completes', hand !== null && hand.results.some(text => text.includes('was resumed in the background')) && wire.some(w => w.agent && w.kind === 'agent' && w.at >= handAt && w.ask.includes(RESUME_PROMPT)) && completed !== null && completed.at >= handAt && completed.ask.includes(AGENT_DONE), brief())
  check('the hand-resumed completion starts its own request once and no further automatic resume occurred', wire.filter(w => triggerSummary(w).startsWith(`${AGENT_NOTICE} completed`)).length === 1 && wire.filter(w => triggerSummary(w).startsWith(`${AGENT_NOTICE} resumed by itself`)).length === 1, brief())
  await runner.stop(bound(8_000))
  server.close()

  const projects = join(HOME, 'projects')
  const inputRecordsOf = (line: string): string[] => carriersOf(projects, line).filter(c => c.kind === 'input' && !c.file.includes('subagents')).map(c => c.recordId)
  const needles = [SHELL_NOTICE, `${AGENT_NOTICE} paused`, `${AGENT_NOTICE} resumed by itself`, `${AGENT_NOTICE} completed`, WAKE_PROMPT]
  const records = Object.fromEntries(needles.map(needle => [needle, inputRecordsOf(needle)]))
  check('the transcript writes each notice once: one shell, two refusal pauses, one automatic-retry receipt, one hand-resumed completion and one wake', records[SHELL_NOTICE]!.length === 1 && inputRecordsOf(`${AGENT_NOTICE} paused`).length === 2 && records[`${AGENT_NOTICE} resumed by itself`]!.length === 1 && records[`${AGENT_NOTICE} completed`]!.length === 1 && records[WAKE_PROMPT]!.length === 1, j(records))

  exportWorld('wake-hold', HOME, { 'wire.json': JSON.stringify(wire, null, 2), 'frames.json': JSON.stringify(runner.frames, null, 2) })
  await removeWorld(HOME)
}
finish()
