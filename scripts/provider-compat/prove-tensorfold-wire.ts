#!/usr/bin/env bun
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const HOME = mkdtempSync(join(tmpdir(), 'tensorfold-wire-proof-'))
process.env.MERCURY_CONFIG_DIR = HOME
process.env.MERCURY_CREDENTIAL_STORE = 'file'
process.env.ANTHROPIC_API_KEY = 'proof-key-ci-gate-not-a-real-key'
delete process.env.MERCURY_LOCAL_API_KEY
delete process.env.MERCURY_LOCAL_BASE_URL

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t)
}

type Route = (req: IncomingMessage, body: string, res: ServerResponse) => boolean
function serve(route: Route): Promise<{ server: Server; root: string; port: number }> {
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
      resolve({ server, root: `http://127.0.0.1:${port}`, port })
    })
  })
}
function json(res: ServerResponse, status: number, body: unknown): true {
  res.writeHead(status, { 'content-type': 'application/json', server: 'TensorFold' })
  res.end(JSON.stringify(body))
  return true
}
const sse = (obj: unknown): string => `data: ${JSON.stringify(obj)}\n\n`

const FIXTURES = join(import.meta.dir, 'fixtures', 'tensorfold')
const fixture = (name: string): Record<string, unknown> => JSON.parse(readFileSync(join(FIXTURES, name), 'utf8')) as Record<string, unknown>
const FINISH = fixture('stream-finish-chunk.json')
const USAGE = fixture('stream-usage-chunk.json')
const WINDOW = 32768

const chatBodies: Record<string, unknown>[] = []
const tensorfold = await serve((req, body, res) => {
  const url = req.url ?? ''
  if (req.method === 'GET' && url === '/health') return json(res, 200, fixture('health-open.json'))
  if (req.method === 'GET' && /\/models$/.test(url)) return json(res, 200, { object: 'list', data: [{ id: 'qwen3.5-2b', object: 'model', created: 1793822261, owned_by: 'tensorfold', context_length: WINDOW, max_model_len: WINDOW, reasoning: { default_enabled: true } }] })
  if (req.method === 'POST' && url === '/v1/chat/completions') {
    const parsed = JSON.parse(body || '{}') as Record<string, unknown>
    chatBodies.push(parsed)
    const asked = typeof parsed.reasoning_effort === 'string' ? parsed.reasoning_effort : 'xhigh'
    const applied = asked === 'none' ? 'none' : asked === 'minimal' || asked === 'low' ? 'low' : asked === 'medium' ? 'medium' : 'xhigh'
    const runtime = { ...(FINISH.tensorfold as Record<string, unknown>), reasoning_effort: applied, enable_thinking: applied !== 'none' }
    res.writeHead(200, { 'content-type': 'text/event-stream', server: 'TensorFold' })
    res.write(sse({ id: 'c1', object: 'chat.completion.chunk', created: 1, model: 'qwen3.5-2b', choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }] }))
    if (applied !== 'none') res.write(sse({ id: 'c1', object: 'chat.completion.chunk', created: 1, model: 'qwen3.5-2b', choices: [{ index: 0, delta: { reasoning_content: 'Thinking.' }, finish_reason: null }] }))
    res.write(sse({ id: 'c1', object: 'chat.completion.chunk', created: 1, model: 'qwen3.5-2b', choices: [{ index: 0, delta: { content: 'Hello.' }, finish_reason: null }] }))
    res.write(sse({ ...FINISH, tensorfold: runtime }))
    res.write(sse({ ...USAGE, usage: { prompt_tokens: 640, completion_tokens: 3, total_tokens: 643, prompt_tokens_details: { cached_tokens: 512 }, completion_tokens_details: { reasoning_tokens: applied === 'none' ? 0 : 2 } } }))
    res.write('data: [DONE]\n\n')
    res.end()
    return true
  }
  return false
})
process.env.MERCURY_LOCAL_PROBE_TARGETS = `tensorfold=${tensorfold.root}`

const { enableConfigs } = await import('../../src/utils/config.ts')
enableConfigs()
const { refreshLocalDiscovery } = await import('../../src/services/providers/local/localDiscovery.ts')
const { localRecordFor } = await import('../../src/services/providers/local/localCatalogue.ts')
const { localLaneProfileFor, localModelAcceptsEffort, tensorFoldOutputCeiling } = await import('../../src/services/providers/local/localCallModel.ts')
const wire = await import('../../src/services/providers/openaicompat/compatWire.ts')
const { decodeTensorFoldRuntime, decodeCompatUsage } = await import('../../src/services/providers/openaicompat/compatChatClient.ts')
const { compatChatCallModel } = await import('../../src/services/providers/openaicompat/compatChatCallModel.ts')
const { effortVocabularyFor } = await import('../../src/utils/model/capabilities.ts')
const usageLedger = await import('../../src/services/providers/local/tensorfoldUsage.ts')

await refreshLocalDiscovery({ force: true })
const record = localRecordFor('local/qwen3.5-2b')
check('the fixture is discovered as a TensorFold record', record?.server === 'tensorfold' && record.thinkingDeclared === true, JSON.stringify(record))
if (record === undefined) {
  tensorfold.server.close()
  console.log('\nprove-tensorfold-wire: 1 FAILED')
  process.exit(1)
}

section('§1 effort → reasoning_effort plus a thinking budget per level; none at low and with thinking off')
{
  const extras = (effortValue: string | undefined, thinkingEnabled: boolean) => wire.buildLocalExtras({ wireModel: record.id, effortValue, thinkingEnabled, maxOutputTokensOverride: 4096, server: 'tensorfold', acceptsEffort: localModelAcceptsEffort(record) }) as { reasoning_effort?: string; thinking_budget?: number; max_tokens?: number; stream_options?: { include_usage?: boolean } }
  check('⌥T off ⇒ reasoning_effort none and no budget', extras('high', false).reasoning_effort === 'none' && extras('high', false).thinking_budget === undefined, JSON.stringify(extras('high', false)))
  check('low ⇒ none (thinking off at low)', extras('low', true).reasoning_effort === 'none' && extras('low', true).thinking_budget === undefined, JSON.stringify(extras('low', true)))
  check('medium ⇒ medium with a 4096 budget', extras('medium', true).reasoning_effort === 'medium' && extras('medium', true).thinking_budget === 4096, JSON.stringify(extras('medium', true)))
  check('high ⇒ high with a 16384 budget', extras('high', true).reasoning_effort === 'high' && extras('high', true).thinking_budget === 16384, JSON.stringify(extras('high', true)))
  check('xhigh ⇒ xhigh with a 32768 budget', extras('xhigh', true).reasoning_effort === 'xhigh' && extras('xhigh', true).thinking_budget === 32768)
  check('max ⇒ max with a 65536 budget', extras('max', true).reasoning_effort === 'max' && extras('max', true).thinking_budget === 65536)
  check('no effort asked ⇒ no field (the template default)', extras(undefined, true).reasoning_effort === undefined && extras(undefined, true).thinking_budget === undefined)
  check('include_usage and max_tokens ride every request', extras('high', true).stream_options?.include_usage === true && extras('high', true).max_tokens === 4096)
  const plain = wire.buildLocalExtras({ wireModel: 'x', effortValue: 'high', thinkingEnabled: true, maxOutputTokensOverride: undefined, server: 'tensorfold', acceptsEffort: false }) as { reasoning_effort?: string }
  check('a model without a thinking template gets no effort field', plain.reasoning_effort === undefined)
  const dial = effortVocabularyFor('local/qwen3.5-2b')
  check("the dial is Mercury's ladder low · medium · high · xhigh · max, thinking-gated with 'none' as the off word", dial.kind === 'provider' && JSON.stringify(dial.vocabulary) === JSON.stringify(['low', 'medium', 'high', 'xhigh', 'max']) && dial.thinkingGated === true && dial.thinkingOffWire === 'none', JSON.stringify(dial))
  check('the output ceiling stays within the served window', tensorFoldOutputCeiling(record) <= WINDOW && tensorFoldOutputCeiling(record) > 0, String(tensorFoldOutputCeiling(record)))
}

section('§2 the recorded chunks: the finish chunk carries the runtime block, the usage chunk the cached and reasoning tokens')
{
  const runtime = decodeTensorFoldRuntime(FINISH.tensorfold, FINISH.speculative)
  check('tokens per second, first token and prefill read from the finish chunk', runtime?.tokensPerSecond !== undefined && Math.round(runtime.tokensPerSecond) === 109 && runtime.timeToFirstTokenS !== undefined && runtime.prefillSeconds !== undefined, JSON.stringify(runtime))
  check('the applied effort and the thinking switch read from the finish chunk', runtime?.reasoningEffort === 'none' && runtime.thinking === false)
  check('no draft acceptance when nothing was drafted', runtime?.draftAcceptance === undefined)
  const usage = decodeCompatUsage(USAGE.usage as Record<string, unknown>)
  check('cached and reasoning tokens decode from the usage chunk', usage?.inputTokens === 18 && usage.outputTokens === 3 && usage.cachedInputTokens === 0 && usage.reasoningTokens === 0, JSON.stringify(usage))
  check('a chunk without the block yields no runtime', decodeTensorFoldRuntime(undefined) === undefined && decodeTensorFoldRuntime({}) === undefined)
}

section('§3 a turn through the local lane: the body, the corrected effort stamp, the /usage ledger')
const profile = localLaneProfileFor(record)
check('the profile posts to the chat-completions route', profile.requestUrl() === `${tensorfold.root}/v1/chat/completions`)
async function drive(thinking: boolean, effortValue: string): Promise<{ body: Record<string, unknown> | undefined; effort: Record<string, unknown> | undefined }> {
  const before = chatBodies.length
  let effort: Record<string, unknown> | undefined
  for await (const item of compatChatCallModel(profile, {
    messages: [{ type: 'user', message: { role: 'user', content: 'hi' }, uuid: '00000000-0000-4000-8000-000000000001', timestamp: new Date().toISOString() }] as never,
    systemPrompt: ['sys'] as never,
    thinkingConfig: (thinking ? { type: 'enabled', budget_tokens: 1024 } : { type: 'disabled' }) as never,
    tools: [] as never,
    signal: new AbortController().signal,
    options: { model: 'local/qwen3.5-2b', querySource: 'user', effortValue, getToolPermissionContext: async () => ({ mode: 'default' }) as never } as never,
  })) {
    const row = item as { type?: string; effort?: Record<string, unknown> }
    if (row.type === 'assistant' && row.effort !== undefined) effort = row.effort
  }
  return { body: chatBodies.length > before ? chatBodies.at(-1) : undefined, effort }
}
usageLedger.__resetTensorFoldUsageForTest()
const off = await drive(false, 'high')
check('⌥T off: the body carries reasoning_effort none and no budget', off.body?.reasoning_effort === 'none' && off.body?.thinking_budget === undefined, JSON.stringify({ reasoning_effort: off.body?.reasoning_effort, thinking_budget: off.body?.thinking_budget }))
check('⌥T off: max_tokens rides within the window', typeof off.body?.max_tokens === 'number' && off.body.max_tokens <= WINDOW, String(off.body?.max_tokens))
check('⌥T off: the stamp says thinking off', off.effort?.applied === 'thinking off', JSON.stringify(off.effort))
const on = await drive(true, 'high')
check('high: the body carries reasoning_effort high with the 16384 budget', on.body?.reasoning_effort === 'high' && on.body?.thinking_budget === 16384, JSON.stringify({ reasoning_effort: on.body?.reasoning_effort, thinking_budget: on.body?.thinking_budget }))
check('high: the stamp shows the level the engine applied (xhigh) beside the asked high', on.effort?.asked === 'high' && on.effort?.applied === 'xhigh' && String(on.effort?.wire).includes('reasoning_effort=high'), JSON.stringify(on.effort))
const turns = usageLedger.tensorFoldTurnReadings()
check('two turns in the /usage ledger', turns.length === 2, String(turns.length))
const last = turns.at(-1)
check('the ledger reads tok/s, decode seconds, first token, prefill, cached and reasoning tokens', last?.tokensPerSecond !== undefined && Math.round(last.tokensPerSecond) === 109 && last.decodeSeconds !== undefined && last.timeToFirstTokenS !== undefined && last.prefillSeconds !== undefined && last.promptTokens === 640 && last.cachedTokens === 512 && last.reasoningTokens === 2 && last.reasoningEffort === 'xhigh', JSON.stringify(last))
const lines = usageLedger.tensorFoldUsageLines()
check('the /usage lines name the last turn and the session (the average from decode time, as his benchmark page means tok/s)', lines.length === 2 && lines[0]!.startsWith('last turn · qwen3.5-2b · ~109 tok/s · first token in 58 ms · prefill 58 ms · 640 in (512 cached) · 3 out (2 thinking) · effort xhigh') && lines[1]!.startsWith('this session · 2 turns · ~109 tok/s on average · 1,280 in (1,024 cached · 80%) · 6 out'), JSON.stringify(lines))
check('the per-turn line carries no port, flag or path', !/--|\/Users|127\.0\.0\.1:\d+/.test(lines[0]!), lines[0])

section('§4 live: a turn on the 2B when it answers (skipped when it does not)')
const LIVE = process.env.MERCURY_TENSORFOLD_LIVE?.trim() || 'http://127.0.0.1:8087'
const liveAnswers = await (async () => {
  try {
    const response = await fetch(`${LIVE}/v1/models`, { signal: AbortSignal.timeout(1500) })
    const body = (await response.json()) as { data?: Array<{ owned_by?: string }> }
    return response.ok && body.data?.[0]?.owned_by === 'tensorfold'
  } catch {
    return false
  }
})()
if (!liveAnswers) {
  console.log(`  [SKIP] no TensorFold server answers at the live address — the live turn is not proven in this run`)
} else {
  process.env.MERCURY_LOCAL_PROBE_TARGETS = `tensorfold=${LIVE},tensorfold=${tensorfold.root}`
  await refreshLocalDiscovery({ force: true })
  const live = localRecordFor(`local/tensorfold/${(await (await fetch(`${LIVE}/v1/models`)).json() as { data: Array<{ id: string }> }).data[0]!.id}`) ?? localRecordFor('local/qwen3.5-2b')
  const liveRecord = live !== undefined && live.baseUrl === `${LIVE}/v1` ? live : undefined
  check('the live server is discovered as TensorFold with its window', liveRecord?.server === 'tensorfold' && liveRecord.contextWindow !== undefined, JSON.stringify(live))
  if (liveRecord !== undefined) {
    const liveProfile = localLaneProfileFor(liveRecord)
    usageLedger.__resetTensorFoldUsageForTest()
    const run = async (thinking: boolean, effortValue: string) => {
      let effort: Record<string, unknown> | undefined
      let text = ''
      for await (const item of compatChatCallModel(liveProfile, {
        messages: [{ type: 'user', message: { role: 'user', content: 'Reply with the single word hello.' }, uuid: '00000000-0000-4000-8000-000000000002', timestamp: new Date().toISOString() }] as never,
        systemPrompt: ['You answer in one word.'] as never,
        thinkingConfig: (thinking ? { type: 'enabled', budget_tokens: 1024 } : { type: 'disabled' }) as never,
        tools: [] as never,
        signal: AbortSignal.timeout(120_000),
        options: { model: `local/${liveRecord.id}`, querySource: 'user', effortValue, maxOutputTokensOverride: 64, getToolPermissionContext: async () => ({ mode: 'default' }) as never } as never,
      })) {
        const row = item as { type?: string; effort?: Record<string, unknown>; message?: { content?: Array<{ type: string; text?: string }> } }
        if (row.type === 'assistant') {
          if (row.effort !== undefined) effort = row.effort
          for (const block of row.message?.content ?? []) if (block.type === 'text' && block.text) text += block.text
        }
      }
      return { effort, text }
    }
    const liveOff = await run(false, 'high')
    const liveOffTurn = usageLedger.lastTensorFoldTurn()
    check('live ⌥T off: the engine reports no thinking and the ledger reads the reply', liveOffTurn?.reasoningEffort === 'none' && liveOffTurn.thinking === false && liveOffTurn.completionTokens > 0 && (liveOffTurn.reasoningTokens ?? 0) === 0, JSON.stringify(liveOffTurn))
    check('live ⌥T off: the stamp says thinking off', liveOff.effort?.applied === 'thinking off', JSON.stringify(liveOff.effort))
    check('live ⌥T off: a reply came back', liveOff.text.trim() !== '', liveOff.text)
    const liveOn = await run(true, 'medium')
    const liveOnTurn = usageLedger.lastTensorFoldTurn()
    check('live medium: the engine applied a thinking level and reports tok/s, first token and prefill', liveOnTurn?.thinking === true && liveOnTurn.reasoningEffort !== 'none' && liveOnTurn.tokensPerSecond !== undefined && liveOnTurn.tokensPerSecond > 0 && liveOnTurn.timeToFirstTokenS !== undefined && liveOnTurn.prefillSeconds !== undefined, JSON.stringify(liveOnTurn))
    check('live medium: usage carries the prompt, completion, cached and reasoning counts', liveOnTurn !== undefined && liveOnTurn.promptTokens > 0 && liveOnTurn.cachedTokens !== undefined && liveOnTurn.reasoningTokens !== undefined, JSON.stringify(liveOnTurn))
    check('live medium: the stamp shows the applied level', typeof liveOn.effort?.applied === 'string' && liveOn.effort.applied !== 'thinking off', JSON.stringify(liveOn.effort))
    console.log(`  live /usage: ${usageLedger.tensorFoldUsageLines().join(' | ')}`)
  }
}

tensorfold.server.close()
console.log(`\nprove-tensorfold-wire: ${failures === 0 ? 'ALL PASS' : `${failures} FAILED`}`)
process.exit(failures === 0 ? 0 : 1)
