#!/usr/bin/env bun
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0', PACKAGE_URL: 'https://github.com/example/mercury' }

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.MERCURY_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'local-empty-reply-'))
process.env.MERCURY_DAEMON_DIR = mkdtempSync(join(tmpdir(), 'local-empty-reply-daemon-'))
process.env.MERCURY_CREDENTIAL_STORE = 'file'
process.env.ANTHROPIC_API_KEY = 'sk-ant-fixture-not-a-real-key'
for (const k of ['MERCURY_BARE', 'MERCURY_EFFORT_LEVEL', 'MERCURY_MAX_OUTPUT_TOKENS', 'MERCURY_TIME_BASED_MC', 'MERCURY_COMPACT', 'MERCURY_AUTO_COMPACT', 'MERCURY_LOCAL_API_KEY', 'MERCURY_LOCAL_BASE_URL', 'MERCURY_THINKING_BINDING', 'MERCURY_PREFIX_INDUCE_EDIT', 'NODE_ENV', 'ANTHROPIC_BASE_URL']) {
  delete process.env[k]
}

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t)
}
const j = (v: unknown): string => JSON.stringify(v)
const guard = setTimeout(() => {
  console.log('\nTIMEOUT — the local empty-reply prover exceeded 120s')
  process.exit(1)
}, 120_000)
guard.unref?.()

const MODEL = 'qwen3.6:27b-coding'
const REPLY = 'All eleven tests pass; totalByTag is in src/ledger.ts with its test and README line.'
const ASK = 'Add the function, its test and the README line, run the tests, then tell me what you added.'
type ChatAnswer = (res: ServerResponse) => void
const row = (fields: Record<string, unknown>): string => JSON.stringify({ model: MODEL, created_at: '2026-10-09T16:51:49.547385Z', ...fields }) + '\n'
const doneRow = (reason: string): string => row({ message: { role: 'assistant', content: '' }, done: true, done_reason: reason, total_duration: 5_739_031_083, load_duration: 70_000_000, prompt_eval_count: 13_300, prompt_eval_duration: 1_000_000_000, eval_count: 0, eval_duration: 1 })
const emptyStop: ChatAnswer = res => {
  res.writeHead(200, { 'content-type': 'application/x-ndjson' })
  res.write(doneRow('stop'))
  res.end()
}
const thenReply: ChatAnswer = res => {
  res.writeHead(200, { 'content-type': 'application/x-ndjson' })
  res.write(row({ message: { role: 'assistant', content: REPLY }, done: false }))
  res.write(row({ message: { role: 'assistant', content: '' }, done: true, done_reason: 'stop', prompt_eval_count: 13_320, prompt_eval_duration: 200_000_000, eval_count: 24, eval_duration: 1_000_000_000 }))
  res.end()
}

type WireBody = { messages: Array<{ role: string; content: unknown }> }
const bodies: WireBody[] = []
let script: ChatAnswer[] = []
function json(res: ServerResponse, body: unknown): void {
  res.writeHead(200, { 'content-type': 'application/json' })
  res.end(JSON.stringify(body))
}
const fixture: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
  let body = ''
  req.on('data', c => {
    body += String(c)
  })
  req.on('end', () => {
    const url = req.url ?? ''
    if (url === '/api/tags') return json(res, { models: [{ name: MODEL, model: MODEL, size: 17_800_000_000, details: { family: 'qwen36', parameter_size: '27B', quantization_level: 'Q4_K_M' } }] })
    if (url === '/api/version') return json(res, { version: '0.34.4' })
    if (url === '/api/ps') return json(res, { models: [{ name: MODEL, model: MODEL, size: 20_000_000_000, context_length: 262_144, expires_at: '2099-01-01T00:00:00Z' }] })
    if (url === '/api/show') return json(res, { capabilities: ['completion', 'tools', 'thinking'], model_info: { 'general.architecture': 'qwen36', 'qwen36.context_length': 262_144 }, parameters: '' })
    if (url === '/api/chat' && req.method === 'POST') {
      bodies.push(JSON.parse(body || '{}') as WireBody)
      const answer = script.shift()
      if (!answer) return json(res, { error: 'fixture script exhausted' })
      return answer(res)
    }
    res.writeHead(404, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ error: 'not found' }))
  })
})
const root: string = await new Promise(resolve => {
  fixture.listen(0, '127.0.0.1', () => {
    const a = fixture.address()
    resolve(`http://127.0.0.1:${typeof a === 'object' && a !== null ? a.port : 0}`)
  })
})
process.env.MERCURY_LOCAL_PROBE_TARGETS = `ollama=${root}`

const turnMachine = (await import('../../src/run-core/turn-machine.ts')) as Record<string, unknown>
const runEventCore = turnMachine.runEventCore as (params: unknown, consumed: string[]) => AsyncGenerator<Record<string, unknown>, Record<string, unknown>>
const bootstrap = await import('../../src/bootstrap/state.ts')
bootstrap.setIsInteractive(false)
const { enableConfigs } = await import('../../src/utils/config/globalConfig.ts')
enableConfigs()
const { getDefaultAppState } = await import('../../src/state/AppStateStore.ts')
const { createUserMessage } = await import('../../src/utils/messages.ts')
const { createFileStateCacheWithSizeLimit } = await import('../../src/utils/fileStateCache.ts')
const { refreshLocalDiscovery } = await import('../../src/services/providers/local/localDiscovery.ts')
const { localRecordFor } = await import('../../src/services/providers/local/localCatalogue.ts')
const { localCallModel } = await import('../../src/services/providers/local/localCallModel.ts')
const { emptyReplyKindOf } = await import('../../src/services/providers/emptyReply.ts')
await refreshLocalDiscovery({ force: true })
const LOCAL_MODEL = `local/${MODEL}`

type AnyMsg = Record<string, unknown> & { type?: string; isMeta?: boolean; message?: { role?: string; content?: unknown; stop_reason?: string } }
type Run = { calls: number; notices: Array<{ text: string; level: string }>; transitions: Array<{ reason: string; attempt?: number }>; answers: string[]; settled: AnyMsg[]; terminal: Record<string, unknown> }

function makeCtx(model: string): Record<string, unknown> {
  let appState: Record<string, unknown> = { ...(getDefaultAppState() as unknown as Record<string, unknown>), effortValue: 'high' }
  return {
    abortController: new AbortController(),
    options: { commands: [], tools: [], engineModel: model, thinkingConfig: { type: 'enabled', budget_tokens: 1024 }, mcpClients: [], mcpResources: {}, isNonInteractiveSession: true, debug: false, verbose: false, agentDefinitions: { activeAgents: [], allAgents: [] } },
    getAppState: () => appState,
    setAppState: (f: (prev: never) => never): void => {
      appState = f(appState as never) as unknown as Record<string, unknown>
    },
    messages: [],
    readFileState: createFileStateCacheWithSizeLimit(100),
    setInProgressToolUseIDs: () => {},
    setResponseLength: () => {},
    updateFileHistoryState: () => {},
    updateAttributionState: () => {},
    agentId: undefined,
  }
}
const allowAll = async (_tool: unknown, input: Record<string, unknown>) => ({ behavior: 'allow', updatedInput: input, decisionReason: { type: 'other', reason: 'rig' } }) as never

async function runLocal(answers: ChatAnswer[]): Promise<Run> {
  script = [...answers]
  let calls = 0
  async function* callModel(params: { messages: AnyMsg[] }): AsyncGenerator<unknown, void> {
    calls++
    yield* localCallModel(params as never) as never
  }
  const gen = runEventCore(
    {
      messages: [createUserMessage({ content: ASK })],
      systemPrompt: ['rig system prompt'],
      userContext: {},
      systemContext: {},
      canUseTool: allowAll,
      toolUseContext: makeCtx(LOCAL_MODEL),
      querySource: 'sdk',
      deps: {
        callModel,
        autocompact: async () => ({ wasCompacted: false }),
        microcompact: async (messages: unknown[]) => ({ messages }),
        uuid: (() => {
          let n = 0
          return () => `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}`
        })(),
      },
    },
    [],
  )
  const out: Run = { calls: 0, notices: [], transitions: [], answers: [], settled: [], terminal: {} }
  let r = await gen.next()
  while (!r.done) {
    const e = r.value
    if (e.kind === 'notice') {
      const m = e.message as { content?: unknown; level?: unknown }
      out.notices.push({ text: String(m.content ?? ''), level: String(m.level ?? '') })
    }
    if (e.kind === 'turn_settled') out.transitions.push(e.transition as { reason: string; attempt?: number })
    if (e.kind === 'assistant_settled' && e.withheld !== true) {
      const message = e.message as AnyMsg
      out.settled.push(message)
      const content = message.message?.content
      if (Array.isArray(content)) for (const b of content as Array<{ type?: string; text?: string }>) if (b.type === 'text' && typeof b.text === 'string' && b.text.trim() !== '') out.answers.push(b.text)
    }
    r = await gen.next()
  }
  await new Promise(resolve => setTimeout(resolve, 5))
  out.calls = calls
  out.terminal = r.value
  return out
}
const textOf = (content: unknown): string => (typeof content === 'string' ? content : Array.isArray(content) ? (content as Array<{ type?: string; text?: string }>).filter(b => b?.type === 'text' && typeof b.text === 'string').map(b => b.text as string).join('\n') : '')

section('A · the Ollama road: a reply of nothing at all (one done row, content "", no thinking, no tool call, done_reason stop) is marked as the provider\'s empty reply')
{
  check('the fixture model is a discovered local record', localRecordFor(LOCAL_MODEL) !== undefined)
  const r = await runLocal([emptyStop, thenReply])
  const first = r.settled[0]
  check('the first settled assistant message carries the empty-reply mark (kind empty)', first !== undefined && emptyReplyKindOf(first as never) === 'empty', j({ kind: first === undefined ? 'none' : emptyReplyKindOf(first as never), content: first?.message?.content }))
  check('one empty_reply_retry transition, attempt 1', r.transitions.filter(t => t.reason === 'empty_reply_retry').length === 1 && r.transitions.find(t => t.reason === 'empty_reply_retry')?.attempt === 1, j(r.transitions))
  check('two chat requests reached the server (the empty turn, then the nudged ask)', r.calls === 2 && bodies.length === 2, `${r.calls} call(s), ${bodies.length} body(ies)`)
  const last = bodies[1]?.messages.at(-1)
  check('the second request ends with the user nudge asking for the answer', last?.role === 'user' && /answer|reply/i.test(textOf(last.content)), j(textOf(last?.content)).slice(0, 160))
  check('one visible warning says the provider returned an empty reply and the model was asked once', r.notices.filter(n => n.level === 'warning' && n.text.includes('empty reply') && n.text.includes('asked the model for its answer')).length === 1, j(r.notices))
  check('the reply lands as text and the run completes', r.answers.at(-1) === REPLY && r.terminal.reason === 'completed', j({ answers: r.answers, terminal: r.terminal }))
}

section('B · two empty replies in a row: the turn ends with the plain words, no third request')
{
  bodies.length = 0
  const r = await runLocal([emptyStop, emptyStop, thenReply])
  check('exactly two chat requests', r.calls === 2 && bodies.length === 2, `${r.calls} call(s)`)
  check('the ending notice says the model was already asked once and the turn ends here', r.notices.some(n => n.level === 'warning' && n.text.includes('already asked for its answer once')), j(r.notices))
  check('no text answer is invented', r.answers.length === 0, j(r.answers))
}

section('C · a reply with words is never marked')
{
  bodies.length = 0
  const r = await runLocal([thenReply])
  check('one request, no empty-reply transition, the reply lands', r.calls === 1 && !r.transitions.some(t => t.reason === 'empty_reply_retry') && r.answers.at(-1) === REPLY, j({ calls: r.calls, transitions: r.transitions, answers: r.answers }))
  check('the settled message carries no mark', r.settled[0] !== undefined && emptyReplyKindOf(r.settled[0] as never) === undefined)
}

fixture.close()
clearTimeout(guard)
console.log(`\n${failures === 0 ? 'ALL GREEN' : `${failures} FAILURE(S)`}`)
process.exit(failures === 0 ? 0 : 1)
