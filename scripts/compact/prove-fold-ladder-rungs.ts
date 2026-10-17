#!/usr/bin/env bun
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

delete process.env.NODE_ENV
for (const key of ['MERCURY_HOME', 'MERCURY_OAUTH_TOKEN', 'MERCURY_MODEL', 'MERCURY_EFFORT_LEVEL', 'MERCURY_SCRIPTED_STREAM', 'MERCURY_SM_COMPACT', 'ANTHROPIC_API_KEY', 'MERCURY_COMPACT_KEEP_TAIL', 'MERCURY_BLOCKING_LIMIT_OVERRIDE', 'MERCURY_AUTOCOMPACT_PCT_OVERRIDE', 'MERCURY_CTX_COMPACTION', 'MERCURY_THINKING_BUDGET']) delete process.env[key]
process.env.MERCURY_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'fold-ladder-rungs-'))
process.env.MERCURY_CREDENTIAL_STORE = 'file'

let failures = 0
const check = (label: string, ok: boolean, detail = ''): void => {
  if (!ok) failures++
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${!ok && detail ? ` — ${detail}` : ''}`)
}
const record = (line: string): void => console.log(`  [record] ${line}`)
const section = (t: string): void => {
  console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
}
const watchdog = setTimeout(() => {
  console.log('\nTIMEOUT — the fold ladder rungs prover exceeded 300s')
  process.exit(1)
}, 300_000)
watchdog.unref?.()

const LOCAL_MODEL = 'small-window:latest'
const LOCAL_SERVED = 32_768
const localHits: Array<{ url: string; chars: number; body: Record<string, unknown> }> = []
let localAnswer: (body: Record<string, unknown>) => string = () => 'a summary'
function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' })
  res.end(JSON.stringify(body))
}
const ollama = await new Promise<{ server: Server; root: string }>(resolve => {
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    let raw = ''
    req.on('data', chunk => {
      raw += String(chunk)
    })
    req.on('end', () => {
      const url = req.url ?? ''
      if (url === '/api/tags') return json(res, 200, { models: [{ name: LOCAL_MODEL, model: LOCAL_MODEL, size: 1, details: { family: 'llama', parameter_size: '9B', quantization_level: 'Q4_K_M' } }] })
      if (url === '/api/version') return json(res, 200, { version: '0.34.4' })
      if (url === '/api/ps') return json(res, 200, { models: [{ name: LOCAL_MODEL, model: LOCAL_MODEL, size: 1, context_length: LOCAL_SERVED, expires_at: '2026-01-01T00:00:00Z' }] })
      if (url === '/api/show') return json(res, 200, { modelfile: '', parameters: '', details: {}, model_info: { 'general.architecture': 'llama', 'llama.context_length': 131072 }, capabilities: ['completion', 'tools'] })
      if (url === '/api/generate') return json(res, 200, { model: LOCAL_MODEL, response: '', done: true, done_reason: 'load' })
      if (url === '/v1/chat/completions' || url === '/api/chat') {
        let body: Record<string, unknown> = {}
        try {
          body = JSON.parse(raw) as Record<string, unknown>
        } catch {
          body = {}
        }
        localHits.push({ url, chars: raw.length, body })
        const text = localAnswer(body)
        if (url === '/api/chat') {
          res.writeHead(200, { 'content-type': 'application/x-ndjson' })
          if (text !== '') res.write(`${JSON.stringify({ model: LOCAL_MODEL, created_at: '2026-01-01T00:00:00Z', message: { role: 'assistant', content: text }, done: false })}\n`)
          res.write(`${JSON.stringify({ model: LOCAL_MODEL, created_at: '2026-01-01T00:00:00Z', message: { role: 'assistant', content: '' }, done: true, done_reason: 'stop', prompt_eval_count: Math.round(raw.length / 4), eval_count: 20 })}\n`)
          res.end()
          return
        }
        res.writeHead(200, { 'content-type': 'text/event-stream' })
        res.write(`data: ${JSON.stringify({ id: 'c', object: 'chat.completion.chunk', created: 1, model: LOCAL_MODEL, choices: [{ index: 0, delta: { role: 'assistant', content: text }, finish_reason: 'stop' }], usage: { prompt_tokens: Math.round(raw.length / 4), completion_tokens: 20, total_tokens: Math.round(raw.length / 4) + 20 } })}\n\n`)
        res.write('data: [DONE]\n\n')
        res.end()
        return
      }
      json(res, 404, { error: 'not found' })
    })
  })
  server.listen(0, '127.0.0.1', () => {
    const address = server.address()
    const port = typeof address === 'object' && address !== null ? address.port : 0
    resolve({ server, root: `http://127.0.0.1:${port}` })
  })
})
process.env.MERCURY_LOCAL_PROBE_TARGETS = `ollama=${ollama.root}`

const { startOverflowFixture } = await import('./overflowFixture.ts')
type Captured = import('./overflowFixture.ts').Captured
type Turn = import('./overflowFixture.ts').Turn
const fixture = await startOverflowFixture()
Object.assign(process.env, fixture.env)
process.env.MERCURY_LOCAL_PROBE_TARGETS = `ollama=${ollama.root}`
delete process.env.MERCURY_LOCAL_BASE_URL
const { enableConfigs } = await import('../../src/utils/config/globalConfig.ts')
enableConfigs()
const { setIsInteractive } = await import('../../src/bootstrap/state.ts')
setIsInteractive(false)
const { refreshGeminiCatalogue } = await import('../../src/services/providers/gemini/geminiCatalogue.ts')
const { getContextWindowForModel } = await import('../../src/utils/model/capabilities.ts')
const { getAutoCompactThreshold, getBlockingLimit } = await import('../../src/services/compact/autoCompact.ts')
const { tokenCountWithEstimation } = await import('../../src/utils/tokens.ts')
const { requestGaugeDigest } = await import('../../src/services/run/requestGauge.ts')
const { createUserMessage } = await import('../../src/utils/messages.ts')
const { getEmptyToolPermissionContext } = await import('../../src/Tool.ts')
const { FileStateCache, READ_FILE_STATE_CACHE_SIZE } = await import('../../src/utils/fileStateCache.ts')
const compactModule = await import('../../src/services/compact/compact.ts')
const { compactConversation, partialCompactConversation, buildPostCompactMessages, PROSE_SKIPPED_KEY, ERROR_MESSAGE_NO_SUMMARY, summaryAnswerFault, FOLD_WINDOW_REFUSAL_KEY } = compactModule
const { refreshLocalDiscovery } = await import('../../src/services/providers/local/localDiscovery.ts')
const { localRecordFor } = await import('../../src/services/providers/local/localCatalogue.ts')
const windowModule = await import('../../src/services/providers/local/localWindow.ts')
await refreshLocalDiscovery({ force: true })
windowModule.writeLocalWindowSetting?.({ id: LOCAL_MODEL }, 'server')
type Message = import('../../src/types/message.ts').Message
type AssistantMessage = import('../../src/types/message.ts').AssistantMessage

const GEMINI = 'gemini-3-pro'
const GEMINI_WINDOW = 1_048_576
const GEMINI_CHARS_PER_TOKEN = 2.94
const geminiCount = (body: Record<string, unknown>): number => Math.round(JSON.stringify(body).length / GEMINI_CHARS_PER_TOKEN)
const fetchImpl: typeof fetch = async () =>
  new Response(JSON.stringify({ models: [{ name: `models/${GEMINI}`, displayName: 'fixture', inputTokenLimit: GEMINI_WINDOW, outputTokenLimit: 65_536, supportedGenerationMethods: ['generateContent'], thinking: true }] }), { status: 200, headers: { 'content-type': 'application/json' } })
await refreshGeminiCatalogue('api-key', { force: true, fetchImpl })

let uuidSeq = 0
const nextUuid = (): string => `00000000-0000-4000-a000-${String(++uuidSeq).padStart(12, '0')}`
function filler(chars: number, label: string): string {
  let out = ''
  let n = 0
  while (out.length < chars) out += `${++n}\t${label}: a fixture line standing in for the recorded bytes\n`
  return out.slice(0, chars)
}
function assistantRow(model: string, id: string, blocks: unknown[], usage: { input: number; output: number; cacheRead?: number }, stop = 'tool_use'): AssistantMessage {
  return {
    type: 'assistant',
    uuid: nextUuid(),
    timestamp: new Date().toISOString(),
    requestId: `req_${id}`,
    message: { id, type: 'message', role: 'assistant', model, content: blocks, stop_reason: stop, stop_sequence: null, usage: { input_tokens: usage.input, output_tokens: usage.output, cache_read_input_tokens: usage.cacheRead ?? 0, cache_creation_input_tokens: 0 } },
  } as unknown as AssistantMessage
}
type Rig = { rounds: number; resultChars: number; model: string; lastUsage: { input: number; output: number; cacheRead?: number }; gauge?: { ratio: number; fixed: number } }
function conversation(rig: Rig): Message[] {
  const out: Message[] = [createUserMessage({ content: `ask 0: read the sources and write the memo ${filler(400, 'the operator ask')}` })]
  for (let i = 0; i < rig.rounds; i++) {
    const id = `call_${String(i).padStart(4, '0')}`
    const last = i === rig.rounds - 1
    out.push(assistantRow(rig.model, `msg_${i}`, [{ type: 'tool_use', id, name: 'Read', input: { file_path: `/fixture/source-${String(i).padStart(3, '0')}.ts` } }], last ? rig.lastUsage : { input: 1000 + i * 10, output: 50 }))
    out.push(createUserMessage({ content: [{ type: 'tool_result', tool_use_id: id, content: filler(rig.resultChars, `result ${id}`) }] as never }))
  }
  if (rig.gauge !== undefined) {
    const anchor = [...out].reverse().find(row => row.type === 'assistant') as AssistantMessage & { contextGauge?: unknown }
    const first = out.indexOf(anchor)
    anchor.contextGauge = { version: 1, key: `gemini:${rig.model}:c1`, epoch: 0, digest: requestGaugeDigest(out.slice(0, first)), rawTokens: 0, fixed: { digest: 'fixed', tokens: rig.gauge.fixed }, density: { ratio: rig.gauge.ratio, samples: 20, residuals: [] }, sample: { eligible: true, denominator: 20_000, measured: 27_200, reason: 'matched-request-tail' } }
  }
  return out
}

const state = { toolPermissionContext: getEmptyToolPermissionContext(), sessionHooks: new Map(), tasks: {}, agentNameRegistry: new Map(), mcp: { clients: [], tools: [], commands: [], resources: {} }, effortValue: 'high' }
function makeContext(model: string, messages: Message[]): Record<string, unknown> {
  return {
    abortController: new AbortController(),
    getAppState: () => state,
    setAppState: () => {},
    messages,
    readFileState: new FileStateCache(READ_FILE_STATE_CACHE_SIZE, 25 * 1024 * 1024),
    options: { tools: [], commands: [], mcpClients: [], engineModel: model, maxThinkingTokens: 0, thinkingConfig: { type: 'enabled', budget_tokens: 8_000 }, isNonInteractiveSession: true, agentDefinitions: { activeAgents: [] } },
  }
}
type Drive = { landed: boolean; error?: string; pre?: number; post?: number; kept?: number; notes?: string[]; summaryText?: string; result?: Awaited<ReturnType<typeof compactConversation>>; ms: number }
async function fold(model: string, messages: Message[], road: 'auto' | 'manual' = 'manual'): Promise<Drive> {
  const context = makeContext(model, messages)
  const cache = { systemPrompt: ['fixture system prompt'], userContext: {}, systemContext: {}, toolUseContext: context, forkContextMessages: messages } as never
  const started = Date.now()
  try {
    const result = await compactConversation(messages, context as never, cache, road === 'auto', undefined, road === 'auto', { isRecompaction: false, turnsSincePreviousCompact: -1, autoCompactThreshold: getAutoCompactThreshold(model) }, undefined, model)
    const summary = result.summaryMessages[0]
    return { landed: true, pre: result.preCompactTokenCount, post: result.truePostCompactTokenCount, kept: result.messagesToKeep?.length ?? 0, notes: result.notes, summaryText: summary !== undefined && typeof summary.message.content === 'string' ? summary.message.content : '', result, ms: Date.now() - started }
  } catch (error) {
    return { landed: false, error: error instanceof Error ? error.message : String(error), ms: Date.now() - started }
  }
}
const SUMMARY: Turn = { text: '<summary>1. Operator Intent: read the sources and write the memo.\n8. Where Work Stands: the sources are read.\n10. Agents in flight: none.</summary>', usage: { input: 1000, output: 60 } }
const thinkingLevelOf = (request: Captured): string => String(((request.body.generationConfig as { thinkingConfig?: { thinkingLevel?: string } } | undefined)?.thinkingConfig?.thinkingLevel) ?? 'none')

section('R1 (c) already over the window with the automatic fold failed: a 1,048,576-token Gemini seat at 1,03x,xxx tokens — the operator\'s /compact lands on rung 1 in one request')
{
  const messages = conversation({ rounds: 40, resultChars: 100_000, model: GEMINI, lastUsage: { input: 24_000, output: 1_200, cacheRead: 985_000 }, gauge: { ratio: 1.36, fixed: 40_000 } })
  const gauge = tokenCountWithEstimation(messages, GEMINI)
  record(`the gauge reads ${gauge.toLocaleString('en-US')} on window ${getContextWindowForModel(GEMINI).toLocaleString('en-US')} (threshold ${getAutoCompactThreshold(GEMINI).toLocaleString('en-US')}, blocking ${getBlockingLimit(GEMINI).toLocaleString('en-US')})`)
  check('the conversation is over the blocking limit (the automatic fold has failed, the turn was stopped)', gauge > getBlockingLimit(GEMINI), String(gauge))
  const sent: number[] = []
  fixture.script((request: Captured) => {
    const tokens = geminiCount(request.body)
    sent.push(tokens)
    return tokens > Math.floor(GEMINI_WINDOW * 0.95) ? { text: '' } : SUMMARY
  })
  const run = await fold(GEMINI, messages, 'manual')
  record(`/compact: ${run.landed ? 'LANDED' : `FAILED (${run.error})`} after ${sent.length} request(s) of ${sent.map(n => n.toLocaleString('en-US')).join(', ')} tokens by the provider's density; ${run.ms} ms`)
  check('the manual fold landed (red on the base: Failed to generate a conversation summary.)', run.landed, run.error ?? '')
  check('rung 1: one request, under the window by the provider\'s count', sent.length === 1 && sent[0]! <= Math.floor(GEMINI_WINDOW * 0.95), sent.join(','))
  check('the prose summary is the model\'s (no skipped-prose line, no receipt note)', (run.summaryText ?? '').includes('Where Work Stands') && !(run.summaryText ?? '').includes(PROSE_SKIPPED_KEY) && (run.notes ?? []).length === 0, JSON.stringify(run.notes))
  check('the post-fold context is under the threshold with a verbatim tail', (run.post ?? Infinity) < getAutoCompactThreshold(GEMINI) && (run.kept ?? 0) > 0, `${run.post} / ${run.kept}`)
}

section('R2 (c, the provider answers nothing whatever it is sent): rung 2 halves the input with thinking off, twice; rung 3 lands the fold on Mercury\'s own records and says so in one line')
{
  const messages = conversation({ rounds: 40, resultChars: 100_000, model: GEMINI, lastUsage: { input: 24_000, output: 1_200, cacheRead: 985_000 }, gauge: { ratio: 1.36, fixed: 40_000 } })
  const before = fixture.captured.length
  fixture.script(() => ({ text: '' }))
  const run = await fold(GEMINI, messages, 'manual')
  const requests = fixture.captured.slice(before)
  record(`${run.landed ? 'LANDED' : `FAILED (${run.error})`} after ${requests.length} request(s); thinking levels on the wire: ${requests.map(thinkingLevelOf).join(', ')}; ${run.ms} ms`)
  check('the fold landed without a model (red on the base: Failed to generate a conversation summary.)', run.landed, run.error ?? '')
  check('rung 2: the first request rode the session\'s thinking level, the retries rode thinking off', requests.length >= 3 && thinkingLevelOf(requests[0]!) === 'HIGH' && requests.slice(1).every(request => thinkingLevelOf(request) === 'LOW'), requests.map(thinkingLevelOf).join(','))
  check('rung 2 is bounded: two no-summary retries and no more', requests.length <= 4, String(requests.length))
  const line = `${PROSE_SKIPPED_KEY}: the answer had no text (stop reason end_turn; 0 thinking blocks, 0 tool calls).`
  check('the summary card opens on the one-line notice naming the cause', (run.summaryText ?? '').includes(line), (run.summaryText ?? '').slice(0, 400))
  check('the receipt carries the same line as its note', (run.notes ?? []).some(note => note.startsWith(line)), JSON.stringify(run.notes))
  const post = run.result === undefined ? [] : buildPostCompactMessages(run.result)
  const kinds = post.map(row => (row.type === 'system' ? `system:${(row as { subtype?: string }).subtype ?? ''}` : row.type === 'attachment' ? `attachment:${(row as { attachment: { type: string } }).attachment.type}` : row.type))
  check('the records carry the fold: the boundary, the operator messages, the summary row with the fold ledger, the kept tail', kinds[0] === 'system:compact_boundary' && kinds.includes('attachment:compact_operator_messages') && (run.summaryText ?? '').includes('Folded work') && (run.kept ?? 0) > 0, kinds.slice(0, 6).join(' · '))
  check('the post-fold context is under the threshold', (run.post ?? Infinity) < getAutoCompactThreshold(GEMINI), String(run.post))
}

section('R3 a Gemini-shaped empty candidate on an ordinary fold is rung 2, not a throw: the halved retry answers and the fold lands with the model\'s prose')
{
  const messages = conversation({ rounds: 6, resultChars: 4_000, model: GEMINI, lastUsage: { input: 9_000, output: 300 } })
  const before = fixture.captured.length
  fixture.script([{ text: '' }, SUMMARY, SUMMARY, SUMMARY])
  const run = await fold(GEMINI, messages, 'auto')
  const requests = fixture.captured.slice(before)
  record(`${run.landed ? 'LANDED' : `FAILED (${run.error})`} after ${requests.length} request(s); thinking levels ${requests.map(thinkingLevelOf).join(', ')}`)
  check('the fold landed (red on the base: Failed to generate a conversation summary. after one request)', run.landed, run.error ?? '')
  check('the empty candidate was retried on half the input with thinking off and the fold carries the model\'s prose', requests.length === 3 && thinkingLevelOf(requests[1]!) === 'LOW' && (run.summaryText ?? '').includes('Where Work Stands') && !(run.summaryText ?? '').includes(PROSE_SKIPPED_KEY), `${requests.length} · ${(run.summaryText ?? '').slice(0, 200)}`)
  check('the retry\'s second half opened on the first half\'s part capsule', JSON.stringify(requests[2]?.body ?? {}).includes('earlier turns folded into this summary for the compaction'), JSON.stringify(requests[2]?.body ?? {}).slice(0, 200))
}

section('R4 an answer that spent its output before any text (finish reason MAX_TOKENS) is the same rung')
{
  const messages = conversation({ rounds: 6, resultChars: 4_000, model: GEMINI, lastUsage: { input: 9_000, output: 300 } })
  const before = fixture.captured.length
  fixture.script([{ text: '', finishReason: 'max_tokens' }, SUMMARY, SUMMARY, SUMMARY])
  const run = await fold(GEMINI, messages, 'auto')
  const requests = fixture.captured.slice(before)
  record(`${run.landed ? 'LANDED' : `FAILED (${run.error})`} after ${requests.length} request(s)`)
  check('the fold landed with the model\'s prose (red on the base: Compaction was interrupted before a summary arrived)', run.landed && (run.summaryText ?? '').includes('Where Work Stands') && requests.length === 3, run.error ?? String(requests.length))
}

section('R5 (d) a 32,768-token local model: the fold lands with the summariser\'s input shaped to the served window, and lands on rung 3 when the model answers nothing')
{
  const model = `local/${LOCAL_MODEL}`
  check('discovery states the served window (32,768 · served)', localRecordFor(model)?.contextWindow?.tokens === LOCAL_SERVED, JSON.stringify(localRecordFor(model)?.contextWindow))
  const messages = conversation({ rounds: 30, resultChars: 8_000, model, lastUsage: { input: 60_000, output: 300 } })
  record(`the gauge reads ${tokenCountWithEstimation(messages, model).toLocaleString('en-US')} on window ${getContextWindowForModel(model).toLocaleString('en-US')} (threshold ${getAutoCompactThreshold(model).toLocaleString('en-US')}, blocking ${getBlockingLimit(model).toLocaleString('en-US')})`)
  localHits.length = 0
  localAnswer = () => '<summary>1. Operator Intent: read the sources and write the memo.\n8. Where Work Stands: the sources are read.\n10. Agents in flight: none.</summary>'
  const run = await fold(model, messages, 'auto')
  const largest = localHits.reduce((max, hit) => Math.max(max, hit.chars), 0)
  record(`${run.landed ? 'LANDED' : `FAILED (${run.error})`} after ${localHits.length} request(s); the largest request ${largest.toLocaleString('en-US')} chars (≈${Math.round(largest / 3.9).toLocaleString('en-US')} tokens by the local wire's count); ${run.ms} ms`)
  check(`the fold landed (red on the base: ${FOLD_WINDOW_REFUSAL_KEY} …)`, run.landed, run.error ?? '')
  check('every summariser request fitted the served window, so the silent-truncation guard never fired and nothing was sent over the window', localHits.length >= 1 && localHits.every(hit => hit.chars / 3.9 <= LOCAL_SERVED), `${localHits.length} requests, largest ${largest}`)
  check('the fold ran in parts: the oldest rounds folded into part capsules ahead of the final request', localHits.length >= 2 && localHits.some(hit => JSON.stringify(hit.body).includes('earlier turns folded into this summary for the compaction')), String(localHits.length))
  check('the post-fold context is under the threshold', (run.post ?? Infinity) < getAutoCompactThreshold(model), `${run.post} vs ${getAutoCompactThreshold(model)}`)
  localHits.length = 0
  localAnswer = () => ''
  const silent = await fold(model, messages, 'auto')
  record(`a model that answers nothing: ${silent.landed ? 'LANDED' : `FAILED (${silent.error})`} after ${localHits.length} request(s)`)
  check('rung 3: the fold lands on the records when the local model answers nothing, the card naming the cause', silent.landed && (silent.summaryText ?? '').includes(`${PROSE_SKIPPED_KEY}: the answer had no text`), silent.error ?? (silent.summaryText ?? '').slice(0, 200))
  check('and the requests stayed bounded', localHits.length <= 8, String(localHits.length))
}

section('R6 the floor names its cause: the partial fold (no rung 3) and the answer classifier')
{
  const messages = conversation({ rounds: 3, resultChars: 2_000, model: GEMINI, lastUsage: { input: 3_000, output: 100 } })
  fixture.script(() => ({ text: '' }))
  const context = makeContext(GEMINI, messages)
  const cache = { systemPrompt: ['fixture system prompt'], userContext: {}, systemContext: {}, toolUseContext: context, forkContextMessages: messages } as never
  let error = ''
  try {
    await partialCompactConversation(messages, 0, context as never, cache, undefined, 'from')
  } catch (caught) {
    error = caught instanceof Error ? caught.message : String(caught)
  }
  record(`the partial fold's error: ${error}`)
  check('the partial road still refuses, and the sentence names the cause (red on the base: the generic "Failed to generate a conversation summary.")', error === `${ERROR_MESSAGE_NO_SUMMARY}: the answer had no text (stop reason end_turn; 0 thinking blocks, 0 tool calls)`, error)
  const row = (content: unknown[], stop: string | null): AssistantMessage => assistantRow(GEMINI, 'msg_x', content, { input: 10, output: 5 }, stop as string)
  check('a max_tokens answer names the output limit', (summaryAnswerFault(row([{ type: 'text', text: 'partial' }], 'max_tokens')) ?? '').startsWith('the answer hit its output limit before a summary (stop reason max_tokens; 7 characters of text, 0 thinking blocks)'), summaryAnswerFault(row([{ type: 'text', text: 'partial' }], 'max_tokens')) ?? 'null')
  check('a thinking-only answer names the thinking blocks', summaryAnswerFault(row([{ type: 'thinking', thinking: 'hmm', signature: 's' }], 'end_turn')) === 'the answer had no text (stop reason end_turn; 1 thinking block, 0 tool calls)', summaryAnswerFault(row([{ type: 'thinking', thinking: 'hmm', signature: 's' }], 'end_turn')) ?? 'null')
  check('the headings alone are named as such', summaryAnswerFault(row([{ type: 'text', text: '1. Operator Intent:\n2. Technical Ground:' }], 'end_turn')) === "the answer carried the summary's headings and nothing under them")
  check('a refusal in prose is quoted', (summaryAnswerFault(row([{ type: 'text', text: 'I cannot summarize this conversation.' }], 'end_turn')) ?? '').startsWith('the answer refused in prose: "I cannot summarize'))
  check('a summary is no fault', summaryAnswerFault(row([{ type: 'text', text: 'The parser supports quoted commas; 14 checks pass. Next: the CLI check.' }], 'end_turn')) === null)
  check('an unsettled answer (no stop reason) is the incomplete road, not a fault', summaryAnswerFault(row([{ type: 'text', text: '' }], null)) === null)
}

section('R7 (a) under the budget nothing is shaped: the summariser reads the whole conversation as the session sent it, every result whole, the newest round included')
{
  const messages = conversation({ rounds: 8, resultChars: 3_000, model: GEMINI, lastUsage: { input: 12_000, output: 300 } })
  const before = fixture.captured.length
  fixture.script([SUMMARY])
  const run = await fold(GEMINI, messages, 'auto')
  const requests = fixture.captured.slice(before)
  const wire = JSON.stringify(requests[0]?.body ?? {})
  check('the fold landed in one request', run.landed && requests.length === 1, run.error ?? String(requests.length))
  check('the request carried every round whole: the first and the last tool call, every result\'s bytes, no capped body, no part capsule', wire.includes('call_0000') && wire.includes('call_0007') && !wire.includes('characters omitted for the compaction') && !wire.includes('earlier turns folded') && [...Array(8).keys()].every(i => wire.includes(`result call_${String(i).padStart(4, '0')}: a fixture line`)), wire.slice(0, 200))
}

ollama.server.close()
await fixture.close()
console.log(`\n${failures === 0 ? '✅' : '❌'} prove-fold-ladder-rungs — ${failures === 0 ? 'all checks pass' : `${failures} check(s) failed`}`)
process.exit(failures === 0 ? 0 : 1)
