#!/usr/bin/env bun
import { type ChildProcess, spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, type ServerResponse } from 'node:http'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { Readable, Writable } from 'node:stream'
import { client, ndJsonStream, PROTOCOL_VERSION } from '@agentclientprotocol/sdk'
import { seedFirstRun } from '../lib/firstRunSeed.ts'
import { HANDOFF_ASK_MARK } from '../lib/fixtureApi.ts'
import { endProcessGroup, spawnInOwnGroup } from '../lib/processGroup.ts'

const distArg = process.argv.indexOf('--dist')
const DIST = resolve(distArg < 0 ? join(import.meta.dir, '../../dist/mercury.mjs') : process.argv[distArg + 1]!)
const nodeBin = Bun.which('node')
if (!existsSync(DIST) || nodeBin === null) {
  console.error(`✗ ${DIST} or node is missing — run \`bun run build.ts\` first`)
  process.exit(1)
}

const scratch = mkdtempSync(join(tmpdir(), 'withdrawn-call-'))
let failures = 0
let checks = 0
function check(label: string, cond: boolean, detail = ''): void {
  checks++
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail.slice(0, 900)}` : ''}`)
}
function section(title: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + title)
}
const j = (value: unknown): string => JSON.stringify(value) ?? ''

const servers: ChildProcess[] = []
const guard = setTimeout(() => {
  console.log('\n❌ TIMEOUT — the withdrawn-call proof exceeded 300s')
  for (const server of servers) endProcessGroup(server)
  process.exit(1)
}, 300_000)
guard.unref?.()

const MODEL = 'claude-opus-4-8'
const sse = (event: string, data: unknown): string => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`
const messageStart = (id: string, inputTokens = 25): string =>
  sse('message_start', { type: 'message_start', message: { id, type: 'message', role: 'assistant', model: MODEL, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: inputTokens, output_tokens: 1 } } })
const blockStart = (index: number, block: Record<string, unknown>): string => sse('content_block_start', { type: 'content_block_start', index, content_block: block })
const blockDelta = (index: number, delta: Record<string, unknown>): string => sse('content_block_delta', { type: 'content_block_delta', index, delta })
const blockStop = (index: number): string => sse('content_block_stop', { type: 'content_block_stop', index })
const textWhole = (index: number, text: string): string => blockStart(index, { type: 'text', text: '' }) + blockDelta(index, { type: 'text_delta', text }) + blockStop(index)
const toolWhole = (index: number, id: string, name: string, input: Record<string, unknown>): string =>
  blockStart(index, { type: 'tool_use', id, name, input: {} }) + blockDelta(index, { type: 'input_json_delta', partial_json: JSON.stringify(input) }) + blockStop(index)
const messageEnd = (stop: string, outputTokens = 12): string =>
  sse('message_delta', { type: 'message_delta', delta: { stop_reason: stop, stop_sequence: null }, usage: { output_tokens: outputTokens } }) + sse('message_stop', { type: 'message_stop' })

type Ask = { n: number; stream: boolean; last: string; tokens: number; res: ServerResponse }
type Provider = { url: string; asks: Ask[]; close: () => Promise<void> }
function say(ask: Ask, text: string): void {
  const outputTokens = Math.ceil(text.length / 4)
  if (!ask.stream) {
    ask.res.writeHead(200, { 'content-type': 'application/json' })
    ask.res.end(JSON.stringify({ id: `msg_said_${ask.n}`, type: 'message', role: 'assistant', model: MODEL, content: [{ type: 'text', text }], stop_reason: 'end_turn', stop_sequence: null, usage: { input_tokens: ask.tokens, output_tokens: outputTokens } }))
    return
  }
  ask.res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store' })
  ask.res.end(messageStart(`msg_said_${ask.n}`, ask.tokens) + textWhole(0, text) + messageEnd('end_turn', outputTokens))
}
function cut(ask: Ask, id: string, blocks: string, open: number): void {
  ask.res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store' })
  ask.res.write(messageStart(id) + blocks + blockStart(open, { type: 'text', text: '' }))
  setTimeout(() => ask.res.destroy(), 300)
}
async function startProvider(reply: (ask: Ask) => void): Promise<Provider> {
  const provider: Provider = { url: '', asks: [], close: async () => {} }
  const server = createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', chunk => chunks.push(chunk as Buffer))
    req.on('end', () => {
      const url = req.url ?? ''
      const raw = Buffer.concat(chunks).toString('utf8')
      const tokens = Math.ceil(raw.length / 4)
      if (url.includes('/v1/messages/count_tokens')) {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ input_tokens: tokens }))
        return
      }
      if (!url.includes('/v1/messages')) {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end('{}')
        return
      }
      let body: { stream?: unknown; messages?: unknown[] } = {}
      try {
        body = JSON.parse(raw) as typeof body
      } catch {
        body = {}
      }
      const last = j(body.messages?.at(-1) ?? null)
      const asked: Ask = { n: provider.asks.length + 1, stream: body.stream === true, last, tokens, res }
      if (last.includes(HANDOFF_ASK_MARK)) {
        say({ ...asked, n: 0 }, 'The note for the next session.')
        return
      }
      provider.asks.push(asked)
      reply(asked)
    })
  })
  await new Promise<void>(done => server.listen(0, '127.0.0.1', () => done()))
  provider.url = `http://127.0.0.1:${(server.address() as { port: number }).port}`
  provider.close = () =>
    new Promise<void>(done => {
      server.closeAllConnections?.()
      server.close(() => done())
    })
  return provider
}

type Arena = { home: string; cwd: string; env: Record<string, string> }
function makeArena(name: string, apiUrl: string): Arena {
  const root = join(scratch, name)
  const home = join(root, 'home')
  const cwd = join(root, 'cwd')
  for (const dir of [home, cwd, join(root, 'tmp'), join(root, 'daemon')]) mkdirSync(dir, { recursive: true })
  seedFirstRun(home, [cwd])
  return {
    home,
    cwd,
    env: {
      HOME: home,
      PATH: `/usr/bin:/bin:${dirname(nodeBin!)}`,
      TERM: 'dumb',
      TMPDIR: join(root, 'tmp'),
      MERCURY_CONFIG_DIR: home,
      MERCURY_TMPDIR: join(root, 'tmp'),
      MERCURY_CREDENTIAL_STORE: 'file',
      ANTHROPIC_BASE_URL: apiUrl,
      ANTHROPIC_API_KEY: 'fixture-key-000',
      MERCURY_DAEMON_DIR: join(root, 'daemon'),
      MERCURY_LOCAL_PROBE_TARGETS: 'none',
      MERCURY_VERIFY_EVIDENCE: '0',
      MERCURY_CACHE_CLOCK: '0',
    },
  }
}
type Row = Record<string, unknown> & { type?: string; call_id?: string; message_id?: string; status?: string; output?: unknown; answer?: string; text?: string }
const rowsOf = (stdout: string): Row[] =>
  stdout.split('\n').filter(line => line.startsWith('{')).map(line => JSON.parse(line) as Row)
function run(arena: Arena, args: string[]): Promise<{ exit: number | null; rows: Row[]; stderr: string }> {
  return new Promise(done => {
    const child = spawn(nodeBin!, [DIST, 'run', ...args, '--model', MODEL, '--format', 'rows'], { cwd: arena.cwd, env: arena.env })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', chunk => (stdout += String(chunk)))
    child.stderr.on('data', chunk => (stderr += String(chunk)))
    const killer = setTimeout(() => child.kill('SIGKILL'), 90_000)
    child.on('close', exit => {
      clearTimeout(killer)
      done({ exit, rows: rowsOf(stdout), stderr })
    })
  })
}
const recordOf = (arena: Arena): string => {
  const stack = [join(arena.home, 'projects')]
  let text = ''
  while (stack.length > 0) {
    const dir = stack.pop()!
    if (!existsSync(dir)) continue
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name)
      if (entry.isDirectory()) stack.push(path)
      else if (entry.name.endsWith('.jsonl')) text += readFileSync(path, 'utf8')
    }
  }
  return text
}
const shape = (rows: Row[]): string[] =>
  rows.flatMap(row => {
    if (row.type === 'text') return [`text ${String(row.message_id)}`]
    if (row.type === 'tool_call') return [`call ${String(row.call_id)}`]
    if (row.type === 'tool_result') return [`result ${String(row.call_id)} ${String(row.status)} ${j(row.output ?? '')}`]
    if (row.type === 'retracted') return [`retracted ${String(row.message_id)}`]
    if (row.type === 'outcome') return [`outcome ${String(row.status)}`]
    return []
  })
const resultsFor = (rows: Row[], callId: string): Row[] => rows.filter(row => row.type === 'tool_result' && row.call_id === callId)

console.log('============================================================')
console.log(' a reply the turn withdraws answers the calls it had announced')
console.log('============================================================')

try {
  const cutScript = (seen: string, never: string) => {
    let cutOnce = false
    return (asked: Ask): void => {
      if (!asked.last.includes('CUT-PROMPT')) return say(asked, `AUX-${asked.n}.`)
      if (asked.stream && !cutOnce) {
        cutOnce = true
        return cut(asked, 'msg_cut', textWhole(0, 'CUT-REPLY-TEXT before the calls.') + toolWhole(1, 'toolu_cut_read', 'Read', { file_path: seen }) + toolWhole(2, 'toolu_cut_write', 'Write', { file_path: never, content: 'never' }), 3)
      }
      say(asked, 'ONE-SHOT WHOLE REPLY.')
    }
  }

  section('A — mercury run --format rows, whole rows: a reply cut after settled text, a read and a write, asked again as one completion')
  {
    let script: (asked: Ask) => void = () => {}
    const api = await startProvider(asked => script(asked))
    const arena = makeArena('whole', api.url)
    const seen = join(arena.cwd, 'seen.txt')
    const never = join(arena.cwd, 'never-written.txt')
    writeFileSync(seen, 'SEEN-FILE-CONTENT\n')
    script = cutScript(seen, never)
    try {
      const ran = await run(arena, ['CUT-PROMPT whole rows.'])
      const outcome = ran.rows.find(row => row.type === 'outcome')
      const calls = ran.rows.filter(row => row.type === 'tool_call').map(row => String(row.call_id))
      check('A: the turn withdrew the cut reply and reached its whole answer', ran.exit === 0 && outcome?.status === 'completed' && outcome?.answer === 'ONE-SHOT WHOLE REPLY.', `exit ${ran.exit}; ${j(shape(ran.rows))}; ${ran.stderr.slice(-300)}`)
      check('A: the host was sent the cut reply\'s words and its two calls', j(calls) === j(['toolu_cut_read', 'toolu_cut_write']) && ran.rows.some(row => row.type === 'text' && row.message_id === 'msg_cut'), j(shape(ran.rows)))
      for (const callId of ['toolu_cut_read', 'toolu_cut_write']) {
        const answers = resultsFor(ran.rows, callId)
        check(`A: ${callId} is answered once, aborted, with nothing as its output`, answers.length === 1 && answers[0]!.status === 'aborted' && (answers[0]!.output ?? '') === '', j(answers.map(row => ({ status: row.status, output: row.output }))))
      }
      check('A: every call row of the run has exactly one result row', calls.length > 0 && calls.every(callId => resultsFor(ran.rows, callId).length === 1), j(shape(ran.rows)))
      const order = shape(ran.rows)
      check('A: the answers stand before the reply that replaced the cut one', order.findIndex(line => line.startsWith('result toolu_cut_write')) !== -1 && order.findIndex(line => line.startsWith('result toolu_cut_write')) < order.findLastIndex(line => line.startsWith('text ')), j(order))
      check('A: the write the cut reply asked for never ran', !existsSync(never))
      const onDisk = recordOf(arena)
      check('A: the record holds the withdrawn reply and no result row for its calls', onDisk.includes('toolu_cut_write') && !onDisk.split('\n').some(line => line.includes('tool_result') && line.includes('toolu_cut_')), `${onDisk.length} bytes`)
    } finally {
      await api.close()
    }
  }

  section('B — the same reply with --partial: the stream withdraws the reply by its own row, as before')
  {
    let script: (asked: Ask) => void = () => {}
    const api = await startProvider(asked => script(asked))
    const arena = makeArena('partial', api.url)
    const seen = join(arena.cwd, 'seen.txt')
    writeFileSync(seen, 'SEEN-FILE-CONTENT\n')
    script = cutScript(seen, join(arena.cwd, 'never-written.txt'))
    try {
      const ran = await run(arena, ['CUT-PROMPT partial rows.', '--partial'])
      const outcome = ran.rows.find(row => row.type === 'outcome')
      check('B: the turn reached its whole answer', ran.exit === 0 && outcome?.status === 'completed' && outcome?.answer === 'ONE-SHOT WHOLE REPLY.', `exit ${ran.exit}; ${ran.stderr.slice(-300)}`)
      check('B: the stream withdraws the cut reply by a retracted row', ran.rows.some(row => row.type === 'retracted' && row.message_id === 'msg_cut'), j(shape(ran.rows)))
      check('B: …and carries no result row for the withdrawn calls', resultsFor(ran.rows, 'toolu_cut_read').length === 0 && resultsFor(ran.rows, 'toolu_cut_write').length === 0, j(shape(ran.rows)))
    } finally {
      await api.close()
    }
  }

  section('C — an editor over ACP watches the cut reply, then a second whole turn')
  {
    const api = await startProvider(asked => {
      if (asked.last.includes('CUT-PROMPT-TWO')) return say(asked, 'SECOND TURN REPLY.')
      if (!asked.last.includes('CUT-PROMPT-ONE')) return say(asked, `AUX-${asked.n}.`)
      if (asked.stream) return cut(asked, 'msg_cut', textWhole(0, 'CUT-REPLY-TEXT before the call.') + toolWhole(1, 'toolu_cut', 'Write', { file_path: join(arena.cwd, 'never-written.txt'), content: 'never' }), 2)
      say(asked, 'ONE-SHOT WHOLE REPLY.')
    })
    const arena = makeArena('editor', api.url)
    const server = spawnInOwnGroup(nodeBin!, [DIST, 'acp'], { cwd: arena.cwd, stdio: ['pipe', 'pipe', 'pipe'], env: arena.env })
    servers.push(server)
    server.stderr!.on('data', () => {})
    type Update = Record<string, unknown> & { sessionUpdate?: string; toolCallId?: string; status?: string; content?: { text?: string } }
    const updates: Update[] = []
    const connection = client({ name: 'withdrawn-call-proof' })
      .onNotification('session/update', ctx => {
        updates.push(ctx.params.update as unknown as Update)
      })
      .onRequest('session/request_permission', () => ({ outcome: { outcome: 'selected' as const, optionId: 'allow' } }))
      .connect(ndJsonStream(Writable.toWeb(server.stdin!) as WritableStream<Uint8Array>, Readable.toWeb(server.stdout!) as ReadableStream<Uint8Array>))
    const request = (method: string, params: unknown): Promise<Record<string, unknown>> => {
      let alarm: ReturnType<typeof setTimeout> | undefined
      return Promise.race([
        (connection.agent.request as (method: string, params: unknown) => Promise<unknown>)(method, params) as Promise<Record<string, unknown>>,
        new Promise<never>((_, refuse) => {
          alarm = setTimeout(() => refuse(new Error(`${method} did not settle`)), 90_000)
        }),
      ]).finally(() => clearTimeout(alarm))
    }
    try {
      await request('initialize', { protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} })
      const sessionId = String((await request('session/new', { cwd: arena.cwd, mcpServers: [] })).sessionId)
      const first = await request('session/prompt', { sessionId, prompt: [{ type: 'text', text: 'CUT-PROMPT-ONE.' }] })
      const second = await request('session/prompt', { sessionId, prompt: [{ type: 'text', text: 'CUT-PROMPT-TWO.' }] })
      await new Promise(done => setTimeout(done, 400))
      const said = updates.filter(update => update.sessionUpdate === 'agent_message_chunk').map(update => String(update.content?.text ?? ''))
      const held = new Map<string, string>()
      for (const update of updates) {
        if (update.toolCallId === undefined || update.status === undefined) continue
        if (update.sessionUpdate === 'tool_call' || update.sessionUpdate === 'tool_call_update') held.set(update.toolCallId, String(update.status))
      }
      check('C: both turns ended, and the editor was shown the cut words, the reply that replaced them and the second reply', first.stopReason === 'end_turn' && second.stopReason === 'end_turn' && said.join('|').includes('CUT-REPLY-TEXT') && said.join('|').includes('ONE-SHOT WHOLE REPLY.') && said.join('|').includes('SECOND TURN REPLY.'), j({ first: first.stopReason, second: second.stopReason, said }))
      check('C: the editor was shown the cut reply\'s call', updates.some(update => update.sessionUpdate === 'tool_call' && update.toolCallId === 'toolu_cut'), j(updates.filter(update => update.toolCallId !== undefined).map(update => [update.sessionUpdate, update.toolCallId, update.status])))
      check('C: …and that it failed: with the session idle the editor holds no call in progress', j([...held]) === j([['toolu_cut', 'failed']]), j([...held]))
    } finally {
      connection.close()
      server.kill('SIGTERM')
      const until = Date.now() + 30_000
      while (server.exitCode === null && server.signalCode === null && Date.now() < until) await new Promise(done => setTimeout(done, 25))
      endProcessGroup(server)
      await api.close()
    }
  }

  section('D — a turn interrupted after it withdrew a reply: its end names no tool of the withdrawn reply as cut')
  {
    let retryOut: () => void = () => {}
    const retried = new Promise<void>(done => {
      retryOut = done
    })
    let heldRetry: ServerResponse | null = null
    let cutOnce = false
    const api = await startProvider(asked => {
      if (!asked.last.includes('CUT-PROMPT')) return say(asked, `AUX-${asked.n}.`)
      if (asked.stream && !cutOnce) {
        cutOnce = true
        return cut(asked, 'msg_cut', textWhole(0, 'CUT-REPLY-TEXT before the call.') + toolWhole(1, 'toolu_cut', 'Write', { file_path: join(arena.cwd, 'never-written.txt'), content: 'never' }), 2)
      }
      heldRetry = asked.res
      retryOut()
    })
    const arena = makeArena('interrupted', api.url)
    const ends = join(scratch, 'interrupted', 'turn-ends.jsonl')
    writeFileSync(join(arena.home, 'settings.json'), JSON.stringify({ events: { hooks: { 'turn.end': [{ name: 'end facts', run: `cat >> '${ends}'` }] } } }))
    try {
      const child = spawn(nodeBin!, [DIST, 'run', 'CUT-PROMPT then interrupted.', '--model', MODEL, '--format', 'rows'], { cwd: arena.cwd, env: arena.env })
      let stdout = ''
      child.stdout.on('data', chunk => (stdout += String(chunk)))
      child.stderr.on('data', () => {})
      const killer = setTimeout(() => child.kill('SIGKILL'), 90_000)
      const gone = new Promise<number | null>(done => child.on('close', exit => done(exit)))
      await Promise.race([retried, gone])
      await new Promise(done => setTimeout(done, 300))
      child.kill('SIGINT')
      const exit = await gone
      clearTimeout(killer)
      ;(heldRetry as ServerResponse | null)?.destroy()
      const rows = rowsOf(stdout)
      const outcome = rows.find(row => row.type === 'outcome')
      const ended = existsSync(ends) ? readFileSync(ends, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line) as { status?: string; cut?: { reason?: string; tools?: string[] } }) : []
      check('D: the turn withdrew the cut reply, asked again, and was interrupted with that request out', exit === 130 && outcome?.status === 'interrupted' && rows.some(row => row.type === 'tool_call' && row.call_id === 'toolu_cut'), `exit ${exit}; ${j(shape(rows))}`)
      check('D: its end fired once, interrupted, and names no tool as cut: the withdrawn call was not running', ended.length === 1 && ended[0]!.status === 'interrupted' && j(ended[0]!.cut?.tools) === j([]), j(ended))
    } finally {
      await api.close()
    }
  }
} finally {
  for (const server of servers) endProcessGroup(server)
  rmSync(scratch, { recursive: true, force: true })
}

console.log('\n============================================================')
console.log(failures === 0 ? ` ✅ WITHDRAWN CALLS ANSWERED (${checks} checks)` : ` ❌ ${failures} of ${checks} WITHDRAWN-CALL CHECK(S) FAILED`)
process.exit(failures === 0 ? 0 : 1)
