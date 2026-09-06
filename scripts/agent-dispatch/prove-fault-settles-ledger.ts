#!/usr/bin/env bun
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

delete process.env.NODE_ENV
delete process.env.CI
for (const key of [
  'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN', 'MERCURY_MODEL', 'MERCURY_SCRIPTED_STREAM', 'MERCURY_BARE',
  'MERCURY_EFFORT_LEVEL', 'MERCURY_OPENAI_CHATGPT_BASE', 'MERCURY_AUTH_SCOPE_DIR',
]) delete process.env[key]
process.env.MERCURY_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'fault-ledger-'))
process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'

const ROOT = join(import.meta.dir, '..', '..')
let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
}
const guard = setTimeout(() => {
  console.log('\nTIMEOUT — the fault-settles-ledger prover exceeded 120s')
  process.exit(1)
}, 120_000)
guard.unref?.()

type Mode = 'drop-after-content' | 'complete'
let mode: Mode = 'drop-after-content'
let held: ServerResponse | null = null
let backstop: ReturnType<typeof setTimeout> | null = null
let sectionStart = Date.now()
const timeline: string[] = []
const mark = (what: string): void => {
  timeline.push(`+${String(Date.now() - sectionStart).padStart(5)}ms ${what}`)
}
const dropHeld = (by: 'consumer' | 'backstop'): void => {
  const r = held
  held = null
  if (backstop !== null) clearTimeout(backstop)
  backstop = null
  if (r === null) return
  mark(`destroy by ${by} (socket bytesWritten=${String(r.socket?.bytesWritten ?? '?')})`)
  r.destroy()
}
const PARTIAL = 'partial words that streamed before the connection dropped '
const hits: Array<{ method: string; path: string }> = []
const sse = (obj: unknown): string => `data: ${JSON.stringify(obj)}\n\n`
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
      input_modalities: ['text', 'image'],
      supported_in_api: true,
    },
  ],
}
const server = createServer((req: IncomingMessage, res: ServerResponse) => {
  const chunks: Buffer[] = []
  req.on('data', c => chunks.push(c as Buffer))
  req.on('end', () => {
    const path = (req.url ?? '').split('?')[0] ?? ''
    hits.push({ method: req.method ?? '', path })
    mark(`${req.method ?? ''} ${path} arrived (client port ${String(req.socket.remotePort ?? '?')})`)
    if (req.method === 'GET' && path.endsWith('/models')) {
      res.writeHead(200, { 'content-type': 'application/json', connection: 'close' })
      res.end(path.includes('/openai/') ? JSON.stringify(MODELS_BODY) : JSON.stringify({ object: 'list', data: [] }))
      return
    }
    const dialect = path.endsWith('/responses') ? 'responses' : path.endsWith('/chat/completions') ? 'chat' : undefined
    if (req.method !== 'POST' || dialect === undefined) {
      res.writeHead(404, { 'content-type': 'application/json' })
      res.end('{}')
      return
    }
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    if (dialect === 'chat') {
      res.write(sse({ id: 'chatcmpl-fixture', object: 'chat.completion.chunk', created: 0, model: 'fixture', choices: [{ index: 0, delta: { role: 'assistant', content: PARTIAL }, finish_reason: null }] }), () => mark(`chat content chunk flushed (${dialect})`))
      if (mode === 'complete') {
        res.write(sse({ id: 'chatcmpl-fixture', object: 'chat.completion.chunk', created: 0, model: 'fixture', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 1234, completion_tokens: 56, total_tokens: 1290 } }))
        res.end('data: [DONE]\n\n')
        return
      }
    } else {
      res.write(sse({ type: 'response.created', response: { id: 'resp_fixture' } }))
      res.write(sse({ type: 'response.output_text.delta', delta: PARTIAL }), () => mark('responses text delta flushed'))
      if (mode === 'complete') {
        res.write(sse({ type: 'response.output_item.done', item: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: PARTIAL }] } }))
        res.end(sse({ type: 'response.completed', response: { id: 'resp_fixture', usage: { input_tokens: 1234, output_tokens: 56, input_tokens_details: { cached_tokens: 0 } } } }))
        return
      }
    }
    held = res
    mark('response held open after the content chunk')
    if (backstop !== null) clearTimeout(backstop)
    backstop = setTimeout(() => {
      if (held === res) dropHeld('backstop')
    }, 2_000)
  })
})
await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
const address = server.address()
const base = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`
Object.assign(process.env, {
  MERCURY_DEEPSEEK_API_BASE: `${base}/deepseek`,
  DEEPSEEK_API_KEY: 'fixture-deepseek-key',
  MERCURY_ZAI_API_BASE: `${base}/zai/v4`,
  ZAI_API_KEY: 'fixture-zai-key',
  MERCURY_OPENAI_API_BASE: `${base}/openai/v1`,
  OPENAI_API_KEY: 'fixture-openai-key',
})

const { enableConfigs } = await import('../../src/utils/config.ts')
enableConfigs()
const bootstrap = await import('../../src/bootstrap/state.ts')
bootstrap.setIsInteractive(false)
const { routedCallModel } = await import('../../src/services/providers/callModelRouter.ts')
const { createUserMessage } = await import('../../src/utils/messages.ts')
const { asSystemPrompt } = await import('../../src/utils/systemPromptType.ts')
const { getEmptyToolPermissionContext } = await import('../../src/Tool.ts')
const ledger = await import('../../src/cost-tracker.ts')

type Drive = { yielded: Array<Record<string, unknown>>; thrown: string | null; usage: ReturnType<typeof ledger.getUsageForModel>; cost: number; apiMs: number }
async function drive(model: string): Promise<Drive> {
  ledger.resetCostState()
  const abort = new AbortController()
  const yielded: Array<Record<string, unknown>> = []
  let thrown: string | null = null
  try {
    const stream = routedCallModel({
      messages: [createUserMessage({ content: 'the operator asks for a long answer about the ledger ' + 'x'.repeat(400) })] as never,
      systemPrompt: asSystemPrompt(['You are the fault fixture. ' + 'y'.repeat(800)]),
      thinkingConfig: { type: 'disabled' },
      tools: [],
      signal: abort.signal,
      options: {
        getToolPermissionContext: () => Promise.resolve(getEmptyToolPermissionContext()),
        model,
        isNonInteractiveSession: true,
        hasAppendSystemPrompt: false,
        querySource: 'agent' as never,
        agents: [],
        mcpTools: [],
      },
    } as never)
    for await (const event of stream) {
      yielded.push(event as Record<string, unknown>)
      const item = event as { type?: string; event?: { type?: string; delta?: { type?: string; text?: string } } }
      const deltaText = item.event?.type === 'content_block_delta' && item.event.delta?.type === 'text_delta' ? (item.event.delta.text ?? '') : undefined
      mark(`consumer saw ${item.type ?? '?'}${item.event?.type !== undefined ? `/${item.event.type}` : ''}${deltaText !== undefined ? ` "${deltaText.slice(0, 24)}"` : ''}`)
      if (mode === 'drop-after-content' && deltaText !== undefined && deltaText.includes('partial words')) dropHeld('consumer')
    }
  } catch (e) {
    thrown = String(e)
  }
  return { yielded, thrown, usage: ledger.getUsageForModel(model), cost: ledger.getTotalCost(), apiMs: ledger.getTotalAPIDuration() }
}
const assistantText = (d: Drive): string =>
  d.yielded
    .filter(e => e.type === 'assistant')
    .map(e => JSON.stringify((e as { message?: { content?: unknown } }).message?.content ?? ''))
    .join(' ')

console.log('============================================================')
console.log(' a faulted stream still joins the ledger — three lanes')
console.log('============================================================')

const LANES: Array<{ title: string; model: string; ledgerKey?: string }> = [
  { title: '§1 DeepSeek (the shared compat runtime)', model: 'deepseek-v4-flash' },
  { title: '§2 Z.AI (the native GLM runtime)', model: 'glm-5.3' },
  { title: '§3 OpenAI (the Responses runtime)', model: 'gpt-5.6-sol' },
]
for (const lane of LANES) {
  section(`${lane.title}: the socket drops after a content chunk — the request still joins the ledger`)
  mode = 'drop-after-content'
  hits.length = 0
  timeline.length = 0
  sectionStart = Date.now()
  const d = await drive(lane.model)
  check('the routed call ended without throwing (the honest-settlement contract)', d.thrown === null, d.thrown ?? '')
  check('the partial words reached the consumer', assistantText(d).includes('partial words that streamed'), assistantText(d).slice(0, 160))
  const usage = d.usage ?? ledger.getModelUsage()[Object.keys(ledger.getModelUsage())[0] ?? ''] 
  check('THE LEDGER HOLDS THE FAULTED REQUEST (the base recorded nothing)', usage !== undefined, JSON.stringify(ledger.getModelUsage()))
  check('…with the prompt as sent estimated on the input side', (usage?.inputTokens ?? 0) > 200, String(usage?.inputTokens))
  check('…and the streamed words estimated on the output side', (usage?.outputTokens ?? 0) >= 10, String(usage?.outputTokens))
  check('…priced (a recorded pin, or the flagged fallback — never $0.00 for a billed request)', d.cost > 0, String(d.cost))
  const starts = d.yielded.filter(e => e.type === 'stream_event' && (e as { event?: { type?: string } }).event?.type === 'message_start').length
  check('the lane ran exactly ONE attempt (one message_start reached the consumer — no retry after content)', starts === 1, `message_start ×${starts}`)
  check('exactly one request reached the wire (no retry after content)', hits.filter(h => h.method === 'POST').length === 1, JSON.stringify(hits))
  console.log(`  timeline (${lane.model}):\n    ${timeline.join('\n    ')}`)
  check("the API-duration ledger holds the turn's provider time (FN-018 rank 11: these lanes never wrote it)", d.apiMs > 0, String(d.apiMs))
}

section('§4 control: a completed stream records the wire\'s own usage, never an estimate on top')
{
  mode = 'complete'
  timeline.length = 0
  sectionStart = Date.now()
  const d = await drive('deepseek-v4-flash')
  check('the completed stream settled without throwing', d.thrown === null, d.thrown ?? '')
  const usage = d.usage ?? ledger.getModelUsage()[Object.keys(ledger.getModelUsage())[0] ?? '']
  check("the wire's prompt count is what the ledger holds (1234)", usage?.inputTokens === 1234, JSON.stringify(usage))
  check("the wire's completion count (56)", usage?.outputTokens === 56)
  check('a completed compat turn writes the API duration too', d.apiMs > 0, String(d.apiMs))
}

section('§5 the shape')
{
  for (const file of ['src/services/providers/openai/openaiCallModel.ts', 'src/services/providers/openaicompat/compatChatCallModel.ts', 'src/services/providers/zai/zaiCallModel.ts']) {
    const src = readFileSync(join(ROOT, file), 'utf8')
    check(`${file.split('/').pop()}: settles a faulted request at the estimate before the usage-gated ledger call`, /if \(!usageSeen && fault !== undefined\) \{[\s\S]*?estimateFaultedRequestUsage\(/.test(src))
  }
  const helper = readFileSync(join(ROOT, 'src/services/providers/faultUsageEstimate.ts'), 'utf8')
  check('the estimate rides the one character-ratio estimator over the request as sent and the minted blocks', /roughTokenCountEstimation\(/.test(helper) && /requestCharsOf\(args\.request\)/.test(helper) && /streamedCharsOf\(args\.minted\)/.test(helper))
}

server.close()
console.log(`\n${failures === 0 ? 'PASS' : 'FAIL'} prove-fault-settles-ledger${failures ? ` (${failures} failure(s))` : ''}`)
process.exit(failures === 0 ? 0 : 1)
