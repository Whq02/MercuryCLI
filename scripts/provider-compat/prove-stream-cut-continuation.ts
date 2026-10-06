#!/usr/bin/env bun
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.MERCURY_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'stream-cut-continuation-'))
process.env.MERCURY_DAEMON_DIR = mkdtempSync(join(tmpdir(), 'stream-cut-continuation-daemon-'))
process.env.MERCURY_CREDENTIAL_STORE = 'file'
for (const k of ['MERCURY_BARE', 'MERCURY_EFFORT_LEVEL', 'MERCURY_MAX_OUTPUT_TOKENS', 'MERCURY_TIME_BASED_MC', 'MERCURY_COMPACT', 'MERCURY_AUTO_COMPACT', 'MERCURY_LOCAL_API_KEY', 'MERCURY_LOCAL_BASE_URL', 'NODE_ENV']) {
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
const guard = setTimeout(() => {
  console.log('\nTIMEOUT — the stream-cut continuation prover exceeded 120s')
  process.exit(1)
}, 120_000)
guard.unref?.()

type Route = (req: IncomingMessage, body: string, res: ServerResponse) => boolean
function serve(route: Route): Promise<{ server: Server; root: string }> {
  return new Promise(resolve => {
    const server = createServer((req, res) => {
      let body = ''
      req.on('data', chunk => {
        body += String(chunk)
      })
      req.on('end', () => {
        if (!route(req, body, res)) {
          res.writeHead(404, { 'content-type': 'application/json' })
          res.end(JSON.stringify({ error: 'not found' }))
        }
      })
    })
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      const port = typeof address === 'object' && address !== null ? address.port : 0
      resolve({ server, root: `http://127.0.0.1:${port}` })
    })
  })
}
function json(res: ServerResponse, status: number, body: unknown): true {
  res.writeHead(status, { 'content-type': 'application/json' })
  res.end(JSON.stringify(body))
  return true
}
const sse = (obj: unknown): string => `data: ${JSON.stringify(obj)}\n\n`
const chunk = (model: unknown, delta: Record<string, unknown>, finish: string | null = null): string =>
  sse({ id: 'c1', object: 'chat.completion.chunk', created: 1, model, choices: [{ index: 0, delta, finish_reason: finish }] })

const MODEL_ID = 'Qwen/Qwen3-32B'
const VLLM_MODELS = { object: 'list', data: [{ id: MODEL_ID, object: 'model', created: 1, owned_by: 'vllm', root: '/models/Qwen3-32B', parent: null, max_model_len: 40960, permission: [] }] }

const PARTIAL_DELTAS = [
  "I'll build you a playable RPG game in a single HTML file with embedded CSS and JavaScript. ",
  'Let me design a turn-based RPG with:\n\n',
  '- Character creation with stats (strength, agility, intelligence)\n',
  '- Turn-based combat system',
]
const PARTIAL = PARTIAL_DELTAS.join('')
const REST = 'and here is the rest of the game.'

type ChatAnswer = (model: unknown, res: ServerResponse) => void
const cutAfterText: ChatAnswer = (model, res) => {
  res.writeHead(200, { 'content-type': 'text/event-stream' })
  res.write(chunk(model, { role: 'assistant', reasoning: 'The user wants an RPG game in HTML.' }))
  for (const text of PARTIAL_DELTAS) res.write(chunk(model, { content: text }))
  res.end()
}
const cutBeforeText: ChatAnswer = (model, res) => {
  res.writeHead(200, { 'content-type': 'text/event-stream' })
  res.write(chunk(model, { role: 'assistant', reasoning: 'Thinking about the shape of the game.' }))
  res.end()
}
const finishNormally: ChatAnswer = (model, res) => {
  res.writeHead(200, { 'content-type': 'text/event-stream' })
  res.write(chunk(model, { role: 'assistant', content: REST }, 'stop'))
  res.write(sse({ id: 'c1', object: 'chat.completion.chunk', created: 1, model, choices: [], usage: { prompt_tokens: 40, completion_tokens: 8, total_tokens: 48 } }))
  res.write('data: [DONE]\n\n')
  res.end()
}

type WireBody = { messages: Array<{ role: string; content: unknown }> }
const bodies: WireBody[] = []
let script: ChatAnswer[] = []
const vllm = await serve((req, body, res) => {
  const url = req.url ?? ''
  if (url === '/v1/models') return json(res, 200, VLLM_MODELS)
  if (url === '/v1/chat/completions' && req.method === 'POST') {
    const parsed = JSON.parse(body || '{}') as WireBody & { model?: unknown }
    bodies.push(parsed)
    const answer = script.shift()
    if (!answer) return json(res, 500, { error: 'fixture script exhausted' })
    answer(parsed.model, res)
    return true
  }
  return false
})
process.env.MERCURY_LOCAL_PROBE_TARGETS = `vllm=${vllm.root}`

const { query } = await import('../../src/query.ts')
const bootstrap = await import('../../src/bootstrap/state.ts')
bootstrap.setIsInteractive(false)
const { enableConfigs } = await import('../../src/utils/config/globalConfig.ts')
enableConfigs()
const { getDefaultAppState } = await import('../../src/state/AppStateStore.ts')
const { createUserMessage } = await import('../../src/utils/messages.ts')
const { createFileStateCacheWithSizeLimit } = await import('../../src/utils/fileStateCache.ts')
const { STREAM_FAULT_RECOVERY_NUDGE, API_ERROR_MESSAGE_PREFIX, isContinuableStreamFaultMessage } = await import('../../src/services/api/errors.ts')
const { refreshLocalDiscovery } = await import('../../src/services/providers/local/localDiscovery.ts')
const { localCallModel } = await import('../../src/services/providers/local/localCallModel.ts')
await refreshLocalDiscovery({ force: true })
const MODEL = `local/${MODEL_ID}`

type AnyMsg = Record<string, unknown> & { type?: string; isApiErrorMessage?: boolean; isMeta?: boolean; message?: { role?: string; content?: unknown } }
type CallRecord = { messages: AnyMsg[] }

function makeCtx(): { ctx: Record<string, unknown>; abortController: AbortController } {
  let appState: Record<string, unknown> = { ...(getDefaultAppState() as unknown as Record<string, unknown>), effortValue: 'high' }
  const abortController = new AbortController()
  const ctx: Record<string, unknown> = {
    abortController,
    options: {
      commands: [],
      tools: [],
      engineModel: MODEL,
      thinkingConfig: { type: 'enabled', budget_tokens: 1024 },
      mcpClients: [],
      mcpResources: {},
      isNonInteractiveSession: true,
      debug: false,
      verbose: false,
      agentDefinitions: { activeAgents: [], allAgents: [] },
    },
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
  return { ctx, abortController }
}

async function run(answers: ChatAnswer[]): Promise<{ yields: AnyMsg[]; calls: CallRecord[]; wire: WireBody[]; terminal: Record<string, unknown> }> {
  script = [...answers]
  const firstBody = bodies.length
  const calls: CallRecord[] = []
  async function* callModel(params: { messages: AnyMsg[] }): AsyncGenerator<unknown, void> {
    calls.push({ messages: [...params.messages] })
    yield* localCallModel(params as never)
  }
  const rig = makeCtx()
  const gen = query({
    messages: [createUserMessage({ content: 'can you make a html for a rpg game' })] as never,
    systemPrompt: ['rig system prompt'] as never,
    userContext: {},
    systemContext: {},
    canUseTool: (async () => ({ behavior: 'deny', message: 'no tools in this rig' })) as never,
    toolUseContext: rig.ctx as never,
    querySource: 'sdk' as never,
    deps: {
      callModel: callModel as never,
      autocompact: (async () => ({ wasCompacted: false })) as never,
      microcompact: (async (messages: unknown[]) => ({ messages })) as never,
      uuid: (() => {
        let n = 0
        return () => `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}`
      })(),
    },
  })
  const yields: AnyMsg[] = []
  let r = await gen.next()
  while (!r.done) {
    yields.push(r.value as AnyMsg)
    r = await gen.next()
  }
  await new Promise(resolve => setTimeout(resolve, 5))
  return { yields, calls, wire: bodies.slice(firstBody), terminal: r.value as Record<string, unknown> }
}

const textOf = (content: unknown): string => {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return (content as Array<{ type?: string; text?: string }>).filter(b => b?.type === 'text' && typeof b.text === 'string').map(b => b.text as string).join('\n')
}
const textBlocksOf = (content: unknown): string[] => {
  if (typeof content === 'string') return [content]
  if (!Array.isArray(content)) return []
  return (content as Array<{ type?: string; text?: string }>).filter(b => b?.type === 'text' && typeof b.text === 'string').map(b => b.text as string)
}
const tailOf = (text: string, n: number): string => text.slice(-n)

section('A · a cut after settled text: the continuation replays the partial as the assistant\'s own last message, then the marker')
{
  const r = await run([cutAfterText, finishNormally])
  check('the fixture saw two chat requests (the cut turn, then the continuation)', r.wire.length === 2, `${r.wire.length} request(s)`)
  check('the run completed', r.terminal.reason === 'completed', JSON.stringify(r.terminal))
  check('the cut turn settled its partial text and the typed fault marker (the continuable class)', r.yields.some(y => y.type === 'assistant' && textOf(y.message?.content) === PARTIAL) && r.yields.some(y => y.type === 'assistant' && isContinuableStreamFaultMessage(y as never)))
  check('the one calm notice: asked the model to continue from where it stopped', r.yields.some(y => y.type === 'system' && String((y as { content?: unknown }).content ?? '').includes('asked the model to continue from where it stopped')))

  const request = r.calls[1]?.messages ?? []
  const lastAssistant = [...request].reverse().find(m => m.type === 'assistant')
  check('the continuation request: its last assistant message carries the settled partial text verbatim', lastAssistant !== undefined && textOf(lastAssistant.message?.content) === PARTIAL, lastAssistant === undefined ? 'no assistant message' : `last assistant = ${JSON.stringify(textOf(lastAssistant.message?.content).slice(0, 90))}`)
  check("the continuation request carries no API-error row (Mercury's own words never ride as the model's)", !request.some(m => m.type === 'assistant' && m.isApiErrorMessage === true), `${request.filter(m => m.type === 'assistant' && m.isApiErrorMessage === true).length} API-error row(s)`)
  const marker = request.at(-1)
  const markerBlocks = textBlocksOf(marker?.message?.content)
  check('the marker is the last message: a meta user message whose first text block is the owned nudge (the transcript lookups key on it)', marker?.type === 'user' && marker.isMeta === true && markerBlocks[0] === STREAM_FAULT_RECOVERY_NUDGE, JSON.stringify(markerBlocks.map(b => b.slice(0, 60))))
  check('the marker names the last words of the partial, so the model cannot contradict it', markerBlocks.slice(1).some(b => b.includes(tailOf(PARTIAL, 40))), JSON.stringify(markerBlocks.slice(1)))
  check('the marker names the assistant message directly above as the reply so far', markerBlocks.slice(1).some(b => b.includes('directly above')), JSON.stringify(markerBlocks.slice(1)))
  check('the message before the marker is the partial (nothing stands between them)', request.at(-2)?.type === 'assistant' && textOf(request.at(-2)?.message?.content) === PARTIAL, `before the marker: ${String(request.at(-2)?.type)} ${JSON.stringify(textOf(request.at(-2)?.message?.content).slice(0, 60))}`)

  const wire = r.wire[1]?.messages ?? []
  const assistantRows = wire.filter(m => m.role === 'assistant')
  const lastRow = assistantRows.at(-1)
  check('the wire body: the last assistant row is the settled partial, verbatim', lastRow !== undefined && lastRow.content === PARTIAL, `last assistant row = ${JSON.stringify(String(lastRow?.content ?? '').slice(0, 90))}`)
  check("the wire body: no assistant row carries Mercury's API-error prefix", !assistantRows.some(m => String(m.content ?? '').startsWith(API_ERROR_MESSAGE_PREFIX)), JSON.stringify(assistantRows.map(m => String(m.content ?? '').slice(0, 50))))
  const lastAssistantIndex = wire.lastIndexOf(lastRow as never)
  const after = wire[lastAssistantIndex + 1]
  check('the wire body: the marker row follows the partial directly, carrying the nudge and the partial\'s last words', after?.role === 'user' && String(after.content).startsWith(STREAM_FAULT_RECOVERY_NUDGE) && String(after.content).includes(tailOf(PARTIAL, 40)), `${String(after?.role)}: ${JSON.stringify(String(after?.content ?? '').slice(0, 80))}`)
}

section('B · a cut before any text: the plain marker as today')
{
  const r = await run([cutBeforeText, finishNormally])
  check('the fixture saw two chat requests', r.wire.length === 2, `${r.wire.length} request(s)`)
  check('the run completed', r.terminal.reason === 'completed', JSON.stringify(r.terminal))
  const request = r.calls[1]?.messages ?? []
  const marker = request.at(-1)
  check('the marker is the plain owned nudge, nothing named (no settled words to name)', marker?.type === 'user' && marker.isMeta === true && marker.message?.content === STREAM_FAULT_RECOVERY_NUDGE, JSON.stringify(marker?.message?.content).slice(0, 120))
  check('the continuation request carries no API-error row', !request.some(m => m.type === 'assistant' && m.isApiErrorMessage === true))
}

vllm.server.close()
console.log(`\n${failures === 0 ? 'ALL GREEN' : `${failures} FAILURE(S)`}`)
process.exit(failures === 0 ? 0 : 1)
