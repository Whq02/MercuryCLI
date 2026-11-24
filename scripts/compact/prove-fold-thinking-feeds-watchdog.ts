import { createServer } from 'node:http'
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
for (const key of ['MERCURY_HOME', 'MERCURY_OAUTH_TOKEN', 'MERCURY_MODEL', 'MERCURY_EXTRA_BODY', 'MERCURY_EFFORT_LEVEL', 'MERCURY_MAX_OUTPUT_TOKENS', 'MERCURY_SCRIPTED_STREAM', 'MERCURY_SM_COMPACT', 'ANTHROPIC_AUTH_TOKEN']) delete process.env[key]
const home = mkdtempSync(join(tmpdir(), 'fold-thinking-feeds-'))
process.env.MERCURY_CONFIG_DIR = home
process.env.MERCURY_CREDENTIAL_STORE = 'file'
process.env.ANTHROPIC_API_KEY = 'proof-key-ci-gate-not-a-real-key'
process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'
const ROAD_RECORD = mkdtempSync(join(tmpdir(), 'fold-thinking-feeds-roads-'))
process.env.MERCURY_WIRE_DUMP = ROAD_RECORD
const foldRoads = (): string[] =>
  readdirSync(ROAD_RECORD)
    .flatMap(name => readFileSync(join(ROAD_RECORD, name), 'utf8').split('\n'))
    .filter(line => line.includes('"kind":"fold"'))
    .map(line => JSON.parse(line) as { seq: number; road: string; outcome: string; detail?: string })
    .sort((a, b) => a.seq - b.seq)
    .map(row => `${row.road}:${row.outcome}${row.detail !== undefined ? ` (${row.detail})` : ''}`)

const summary = 'The synthetic parser accepts quoted commas and its 14 checks passed. Preserve the test command and continue with CLI verification.'
const STALL_MS = 2_000
const THINK_MS = 6_500
const BEAT_MS = 400
type Shape = 'anthropic-thinking' | 'anthropic-silent' | 'chat-reasoning' | 'chat-comments' | 'responses-summary'
let shape: Shape = 'anthropic-thinking'
let requests = 0
let reasoningBeats = 0
const posted: string[] = []
const sse = (value: unknown): string => `data: ${JSON.stringify(value)}\n\n`
const evt = (type: string, value: unknown): string => `event: ${type}\ndata: ${JSON.stringify(value)}\n\n`
const server = createServer((req, res) => {
  const path = (req.url ?? '').split('?')[0] ?? ''
  if (req.method === 'GET') {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(path.endsWith('/models') ? JSON.stringify({ object: 'list', data: [{ id: 'glm-5.2', object: 'model', owned_by: 'zai' }, { id: 'gpt-5.6-sol', object: 'model' }] }) : '{}')
    return
  }
  req.resume()
  req.on('end', () => {
    requests++
    posted.push(`${req.method} ${path}`)
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    const usage = { input_tokens: 20, output_tokens: 40, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 }
    let beat: NodeJS.Timeout | null = null
    if (shape === 'anthropic-thinking' || shape === 'anthropic-silent') {
      res.write(evt('message_start', { type: 'message_start', message: { id: `msg_${requests}`, type: 'message', role: 'assistant', model: 'claude-fable-5-1', content: [], stop_reason: null, stop_sequence: null, usage } }))
      if (shape === 'anthropic-thinking') {
        res.write(evt('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } }))
        beat = setInterval(() => { reasoningBeats++; res.write(evt('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'still reasoning about the parser… ' } })) }, BEAT_MS)
      }
      setTimeout(() => {
        if (beat) clearInterval(beat)
        if (shape === 'anthropic-thinking') {
          res.write(evt('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'fixture-signature' } }))
          res.write(evt('content_block_stop', { type: 'content_block_stop', index: 0 }))
        }
        res.write(evt('content_block_start', { type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } }))
        res.write(evt('content_block_delta', { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: summary } }))
        res.write(evt('content_block_stop', { type: 'content_block_stop', index: 1 }))
        res.write(evt('message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage }))
        res.end(evt('message_stop', { type: 'message_stop' }))
      }, THINK_MS).unref()
    } else if (shape === 'chat-reasoning' || shape === 'chat-comments') {
      const chunk = (delta: Record<string, unknown>, finish: string | null = null, withUsage = false): string => sse({ id: 'chatcmpl-fixture', object: 'chat.completion.chunk', created: 0, model: 'glm-5.2', choices: [{ index: 0, delta, finish_reason: finish }], ...(withUsage ? { usage: { prompt_tokens: 20, completion_tokens: 40, total_tokens: 60 } } : {}) })
      beat = setInterval(() => { reasoningBeats++; res.write(shape === 'chat-reasoning' ? chunk({ reasoning_content: 'still reasoning about the parser… ' }) : ': OPENROUTER PROCESSING\n\n') }, BEAT_MS)
      setTimeout(() => {
        if (beat) clearInterval(beat)
        res.write(chunk({ role: 'assistant', content: summary }))
        res.write(chunk({}, 'stop', true))
        res.end('data: [DONE]\n\n')
      }, THINK_MS).unref()
    } else {
      res.write(sse({ type: 'response.created', response: { id: `resp_${requests}` } }))
      res.write(sse({ type: 'response.output_item.added', item: { type: 'reasoning', id: `rs_${requests}`, summary: [] } }))
      beat = setInterval(() => { reasoningBeats++; res.write(sse({ type: 'response.reasoning_summary_text.delta', item_id: `rs_${requests}`, delta: 'still reasoning about the parser… ' })) }, BEAT_MS)
      setTimeout(() => {
        if (beat) clearInterval(beat)
        res.write(sse({ type: 'response.output_item.done', item: { type: 'reasoning', id: `rs_${requests}`, summary: [{ type: 'summary_text', text: 'reasoned' }], encrypted_content: 'fixture-encrypted' } }))
        res.write(sse({ type: 'response.output_item.added', item: { type: 'message', id: `msg_${requests}`, role: 'assistant', content: [] } }))
        res.write(sse({ type: 'response.output_text.delta', delta: summary }))
        res.write(sse({ type: 'response.output_item.done', item: { type: 'message', id: `msg_${requests}`, role: 'assistant', content: [{ type: 'output_text', text: summary }] } }))
        res.end(sse({ type: 'response.completed', response: { id: `resp_${requests}`, usage: { input_tokens: 20, output_tokens: 40, input_tokens_details: { cached_tokens: 0 } } } }))
      }, THINK_MS).unref()
    }
    res.once('close', () => { if (beat) clearInterval(beat) })
  })
})
await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`
Object.assign(process.env, {
  ANTHROPIC_BASE_URL: base,
  MERCURY_ZAI_API_BASE: `${base}/zai/v4`,
  ZAI_API_KEY: 'fixture-zai-key',
  MERCURY_OPENROUTER_API_BASE: `${base}/openrouter/api/v1`,
  MERCURY_OPENROUTER_AUTH_BASE: `${base}/openrouter/auth`,
  OPENROUTER_API_KEY: 'fixture-openrouter-key',
  MERCURY_OPENAI_API_BASE: `${base}/openai/v1`,
  MERCURY_OPENAI_CHATGPT_BASE: `${base}/openai/chatgpt`,
  MERCURY_OPENAI_AUTH_BASE: `${base}/openai/auth`,
  OPENAI_API_KEY: 'fixture-openai-key',
})
const { enableConfigs } = await import('../../src/platform/config/globalConfig.ts')
enableConfigs()
const { setIsInteractive } = await import('../../src/boot/process-state/processState.ts')
setIsInteractive(false)
const { foldConversation, setFoldBoundsForTests, ERROR_MESSAGE_FOLD_TIMEOUT } = await import('../../src/engine/compaction/foldConversation.ts')
const { createUserMessage } = await import('../../src/engine/messages/messages.ts')
const { FileStateCache, READ_FILE_STATE_CACHE_SIZE } = await import('../../src/platform/files/fileStateCache.ts')
const { turnDoor: startTurn } = await import('../../src/engine/turnDoor.ts')
const { getEmptyToolPermissionContext } = await import('../../src/tools/kit/tool.ts')
const { asSystemPrompt } = await import('../../src/engine/system-prompt/systemPromptType.ts')
let failures = 0
let checks = 0
const check = (label: string, ok: boolean, detail: unknown = ''): void => {
  checks++
  if (!ok) failures++
  console.log(`${ok ? 'PASS' : 'FAIL'} ${label}${ok ? '' : ` — ${JSON.stringify(detail)}`}`)
}
async function fold(model: string, next: Shape): Promise<{ ms: number; requests: number; posted: string[]; beats: number; summary: boolean; error: string | undefined; activity: number; roads: string[] }> {
  shape = next
  requests = 0
  reasoningBeats = 0
  posted.length = 0
  let activity = 0
  const roadsBefore = foldRoads().length
  const state = { toolPermissionContext: getEmptyToolPermissionContext(), sessionHooks: new Map(), tasks: {}, agentNameRegistry: new Map(), mcp: { clients: [], tools: [], commands: [], resources: {} }, effortValue: 'max' }
  const context: any = { abortController: new AbortController(), getAppState: () => state, setAppState: () => {}, setSDKStatus: (value: any) => { if (typeof value?.streamActivity === 'number') activity++ }, messages: [], startTurn, readFileState: new FileStateCache(READ_FILE_STATE_CACHE_SIZE, 25 * 1024 * 1024), options: { tools: [], commands: [], mcpClients: [], engineModel: model, maxThinkingTokens: 0, thinkingConfig: { type: 'adaptive' }, isNonInteractiveSession: true, agentDefinitions: { activeAgents: [] } } }
  const messages = [createUserMessage({ content: 'Preserve the parser result and continue with CLI verification.' })]
  const cache = { systemPrompt: asSystemPrompt(['Synthetic thinking-feed proof.']), userContext: {}, systemContext: {}, toolUseContext: context, forkContextMessages: messages }
  const guard = setTimeout(() => context.abortController.abort(), 60_000)
  const start = Date.now()
  let error: string | undefined
  let result: Awaited<ReturnType<typeof foldConversation>> | undefined
  try {
    result = await foldConversation(messages, context, cache, false)
  } catch (caught) {
    error = caught instanceof Error ? caught.message : String(caught)
  } finally {
    clearTimeout(guard)
  }
  return { ms: Date.now() - start, requests, posted: [...posted], beats: reasoningBeats, summary: result?.summaryMessages.some(row => String(row.message.content).includes(summary)) === true, error, activity, roads: foldRoads().slice(roadsBefore) }
}
setFoldBoundsForTests({ stallMs: STALL_MS, ingestMsPer1kTokens: 0 })
try {
  console.log(`stall ${STALL_MS} ms · the model reasons for ${THINK_MS} ms (${Math.floor(THINK_MS / STALL_MS)} stall windows) before its first text, one reasoning event every ${BEAT_MS} ms`)
  const anthropic = await fold('claude-fable-5-1', 'anthropic-thinking')
  check('Anthropic (the cache-sharing fork): thinking deltas alone keep the fold alive through three stall windows and the summary lands on the first request', anthropic.requests === 1 && anthropic.summary && anthropic.ms >= THINK_MS && anthropic.beats >= 10, { hint: 'the fold stall watchdog in src/engine/compaction/foldConversation.ts must count thinking deltas as stream activity', anthropic })
  check("…and the fold's road record reads that the fork lane itself carried that summary: one row, fork:summary, no hand-over to the direct lane", anthropic.roads.join(' · ') === 'fork:summary', { roads: anthropic.roads, change: 'summarizeViaCacheSharingFork (src/engine/compaction/foldConversation.ts) hands a failure of its nested turn to the direct lane, which lands the same summary: the context this proof builds must let that turn start (startTurn) and carry what runForkedAgent reads' })
  const zai = await fold('glm-5.2', 'chat-reasoning')
  check('chat dialect (Z.AI): reasoning_content deltas alone keep the fold alive and the summary lands on the first request', zai.requests === 1 && zai.summary && zai.ms >= THINK_MS && zai.beats >= 10, { hint: 'the fold stall watchdog in src/engine/compaction/foldConversation.ts must count reasoning_content deltas as stream activity', zai })
  const openrouter = await fold('openrouter/fixture/model', 'chat-comments')
  check('chat dialect (OpenRouter): keep-alive comments with no event at all keep the fold alive through the byte relay and the summary lands on the first request', openrouter.requests === 1 && openrouter.summary && openrouter.ms >= THINK_MS && openrouter.activity >= 3, { hint: 'the fold stall watchdog in src/engine/compaction/foldConversation.ts must count keep-alive comment bytes as stream activity (streamActivity reaching setSDKStatus)', openrouter })
  const openai = await fold('gpt-5.6-sol', 'responses-summary')
  check('OpenAI Responses: reasoning summary deltas alone keep the fold alive and the summary lands on the first request', openai.requests === 1 && openai.summary && openai.ms >= THINK_MS && openai.beats >= 10, { hint: 'the fold stall watchdog in src/engine/compaction/foldConversation.ts must count reasoning summary deltas as stream activity', openai })
  const silent = await fold('claude-fable-5-1', 'anthropic-silent')
  check('a stream with NO bytes for a whole stall window is the wedge the watchdog is for: both lanes cut it for silence and nothing is folded', !silent.summary && silent.error === ERROR_MESSAGE_FOLD_TIMEOUT && silent.requests === 2, { hint: 'compactConversation in src/engine/compaction/foldConversation.ts must cut a stream with no bytes for a stall window on both lanes (fork then direct) and throw ERROR_MESSAGE_FOLD_TIMEOUT', silent })
  check(`the silent stream was cut near the stall window, not at a wall (fork then direct, each one window ≈ ${STALL_MS} ms, under ${THINK_MS} ms)`, silent.ms >= 2 * STALL_MS && silent.ms < THINK_MS, { hint: 'the stall bound set by setFoldBoundsForTests in src/engine/compaction/foldConversation.ts must cut each lane after one stall window, not at a wall', ms: silent.ms })
  check("…and the road record reads the two cuts as the lanes' own: the fork lane handed over at its fold bound, then the direct lane timed out", silent.roads.length === 2 && /^fork:handover \(fold bound after \d+ ms/.test(silent.roads[0] ?? '') && (silent.roads[1] ?? '').startsWith('direct:timeout'), { roads: silent.roads, change: 'a fork row that hands over for another reason than its fold bound is a failure of the nested turn itself (src/engine/compaction/foldConversation.ts, summarizeViaCacheSharingFork): the context this proof builds must let that turn start' })
} finally {
  setFoldBoundsForTests(null)
  server.closeAllConnections()
  await new Promise<void>(resolve => server.close(() => resolve()))
  rmSync(home, { recursive: true, force: true })
  rmSync(ROAD_RECORD, { recursive: true, force: true })
}
console.log(`${failures ? 'FAIL' : 'PASS'} fold-thinking-feeds-watchdog: ${checks} checks, ${failures} failures`)
process.exit(failures ? 1 : 0)
