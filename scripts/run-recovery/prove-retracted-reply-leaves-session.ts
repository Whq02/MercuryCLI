#!/usr/bin/env bun
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { createServer, type ServerResponse } from 'node:http'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

process.env.MERCURY_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'retracted-reply-config-'))
process.env.ANTHROPIC_API_KEY = 'fixture-key'
delete process.env.ANTHROPIC_BASE_URL
delete process.env.MERCURY_EFFORT_LEVEL

import { z } from 'zod/v4'

const ROOT = join(import.meta.dir, '..', '..')
const DIST = join(ROOT, 'dist', 'mercury.mjs')
const nodeBin = Bun.which('node')
if (!existsSync(DIST) || !nodeBin) {
  console.log(!existsSync(DIST) ? '❌ dist/mercury.mjs absent — build first (the pooled gate prebuilds it)' : '❌ no node binary on PATH')
  process.exit(1)
}

const { enableConfigs } = await import('../../src/utils/config.ts')
enableConfigs()
const bootstrap = await import('../../src/bootstrap/state.ts')
const projDir = mkdtempSync(join(tmpdir(), 'retracted-reply-proj-'))
bootstrap.setOriginalCwd(projDir)
bootstrap.setProjectRoot(projDir)

const { ask } = await import('../../src/rows/turn.ts')
const { getEmptyToolPermissionContext } = await import('../../src/Tool.ts')
const { createFileStateCacheWithSizeLimit, READ_FILE_STATE_CACHE_SIZE } = await import('../../src/utils/fileStateCache.ts')
const { flushSessionStorage, getTranscriptPath, loadTranscriptFile, resetSessionFilePointer } = await import('../../src/utils/sessionStorage.ts')
const { loadConversationForResume } = await import('../../src/utils/conversationRecovery.ts')
const { normalizeMessagesForAPI } = await import('../../src/utils/messages.ts')
const { encodeTranscriptLine } = await import('../../src/utils/sessionStorage/vnext.ts')
import type { Message } from '../../src/types/message.ts'

let failures = 0
let checks = 0
function check(label: string, cond: boolean, detail = ''): void {
  checks++
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail.slice(0, 600)}` : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t)
}
const j = (v: unknown): string => JSON.stringify(v) ?? ''

const guard = setTimeout(() => {
  console.log('\n❌ TIMEOUT — the retracted-reply proof exceeded 240s')
  process.exit(1)
}, 240_000)
guard.unref?.()

const MODEL = 'claude-opus-5-5'
const NO_RESULT_WORDS = 'No result was recorded for this tool call'
const sse = (event: string, data: unknown): string => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`
const messageStart = (id: string, model = MODEL): string =>
  sse('message_start', { type: 'message_start', message: { id, type: 'message', role: 'assistant', model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 25, output_tokens: 1 } } })
const blockStart = (index: number, block: Record<string, unknown>): string => sse('content_block_start', { type: 'content_block_start', index, content_block: block })
const blockDelta = (index: number, delta: Record<string, unknown>): string => sse('content_block_delta', { type: 'content_block_delta', index, delta })
const blockStop = (index: number): string => sse('content_block_stop', { type: 'content_block_stop', index })
const textOpen = (index: number, text: string): string => blockStart(index, { type: 'text', text: '' }) + blockDelta(index, { type: 'text_delta', text })
const textWhole = (index: number, text: string): string => textOpen(index, text) + blockStop(index)
const toolWhole = (index: number, id: string, name: string, json: string): string =>
  blockStart(index, { type: 'tool_use', id, name, input: {} }) + blockDelta(index, { type: 'input_json_delta', partial_json: json }) + blockStop(index)
const messageEnd = (stop: string, output = 12): string =>
  sse('message_delta', { type: 'message_delta', delta: { stop_reason: stop, stop_sequence: null }, usage: { output_tokens: output } }) + sse('message_stop', { type: 'message_stop' })

type Wire = { stream: boolean; messages: Array<{ role: string; content: unknown }> }
type Reply = (n: number, res: ServerResponse, body: { stream?: unknown }) => void

async function startLoopback(reply: Reply): Promise<{ url: string; wires: Wire[]; close: () => Promise<void> }> {
  const wires: Wire[] = []
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
      let body: { stream?: unknown; messages?: Wire['messages'] } = {}
      try {
        body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as typeof body
      } catch {
        body = {}
      }
      wires.push({ stream: body.stream === true, messages: body.messages ?? [] })
      reply(wires.length, res, body)
    })
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as { port: number }).port
  return {
    url: `http://127.0.0.1:${port}`,
    wires,
    close: () =>
      new Promise<void>(resolve => {
        server.closeAllConnections?.()
        server.close(() => resolve())
      }),
  }
}

const sseHead = (res: ServerResponse): void => {
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store' })
}
function wholeReply(n: number, res: ServerResponse, body: { stream?: unknown }, text: string, model = MODEL): void {
  if (body.stream !== true) {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ id: `msg_whole_${n}`, type: 'message', role: 'assistant', model, content: [{ type: 'text', text }], stop_reason: 'end_turn', stop_sequence: null, usage: { input_tokens: 25, output_tokens: 12 } }))
    return
  }
  sseHead(res)
  res.end(messageStart(`msg_whole_${n}`, model) + textWhole(0, text) + messageEnd('end_turn'))
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

const WRITER = 'RetractedReplyWriter'
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

type Row = Record<string, unknown> & { type: string }
type World = { model: string; conversation: Message[]; store: ReturnType<typeof makeStore>; readCache: ReturnType<typeof createFileStateCacheWithSizeLimit> }
const world = (model = MODEL): World => ({ model, conversation: [], store: makeStore(), readCache: createFileStateCacheWithSizeLimit(READ_FILE_STATE_CACHE_SIZE) })

async function turn(w: World, prompt: string): Promise<Row[]> {
  const rows: Row[] = []
  for await (const row of ask({
    commands: [],
    prompt,
    cwd: projDir,
    tools: [writer] as never,
    mcpClients: [],
    canUseTool: (async (_tool: unknown, input: unknown) => ({ behavior: 'allow', updatedInput: input })) as never,
    getAppState: w.store.getAppState as never,
    setAppState: w.store.setAppState as never,
    getReadFileCache: () => w.readCache,
    setReadFileCache: () => {},
    userSpecifiedModel: w.model,
    abortController: new AbortController(),
    mutableMessages: w.conversation,
  })) {
    rows.push(row as Row)
  }
  return rows
}

const blocksOf = (content: unknown): Array<Record<string, unknown>> => (Array.isArray(content) ? (content as Array<Record<string, unknown>>) : [{ type: 'text', text: String(content ?? '') }])
function requestView(messages: readonly Message[]): string {
  const view = normalizeMessagesForAPI([...messages], [writer] as never) as Array<{ type: string; message: { role?: string; content: unknown } }>
  return j(view.map(row => ({ role: row.type, content: blocksOf(row.message.content).map(block => (block.type === 'text' ? { text: block.text } : block.type === 'tool_use' ? { call: block.id, name: block.name } : block.type === 'tool_result' ? { result: block.tool_use_id, content: block.content } : { type: block.type })) })))
}
const wireText = (wire: Wire | undefined): string => j(wire?.messages ?? [])
const conversationText = (messages: readonly Message[]): string => j(messages.filter(row => row.type === 'assistant' || row.type === 'user').map(row => (row.type === 'assistant' || row.type === 'user' ? row.message.content : null)))
const outcomeOf = (rows: Row[]): Row & { status?: string; answer?: string } => rows.at(-1) as Row & { status?: string; answer?: string }

async function storedRowsOf(messageId: string): Promise<Array<{ retracted?: boolean }>> {
  await flushSessionStorage()
  const loaded = await loadTranscriptFile(getTranscriptPath(), { keepAllLeaves: true })
  return [...loaded.messages.values()].filter(row => row.type === 'assistant' && (row as { message?: { id?: unknown } }).message?.id === messageId) as Array<{ retracted?: boolean }>
}
async function storedRowsSaying(words: string): Promise<Array<{ retracted?: boolean }>> {
  await flushSessionStorage()
  const loaded = await loadTranscriptFile(getTranscriptPath(), { keepAllLeaves: true })
  return [...loaded.messages.values()].filter(row => row.type === 'assistant' && j((row as { message?: { content?: unknown } }).message?.content).includes(words)) as Array<{ retracted?: boolean }>
}
async function resumedView(): Promise<string> {
  await flushSessionStorage()
  const loaded = await loadConversationForResume(String(bootstrap.getSessionId()), getTranscriptPath())
  if (!loaded) throw new Error('the resume loader returned nothing')
  return requestView(loaded.messages as Message[])
}

async function freshSession(): Promise<void> {
  await flushSessionStorage()
  bootstrap.regenerateSessionId()
  await resetSessionFilePointer()
}

type Scene = {
  withdrawnTexts: string[]
  withdrawnMessageId: string
  withdrawnCallIds: string[]
  standing: string
  first: Reply
}

async function retractionScene(name: string, scene: Scene, opts: { persistent: boolean }): Promise<void> {
  await freshSession()
  bootstrap.setSessionPersistenceDisabled(!opts.persistent)
  let turnNumber = 1
  const api = await startLoopback((n, res, body) => {
    if (turnNumber === 1) return scene.first(n, res, body)
    wholeReply(n, res, body, `${name} SECOND TURN REPLY.`)
  })
  process.env.ANTHROPIC_BASE_URL = api.url
  const w = world()
  try {
    const first = await turn(w, 'First prompt.')
    check(`${name}: the turn withdrew a reply and still reached its whole answer`, outcomeOf(first)?.status === 'completed' && String(outcomeOf(first)?.answer ?? '').includes(scene.standing), j({ status: outcomeOf(first)?.status, answer: outcomeOf(first)?.answer }))
    const held = conversationText(w.conversation)
    check(`${name}: the session's conversation holds none of the withdrawn reply's words`, scene.withdrawnTexts.every(text => !held.includes(text)), held)
    check(`${name}: …and no row of the withdrawn reply (by its message id)`, !w.conversation.some(row => row.type === 'assistant' && row.message.id === scene.withdrawnMessageId), j(w.conversation.filter(row => row.type === 'assistant').map(row => (row.type === 'assistant' ? row.message.id : null))))
    check(`${name}: …and neither a withdrawn call nor a result that names one`, scene.withdrawnCallIds.every(id => !held.includes(id)), held)
    const liveView = requestView(w.conversation)
    if (opts.persistent) {
      const stored = await storedRowsOf(scene.withdrawnMessageId)
      check(`${name}: the transcript still records the withdrawn reply, every row of it marked retracted`, stored.length > 0 && stored.every(row => row.retracted === true), j(stored.map(row => row.retracted ?? null)))
      const resumed = await resumedView()
      check(`${name}: a conversation resumed from that transcript has the request view the live one has, byte for byte`, resumed === liveView, `live ${liveView} resumed ${resumed}`)
    } else {
      check(`${name}: nothing was written (the run keeps no record)`, !existsSync(getTranscriptPath()), getTranscriptPath())
    }
    turnNumber = 2
    const before = api.wires.length
    const second = await turn(w, 'Second prompt.')
    const sent = wireText(api.wires[before])
    check(`${name}: the next turn of the same process completes`, outcomeOf(second)?.status === 'completed', j(outcomeOf(second)))
    check(`${name}: its request carries none of the withdrawn reply's words`, scene.withdrawnTexts.every(text => !sent.includes(text)), sent)
    check(`${name}: …no withdrawn call, and no made-up result for one`, scene.withdrawnCallIds.every(id => !sent.includes(id)) && !sent.includes(NO_RESULT_WORDS), sent)
    check(`${name}: …and the reply that stood, once`, sent.split(scene.standing).length - 1 === 1, sent)
    if (opts.persistent) {
      const resumedAfter = await resumedView()
      check(`${name}: after the second turn the transcript resumes to what the live session holds (no row repeated, none skipped around the withdrawn one)`, resumedAfter === requestView(w.conversation), `live ${requestView(w.conversation)} resumed ${resumedAfter}`)
    }
  } finally {
    bootstrap.setSessionPersistenceDisabled(false)
    await api.close()
  }
}

console.log('============================================================')
console.log(' a reply the turn withdrew is in the record, and in no request')
console.log('============================================================')

const cutAfterCall: Scene = {
  withdrawnTexts: ['CUT-REPLY-TEXT before the call.'],
  withdrawnMessageId: 'msg_cut',
  withdrawnCallIds: ['toolu_cut'],
  standing: 'ONE-SHOT WHOLE REPLY.',
  first: (n, res, body) => {
    if (n === 1) {
      sseHead(res)
      res.write(messageStart('msg_cut') + textWhole(0, 'CUT-REPLY-TEXT before the call.') + toolWhole(1, 'toolu_cut', WRITER, '{}') + blockStart(2, { type: 'text', text: '' }))
      setTimeout(() => res.destroy(), 150)
      return
    }
    wholeReply(n, res, body, 'ONE-SHOT WHOLE REPLY.')
  },
}

section('R1 — the one-shot retry: text and a whole writing call settle, the socket is cut, one non-streamed completion answers')
await retractionScene('R1', cutAfterCall, { persistent: true })

section('R2 — the cut-tool-call re-ask (the chat road, where the cap can be raised): the reply ends at the output ceiling inside a call\'s input and is asked again with more room')
{
  const { startOverflowFixture } = await import('../compact/overflowFixture.ts')
  const fixture = await startOverflowFixture()
  const before = { ...process.env }
  Object.assign(process.env, fixture.env)
  await freshSession()
  const REFUSAL_WORDS = 'the provider emitted a malformed tool call'
  fixture.script([
    { calls: [{ id: 'call_ceiling', name: WRITER, args: '{"content": "half of a fi' }], finishReason: 'length', usage: { input: 8, output: 4096 } },
    { text: 'ROOMIER WHOLE REPLY.' },
    { text: 'R2 SECOND TURN REPLY.' },
  ])
  const w = world('compat/fixture-model')
  try {
    const first = await turn(w, 'First prompt.')
    const notices = first.filter(row => row.type === 'notice').map(row => String(row.text ?? ''))
    check('R2: the turn re-asked with more room and reached its whole answer', notices.some(text => text.includes('re-asking with room for')) && outcomeOf(first)?.status === 'completed' && outcomeOf(first)?.answer === 'ROOMIER WHOLE REPLY.', j({ notices, status: outcomeOf(first)?.status, answer: outcomeOf(first)?.answer }))
    const held = conversationText(w.conversation)
    check('R2: the session\'s conversation holds nothing of the withdrawn reply (its refused-call note is gone)', !held.includes(REFUSAL_WORDS) && !held.includes('call_ceiling'), held)
    const stored = await storedRowsSaying(REFUSAL_WORDS)
    check('R2: the transcript still records the withdrawn note, marked retracted', stored.length === 1 && stored[0]?.retracted === true, j(stored.map(row => row.retracted ?? null)))
    const liveView = requestView(w.conversation)
    const resumed = await resumedView()
    check('R2: a conversation resumed from that transcript has the request view the live one has, byte for byte', resumed === liveView, `live ${liveView} resumed ${resumed}`)
    const second = await turn(w, 'Second prompt.')
    const sent = j(fixture.captured.at(-1)?.body.messages ?? [])
    check('R2: the next turn completes and its request carries nothing of the withdrawn reply', outcomeOf(second)?.status === 'completed' && !sent.includes(REFUSAL_WORDS) && !sent.includes('call_ceiling'), sent)
    check('R2: …and the reply that stood, once', sent.split('ROOMIER WHOLE REPLY.').length - 1 === 1, sent)
    const resumedAfter = await resumedView()
    check('R2: after the second turn the transcript resumes to what the live session holds', resumedAfter === requestView(w.conversation), `live ${requestView(w.conversation)} resumed ${resumedAfter}`)
  } finally {
    await fixture.close()
    for (const key of Object.keys(fixture.env)) {
      if (before[key] === undefined) delete process.env[key]
      else process.env[key] = before[key]
    }
  }
}

const CHANT = 'The very same sentence comes around again, word for word. '
section('R3 — the chant trim: a reply that repeats one sentence is replaced by its trimmed copy')
{
  await freshSession()
  let turnNumber = 1
  const api = await startLoopback((n, res, body) => {
    if (turnNumber === 1 && n === 1) {
      sseHead(res)
      res.end(messageStart('msg_chant') + textWhole(0, `CHANT-INTRO stands.\n${CHANT.repeat(16)}`) + messageEnd('end_turn'))
      return
    }
    wholeReply(n, res, body, turnNumber === 1 ? 'PAST THE LOOP REPLY.' : 'R3 SECOND TURN REPLY.')
  })
  process.env.ANTHROPIC_BASE_URL = api.url
  const w = world()
  try {
    const first = await turn(w, 'First prompt.')
    check('R3: the turn went past the loop', outcomeOf(first)?.status === 'completed' && outcomeOf(first)?.answer === 'PAST THE LOOP REPLY.', j({ status: outcomeOf(first)?.status, answer: outcomeOf(first)?.answer }))
    const chants = (text: string): number => text.split(CHANT.trim()).length - 1
    const held = conversationText(w.conversation)
    check('R3: the session holds the trimmed copy alone (the sentence at most twice, the omission mark once)', chants(held) <= 2 && held.split('[repeated text omitted]').length - 1 === 1, `the sentence ${chants(held)} time(s): ${held.slice(0, 300)}`)
    check('R3: one row carries the chanted reply\'s message id', w.conversation.filter(row => row.type === 'assistant' && row.message.id === 'msg_chant').length === 1, j(w.conversation.filter(row => row.type === 'assistant').map(row => (row.type === 'assistant' ? row.message.id : null))))
    const stored = await storedRowsOf('msg_chant')
    check('R3: the transcript records both: the withdrawn original marked retracted, the trimmed copy unmarked', stored.filter(row => row.retracted === true).length === 1 && stored.filter(row => row.retracted !== true).length === 1, j(stored.map(row => row.retracted ?? null)))
    const liveView = requestView(w.conversation)
    const resumed = await resumedView()
    check('R3: a conversation resumed from that transcript has the request view the live one has, byte for byte', resumed === liveView, `live ${liveView.slice(0, 300)} resumed ${resumed.slice(0, 300)}`)
    turnNumber = 2
    const before = api.wires.length
    const second = await turn(w, 'Second prompt.')
    const sent = wireText(api.wires[before])
    check('R3: the next turn completes and its request carries the sentence at most twice', outcomeOf(second)?.status === 'completed' && chants(sent) <= 2, `the sentence ${chants(sent)} time(s)`)
  } finally {
    await api.close()
  }
}

section('R4 — the same one-shot retry in a run that keeps no record (nothing recorded, so nothing to step back over)')
await retractionScene('R4', cutAfterCall, { persistent: false })

section('R5 — the built bundle: a stream cut after a settled paragraph is asked again (the reissue and the one-shot retry withdraw the cut reply through one door); a second process resumes the session')
{
  const home = mkdtempSync(join(tmpdir(), 'retracted-reply-home-'))
  const cwd = mkdtempSync(join(tmpdir(), 'retracted-reply-cwd-'))
  mkdirSync(join(home, '.mercury'), { recursive: true })
  let phase = 1
  const api = await startLoopback((n, res, body) => {
    if (phase === 1 && n === 1) {
      sseHead(res)
      res.write(messageStart('msg_reissue', 'claude-opus-4-8') + textWhole(0, 'REISSUE-PARAGRAPH-ONE that settled.') + textOpen(1, 'half of paragraph two'))
      setTimeout(() => res.destroy(), 200)
      return
    }
    wholeReply(n, res, body, phase === 1 ? 'REISSUED WHOLE REPLY.' : 'SECOND PROCESS REPLY.', 'claude-opus-4-8')
  })
  const env = {
    HOME: home,
    PATH: `/usr/bin:/bin:${dirname(nodeBin)}`,
    TERM: 'dumb',
    MERCURY_CONFIG_DIR: join(home, '.mercury'),
    ANTHROPIC_BASE_URL: api.url,
    ANTHROPIC_API_KEY: 'fixture-key-000',
    MERCURY_DAEMON_DIR: join(home, 'daemon'),
    MERCURY_LOCAL_PROBE_TARGETS: 'none',
    MERCURY_VERIFY_EVIDENCE: '0',
  }
  const run = (args: string[]): Promise<{ exit: number | null; stdout: string }> =>
    new Promise(resolve => {
      const child = spawn(nodeBin, [DIST, ...args], { cwd, env })
      let stdout = ''
      child.stdout.on('data', chunk => (stdout += String(chunk)))
      child.stderr.on('data', () => {})
      const killer = setTimeout(() => child.kill('SIGKILL'), 90_000)
      child.on('close', exit => {
        clearTimeout(killer)
        resolve({ exit, stdout })
      })
    })
  const sid = 'facef00d-0000-4000-8000-00000000c1a0'
  try {
    const first = await run(['run', 'First prompt.', '--model', 'claude-opus-4-8', '--session-id', sid, '--format', 'rows'])
    check('R5: the first process answered with the second request\'s reply', first.exit === 0 && api.wires.length === 2 && first.stdout.includes('REISSUED WHOLE REPLY.'), `exit=${first.exit} requests=${api.wires.length} ${first.stdout.slice(-300)}`)
    check('R5: the cut paragraph was withdrawn from its answer', !first.stdout.includes('"answer":"REISSUE-PARAGRAPH-ONE'), first.stdout.slice(-300))
    phase = 2
    const before = api.wires.length
    const second = await run(['run', 'Second prompt.', '--model', 'claude-opus-4-8', '--resume', sid, '--format', 'rows'])
    const sent = wireText(api.wires[before])
    check('R5: the resumed process answered', second.exit === 0 && second.stdout.includes('SECOND PROCESS REPLY.'), `exit=${second.exit}`)
    check('R5: its request carries none of the withdrawn reply', !sent.includes('REISSUE-PARAGRAPH-ONE'), sent.slice(0, 600))
    check('R5: …and the reply that stood, once', sent.split('REISSUED WHOLE REPLY.').length - 1 === 1, sent.slice(0, 600))
    const assistantTurns = (api.wires[before]?.messages ?? []).filter(message => message.role === 'assistant').length
    check('R5: one assistant message stands between the two prompts', assistantTurns === 1, String(assistantTurns))
  } finally {
    await api.close()
  }
}

section('R6 — a transcript an earlier build wrote: two rows of a withdrawn reply on the chain, marked retracted')
{
  const scratch = mkdtempSync(join(tmpdir(), 'retracted-reply-old-'))
  const sessionId = 'facef00d-0000-4000-8000-00000000c1b0'
  const file = join(scratch, `${sessionId}.jsonl`)
  let clock = Date.parse('2026-11-08T10:00:00.000Z')
  let parent: string | null = null
  const uid = (n: number): string => `00000000-0000-4000-8000-${String(100000000000 + n).slice(1)}`
  const chained = (row: Record<string, unknown>): Record<string, unknown> => {
    const out = { parentUuid: parent, isSidechain: false, cwd: scratch, sessionId, version: '1.0.8', gitBranch: 'main', timestamp: new Date((clock += 1000)).toISOString(), ...row }
    parent = row.uuid as string
    return out
  }
  const reply = (uuid: string, id: string, content: unknown[], stop: string | null, extra: Record<string, unknown> = {}): Record<string, unknown> =>
    chained({ uuid, type: 'assistant', requestId: `req_${id}`, message: { id, type: 'message', role: 'assistant', model: MODEL, stop_reason: stop, stop_sequence: null, content }, ...extra })
  const rows = [
    chained({ uuid: uid(1), type: 'user', message: { role: 'user', content: 'First prompt.' } }),
    reply(uid(2), 'msg_cut', [{ type: 'text', text: 'CUT-REPLY-TEXT before the call.' }], null, { retracted: true }),
    reply(uid(3), 'msg_cut', [{ type: 'tool_use', id: 'toolu_cut', name: 'Bash', input: { command: 'echo never-ran' } }], null, { retracted: true }),
    reply(uid(4), 'msg_oneshot', [{ type: 'text', text: 'ONE-SHOT WHOLE REPLY.' }], 'end_turn'),
  ]
  writeFileSync(file, rows.map(row => encodeTranscriptLine(file, row).line).join(''))
  const loaded = await loadConversationForResume(sessionId, file)
  const messages = (loaded?.messages ?? []) as Message[]
  const conversation = messages.filter(row => row.type === 'assistant' || row.type === 'user')
  const chain = [...(await loadTranscriptFile(file, { keepAllLeaves: true })).messages.values()].filter(row => row.type === 'assistant' || row.type === 'user') as unknown as Message[]
  check('R6: the transcript\'s chain holds four rows and two of them are marked retracted', chain.length === 4 && chain.filter(row => (row as { retracted?: unknown }).retracted === true).length === 2, j(chain.map(row => [row.uuid, (row as { retracted?: unknown }).retracted ?? null])))
  const dropped = chain.filter(row => !conversation.some(kept => kept.uuid === row.uuid)).map(row => row.uuid)
  check('R6: the resumed list drops two rows, exactly the marked ones (an earlier build kept the marked text and dropped only the marked call, as unanswered)', j(dropped) === j([uid(2), uid(3)]), j(dropped))
  check('R6: what stays is the prompt and the reply that stood, in order, each the chain\'s own row word for word', j(conversation.map(row => row.uuid)) === j([uid(1), uid(4)]) && conversation.every(kept => j((kept as { message?: unknown }).message) === j((chain.find(row => row.uuid === kept.uuid) as { message?: unknown } | undefined)?.message)), j(conversation.map(row => row.uuid)))
  check('R6: no loaded row is marked retracted', !messages.some(row => (row as { retracted?: unknown }).retracted === true))
  check('R6: the turn reads as finished (no continuation sentence is added for a withdrawn reply)', loaded?.turnInterruptionState.kind === 'none', j(loaded?.turnInterruptionState))
}

console.log('\n============================================================')
console.log(failures === 0 ? ` ✅ RETRACTED REPLY GREEN (${checks} checks)` : ` ❌ ${failures} of ${checks} RETRACTED REPLY CHECK(S) FAILED`)
process.exit(failures === 0 ? 0 : 1)
