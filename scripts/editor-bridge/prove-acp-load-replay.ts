#!/usr/bin/env bun
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { type ChildProcess, spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, type ServerResponse } from 'node:http'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { PassThrough, Readable, Writable } from 'node:stream'
import { client, ndJsonStream, PROTOCOL_VERSION } from '@agentclientprotocol/sdk'
import { z } from 'zod/v4'
import { seedFirstRun } from '../lib/firstRunSeed.ts'
import { HANDOFF_ASK_MARK } from '../lib/fixtureApi.ts'
import { endProcessGroup, spawnInOwnGroup } from '../lib/processGroup.ts'

const DIST = join(process.cwd(), 'dist', 'mercury.mjs')
const nodeBin = Bun.which('node')
if (!existsSync(DIST) || nodeBin === null) {
  console.error('✗ dist/mercury.mjs or node is missing — run `bun run build.ts` first')
  process.exit(1)
}

const scratch = mkdtempSync(join(tmpdir(), 'acp-load-replay-'))
const project = join(scratch, 'project')
mkdirSync(project)
process.env.MERCURY_CONFIG_DIR = join(scratch, 'home')
process.env.MERCURY_CREDENTIAL_STORE = 'file'
process.env.ANTHROPIC_API_KEY = 'proof-key-ci-gate-not-a-real-key'
process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'
delete process.env.ANTHROPIC_BASE_URL
delete process.env.MERCURY_HOME
delete process.env.MERCURY_EFFORT_LEVEL

const { enableConfigs } = await import('../../src/utils/config.ts')
enableConfigs()
const bootstrap = await import('../../src/bootstrap/state.ts')
bootstrap.setOriginalCwd(project)
bootstrap.setProjectRoot(project)

const { ask } = await import('../../src/rows/turn.ts')
const { getEmptyToolPermissionContext } = await import('../../src/Tool.ts')
const { createFileStateCacheWithSizeLimit, READ_FILE_STATE_CACHE_SIZE } = await import('../../src/utils/fileStateCache.ts')
const { flushSessionStorage, getTranscriptPath, loadTranscriptFile, resetSessionFilePointer } = await import('../../src/utils/sessionStorage.ts')
const { getProjectDir } = await import('../../src/utils/sessionStorage/paths.ts')
const { encodeTranscriptLine } = await import('../../src/utils/sessionStorage/vnext.ts')
const { runAcpServer } = await import('../../src/services/acp/acpServer.ts')
import type { Message } from '../../src/types/message.ts'

const storage = getProjectDir(project)
mkdirSync(storage, { recursive: true })

let failures = 0
let checks = 0
function check(label: string, cond: boolean, detail = ''): void {
  checks++
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail.slice(0, 700)}` : ''}`)
}
function section(title: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + title)
}
const j = (value: unknown): string => JSON.stringify(value) ?? ''

const servers: ChildProcess[] = []
const guard = setTimeout(() => {
  console.log('\n❌ TIMEOUT — the ACP load replay proof exceeded 420s')
  for (const server of servers) endProcessGroup(server)
  process.exit(1)
}, 420_000)
guard.unref?.()

const MODEL = 'claude-opus-5-5'
const sse = (event: string, data: unknown): string => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`
const messageStart = (id: string, inputTokens = 25): string =>
  sse('message_start', { type: 'message_start', message: { id, type: 'message', role: 'assistant', model: MODEL, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: inputTokens, output_tokens: 1 } } })
const blockStart = (index: number, block: Record<string, unknown>): string => sse('content_block_start', { type: 'content_block_start', index, content_block: block })
const blockDelta = (index: number, delta: Record<string, unknown>): string => sse('content_block_delta', { type: 'content_block_delta', index, delta })
const blockStop = (index: number): string => sse('content_block_stop', { type: 'content_block_stop', index })
const textWhole = (index: number, text: string): string => blockStart(index, { type: 'text', text: '' }) + blockDelta(index, { type: 'text_delta', text }) + blockStop(index)
const toolWhole = (index: number, id: string, name: string, json: string): string =>
  blockStart(index, { type: 'tool_use', id, name, input: {} }) + blockDelta(index, { type: 'input_json_delta', partial_json: json }) + blockStop(index)
const messageEnd = (stop: string, outputTokens = 12): string =>
  sse('message_delta', { type: 'message_delta', delta: { stop_reason: stop, stop_sequence: null }, usage: { output_tokens: outputTokens } }) + sse('message_stop', { type: 'message_stop' })

type Ask = { n: number; stream: boolean; raw: string; last: string; tokens: number; res: ServerResponse }
type Reply = (ask: Ask) => void
type Provider = { url: string; asks: Ask[]; said: string[]; close: () => Promise<void> }
const providers: Provider[] = []
function say(provider: Pick<Provider, 'said'>, ask: Ask, text: string): void {
  provider.said.push(text)
  const outputTokens = Math.ceil(text.length / 4)
  if (!ask.stream) {
    ask.res.writeHead(200, { 'content-type': 'application/json' })
    ask.res.end(JSON.stringify({ id: `msg_said_${ask.n}`, type: 'message', role: 'assistant', model: MODEL, content: [{ type: 'text', text }], stop_reason: 'end_turn', stop_sequence: null, usage: { input_tokens: ask.tokens, output_tokens: outputTokens } }))
    return
  }
  ask.res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store' })
  ask.res.end(messageStart(`msg_said_${ask.n}`, ask.tokens) + textWhole(0, text) + messageEnd('end_turn', outputTokens))
}
async function startProvider(reply: (provider: Provider, ask: Ask) => void): Promise<Provider> {
  const provider: Provider = { url: '', asks: [], said: [], close: async () => {} }
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
      if (last.includes(HANDOFF_ASK_MARK)) {
        say({ said: [] }, { n: 0, stream: body.stream === true, raw, last, tokens, res }, 'The note for the next session.')
        return
      }
      const asked: Ask = { n: provider.asks.length + 1, stream: body.stream === true, raw, last, tokens, res }
      provider.asks.push(asked)
      reply(provider, asked)
    })
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  provider.url = `http://127.0.0.1:${(server.address() as { port: number }).port}`
  provider.close = () =>
    new Promise<void>(resolve => {
      server.closeAllConnections?.()
      server.close(() => resolve())
    })
  providers.push(provider)
  return provider
}

const WRITER = 'LoadReplayWriter'
const writer = {
  name: WRITER,
  isMcp: false,
  inputSchema: z.object({}).passthrough(),
  isConcurrencySafe: () => false,
  isReadOnly: () => false,
  checkPermissions: async () => ({ behavior: 'passthrough', message: 'ask the wrapper' }),
  description: async () => 'probe tool',
  prompt: async () => 'probe tool prompt',
  mapToolResultToToolResultBlockParam: (data: unknown, id: string) => ({ type: 'tool_result', content: typeof data === 'string' ? data : j(data), tool_use_id: id }),
  call: async () => ({ data: 'probe tool ran' }),
}
function makeStore(): { getAppState: () => Record<string, unknown>; setAppState: (f: (prev: Record<string, unknown>) => Record<string, unknown>) => void } {
  let state: Record<string, unknown> = {
    toolPermissionContext: { ...getEmptyToolPermissionContext(), mode: 'default' as const },
    sessionHooks: new Map(),
    tasks: {},
    todos: {},
    agentNameRegistry: new Map(),
    mcp: { clients: [], tools: [], commands: [], resources: {} },
    fileHistory: { snapshots: new Map(), fileVersions: new Map() },
    attribution: {},
  }
  return {
    getAppState: () => state,
    setAppState: f => {
      state = f(state)
    },
  }
}
type Row = Record<string, unknown> & { type: string }
type World = { conversation: Message[]; store: ReturnType<typeof makeStore>; readCache: ReturnType<typeof createFileStateCacheWithSizeLimit> }
const world = (): World => ({ conversation: [], store: makeStore(), readCache: createFileStateCacheWithSizeLimit(READ_FILE_STATE_CACHE_SIZE) })
async function turn(w: World, prompt: string): Promise<Row[]> {
  const rows: Row[] = []
  for await (const row of ask({
    commands: [],
    prompt,
    cwd: project,
    tools: [writer] as never,
    mcpClients: [],
    canUseTool: (async (_tool: unknown, input: unknown) => ({ behavior: 'allow', updatedInput: input })) as never,
    getAppState: w.store.getAppState as never,
    setAppState: w.store.setAppState as never,
    getReadFileCache: () => w.readCache,
    setReadFileCache: () => {},
    userSpecifiedModel: MODEL,
    abortController: new AbortController(),
    mutableMessages: w.conversation,
  })) {
    rows.push(row as Row)
  }
  return rows
}
async function freshSession(): Promise<string> {
  await flushSessionStorage()
  bootstrap.regenerateSessionId()
  await resetSessionFilePointer()
  return String(bootstrap.getSessionId())
}

const standIn = join(scratch, 'child.mjs')
writeFileSync(standIn, `
import { createInterface } from 'node:readline'
const arg = name => process.argv[process.argv.indexOf(name) + 1]
const sessionId = arg(process.argv.includes('--resume') ? '--resume' : '--session-id')
const answer = message => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...message }) + '\\n')
for await (const line of createInterface({ input: process.stdin })) {
  const frame = JSON.parse(line)
  if (frame.id === undefined) continue
  if (frame.method === 'initialize') { answer({ id: frame.id, result: { protocol: 1, runner: { version: '0', pid: process.pid }, session_id: sessionId } }); continue }
  answer({ id: frame.id, result: {} })
}
`)

type Update = Record<string, unknown> & { sessionUpdate?: string; toolCallId?: string; status?: string; content?: { text?: string } }
async function deadline<T>(label: string, work: Promise<T>): Promise<T> {
  let alarm: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        alarm = setTimeout(() => reject(new Error(`${label} did not settle`)), 60_000)
      }),
    ])
  } finally {
    clearTimeout(alarm)
  }
}
async function loadOverAcp(sessionId: string): Promise<Update[]> {
  const input = new PassThrough()
  const output = new PassThrough()
  const serving = runAcpServer({ input, output, entry: { node: process.execPath, script: standIn } })
  const updates: Update[] = []
  const connection = client({ name: 'load-replay-proof' })
    .onNotification('session/update', ctx => {
      updates.push(ctx.params.update as unknown as Update)
    })
    .connect(ndJsonStream(Writable.toWeb(input) as WritableStream<Uint8Array>, Readable.toWeb(output) as ReadableStream<Uint8Array>))
  try {
    await deadline('initialize', connection.agent.request('initialize', { protocolVersion: PROTOCOL_VERSION }))
    await deadline('session/load', connection.agent.request('session/load', { sessionId, cwd: project, mcpServers: [] }))
  } finally {
    input.end()
    await deadline('server close', serving)
    connection.close()
  }
  return updates
}
const textOf = (updates: Update[], kind: string): string[] => updates.filter(update => update.sessionUpdate === kind).map(update => String(update.content?.text ?? ''))
const callIdsOf = (updates: Update[]): string[] => updates.filter(update => update.sessionUpdate === 'tool_call').map(update => String(update.toolCallId))
const times = (haystack: string[], needle: string): number => haystack.filter(text => text.includes(needle)).length
const talk = (updates: Update[]): string[] =>
  updates.flatMap(update => {
    if (update.sessionUpdate === 'user_message_chunk') return [`user: ${String(update.content?.text ?? '')}`]
    if (update.sessionUpdate === 'agent_message_chunk') return [`agent: ${String(update.content?.text ?? '')}`]
    if (update.sessionUpdate === 'tool_call') return [`call: ${String(update.toolCallId)}`]
    if (update.sessionUpdate === 'tool_call_update') return [`result: ${String(update.toolCallId)} ${String(update.status)}`]
    return []
  })
const heads = (lines: string[]): string => j(lines.map(line => (line.length > 90 ? `${line.slice(0, 90)}… (${line.length})` : line)))

async function storedReplyRows(sessionId: string, messageId: string): Promise<Array<{ retracted?: boolean }>> {
  const loaded = await loadTranscriptFile(join(storage, `${sessionId}.jsonl`), { keepAllLeaves: true })
  return [...loaded.messages.values()].filter(row => row.type === 'assistant' && (row as { message?: { id?: unknown } }).message?.id === messageId) as Array<{ retracted?: boolean }>
}

function handRecord(sessionId: string, build: (h: { user: (content: unknown, extra?: Record<string, unknown>) => void; reply: (id: string, content: unknown[], stop: string | null, extra?: Record<string, unknown>) => void }) => void): void {
  const file = join(storage, `${sessionId}.jsonl`)
  let clock = Date.parse('2026-11-08T10:00:00.000Z')
  let parent: string | null = null
  let n = 0
  const rows: Record<string, unknown>[] = []
  const chained = (row: Record<string, unknown>): void => {
    const uuid = `00000000-0000-4000-8000-${String(100000000000 + ++n).slice(1)}`
    rows.push({ parentUuid: parent, isSidechain: false, cwd: project, sessionId, version: '1.0.8', gitBranch: 'main', timestamp: new Date((clock += 1000)).toISOString(), ...row, uuid })
    parent = uuid
  }
  build({
    user: (content, extra = {}) => chained({ type: 'user', message: { role: 'user', content }, ...extra }),
    reply: (id, content, stop, extra = {}) => chained({ type: 'assistant', requestId: `req_${id}`, message: { id, type: 'message', role: 'assistant', model: MODEL, stop_reason: stop, stop_sequence: null, content }, ...extra }),
  })
  writeFileSync(file, rows.map(row => encodeTranscriptLine(file, row).line).join(''))
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
function run(arena: Arena, args: string[]): Promise<{ exit: number | null; stdout: string; stderr: string }> {
  return new Promise(resolve => {
    const child = spawn(nodeBin!, [DIST, ...args], { cwd: arena.cwd, env: arena.env })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', chunk => (stdout += String(chunk)))
    child.stderr.on('data', chunk => (stderr += String(chunk)))
    const killer = setTimeout(() => child.kill('SIGKILL'), 90_000)
    child.on('close', exit => {
      clearTimeout(killer)
      resolve({ exit, stdout, stderr })
    })
  })
}
function transcriptOf(arena: Arena, sessionId: string): string {
  const stack = [join(arena.home, 'projects')]
  while (stack.length > 0) {
    const dir = stack.pop()!
    if (!existsSync(dir)) continue
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name)
      if (entry.isDirectory()) stack.push(path)
      else if (entry.name === `${sessionId}.jsonl`) return path
    }
  }
  return ''
}
type Editor = { request: (method: string, params: unknown) => Promise<Record<string, unknown>>; updates: Array<{ sessionId: string; update: Update }>; end: () => Promise<void> }
async function openEditor(arena: Arena, capabilities: Record<string, unknown> = {}): Promise<Editor> {
  const server = spawnInOwnGroup(nodeBin!, [DIST, 'acp'], { cwd: arena.cwd, stdio: ['pipe', 'pipe', 'pipe'], env: arena.env })
  servers.push(server)
  server.stderr!.on('data', () => {})
  const updates: Editor['updates'] = []
  const connection = client({ name: 'load-replay-proof' })
    .onNotification('session/update', ctx => {
      updates.push({ sessionId: String(ctx.params.sessionId), update: ctx.params.update as unknown as Update })
    })
    .onRequest('session/request_permission', () => ({ outcome: { outcome: 'selected' as const, optionId: 'allow' } }))
    .connect(ndJsonStream(Writable.toWeb(server.stdin!) as WritableStream<Uint8Array>, Readable.toWeb(server.stdout!) as ReadableStream<Uint8Array>))
  const request: Editor['request'] = (method, params) => deadline(method, (connection.agent.request as (method: string, params: unknown) => Promise<unknown>)(method, params)) as Promise<Record<string, unknown>>
  await request('initialize', { protocolVersion: PROTOCOL_VERSION, clientCapabilities: capabilities })
  return {
    request,
    updates,
    end: async () => {
      connection.close()
      server.kill('SIGTERM')
      const until = Date.now() + 30_000
      while (server.exitCode === null && server.signalCode === null && Date.now() < until) await new Promise(resolve => setTimeout(resolve, 25))
      endProcessGroup(server)
    },
  }
}
async function loadIn(arena: Arena, sessionId: string, capabilities: Record<string, unknown> = {}): Promise<Update[]> {
  const editor = await openEditor(arena, capabilities)
  try {
    await editor.request('session/load', { sessionId, cwd: arena.cwd, mcpServers: [] })
    return editor.updates.filter(entry => entry.sessionId === sessionId).map(entry => entry.update)
  } finally {
    await editor.end()
  }
}

console.log('============================================================')
console.log(' an ACP client that loads a session is shown the conversation the session holds')
console.log('============================================================')

try {
  section('L1 — the rows road withdrew a reply (its stream was cut after settled text and a whole call; one non-streamed completion answered): the record keeps it marked, the replay does not carry it')
  {
    const sessionId = await freshSession()
    const api = await startProvider((provider, asked) => {
      if (asked.n === 1) {
        asked.res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store' })
        asked.res.write(messageStart('msg_cut') + textWhole(0, 'CUT-REPLY-TEXT before the call.') + toolWhole(1, 'toolu_cut', WRITER, '{}') + blockStart(2, { type: 'text', text: '' }))
        setTimeout(() => asked.res.destroy(), 150)
        return
      }
      say(provider, asked, 'ONE-SHOT WHOLE REPLY.')
    })
    process.env.ANTHROPIC_BASE_URL = api.url
    try {
      const rows = await turn(world(), 'First prompt.')
      const outcome = rows.at(-1) as Row & { status?: string; answer?: string }
      check('L1: the turn withdrew the cut reply and reached its whole answer', outcome?.status === 'completed' && outcome?.answer === 'ONE-SHOT WHOLE REPLY.' && api.asks.length === 2, j({ status: outcome?.status, answer: outcome?.answer, requests: api.asks.length }))
      await flushSessionStorage()
      check('L1: the transcript is where a load of this session looks for it', getTranscriptPath() === join(storage, `${sessionId}.jsonl`), getTranscriptPath())
      const stored = await storedReplyRows(sessionId, 'msg_cut')
      check('L1: the record holds the withdrawn reply, every row of it marked retracted', stored.length > 0 && stored.every(row => row.retracted === true), j(stored.map(row => row.retracted ?? null)))
    } finally {
      await api.close()
      delete process.env.ANTHROPIC_BASE_URL
    }
    const updates = await loadOverAcp(sessionId)
    const agent = textOf(updates, 'agent_message_chunk')
    check('L1: the replay carries none of the withdrawn reply\'s words', times(agent, 'CUT-REPLY-TEXT') === 0, j(agent))
    check('L1: …and does not announce the withdrawn call', !callIdsOf(updates).includes('toolu_cut') && !updates.some(update => update.toolCallId === 'toolu_cut'), j(updates.filter(update => update.toolCallId !== undefined)))
    check('L1: the prompt is replayed once', times(textOf(updates, 'user_message_chunk'), 'First prompt.') === 1, j(textOf(updates, 'user_message_chunk')))
    check('L1: the reply that stood is replayed once', times(agent, 'ONE-SHOT WHOLE REPLY.') === 1, j(agent))
  }

  section('L2 — a record an earlier build wrote: two rows of a withdrawn reply on the chain, marked retracted')
  {
    const sessionId = 'facef00d-0000-4000-8000-0000000acb02'
    handRecord(sessionId, h => {
      h.user('Earlier prompt.')
      h.reply('msg_old_cut', [{ type: 'text', text: 'OLD-CUT-TEXT before the call.' }], null, { retracted: true })
      h.reply('msg_old_cut', [{ type: 'tool_use', id: 'toolu_old_cut', name: 'Bash', input: { command: 'echo never-ran' } }], null, { retracted: true })
      h.reply('msg_old_whole', [{ type: 'text', text: 'OLD WHOLE REPLY.' }], 'end_turn')
    })
    const updates = await loadOverAcp(sessionId)
    const agent = textOf(updates, 'agent_message_chunk')
    check('L2: the replay carries neither withdrawn row', times(agent, 'OLD-CUT-TEXT') === 0 && !updates.some(update => update.toolCallId === 'toolu_old_cut'), j(updates))
    check('L2: the prompt and the reply that stood are replayed, once each, in order', j(talk(updates)) === j(['user: Earlier prompt.', 'agent: OLD WHOLE REPLY.']), j(updates))
  }

  section('L3 — a session branched inside its record (run, run --resume, run --resume --replay-to the first reply): the load replays the line the session resumes with')
  {
    const api = await startProvider((provider, asked) => say(provider, asked, `BRANCH-REPLY-${asked.n}.`))
    const arena = makeArena('l3', api.url)
    const sessionId = 'facef00d-0000-4000-8000-0000000acb03'
    try {
      const first = await run(arena, ['run', 'PROMPT-A.', '--session-id', sessionId, '--format', 'rows'])
      const second = await run(arena, ['run', 'PROMPT-B abandoned.', '--resume', sessionId, '--format', 'rows'])
      const file = transcriptOf(arena, sessionId)
      const written = file === '' ? [] : [...(await loadTranscriptFile(file, { keepAllLeaves: true })).messages.values()]
      const firstReply = written.find(row => row.type === 'assistant')
      const third = await run(arena, ['run', 'PROMPT-C kept.', '--resume', sessionId, '--replay-to', String(firstReply?.uuid), '--format', 'rows'])
      const sent = api.asks.at(-1)?.raw ?? ''
      check(
        'L3: the three runs completed, one request each, and the third was sent the line it resumed: PROMPT-A, the first reply, PROMPT-C — not the abandoned prompt or its reply',
        first.exit === 0 && second.exit === 0 && third.exit === 0 && api.asks.length === 3 && sent.includes('PROMPT-A.') && sent.includes(api.said[0]!) && sent.includes('PROMPT-C kept.') && !sent.includes('PROMPT-B abandoned.') && !sent.includes(api.said[1]!),
        `exits ${first.exit} ${second.exit} ${third.exit}; requests ${api.asks.length}; ${third.stderr.slice(-300)}`,
      )
      const onDisk = file === '' ? '' : readFileSync(file, 'utf8')
      check('L3: the record still holds the abandoned prompt and its reply', onDisk.includes('PROMPT-B abandoned.') && onDisk.includes(api.said[1] ?? 'no second reply'), `${onDisk.length} bytes`)
      const replayed = await loadIn(arena, sessionId)
      check(
        'L3: the load replays that line and nothing else — the first prompt and its reply, the kept prompt and its reply',
        j(talk(replayed)) === j(['user: PROMPT-A.', `agent: ${api.said[0]}`, 'user: PROMPT-C kept.', `agent: ${api.said[2]}`]),
        heads(talk(replayed)),
      )
    } finally {
      await api.close()
    }
  }

  section('L4 — a result whose call the replay does not announce (a withdrawn call followed by a result row, a record written by hand) sends nothing; a call the replay announces is settled by its result')
  {
    const orphan = 'facef00d-0000-4000-8000-0000000acb04'
    handRecord(orphan, h => {
      h.user('Prompt with an early read.')
      h.reply('msg_er_cut', [{ type: 'text', text: 'EARLY-CUT-TEXT.' }], null, { retracted: true })
      h.reply('msg_er_cut', [{ type: 'tool_use', id: 'toolu_er_cut', name: 'Read', input: { file_path: '/tmp/x.txt' } }], null, { retracted: true })
      h.user([{ type: 'tool_result', tool_use_id: 'toolu_er_cut', content: 'early read body' }])
      h.reply('msg_er_whole', [{ type: 'text', text: 'EARLY WHOLE REPLY.' }], 'end_turn')
    })
    const orphaned = await loadOverAcp(orphan)
    check('L4: no update names the withdrawn call — neither its announcement nor a result for it', !orphaned.some(update => update.toolCallId === 'toolu_er_cut'), j(orphaned.filter(update => update.toolCallId !== undefined)))
    check('L4: the prompt and the reply that stood are replayed', j(talk(orphaned)) === j(['user: Prompt with an early read.', 'agent: EARLY WHOLE REPLY.']), heads(talk(orphaned)))
    const plain = 'facef00d-0000-4000-8000-0000000acb05'
    handRecord(plain, h => {
      h.user('Plain prompt.')
      h.reply('msg_p1', [{ type: 'text', text: 'Working on it.' }], null)
      h.reply('msg_p1', [{ type: 'tool_use', id: 'toolu_p1', name: 'Bash', input: { command: 'echo ran' } }], 'tool_use')
      h.user([{ type: 'tool_result', tool_use_id: 'toolu_p1', content: 'ran' }])
      h.reply('msg_p2', [{ type: 'text', text: 'PLAIN FINAL.' }], 'end_turn')
    })
    const settled = await loadOverAcp(plain)
    check('L4 control: a call the replay announces is followed by its result', j(talk(settled)) === j(['user: Plain prompt.', 'agent: Working on it.', 'call: toolu_p1', 'result: toolu_p1 completed', 'agent: PLAIN FINAL.']), heads(talk(settled)))
  }
} finally {
  for (const server of servers) endProcessGroup(server)
  for (const provider of providers) await provider.close()
  rmSync(scratch, { recursive: true, force: true })
}

console.log('\n============================================================')
console.log(failures === 0 ? ` ✅ ACP LOAD REPLAY GREEN (${checks} checks)` : ` ❌ ${failures} of ${checks} ACP LOAD REPLAY CHECK(S) FAILED`)
process.exit(failures === 0 ? 0 : 1)
