#!/usr/bin/env bun
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { createServer, type ServerResponse } from 'node:http'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

process.env.MERCURY_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'ended-run-call-'))
process.env.MERCURY_DAEMON_DIR = mkdtempSync(join(tmpdir(), 'ended-run-call-daemon-'))
for (const k of ['MERCURY_BARE', 'MERCURY_MODEL', 'NODE_ENV']) delete process.env[k]
const scratch = mkdtempSync(join(tmpdir(), 'ended-run-call-cwd-'))

const ROOT = join(import.meta.dir, '..', '..')
const DIST = join(ROOT, 'dist', 'mercury.mjs')
const nodeBin = Bun.which('node')
if (!existsSync(DIST) || !nodeBin) {
  console.log(!existsSync(DIST) ? '❌ dist/mercury.mjs absent — build first (the pooled gate prebuilds it)' : '❌ no node binary on PATH')
  process.exit(1)
}

const bootstrap = await import('../../src/bootstrap/state.ts')
bootstrap.setIsInteractive(false)
const { enableConfigs } = await import('../../src/utils/config/globalConfig.ts')
enableConfigs()
const { loadConversationForResume, getResumePrompt } = await import('../../src/utils/conversationRecovery.ts')
const { encodeTranscriptLine } = await import('../../src/utils/sessionStorage/vnext.ts')
const { normalizeMessagesForAPI } = await import('../../src/utils/messages.ts')
import type { Message } from '../../src/types/message.ts'

const SENTENCE = 'The previous run ended before this call returned a result; whether the call started or finished is not known.'
const PLACEHOLDER_HEAD = 'No result was recorded for this tool call'
const CONTINUATION = getResumePrompt()

let failures = 0
let checks = 0
function check(label: string, cond: boolean, detail = ''): void {
  checks++
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail.slice(0, 700)}` : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t)
}
const j = (v: unknown): string => JSON.stringify(v) ?? ''

const guard = setTimeout(() => {
  console.log('\n❌ TIMEOUT — the ended-run proof exceeded 240s')
  process.exit(1)
}, 240_000)
guard.unref?.()

type Row = Record<string, unknown>
let clock = Date.parse('2026-11-09T10:00:00.000Z')
let minted = 0
const uid = (): string => `00000000-0000-4000-8000-${String(100000000000 + ++minted).slice(1)}`
function chain(sessionId: string, rows: Row[]): Row[] {
  let parent: string | null = null
  return rows.map(row => {
    const out: Row = { parentUuid: parent, isSidechain: false, cwd: scratch, sessionId, version: '1.0.8', gitBranch: 'main', timestamp: new Date((clock += 1000)).toISOString(), ...row }
    parent = row.uuid as string
    return out
  })
}
const prompt = (text: string): Row => ({ uuid: uid(), type: 'user', message: { role: 'user', content: text } })
const reply = (id: string, content: unknown[], stop: string | null = null): Row => ({ uuid: uid(), type: 'assistant', requestId: `req_${id}`, message: { id, type: 'message', role: 'assistant', model: 'claude-opus-5-5', stop_reason: stop, stop_sequence: null, content } })
const result = (toolUseId: string, text: string): Row => ({ uuid: uid(), type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: toolUseId, content: text }] }, toolUseResult: { stdout: text } })
const words = (text: string): Record<string, unknown> => ({ type: 'text', text })
const call = (id: string, name: string, input: Record<string, unknown>): Record<string, unknown> => ({ type: 'tool_use', id, name, input })

type Block = { type?: string; text?: string; id?: string; tool_use_id?: string; content?: unknown; is_error?: boolean; thinking?: string; signature?: string }
const blocksOf = (row: Message | undefined): Block[] => {
  const content = (row as { message?: { content?: unknown } } | undefined)?.message?.content
  return Array.isArray(content) ? (content as Block[]) : typeof content === 'string' ? [{ type: 'text', text: content }] : []
}
const shapeOf = (messages: readonly Message[]): string[] =>
  messages
    .filter(row => row.type === 'assistant' || row.type === 'user')
    .map(row => `${row.type}:${blocksOf(row).map(block => (block.type === 'text' ? `text(${block.text})` : block.type === 'tool_use' ? `call(${block.id})` : block.type === 'tool_result' ? `result(${block.tool_use_id}${block.is_error === true ? ',error' : ''}:${typeof block.content === 'string' ? block.content : j(block.content)})` : String(block.type))).join('+')}`)
const requestShape = (messages: readonly Message[]): string[] => shapeOf(normalizeMessagesForAPI([...messages], []) as Message[])

let sceneNo = 0
async function resume(rows: Row[]): Promise<{ loaded: NonNullable<Awaited<ReturnType<typeof loadConversationForResume>>>; file: string; rows: Row[] }> {
  const sessionId = `${String(++sceneNo).padStart(8, '0')}-0000-4000-8000-000000000000`
  const file = join(scratch, `${sessionId}.jsonl`)
  writeFileSync(file, chain(sessionId, rows).map(row => encodeTranscriptLine(file, row).line).join(''))
  const loaded = await loadConversationForResume(sessionId, file)
  if (!loaded) throw new Error('the resume loader returned nothing')
  return { loaded, file, rows }
}
const stateWords = (loaded: { turnInterruptionState: { kind: string; message?: Message } }): string =>
  loaded.turnInterruptionState.kind === 'interrupted_prompt' ? blocksOf(loaded.turnInterruptionState.message).map(block => block.text ?? '').join('') : loaded.turnInterruptionState.kind

console.log('============================================================')
console.log(' a call with no result when its run ended stays on the resumed conversation')
console.log('============================================================')

section('§1 words, then one call, the run ended while it ran (the common shape)')
{
  const { loaded, rows } = await resume([
    prompt('run the build'),
    reply('msg_a', [words('I will run the build now.')]),
    reply('msg_a', [call('toolu_a', 'Bash', { command: 'npm run build' })]),
  ])
  const messages = loaded.messages as Message[]
  check('the turn reads as cut, not as finished: the continuation is the resume sentence', stateWords(loaded) === CONTINUATION, stateWords(loaded))
  check('the conversation keeps the words, the call, and one result for it that says what the record knows', j(shapeOf(messages)) === j(['user:text(run the build)', 'assistant:text(I will run the build now.)', 'assistant:call(toolu_a)', `user:result(toolu_a,error:${SENTENCE})`, `user:text(${CONTINUATION})`, 'assistant:text(No response requested.)']), j(shapeOf(messages)))
  const settled = messages.find(row => row.type === 'user' && blocksOf(row).some(block => block.type === 'tool_result' && block.tool_use_id === 'toolu_a')) as (Message & { sourceToolAssistantUUID?: string; toolUseResult?: unknown }) | undefined
  check('the result row names the call\'s own row as its source and carries the sentence as its result', settled?.sourceToolAssistantUUID === rows[2]!.uuid && settled?.toolUseResult === SENTENCE, j({ source: settled?.sourceToolAssistantUUID, wanted: rows[2]!.uuid, result: settled?.toolUseResult }))
  check('the request the model reads pairs the call with that sentence, and nothing is made up for it', j(requestShape(messages)) === j(['user:text(run the build)', 'assistant:text(I will run the build now.)+call(toolu_a)', `user:result(toolu_a,error:${SENTENCE})+text(${CONTINUATION})`, 'assistant:text(No response requested.)']) && !j(requestShape(messages)).includes(PLACEHOLDER_HEAD), j(requestShape(messages)))
}

section('§2 one call and no words: the prompt is not asked again')
{
  const { loaded } = await resume([
    prompt('run the build'),
    reply('msg_b', [call('toolu_b', 'Bash', { command: 'npm run build' })]),
  ])
  check('the continuation is the resume sentence, not the operator\'s prompt', stateWords(loaded) === CONTINUATION, stateWords(loaded))
  check('the call stands with its result', j(shapeOf(loaded.messages as Message[])) === j(['user:text(run the build)', 'assistant:call(toolu_b)', `user:result(toolu_b,error:${SENTENCE})`, `user:text(${CONTINUATION})`, 'assistant:text(No response requested.)']), j(shapeOf(loaded.messages as Message[])))
}

section('§3 a read had returned, a write had not: the read keeps its own result, the write gets the sentence')
{
  const { loaded } = await resume([
    prompt('read the note then wait'),
    reply('msg_c', [words('Reading and then waiting.')]),
    reply('msg_c', [call('toolu_c_read', 'Read', { file_path: '/repo/note.txt' })]),
    reply('msg_c', [call('toolu_c_bash', 'Bash', { command: 'sleep 25' })]),
    result('toolu_c_read', 'the note says hello'),
  ])
  const messages = loaded.messages as Message[]
  check('both calls stand; the returned one is unchanged', j(shapeOf(messages)) === j(['user:text(read the note then wait)', 'assistant:text(Reading and then waiting.)', 'assistant:call(toolu_c_read)', 'assistant:call(toolu_c_bash)', 'user:result(toolu_c_read:the note says hello)', `user:result(toolu_c_bash,error:${SENTENCE})`, `user:text(${CONTINUATION})`, 'assistant:text(No response requested.)']), j(shapeOf(messages)))
  check('the request carries both results in one message after the reply', j(requestShape(messages)) === j(['user:text(read the note then wait)', 'assistant:text(Reading and then waiting.)+call(toolu_c_read)+call(toolu_c_bash)', `user:result(toolu_c_read:the note says hello)+result(toolu_c_bash,error:${SENTENCE})+text(${CONTINUATION})`, 'assistant:text(No response requested.)']), j(requestShape(messages)))
}

section('§4 thinking, then a call: the reasoning stays with the call it led to')
{
  const { loaded } = await resume([
    prompt('say hello'),
    reply('msg_d1', [words('Hello.')], 'end_turn'),
    prompt('now deploy'),
    reply('msg_d2', [{ type: 'thinking', thinking: 'Deploying needs the token.', signature: 'sig-d' }]),
    reply('msg_d2', [call('toolu_d', 'Bash', { command: './deploy.sh' })]),
  ])
  const messages = loaded.messages as Message[]
  const reasoning = messages.flatMap(row => blocksOf(row)).find(block => block.type === 'thinking')
  check('the reasoning row is kept with its signature', reasoning?.thinking === 'Deploying needs the token.' && reasoning?.signature === 'sig-d', j(reasoning))
  check('the call stands with its result and the turn reads as cut', stateWords(loaded) === CONTINUATION && shapeOf(messages).includes(`user:result(toolu_d,error:${SENTENCE})`) && shapeOf(messages).includes('assistant:call(toolu_d)'), j(shapeOf(messages)))
  check('the finished turn before it is untouched', j(shapeOf(messages).slice(0, 3)) === j(['user:text(say hello)', 'assistant:text(Hello.)', 'user:text(now deploy)']), j(shapeOf(messages).slice(0, 3)))
}

section('§5 two calls, neither returned: each gets its sentence, in call order')
{
  const { loaded } = await resume([
    prompt('run both'),
    reply('msg_e', [call('toolu_e1', 'Bash', { command: 'make a' })]),
    reply('msg_e', [call('toolu_e2', 'Write', { file_path: '/repo/out.txt', content: 'x' })]),
  ])
  check('a writing call and a shell call are treated alike', j(shapeOf(loaded.messages as Message[]).slice(1, 5)) === j(['assistant:call(toolu_e1)', 'assistant:call(toolu_e2)', `user:result(toolu_e1,error:${SENTENCE})`, `user:result(toolu_e2,error:${SENTENCE})`]), j(shapeOf(loaded.messages as Message[])))
}

section('§6 the controls: what does not move')
{
  const finished = await resume([prompt('say hello'), reply('msg_f', [words('Hello.')], 'end_turn')])
  check('a finished turn: two rows, no sentence, no continuation', finished.loaded.turnInterruptionState.kind === 'none' && j(shapeOf(finished.loaded.messages as Message[])) === j(['user:text(say hello)', 'assistant:text(Hello.)']), j(shapeOf(finished.loaded.messages as Message[])))
  const unanswered = await resume([prompt('say hello'), reply('msg_g', [words('Hello.')], 'end_turn'), prompt('and now goodbye')])
  check('a prompt the model never answered is still re-asked as itself', stateWords(unanswered.loaded) === 'and now goodbye' && !j(shapeOf(unanswered.loaded.messages as Message[])).includes(SENTENCE), stateWords(unanswered.loaded))
  const returned = await resume([prompt('run it'), reply('msg_h', [call('toolu_h', 'Bash', { command: 'make' })]), result('toolu_h', '10 pass, 0 fail')])
  check('a call that had returned keeps its result and gains nothing', j(shapeOf(returned.loaded.messages as Message[]).slice(0, 3)) === j(['user:text(run it)', 'assistant:call(toolu_h)', 'user:result(toolu_h:10 pass, 0 fail)']) && !j(shapeOf(returned.loaded.messages as Message[])).includes(SENTENCE), j(shapeOf(returned.loaded.messages as Message[])))
  const older = await resume([
    prompt('run the build'),
    reply('msg_i1', [words('Building.')]),
    reply('msg_i1', [call('toolu_i', 'Bash', { command: 'npm run build' })]),
    prompt('never mind, what time is it?'),
    reply('msg_i2', [words('Noon.')], 'end_turn'),
  ])
  check('an unanswered call in the middle of a conversation that went on is dropped as before (no sent history moves)', older.loaded.turnInterruptionState.kind === 'none' && j(shapeOf(older.loaded.messages as Message[])) === j(['user:text(run the build)', 'assistant:text(Building.)', 'user:text(never mind, what time is it?)', 'assistant:text(Noon.)']), j(shapeOf(older.loaded.messages as Message[])))
  const once = await resume([prompt('run the build'), reply('msg_j', [call('toolu_j', 'Bash', { command: 'npm run build' })])])
  const bytes = readFileSync(once.file, 'utf8')
  const again = await loadConversationForResume(once.file.split('/').at(-1)!.replace('.jsonl', ''), once.file)
  check('loading writes nothing: the transcript is byte for byte what it was, and a second load reads the same conversation', readFileSync(once.file, 'utf8') === bytes && j(shapeOf((again?.messages ?? []) as Message[])) === j(shapeOf(once.loaded.messages as Message[])), j(shapeOf((again?.messages ?? []) as Message[])))
}

section('§7 the built bundle: the process is stopped by signal 9 while a shell call runs beside a read that returned; two later processes resume the session')
{
  const sse = (event: string, data: unknown): string => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`
  const messageStart = (id: string): string =>
    sse('message_start', { type: 'message_start', message: { id, type: 'message', role: 'assistant', model: 'claude-opus-4-8', content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 25, output_tokens: 1 } } })
  const blockStart = (index: number, block: Record<string, unknown>): string => sse('content_block_start', { type: 'content_block_start', index, content_block: block })
  const blockDelta = (index: number, delta: Record<string, unknown>): string => sse('content_block_delta', { type: 'content_block_delta', index, delta })
  const blockStop = (index: number): string => sse('content_block_stop', { type: 'content_block_stop', index })
  const textWhole = (index: number, text: string): string => blockStart(index, { type: 'text', text: '' }) + blockDelta(index, { type: 'text_delta', text }) + blockStop(index)
  const toolWhole = (index: number, id: string, name: string, input: Record<string, unknown>): string =>
    blockStart(index, { type: 'tool_use', id, name, input: {} }) + blockDelta(index, { type: 'input_json_delta', partial_json: JSON.stringify(input) }) + blockStop(index)
  const messageEnd = (stop: string): string =>
    sse('message_delta', { type: 'message_delta', delta: { stop_reason: stop, stop_sequence: null }, usage: { output_tokens: 12 } }) + sse('message_stop', { type: 'message_stop' })

  const home = mkdtempSync(join(tmpdir(), 'ended-run-call-home-'))
  const cwd = mkdtempSync(join(tmpdir(), 'ended-run-call-work-'))
  mkdirSync(join(home, '.mercury'), { recursive: true })
  const note = join(cwd, 'note.txt')
  writeFileSync(note, 'the note says hello\n')
  type Wire = Array<{ role: string; content: unknown }>
  const wires: Wire[] = []
  let phase = 1
  const server = createServer((req, res: ServerResponse) => {
    const chunks: Buffer[] = []
    req.on('data', chunk => chunks.push(chunk as Buffer))
    req.on('end', () => {
      const url = req.url ?? ''
      if (url.includes('/v1/messages/count_tokens')) {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ input_tokens: 100 }))
        return
      }
      if (!url.includes('/v1/messages')) {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end('{}')
        return
      }
      let body: { stream?: unknown; messages?: Wire } = {}
      try {
        body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as typeof body
      } catch {
        body = {}
      }
      wires.push(body.messages ?? [])
      if (phase === 1) {
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store' })
        res.end(messageStart('msg_stopped') + textWhole(0, 'Reading and then waiting.') + toolWhole(1, 'toolu_read', 'Read', { file_path: note }) + toolWhole(2, 'toolu_shell', 'Bash', { command: 'sleep 20' }) + messageEnd('tool_use'))
        return
      }
      const text = phase === 2 ? 'FIRST RESUMED REPLY.' : 'SECOND RESUMED REPLY.'
      if (body.stream !== true) {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ id: `msg_resumed_${wires.length}`, type: 'message', role: 'assistant', model: 'claude-opus-4-8', content: [{ type: 'text', text }], stop_reason: 'end_turn', stop_sequence: null, usage: { input_tokens: 25, output_tokens: 12 } }))
        return
      }
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store' })
      res.end(messageStart(`msg_resumed_${wires.length}`) + textWhole(0, text) + messageEnd('end_turn'))
    })
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const env = {
    HOME: home,
    PATH: `/usr/bin:/bin:${dirname(nodeBin)}`,
    TERM: 'dumb',
    MERCURY_CONFIG_DIR: join(home, '.mercury'),
    ANTHROPIC_BASE_URL: `http://127.0.0.1:${(server.address() as { port: number }).port}`,
    ANTHROPIC_API_KEY: 'fixture-key-000',
    MERCURY_DAEMON_DIR: join(home, 'daemon'),
    MERCURY_LOCAL_PROBE_TARGETS: 'none',
    MERCURY_VERIFY_EVIDENCE: '0',
  }
  const sid = 'facef00d-0000-4000-8000-00000000e4d0'
  const run = (args: string[], stopWhen?: (stdout: string) => boolean): Promise<{ exit: number | null; signal: string | null; stdout: string }> =>
    new Promise(resolve => {
      const child = spawn(nodeBin, [DIST, ...args], { cwd, env })
      let stdout = ''
      let armed = false
      child.stdout.on('data', chunk => {
        stdout += String(chunk)
        if (stopWhen !== undefined && !armed && stopWhen(stdout)) {
          armed = true
          setTimeout(() => child.kill('SIGKILL'), 1500)
        }
      })
      child.stderr.on('data', () => {})
      const killer = setTimeout(() => child.kill('SIGKILL'), 90_000)
      child.on('close', (exit, signal) => {
        clearTimeout(killer)
        resolve({ exit, signal, stdout })
      })
    })
  const plain = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(plain)
    if (value !== null && typeof value === 'object') return Object.fromEntries(Object.entries(value as Record<string, unknown>).filter(([key]) => key !== 'cache_control').map(([key, inner]) => [key, plain(inner)]))
    return value
  }
  const wireBlocks = (wire: Wire | undefined): Block[] => (wire ?? []).flatMap(message => (Array.isArray(message.content) ? (message.content as Block[]) : []))
  try {
    const stopped = await run(['run', 'read the note then wait', '--model', 'claude-opus-4-8', '--session-id', sid, '--mode', 'sovereign', '--format', 'rows'], stdout => stdout.includes('"type":"tool_result"') && stdout.includes('toolu_read'))
    check('the first process was stopped by signal 9 after the read returned, while the shell call ran', stopped.signal === 'SIGKILL' && wires.length === 1 && !stopped.stdout.includes('"call_id":"toolu_shell","status"'), `signal=${stopped.signal} requests=${wires.length}`)
    phase = 2
    const first = await run(['run', 'what happened before?', '--model', 'claude-opus-4-8', '--resume', sid, '--mode', 'sovereign', '--format', 'rows'])
    const firstWire = wires[1]
    const firstBlocks = wireBlocks(firstWire)
    check('the resumed process answered', first.exit === 0 && first.stdout.includes('FIRST RESUMED REPLY.'), `exit=${first.exit}`)
    check('its request carries the shell call that had no result', firstBlocks.some(block => block.type === 'tool_use' && block.id === 'toolu_shell'), j(firstBlocks.map(block => block.type === 'tool_use' ? block.id : block.type)))
    const shellResult = firstBlocks.find(block => block.type === 'tool_result' && block.tool_use_id === 'toolu_shell')
    check('…answered by the sentence, as an error result', shellResult?.is_error === true && j(shellResult.content).includes(SENTENCE), j(shellResult))
    const readResult = firstBlocks.find(block => block.type === 'tool_result' && block.tool_use_id === 'toolu_read')
    check('…the read keeps the result it returned', readResult !== undefined && readResult.is_error !== true && j(readResult.content).includes('the note says hello'), j(readResult))
    check('…the resume sentence once, and nothing made up', j(firstWire).split(CONTINUATION).length - 1 === 1 && !j(firstWire).includes(PLACEHOLDER_HEAD), j(firstWire).slice(0, 400))
    const projects = join(home, '.mercury', 'projects')
    const transcript = readdirSync(projects).map(dir => join(projects, dir, `${sid}.jsonl`)).find(existsSync)
    const stored = transcript === undefined ? '' : readFileSync(transcript, 'utf8')
    check('the transcript now holds the sentence on one row (the record says it once)', stored.split('\n').filter(line => line.includes(SENTENCE)).length === 1, String(stored.split('\n').filter(line => line.includes(SENTENCE)).length))
    phase = 3
    const second = await run(['run', 'and now?', '--model', 'claude-opus-4-8', '--resume', sid, '--mode', 'sovereign', '--format', 'rows'])
    const secondWire = wires[2]
    check('a second resumed process answered', second.exit === 0 && second.stdout.includes('SECOND RESUMED REPLY.'), `exit=${second.exit}`)
    check('its request begins with the first resumed request, message for message (the record resumes to what was sent)', firstWire !== undefined && secondWire !== undefined && j(plain(secondWire.slice(0, firstWire.length))) === j(plain(firstWire)), `first ${j(plain(firstWire)).slice(-500)} second ${j(plain(secondWire?.slice(0, firstWire?.length ?? 0))).slice(-500)}`)
    check('…and still carries the sentence once', j(secondWire).split(SENTENCE).length - 1 === 1, String(j(secondWire).split(SENTENCE).length - 1))
  } finally {
    server.closeAllConnections?.()
    await new Promise<void>(resolve => server.close(() => resolve()))
  }
}

console.log('\n============================================================')
console.log(failures === 0 ? ` ✅ ENDED RUN GREEN (${checks} checks)` : ` ❌ ${failures} of ${checks} ENDED RUN CHECK(S) FAILED`)
process.exit(failures === 0 ? 0 : 1)
