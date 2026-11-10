#!/usr/bin/env bun
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, type ServerResponse } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough, Readable, Writable } from 'node:stream'
import { client, ndJsonStream, PROTOCOL_VERSION } from '@agentclientprotocol/sdk'
import { z } from 'zod/v4'

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

const guard = setTimeout(() => {
  console.log('\n❌ TIMEOUT — the ACP load replay proof exceeded 180s')
  process.exit(1)
}, 180_000)
guard.unref?.()

const MODEL = 'claude-opus-5-5'
const sse = (event: string, data: unknown): string => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`
const messageStart = (id: string): string =>
  sse('message_start', { type: 'message_start', message: { id, type: 'message', role: 'assistant', model: MODEL, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 25, output_tokens: 1 } } })
const blockStart = (index: number, block: Record<string, unknown>): string => sse('content_block_start', { type: 'content_block_start', index, content_block: block })
const blockDelta = (index: number, delta: Record<string, unknown>): string => sse('content_block_delta', { type: 'content_block_delta', index, delta })
const blockStop = (index: number): string => sse('content_block_stop', { type: 'content_block_stop', index })
const textWhole = (index: number, text: string): string => blockStart(index, { type: 'text', text: '' }) + blockDelta(index, { type: 'text_delta', text }) + blockStop(index)
const toolWhole = (index: number, id: string, name: string, json: string): string =>
  blockStart(index, { type: 'tool_use', id, name, input: {} }) + blockDelta(index, { type: 'input_json_delta', partial_json: json }) + blockStop(index)
const messageEnd = (stop: string): string =>
  sse('message_delta', { type: 'message_delta', delta: { stop_reason: stop, stop_sequence: null }, usage: { output_tokens: 12 } }) + sse('message_stop', { type: 'message_stop' })

type Reply = (n: number, res: ServerResponse, body: { stream?: unknown }) => void
async function startProvider(reply: Reply): Promise<{ url: string; requests: () => number; close: () => Promise<void> }> {
  let count = 0
  const server = createServer((req, res) => {
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
      let body: { stream?: unknown } = {}
      try {
        body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as typeof body
      } catch {
        body = {}
      }
      reply(++count, res, body)
    })
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as { port: number }).port
  return {
    url: `http://127.0.0.1:${port}`,
    requests: () => count,
    close: () =>
      new Promise<void>(resolve => {
        server.closeAllConnections?.()
        server.close(() => resolve())
      }),
  }
}
function wholeReply(n: number, res: ServerResponse, body: { stream?: unknown }, text: string): void {
  if (body.stream !== true) {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ id: `msg_whole_${n}`, type: 'message', role: 'assistant', model: MODEL, content: [{ type: 'text', text }], stop_reason: 'end_turn', stop_sequence: null, usage: { input_tokens: 25, output_tokens: 12 } }))
    return
  }
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store' })
  res.end(messageStart(`msg_whole_${n}`) + textWhole(0, text) + messageEnd('end_turn'))
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

type Update = Record<string, unknown> & { sessionUpdate?: string; toolCallId?: string; content?: { text?: string } }
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

async function storedReplyRows(sessionId: string, messageId: string): Promise<Array<{ retracted?: boolean }>> {
  const loaded = await loadTranscriptFile(join(storage, `${sessionId}.jsonl`), { keepAllLeaves: true })
  return [...loaded.messages.values()].filter(row => row.type === 'assistant' && (row as { message?: { id?: unknown } }).message?.id === messageId) as Array<{ retracted?: boolean }>
}

console.log('============================================================')
console.log(' an ACP client that loads a session is shown the conversation the session holds')
console.log('============================================================')

try {
  section('L1 — the rows road withdrew a reply (its stream was cut after settled text and a whole call; one non-streamed completion answered): the record keeps it marked, the replay does not carry it')
  {
    const sessionId = await freshSession()
    const api = await startProvider((n, res, body) => {
      if (n === 1) {
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store' })
        res.write(messageStart('msg_cut') + textWhole(0, 'CUT-REPLY-TEXT before the call.') + toolWhole(1, 'toolu_cut', WRITER, '{}') + blockStart(2, { type: 'text', text: '' }))
        setTimeout(() => res.destroy(), 150)
        return
      }
      wholeReply(n, res, body, 'ONE-SHOT WHOLE REPLY.')
    })
    process.env.ANTHROPIC_BASE_URL = api.url
    try {
      const rows = await turn(world(), 'First prompt.')
      const outcome = rows.at(-1) as Row & { status?: string; answer?: string }
      check('L1: the turn withdrew the cut reply and reached its whole answer', outcome?.status === 'completed' && outcome?.answer === 'ONE-SHOT WHOLE REPLY.' && api.requests() === 2, j({ status: outcome?.status, answer: outcome?.answer, requests: api.requests() }))
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
    const file = join(storage, `${sessionId}.jsonl`)
    let clock = Date.parse('2026-11-08T10:00:00.000Z')
    let parent: string | null = null
    const uid = (n: number): string => `00000000-0000-4000-8000-${String(100000000000 + n).slice(1)}`
    const chained = (row: Record<string, unknown>): Record<string, unknown> => {
      const out = { parentUuid: parent, isSidechain: false, cwd: project, sessionId, version: '1.0.8', gitBranch: 'main', timestamp: new Date((clock += 1000)).toISOString(), ...row }
      parent = row.uuid as string
      return out
    }
    const reply = (uuid: string, id: string, content: unknown[], stop: string | null, extra: Record<string, unknown> = {}): Record<string, unknown> =>
      chained({ uuid, type: 'assistant', requestId: `req_${id}`, message: { id, type: 'message', role: 'assistant', model: MODEL, stop_reason: stop, stop_sequence: null, content }, ...extra })
    const rows = [
      chained({ uuid: uid(1), type: 'user', message: { role: 'user', content: 'Earlier prompt.' } }),
      reply(uid(2), 'msg_old_cut', [{ type: 'text', text: 'OLD-CUT-TEXT before the call.' }], null, { retracted: true }),
      reply(uid(3), 'msg_old_cut', [{ type: 'tool_use', id: 'toolu_old_cut', name: 'Bash', input: { command: 'echo never-ran' } }], null, { retracted: true }),
      reply(uid(4), 'msg_old_whole', [{ type: 'text', text: 'OLD WHOLE REPLY.' }], 'end_turn'),
    ]
    writeFileSync(file, rows.map(row => encodeTranscriptLine(file, row).line).join(''))
    const updates = await loadOverAcp(sessionId)
    const agent = textOf(updates, 'agent_message_chunk')
    check('L2: the replay carries neither withdrawn row', times(agent, 'OLD-CUT-TEXT') === 0 && !updates.some(update => update.toolCallId === 'toolu_old_cut'), j(updates))
    check('L2: the prompt and the reply that stood are replayed, once each, in order', j(updates.map(update => [update.sessionUpdate, update.content?.text])) === j([['user_message_chunk', 'Earlier prompt.'], ['agent_message_chunk', 'OLD WHOLE REPLY.']]), j(updates))
  }
} finally {
  rmSync(scratch, { recursive: true, force: true })
}

console.log('\n============================================================')
console.log(failures === 0 ? ` ✅ ACP LOAD REPLAY GREEN (${checks} checks)` : ` ❌ ${failures} of ${checks} ACP LOAD REPLAY CHECK(S) FAILED`)
process.exit(failures === 0 ? 0 : 1)
