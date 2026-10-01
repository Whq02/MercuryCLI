#!/usr/bin/env bun
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { createServer, type ServerResponse } from 'node:http'
import { existsSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

delete process.env.NODE_ENV
delete process.env.CI
for (const key of Object.keys(process.env)) {
  if (
    /^(ANTHROPIC_(AUTH_TOKEN|BASE_URL|API_KEY)|MERCURY_(MODEL|SMALL_FAST_MODEL)|MERCURY_OAUTH_TOKEN|MERCURY_SCRIPTED_STREAM|MERCURY_BARE|MERCURY_MAX_OUTPUT_TOKENS|MERCURY_HOME|MERCURY_EFFORT_LEVEL|MERCURY_THINKING_BUDGET|MERCURY_COMPACT_KEEP_TAIL|MERCURY_AUTOCOMPACT_PCT_OVERRIDE|MERCURY_BLOCKING_LIMIT_OVERRIDE|MERCURY_DISABLE_1M_CONTEXT|MERCURY_COMPACT|MERCURY_AUTO_COMPACT|MERCURY_CTX_COMPACTION|MERCURY_THINKING_BINDING|MERCURY_STREAM_IDLE_TIMEOUT_MS|MERCURY_SILENT_AFTER_HEADERS_MS|MERCURY_TOOL_DEFER_PROBE|DEBUG)$/.test(key) ||
    /^(OPENAI|ZAI|MOONSHOT|DEEPSEEK|GEMINI|GOOGLE|OPENROUTER|HF)_/.test(key) ||
    /^HF_TOKEN$/.test(key) ||
    /^MERCURY_(OPENAI|ZAI|MOONSHOT|DEEPSEEK|GEMINI|OPENROUTER|HUGGINGFACE|COMPAT|LOCAL)_/.test(key)
  ) {
    delete process.env[key]
  }
}
const CONFIG_DIR = mkdtempSync(join(tmpdir(), 'fold-stall-'))
process.env.MERCURY_CONFIG_DIR = CONFIG_DIR
process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'
const DEBUG_LOG = join(CONFIG_DIR, 'debug.txt')
process.argv.push(`--debug-file=${DEBUG_LOG}`)

let failures = 0
let checks = 0
function check(label: string, cond: boolean, detail = ''): void {
  checks++
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
}
const j = (v: unknown): string => JSON.stringify(v) ?? ''
const guard = setTimeout(() => {
  console.log('\nTIMEOUT — fold stall liveness prover exceeded 180s')
  process.exit(1)
}, 180_000)
guard.unref?.()

const sse = (obj: unknown): string => `data: ${JSON.stringify(obj)}\n\n`
const evt = (name: string, obj: unknown): string => `event: ${name}\n${sse(obj)}`
const SUMMARY_TEXT = 'Fixture summary: the operator asked for a version bump, the suite ran green, and a changelog entry is the next step.'

type Plan = 'heartbeats' | 'dead' | 'late-first-byte' | 'late-content' | 'forever'
type Seen = { n: number; plan: Plan; startedAt: number; closedAt?: number; finished: boolean; wrote: string[] }
const TICK_MS = 250
const COMMENT_PHASE_MS = 3_000
const PROGRESS_PHASE_MS = 3_000
const LATE_MS = 4_500
let plan: Plan = 'heartbeats'
const seen: Seen[] = []

const MODELS_BODY = {
  models: [
    {
      slug: 'gpt-5.6-sol',
      display_name: 'GPT-5.6-Sol',
      supported_reasoning_levels: [{ effort: 'low', description: 'low' }, { effort: 'high', description: 'high' }],
      default_reasoning_level: 'low',
      visibility: 'list',
      priority: 1,
      context_window: 272_000,
      max_context_window: 872_000,
      input_modalities: ['text', 'image'],
      supported_in_api: true,
    },
  ],
}

function openStream(res: ServerResponse, entry: Seen, n: number): void {
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
  res.write(evt('response.created', { type: 'response.created', response: { id: `resp_${n}`, status: 'in_progress' } }))
  res.write(evt('response.in_progress', { type: 'response.in_progress', response: { id: `resp_${n}`, status: 'in_progress' } }))
  entry.wrote.push('created', 'in_progress')
}

function writeSummary(res: ServerResponse, entry: Seen, n: number): void {
  res.write(evt('response.output_item.added', { type: 'response.output_item.added', output_index: 1, item: { type: 'message', id: `msg_${n}`, role: 'assistant', content: [] } }))
  res.write(evt('response.content_part.added', { type: 'response.content_part.added', item_id: `msg_${n}`, part: { type: 'output_text', text: '' } }))
  for (const piece of [SUMMARY_TEXT.slice(0, 40), SUMMARY_TEXT.slice(40)]) {
    res.write(evt('response.output_text.delta', { type: 'response.output_text.delta', item_id: `msg_${n}`, delta: piece }))
  }
  res.write(evt('response.output_text.done', { type: 'response.output_text.done', item_id: `msg_${n}`, text: SUMMARY_TEXT }))
  res.write(evt('response.content_part.done', { type: 'response.content_part.done', item_id: `msg_${n}`, part: { type: 'output_text', text: SUMMARY_TEXT } }))
  res.write(evt('response.output_item.done', { type: 'response.output_item.done', output_index: 1, item: { type: 'message', id: `msg_${n}`, role: 'assistant', content: [{ type: 'output_text', text: SUMMARY_TEXT }] } }))
  res.write(evt('response.completed', { type: 'response.completed', response: { id: `resp_${n}`, status: 'completed', usage: { input_tokens: 900, output_tokens: 40, input_tokens_details: { cached_tokens: 0 } } } }))
  entry.wrote.push('summary', 'completed')
  entry.finished = true
  res.end()
}

const PROGRESS_FRAMES = (n: number): string[] => [
  evt('response.output_item.added', { type: 'response.output_item.added', output_index: 0, item: { type: 'reasoning', id: `rs_${n}`, summary: [] } }),
  evt('response.reasoning_summary_part.added', { type: 'response.reasoning_summary_part.added', item_id: `rs_${n}`, summary_index: 0, part: { type: 'summary_text', text: '' } }),
  evt('response.reasoning_summary_part.done', { type: 'response.reasoning_summary_part.done', item_id: `rs_${n}`, summary_index: 0, part: { type: 'summary_text', text: '' } }),
  evt('response.output_item.done', { type: 'response.output_item.done', output_index: 0, item: { type: 'reasoning', id: `rs_${n}`, summary: [], encrypted_content: 'enc' } }),
]

const server = createServer((req, res) => {
  const chunks: Buffer[] = []
  req.on('data', c => chunks.push(c as Buffer))
  req.on('end', () => {
    const path = (req.url ?? '').split('?')[0] ?? ''
    if (req.method === 'GET' && path.endsWith('/models')) {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify(MODELS_BODY))
      return
    }
    if (req.method !== 'POST' || !path.endsWith('/responses')) {
      res.writeHead(404, { 'content-type': 'application/json' })
      res.end('{}')
      return
    }
    const n = seen.length + 1
    const entry: Seen = { n, plan, startedAt: Date.now(), finished: false, wrote: [] }
    seen.push(entry)
    const timers: NodeJS.Timeout[] = []
    res.on('close', () => {
      entry.closedAt = Date.now()
      for (const t of timers) clearTimeout(t)
    })
    const after = (ms: number, fn: () => void): void => {
      timers.push(setTimeout(() => {
        if (!res.destroyed) fn()
      }, ms))
    }
    if (entry.plan === 'dead') return
    if (entry.plan === 'late-first-byte') {
      after(LATE_MS, () => {
        openStream(res, entry, n)
        writeSummary(res, entry, n)
      })
      return
    }
    openStream(res, entry, n)
    if (entry.plan === 'late-content') {
      after(LATE_MS, () => writeSummary(res, entry, n))
      return
    }
    if (entry.plan === 'forever') {
      const beat = (): void => {
        res.write(': keep-alive\n\n')
        entry.wrote.push('comment')
        timers.push(setTimeout(() => { if (!res.destroyed) beat() }, TICK_MS))
      }
      after(TICK_MS, beat)
      return
    }
    const frames = PROGRESS_FRAMES(n)
    let elapsed = 0
    let frameAt = 0
    const tick = (): void => {
      elapsed += TICK_MS
      if (elapsed <= COMMENT_PHASE_MS) {
        res.write(': keep-alive\n\n')
        entry.wrote.push('comment')
      } else if (elapsed <= COMMENT_PHASE_MS + PROGRESS_PHASE_MS) {
        res.write(frames[frameAt % frames.length]!)
        entry.wrote.push(`progress:${frameAt % frames.length}`)
        frameAt++
      } else {
        writeSummary(res, entry, n)
        return
      }
      after(TICK_MS, tick)
    }
    after(TICK_MS, tick)
  })
})
await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
const address = server.address()
const PORT = typeof address === 'object' && address ? address.port : 0
const BASE = `http://127.0.0.1:${PORT}`
process.env.MERCURY_OPENAI_API_BASE = `${BASE}/openai/v1`
process.env.MERCURY_OPENAI_CHATGPT_BASE = `${BASE}/openai/chatgpt`
process.env.MERCURY_OPENAI_AUTH_BASE = `${BASE}/openai/auth`
process.env.OPENAI_API_KEY = 'fixture-openai-key'

const { enableConfigs } = await import('../../src/utils/config.ts')
enableConfigs()
const compactModule = await import('../../src/services/compact/compact.ts')
const { compactConversation, setFoldBoundsForTests, ERROR_MESSAGE_FOLD_TIMEOUT, shouldRideCacheSharingFork } = compactModule
const foldFirstByteAllowanceMs: ((estTokens: number, bounds?: { deadlineMs: number; stallMs: number; ingestMsPer1kTokens: number }) => number) | undefined = (compactModule as { foldFirstByteAllowanceMs?: typeof compactModule.foldFirstByteAllowanceMs }).foldFirstByteAllowanceMs
const allowanceOf = (estTokens: number): number => (foldFirstByteAllowanceMs === undefined ? Number.NaN : foldFirstByteAllowanceMs(estTokens))
const { COLD_INGEST_MS_PER_1K_TOKENS } = await import('../../src/services/providers/streamIdleBudget.ts')
const { streamOpenaiResponses } = await import('../../src/services/providers/openai/openaiClient.ts')
const { streamOpenrouterResponses } = await import('../../src/services/providers/openrouter/openrouterResponsesTransport.ts')
const { createUserMessage } = await import('../../src/utils/messages.ts')
const { getEmptyToolPermissionContext } = await import('../../src/Tool.ts')
const { asSystemPrompt } = await import('../../src/utils/systemPromptType.ts')
const { FileStateCache, READ_FILE_STATE_CACHE_SIZE } = await import('../../src/utils/fileStateCache.ts')
const { tokenCountWithEstimation } = await import('../../src/utils/tokens.ts')

const MODEL = 'gpt-5.6-sol'
let uuidSeq = 0
const nextUuid = (): string => `00000000-0000-4000-a000-${String(++uuidSeq).padStart(12, '0')}`
function assistantRow(text: string, inputTokens = 100): unknown {
  const id = `msg_${nextUuid().slice(-6)}`
  return {
    type: 'assistant',
    uuid: nextUuid(),
    requestId: `req_${id}`,
    timestamp: new Date().toISOString(),
    message: {
      id,
      type: 'message',
      role: 'assistant',
      model: MODEL,
      content: [{ type: 'text', text }],
      stop_reason: 'end_turn',
      stop_sequence: null,
      usage: { input_tokens: inputTokens, output_tokens: 50 },
    },
  }
}
function makeMessages(inputTokens = 100): unknown[] {
  return [
    createUserMessage({ content: 'please bump the version and run the tests' }),
    assistantRow('Bumped the version and ran the suite — all green.', inputTokens),
    createUserMessage({ content: 'now write the changelog entry' }),
  ]
}
type Run = { result?: Record<string, unknown>; error?: Error; readFileState: { size: number }; ms: number }
async function runFold(messages: unknown[]): Promise<Run> {
  const toolPermissionContext = { ...getEmptyToolPermissionContext(), mode: 'default' as const }
  const appState = { toolPermissionContext, sessionHooks: new Map(), denialTracking: undefined, tasks: {}, mcp: { clients: [], tools: [], commands: [], resources: {} }, effortValue: 'xhigh' }
  const readFileState = new FileStateCache(READ_FILE_STATE_CACHE_SIZE, 25 * 1024 * 1024)
  readFileState.set('/tmp/fold-stall-file.ts', { content: 'export const x = 1\n', timestamp: Date.now(), offset: undefined, limit: undefined })
  const ctx = {
    abortController: new AbortController(),
    getAppState: () => appState,
    setAppState: () => {},
    messages: [],
    agentType: undefined,
    agentId: undefined,
    readFileState,
    options: { tools: [], mcpClients: [], mainLoopModel: MODEL, maxThinkingTokens: 0, thinkingConfig: { type: 'disabled' as const }, isNonInteractiveSession: true, agentDefinitions: { activeAgents: [] } },
  }
  const cacheSafe = { systemPrompt: asSystemPrompt(['You are a fixture-driven session posture.']) }
  const startedAt = Date.now()
  let result: Record<string, unknown> | undefined
  let error: Error | undefined
  try {
    result = (await compactConversation(messages as never, ctx as never, cacheSafe as never, true)) as never as Record<string, unknown>
  } catch (err) {
    error = err as Error
  }
  return { result, error, readFileState, ms: Date.now() - startedAt }
}
const summaryOf = (run: Run): string => j(run.result?.summaryMessages ?? [])
async function awaitClose(entry: Seen | undefined, withinMs: number): Promise<boolean> {
  const until = Date.now() + withinMs
  while (entry !== undefined && entry.closedAt === undefined && Date.now() < until) {
    await new Promise(resolve => setTimeout(resolve, 50))
  }
  return entry?.closedAt !== undefined
}
let debugCursor = 0
function debugLinesSince(): string[] {
  const text = existsSync(DEBUG_LOG) ? readFileSync(DEBUG_LOG, 'utf8') : ''
  const fresh = text.slice(debugCursor)
  debugCursor = text.length
  return fresh.split('\n').filter(l => l.includes('compact:'))
}

const STALL_MS = 2_000
const DEADLINE_MS = 20_000
const INGEST_MS_PER_1K = 10

section('§1 the first-byte allowance rule, pure — the stall window plus the cold-ingest reading per 1k tokens, capped at the wall')
check('the allowance rule exists (foldFirstByteAllowanceMs)', typeof foldFirstByteAllowanceMs === 'function')
if (typeof foldFirstByteAllowanceMs === 'function') {
  check('an empty history waits the flat stall window (120 s)', foldFirstByteAllowanceMs(0) === 120_000, String(foldFirstByteAllowanceMs(0)))
  check('the slope is the product\'s own cold-ingest reading (COLD_INGEST_MS_PER_1K_TOKENS = 1,200 ms per 1k tokens)', foldFirstByteAllowanceMs(1_000) - foldFirstByteAllowanceMs(0) === COLD_INGEST_MS_PER_1K_TOKENS && COLD_INGEST_MS_PER_1K_TOKENS === 1_200, String(foldFirstByteAllowanceMs(1_000)))
  check('50k tokens → 180 s', foldFirstByteAllowanceMs(50_000) === 180_000, String(foldFirstByteAllowanceMs(50_000)))
  check('100k tokens → 240 s', foldFirstByteAllowanceMs(100_000) === 240_000, String(foldFirstByteAllowanceMs(100_000)))
  check('272k tokens (the served GPT default window) → 446.4 s', foldFirstByteAllowanceMs(272_000) === 446_400, String(foldFirstByteAllowanceMs(272_000)))
  check('400k tokens → the 10-minute wall (600 s), never past it', foldFirstByteAllowanceMs(400_000) === 600_000, String(foldFirstByteAllowanceMs(400_000)))
  check('900k tokens → the 10-minute wall', foldFirstByteAllowanceMs(900_000) === 600_000, String(foldFirstByteAllowanceMs(900_000)))
  check('a NaN or negative estimate reads as zero', foldFirstByteAllowanceMs(Number.NaN) === 120_000 && foldFirstByteAllowanceMs(-5) === 120_000)
  const shrunk = { deadlineMs: DEADLINE_MS, stallMs: STALL_MS, ingestMsPer1kTokens: INGEST_MS_PER_1K }
  check('under the proof bounds, 400k tokens → 2 s + 4 s = 6 s', foldFirstByteAllowanceMs(400_000, shrunk) === 6_000, String(foldFirstByteAllowanceMs(400_000, shrunk)))
  check('gpt-5.6-sol rides the direct lane (the lane this proof drives)', shouldRideCacheSharingFork(MODEL, { type: 'disabled' }) === false)
}

section('§2 the OpenAI Responses transport relays liveness for comment lines and progress-only frames (no outward event)')
{
  const encoder = new TextEncoder()
  async function scriptedFetch(script: Array<{ delayMs: number; bytes: string }>): Promise<Response> {
    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        for (const step of script) {
          await new Promise(resolve => setTimeout(resolve, step.delayMs))
          controller.enqueue(encoder.encode(step.bytes))
        }
        controller.close()
      },
    })
    return new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } })
  }
  const script = [
    { delayMs: 0, bytes: evt('response.created', { type: 'response.created', response: { id: 'resp_u' } }) + evt('response.in_progress', { type: 'response.in_progress', response: { id: 'resp_u' } }) },
    { delayMs: 1_100, bytes: ': keep-alive\n\n' },
    { delayMs: 1_100, bytes: evt('response.output_item.added', { type: 'response.output_item.added', output_index: 0, item: { type: 'reasoning', id: 'rs_u', summary: [] } }) },
    { delayMs: 1_100, bytes: evt('response.reasoning_summary_part.added', { type: 'response.reasoning_summary_part.added', item_id: 'rs_u', summary_index: 0, part: { type: 'summary_text', text: '' } }) },
    { delayMs: 1_100, bytes: evt('response.output_text.delta', { type: 'response.output_text.delta', item_id: 'msg_u', delta: 'hello' }) + evt('response.completed', { type: 'response.completed', response: { id: 'resp_u', status: 'completed', usage: { input_tokens: 1, output_tokens: 1 } } }) },
  ]
  const relays: number[] = []
  const outward: string[] = []
  const t0 = Date.now()
  for await (const event of streamOpenaiResponses({
    baseUrl: `${BASE}/unit`,
    headers: {},
    request: { model: MODEL, input: [] } as never,
    fetchImpl: (() => scriptedFetch(script)) as never,
    idleTimeoutMs: 60_000,
    onStreamActivity: at => relays.push(at - t0),
  })) {
    outward.push(event.type)
  }
  check('the parser still drops the progress-only frames (no outward event for in_progress, reasoning item added, summary part added)', !outward.includes('reasoning-delta') && outward.filter(t => t === 'response-id').length === 1 && outward.includes('text-delta') && outward.includes('finish'), j(outward))
  check(`the comment line, the reasoning item and the summary part each relayed liveness (≥ 3 relays, one per silent second): ${j(relays)}`, relays.length >= 3, j(relays))
  check('the relay is throttled: consecutive relays are at least a second apart', relays.every((at, index) => index === 0 || at - relays[index - 1]! >= 1_000), j(relays))

  const orRelays: number[] = []
  const orOutward: string[] = []
  const t1 = Date.now()
  for await (const event of streamOpenrouterResponses(
    { url: `${BASE}/openrouter/api/v1/chat/completions`, request: { model: 'fixture' } as never, fetchImpl: (() => scriptedFetch(script)) as never, idleTimeoutMs: 60_000, onStreamActivity: at => orRelays.push(at - t1) },
    '{}',
    { model: 'fixture', items: [] } as never,
  )) {
    orOutward.push(event.type)
  }
  check(`the OpenRouter/xAI Responses transport relays the same liveness (≥ 3 relays): ${j(orRelays)}`, orRelays.length >= 3, j(orRelays))
  check('…and still forwards the text and the finish', orOutward.includes('text-delta') && orOutward.includes('finish'), j(orOutward))
}

setFoldBoundsForTests({ deadlineMs: DEADLINE_MS, stallMs: STALL_MS, ingestMsPer1kTokens: INGEST_MS_PER_1K })

section(`§3 (a) a wire silent for longer than the stall window (${STALL_MS} ms) but sending comment lines, then progress-only frames, then the summary → the fold LANDS`)
{
  plan = 'heartbeats'
  debugLinesSince()
  const run = await runFold(makeMessages())
  const lines = debugLinesSince()
  const req = seen.at(-1)
  check(`the fold landed after ${run.ms} ms (the wire was event-silent for ${COMMENT_PHASE_MS + PROGRESS_PHASE_MS} ms before the summary)`, run.result !== undefined && run.error === undefined, (run.error?.message ?? '').slice(0, 300))
  check('the installed summary is the whole fixture summary', summaryOf(run).includes(SUMMARY_TEXT), summaryOf(run).slice(0, 200))
  check('one request on the wire, completed, with comments and progress-only frames written before the summary', req !== undefined && seen.filter(s => s.plan === 'heartbeats').length === 1 && req.finished && req.wrote.includes('comment') && req.wrote.some(w => w.startsWith('progress:')), j(req?.wrote))
  check(`the whole fold outlived the stall window by the heartbeat phases (≥ ${COMMENT_PHASE_MS + PROGRESS_PHASE_MS} ms)`, run.ms >= COMMENT_PHASE_MS + PROGRESS_PHASE_MS, String(run.ms))
  check('the debug log names the armed bound with its first-byte allowance for the small history', lines.some(l => /direct lane bound armed — first-byte allowance \d+ ms for ≈\d+ tokens, stall 2000 ms after the first event, wall 20000 ms/.test(l)), j(lines))
  check('no cut was logged', !lines.some(l => l.includes('direct lane cut for')), j(lines))
}

section('§4 (b) a wire with no bytes at all → cut at the first-byte allowance with the typed timeout sentence')
{
  plan = 'dead'
  debugLinesSince()
  const messages = makeMessages()
  const allowance = allowanceOf(tokenCountWithEstimation(messages as never))
  const run = await runFold(messages)
  const lines = debugLinesSince()
  const req = seen.at(-1)
  check('the fold REFUSED (no result)', run.result === undefined && run.error !== undefined)
  check('the refusal is the typed fold-timeout sentence', run.error?.message === ERROR_MESSAGE_FOLD_TIMEOUT, (run.error?.message ?? '').slice(0, 300))
  check(`the cut came at the allowance (${allowance} ms): fold ${run.ms} ms, within [${allowance}, ${allowance + 2_000}) and well before the ${DEADLINE_MS} ms wall`, run.ms >= allowance && run.ms < allowance + 2_000, String(run.ms))
  check('the conversation stands untouched (read state intact)', run.readFileState.size === 1, String(run.readFileState.size))
  check('the server saw the request and wrote not one byte', req !== undefined && req.plan === 'dead' && req.wrote.length === 0, j(req))
  const closed = await awaitClose(req, 3_000)
  console.log(`  [NOTE] the cut client's socket ${closed ? `closed ${(req?.closedAt ?? 0) - (req?.startedAt ?? 0)} ms after the request opened` : 'was still open 3 s after the cut (the transport pool reaps it later)'}`)
  check('the debug log names the clock: silence on the wire', lines.some(l => /direct lane cut for silence on the wire after \d+ ms — nothing folded/.test(l)), j(lines))
}

section(`§5 (c) a huge history (≈400k estimated tokens): the first byte lands after the old flat stall (${STALL_MS} ms) but inside the scaled allowance (6 s) → the fold LANDS`)
{
  const messages = makeMessages(400_000)
  const est = tokenCountWithEstimation(messages as never)
  const allowance = allowanceOf(est)
  check(`the history estimates to hundreds of thousands of tokens (${est}) and earns a ${allowance} ms allowance (> ${LATE_MS} ms late first byte > ${STALL_MS} ms stall)`, est >= 400_000 && allowance > LATE_MS && LATE_MS > STALL_MS, `${est} ${allowance}`)

  plan = 'late-first-byte'
  debugLinesSince()
  const late = await runFold(messages)
  const lateLines = debugLinesSince()
  const lateReq = seen.at(-1)
  check(`c1 no bytes at all for ${LATE_MS} ms, then the whole stream: the fold landed (${late.ms} ms)`, late.result !== undefined && late.error === undefined && summaryOf(late).includes(SUMMARY_TEXT), (late.error?.message ?? '').slice(0, 300))
  check('c1 one request, completed by the server after its late start', lateReq?.plan === 'late-first-byte' && lateReq.finished === true, j(lateReq))
  check(`c1 the armed bound names the scaled allowance (${allowance} ms for ≈${est} tokens)`, lateLines.some(l => l.includes(`direct lane bound armed — first-byte allowance ${allowance} ms for ≈${est} tokens`)), j(lateLines))

  plan = 'late-content'
  debugLinesSince()
  const content = await runFold(messages)
  const contentReq = seen.at(-1)
  check(`c2 headers + created + in_progress at once, then no bytes for ${LATE_MS} ms, then the summary: the fold landed (${content.ms} ms)`, content.result !== undefined && content.error === undefined && summaryOf(content).includes(SUMMARY_TEXT), (content.error?.message ?? '').slice(0, 300))
  check('c2 the server completed the stream', contentReq?.plan === 'late-content' && contentReq.finished === true, j(contentReq))
}

section('§6 (d) a wire that heartbeats forever without finishing → the wall-clock deadline still cuts it')
{
  const SHORT_WALL_MS = 5_000
  setFoldBoundsForTests({ deadlineMs: SHORT_WALL_MS, stallMs: STALL_MS, ingestMsPer1kTokens: INGEST_MS_PER_1K })
  plan = 'forever'
  debugLinesSince()
  const run = await runFold(makeMessages())
  const lines = debugLinesSince()
  const req = seen.at(-1)
  check('the fold REFUSED with the typed fold-timeout sentence', run.result === undefined && run.error?.message === ERROR_MESSAGE_FOLD_TIMEOUT, (run.error?.message ?? '').slice(0, 300))
  check(`the cut came at the wall (${SHORT_WALL_MS} ms): fold ${run.ms} ms, within [${SHORT_WALL_MS}, ${SHORT_WALL_MS + 2_500})`, run.ms >= SHORT_WALL_MS && run.ms < SHORT_WALL_MS + 2_500, String(run.ms))
  const beats = req?.wrote.filter(w => w === 'comment').length ?? 0
  check(`the server wrote comment lines the whole time (${beats} of them, never a summary)`, req !== undefined && req.plan === 'forever' && beats >= Math.floor((SHORT_WALL_MS - 500) / TICK_MS) && !req.finished, j(req))
  const closed = await awaitClose(req, 3_000)
  console.log(`  [NOTE] the cut client's socket ${closed ? `closed ${(req?.closedAt ?? 0) - (req?.startedAt ?? 0)} ms after the request opened` : 'was still open 3 s after the cut (the transport pool reaps it later)'}`)
  check('the debug log names the clock: the wall-clock deadline', lines.some(l => /direct lane cut for the wall-clock deadline after \d+ ms — nothing folded/.test(l)), j(lines))
  check('the conversation stands untouched', run.readFileState.size === 1, String(run.readFileState.size))
  setFoldBoundsForTests(null)
}

server.closeAllConnections?.()
await new Promise<void>(resolve => server.close(() => resolve()))
clearTimeout(guard)
console.log(`\n${failures === 0 ? 'ALL PASS' : `${failures} FAIL`} — ${checks} checks`)
process.exit(failures === 0 ? 0 : 1)
