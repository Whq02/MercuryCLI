import { strict as assert } from 'node:assert'
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const home = mkdtempSync(join(tmpdir(), 'openai-readonly-auth-'))
process.env.MERCURY_CONFIG_DIR = home
process.env.MERCURY_CREDENTIAL_STORE = 'file'
process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'
process.env.MERCURY_OPENAI_CHATGPT_BASE = 'http://127.0.0.1:9'
process.env.MERCURY_OPENAI_AUTH_BASE = 'http://127.0.0.1:9'
for (const key of ['MERCURY_HOME', 'MERCURY_AUTH_SCOPE_DIR', 'OPENAI_API_KEY']) delete process.env[key]
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

const { resolveOpenaiRequestAuth } = await import('../../src/services/providers/openai/openaiAccounts.js')
const file = join(home, '.openai-auth.json')
let refreshCalls = 0
const fetchImpl = (async () => { refreshCalls++; throw new Error('fixture refresh refused') }) as typeof fetch
try {
  for (const expires of [Date.now() - 1, undefined, Date.now() + 3_600_000]) {
    const stored = JSON.stringify({ version: 1, tokens: { accessToken: 'fixture-access', refreshToken: 'fixture-refresh', idToken: 'fixture-id', accountId: 'fixture-account', ...(expires !== undefined ? { accessTokenExpiresAtMs: expires } : {}) } })
    writeFileSync(file, stored, { mode: 0o600 })
    const auth = await resolveOpenaiRequestAuth({ sourceKind: 'chatgpt-subscription', readOnly: true, fetchImpl })
    assert.equal(refreshCalls, 0)
    assert.equal(readFileSync(file, 'utf8'), stored)
    assert.deepEqual(readdirSync(home), ['.openai-auth.json'])
    if (expires !== undefined && expires > Date.now()) {
      assert.ok(auth)
      assert.equal(auth.baseUrl, 'http://127.0.0.1:9')
      assert.equal(auth.headers.authorization, 'Bearer fixture-access')
      assert.equal(auth.headers['ChatGPT-Account-Id'], 'fixture-account')
    } else assert.equal(auth, undefined)
  }
  console.log('PASS read-only request auth: fresh credentials resolve; expired or undated credentials do not refresh, create locks or write stores')
  const { ResponsesStreamFold } = await import('../../src/services/providers/openai/openaiWire.js')
  const { streamOneOpenaiAttempt, replayableItems, toBridgeMessages } = await import('../../src/services/providers/openai/openaiCallModel.js')
  const { buildOpenaiResponsesRequest } = await import('../../src/services/providers/openai/responsesBridge.js')
  const { createUserMessage } = await import('../../src/utils/messages.js')
  const model = 'gpt-6.1-terra'
  const catalogue = await import('../../src/services/providers/openai/openaiCatalogue.js')
  const { getContextWindowForModel } = await import('../../src/utils/context.js')
  const { resolveEffortTruth, resolveStampedEffortTruth } = await import('../../src/utils/effort.js')
  await catalogue.refreshOpenaiCatalogue('chatgpt-subscription', { force: true, fetchImpl: (async () => new Response(JSON.stringify({ models: [{ slug: model, display_name: 'GPT-6.1 Terra', default_reasoning_level: 'low', supported_reasoning_levels: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'], visibility: 'list', priority: 3, supported_in_api: true, context_window: 500_000, max_context_window: 872_000, input_modalities: ['text', 'image'] }] }), { headers: { 'content-type': 'application/json' } })) as typeof fetch })
  assert.equal(getContextWindowForModel(model), 872_000)
  assert.equal(getContextWindowForModel(`${model}[served]`), 500_000)
  assert.equal(resolveEffortTruth(model, undefined).wire, 'low')
  assert.equal(resolveEffortTruth(model, 'max').label, 'max')
  assert.equal(resolveStampedEffortTruth(model, 'max').wire, 'max')
  assert.ok(!(resolveEffortTruth(model, undefined).selectable as readonly string[]).includes('ultra'))
  console.log('PASS subscription catalogue shape read 2026-10-28: source window and default win, max stays max, unranked list word is not offered')
  const chunks = Array.from({ length: 11 }, (_, i) => ({ type: 'reasoning' as const, id: `rs_fixture_${i}`, summary: [], content: [], encrypted_content: `fixture-opaque-${i}` }))
  const answer = { type: 'message' as const, role: 'assistant' as const, phase: 'final_answer' as const, content: [{ type: 'output_text' as const, text: 'Fixture complete.' }] }
  const items = [...chunks, answer]
  const fold = new ResponsesStreamFold()
  const source = (async function* () {
    yield* fold.fold({ type: 'response.created', response: { id: 'resp_fixture' } })
    for (const item of items) yield* fold.fold({ type: 'response.output_item.done', item })
    yield* fold.fold({ type: 'response.completed', response: { usage: { input_tokens: 100, input_tokens_details: { cached_tokens: 0, cache_write_tokens: 0 }, output_tokens: 5800, output_tokens_details: { reasoning_tokens: 5200 } } } })
  })()
  const settled: import('../../src/types/message.js').AssistantMessage[] = []
  const generator = streamOneOpenaiAttempt({ _eventsForTesting: source, request: buildOpenaiResponsesRequest({ model, messages: [{ role: 'user', content: 'Fixture.' }], reasoningEffort: 'max' }), auth: { baseUrl: 'http://127.0.0.1:9', headers: {}, account: { provider: 'openai', kind: 'api-key', label: 'fixture' } }, signal: new AbortController().signal, tools: [], options: { querySource: 'sdk' } as never, modelId: model, messages: [], settlementNotes: [], contractDigest: 'fixture' })
  for await (const event of generator) if (event.type === 'assistant') settled.push(event)
  assert.deepEqual(settled.at(-1)?.apexProviderTurn?.items, items)
  assert.equal(settled.at(-1)?.apexProviderTurn?.providerUsage?.reasoningOutputTokens, 5200)
  const restored = JSON.parse(JSON.stringify(settled))
  const bridge = toBridgeMessages([...restored, createUserMessage({ content: 'Continue the fixture.' })], model)
  const next = buildOpenaiResponsesRequest({ model, messages: bridge.rows, reasoningEffort: 'max' })
  assert.deepEqual(next.input.slice(0, items.length), items)
  assert.equal(next.reasoning?.effort, 'max')
  assert.equal(next.store, false)
  assert.deepEqual(next.include, ['reasoning.encrypted_content'])
  const call = { type: 'function_call' as const, call_id: 'fixture-call', name: 'Echo', arguments: '{}' }
  assert.deepEqual(replayableItems([...chunks, call, answer], [{ id: call.call_id, code: 'missing-id' }]), [answer])
  assert.deepEqual(replayableItems([...chunks, call, ...chunks, call], [{ id: call.call_id, code: 'duplicate-id' }]), [...chunks, call])
  assert.deepEqual(replayableItems([answer, ...chunks], []), [answer])
  console.log('PASS Terra live shape: all eleven consecutive encrypted reasoning items survive settlement, disk decoding and next-turn replay; refused, duplicate and stranded groups remain excluded')
} finally { rmSync(home, { recursive: true, force: true }) }
process.exit(0)
