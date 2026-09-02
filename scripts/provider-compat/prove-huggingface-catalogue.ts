#!/usr/bin/env bun
// ============================================================================
//  scripts/provider-compat/prove-huggingface-catalogue.ts — the Hugging Face router
//  catalogue, the capability edge it feeds, the picker honesty grammar, and
//  the lane's wire — entirely against injected fetch fixtures (no network,
//  no key, no billables).
//
//  The catalogue fixture is FIVE rows copied VERBATIM from the live answer of
//  GET https://router.huggingface.co/v1/models on 2026-08-22
//  (fixtures/huggingface-models-2026-08-22.json): two 1M-context flagships,
//  Kimi-K3 (one provider states no context), gpt-oss-120b (eleven
//  providers), and a Cohere row whose only provider states
//  supports_tools:false.
//
//    1. DECODE: stated fields only — absent ≠ zero; provider flags kept.
//    2. DERIVED FACTS: the context window is the named provider's width or
//       the widest live one (policy suffixes read as bare); tool support is
//       refused only when every reachable provider states false. The
//       snapshot is seeded through a CREDENTIALED fetch — the catalogue
//       door (catalogueGate) refuses an uncredentialed one outright.
//    3. THE CAPABILITY EDGE: resolveContextWindow budgets a 1M slug at 1M
//       (live-current), a pin stands in when the catalogue is empty, the
//       kill-switch clamps, no effort dial is offered.
//    4. AVAILABILITY + PICKER ROWS + THE DOOR: signed-out ⇒ NO request
//       (the refusal is a non-event) and the ONE connect row saying the
//       ruled sentence ("connect Hugging Face to browse its models");
//       signed-in ⇒ selectable rows in the router's order (+ the summary
//       row past the bound); catalogue failed ⇒ the dated pins stand in,
//       selectable, retry row first; a refused credential ⇒ the
//       auth-invalid sign-in row; credentialed + the essential-traffic
//       switch ⇒ NO request and the row that names the switch.
//    5. THE WIRE: request truth (bearer, X-HF-Bill-To only when pinned,
//       tool_choice auto kept, include_usage, no reasoning_effort), the
//       documented stream decode (content deltas, index-keyed tool-call
//       fragments, the usage chunk before [DONE]), the observed 401 string
//       error, 429 + Retry-After folding into the limit window, the draft
//       RateLimit header, and the tool-capability refusal text.
//
//  Run:  ~/.bun/bin/bun run scripts/provider-compat/prove-huggingface-catalogue.ts
// ============================================================================
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HOME = mkdtempSync(join(tmpdir(), 'huggingface-catalogue-proof-'))
process.env.MERCURY_CONFIG_DIR = HOME
process.env.MERCURY_CREDENTIAL_STORE = 'file'
delete process.env.HF_TOKEN
delete process.env.MERCURY_HUGGINGFACE_BILL_TO
delete process.env.MERCURY_DISABLE_1M_CONTEXT
process.env.MERCURY_HUGGINGFACE_HUB_BASE = 'https://hub.fixture.example'
process.env.MERCURY_HUGGINGFACE_API_BASE = 'https://router.fixture.example/v1'
process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'

const { enableConfigs } = await import('../../src/utils/config.ts')
enableConfigs()

const catalogue = await import('../../src/services/providers/huggingface/huggingfaceCatalogue.ts')
const {
  decodeHuggingfaceModel,
  refreshHuggingfaceCatalogue,
  getCachedHuggingfaceCatalogue,
  huggingfaceLiveContextWindow,
  huggingfaceLiveSupportsTools,
  huggingfaceContextWindowFor,
  getHuggingfaceAvailability,
  getHuggingfaceModelOptions,
  HUGGINGFACE_CONNECT_OPTION_VALUE,
  HUGGINGFACE_MODEL_GROUP,
  __resetHuggingfaceCatalogueForTest,
} = catalogue
const { HUGGINGFACE_DISPLAY_PINS, splitHuggingfaceSlug, huggingfaceDisplayPin } = await import(
  '../../src/services/providers/huggingface/huggingfacePins.ts'
)
const { writeHuggingfaceTokens, huggingfaceChatCompletionsUrl } = await import(
  '../../src/services/providers/huggingface/huggingfaceAccounts.ts'
)
const { writeStoredHuggingfaceApiKey } = await import('../../src/utils/router/providerSecrets.ts')
const { resolveContextWindow, modelSupportsEffort, modelSupportsMaxEffort } = await import(
  '../../src/utils/model/capabilities.ts'
)
const { huggingfaceLaneProfile } = await import('../../src/services/providers/huggingface/huggingfaceCallModel.ts')
const { buildHuggingfaceExtras } = await import('../../src/services/providers/openaicompat/compatWire.ts')
const { streamCompatChat, mapCompatHttpFailure } = await import(
  '../../src/services/providers/openaicompat/compatChatClient.ts'
)
type CompatStreamEvent = import('../../src/services/providers/openaicompat/compatChatClient.ts').CompatStreamEvent
const usageState = await import('../../src/services/providers/huggingface/huggingfaceUsageState.ts')
const { recordHuggingfaceRateHeaders, huggingfaceLimitWindow, huggingfaceObservedRate, parseRateLimitHeader, __resetHuggingfaceUsageStateForTest } = usageState
const { providerFrontierFact } = await import('../../src/utils/model/providerFrontier.ts')

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t)
}
function jsonResponse(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } })
}

const FIXTURE_PATH = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'huggingface-models-2026-08-22.json')
const FIXTURE = JSON.parse(readFileSync(FIXTURE_PATH, 'utf8')) as { object: string; data: unknown[] }
const catalogueFetch = (async (url: unknown) =>
  String(url).endsWith('/models') ? jsonResponse(200, FIXTURE) : jsonResponse(404, {})) as typeof fetch

section('1 · decode: stated fields only')
{
  const rows = FIXTURE.data.map(decodeHuggingfaceModel)
  check('every verbatim row decodes', rows.every(r => r !== undefined) && rows.length === 5)
  const pro = rows.find(r => r?.id === 'deepseek-ai/DeepSeek-V4-Pro-0813')!
  check('provider records keep the documented fields', pro.providers.length === 4 && pro.providers[0]!.provider === 'novita' && pro.providers[0]!.status === 'live' && pro.providers[0]!.contextLength === 1_048_576 && pro.providers[0]!.pricing?.input === 1.32 && pro.providers[0]!.supportsTools === true)
  const fireworks = pro.providers.find(p => p.provider === 'fireworks-ai')!
  check('an unstated price stays ABSENT (never zero)', fireworks.pricing === undefined && fireworks.contextLength === 1_048_576)
  const kimi = rows.find(r => r?.id === 'moonshotai/Kimi-K3')!
  const featherless = kimi.providers.find(p => p.provider === 'featherless-ai')!
  check('a provider stating no context/tools decodes with those fields absent', featherless.contextLength === undefined && featherless.supportsTools === undefined)
  check('architecture modalities decode', kimi.inputModalities?.includes('image') === true)
  check('a malformed row is skipped', decodeHuggingfaceModel({ object: 'model' }) === undefined)
}

section('2 · derived facts over the live snapshot (seeded through the door, credentialed)')
{
  __resetHuggingfaceCatalogueForTest()
  // The catalogue door: an uncredentialed refresh is a NON-EVENT — no
  // request leaves, nothing is cached (the wire would answer anonymously;
  // Mercury never asks anonymously).
  let doorCalls = 0
  const countingFetch = (async (url: unknown) => {
    doorCalls++
    return String(url).endsWith('/models') ? jsonResponse(200, FIXTURE) : jsonResponse(404, {})
  }) as typeof fetch
  const refused = await refreshHuggingfaceCatalogue({ fetchImpl: countingFetch, force: true })
  check('signed out, the door refuses: zero requests, nothing cached', refused === null && doorCalls === 0 && getCachedHuggingfaceCatalogue() === null)
  writeStoredHuggingfaceApiKey('hf_stored_fixture_token_00001')
  const snapshot = await refreshHuggingfaceCatalogue({ fetchImpl: catalogueFetch, force: true })
  check('the credentialed fetch lands, keyed to its credential (never anonymous)', snapshot !== null && snapshot.key.startsWith('stored:') && snapshot.models.length === 5 && snapshot.fetchedAtMs > 0)
  check('the widest live provider states the window', huggingfaceLiveContextWindow('deepseek-ai/DeepSeek-V4-Pro-0813') === 1_048_576)
  check('Qwen3.8: together 1,010,000 beats fireworks 262,144', huggingfaceLiveContextWindow('Qwen/Qwen3.8-2.4T-A95B') === 1_010_000)
  check('a :provider suffix picks that provider\'s width', huggingfaceLiveContextWindow('Qwen/Qwen3.8-2.4T-A95B:fireworks-ai') === 262_144)
  check('a :policy suffix reads as the bare slug', huggingfaceLiveContextWindow('Qwen/Qwen3.8-2.4T-A95B:cheapest') === 1_010_000)
  check('an unlisted provider suffix states nothing', huggingfaceLiveContextWindow('Qwen/Qwen3.8-2.4T-A95B:nobody') === undefined)
  check('lookups are case-insensitive on the slug', huggingfaceLiveContextWindow('qwen/qwen3.8-2.4t-a95b') === 1_010_000)
  check('tool support: true when a reachable provider states it', huggingfaceLiveSupportsTools('openai/gpt-oss-120b') === true)
  check('tool support: FALSE when every reachable provider states false', huggingfaceLiveSupportsTools('CohereLabs/tiny-aya-fire') === false)
  check('tool support: unstated for an unlisted slug', huggingfaceLiveSupportsTools('nobody/nothing') === undefined)
  check('the namespaced accessor reads live first', huggingfaceContextWindowFor('huggingface/moonshotai/Kimi-K3')?.source === 'live-current')
  check('splitHuggingfaceSlug keeps a colon-free slug whole', splitHuggingfaceSlug('openai/gpt-oss-120b').suffix === undefined && splitHuggingfaceSlug('openai/gpt-oss-120b:groq').suffix === 'groq')
  check('the frontier fact is the live head, undated', providerFrontierFact('huggingface')?.modelId === 'huggingface/deepseek-ai/DeepSeek-V4-Pro-0813' && providerFrontierFact('huggingface')?.observedAt === undefined)
}

section('3 · the capability edge')
{
  const live = resolveContextWindow('huggingface/deepseek-ai/DeepSeek-V4-Pro-0813')
  check('a 1M catalogue slug budgets at 1M from the live row', live.effectiveWindow === 1_048_576 && live.source === 'live-current')
  const suffixed = resolveContextWindow('huggingface/Qwen/Qwen3.8-2.4T-A95B:fireworks-ai')
  check('the suffixed slug budgets at the named provider\'s width', suffixed.effectiveWindow === 262_144)
  process.env.MERCURY_DISABLE_1M_CONTEXT = '1'
  const clamped = resolveContextWindow('huggingface/deepseek-ai/DeepSeek-V4-Pro-0813')
  check('the 1M kill-switch clamps to the conservative default and says so', clamped.effectiveWindow === 200_000 && (clamped.fallbackReason ?? '').includes('kill-switch'))
  delete process.env.MERCURY_DISABLE_1M_CONTEXT
  __resetHuggingfaceCatalogueForTest()
  const pinned = resolveContextWindow('huggingface/zai-org/GLM-5.2')
  check('with no catalogue the dated pin stands in (static-pin)', pinned.effectiveWindow === 1_048_576 && pinned.source === 'static-pin' && huggingfaceDisplayPin('zai-org/GLM-5.2')?.observedAt === '2026-08-22')
  const unknown = resolveContextWindow('huggingface/nobody/unpinned-model')
  check('an unlisted, unpinned slug falls to the conservative default, labelled', unknown.effectiveWindow === 200_000 && unknown.source === 'fallback')
  check('no effort dial is offered (display equals dispatch)', modelSupportsEffort('huggingface/openai/gpt-oss-120b') === false && modelSupportsMaxEffort('huggingface/openai/gpt-oss-120b') === false)
  check('every pin carries an observation date', HUGGINGFACE_DISPLAY_PINS.every(p => /^\d{4}-\d{2}-\d{2}$/.test(p.observedAt)))
}

section('4 · availability + the picker rows + the door')
{
  // Signed out (the stored key cleared): NO request, the ONE honest row.
  writeStoredHuggingfaceApiKey(null)
  __resetHuggingfaceCatalogueForTest()
  let outCalls = 0
  const outCounting = (async () => {
    outCalls++
    return jsonResponse(200, FIXTURE)
  }) as typeof fetch
  await refreshHuggingfaceCatalogue({ fetchImpl: outCounting, force: true })
  const signedOut = getHuggingfaceAvailability()
  check('signed out: zero requests through the door', outCalls === 0)
  check('signed out: disabled/no-account saying the ruled sentence, no lineup advertised', signedOut.state === 'disabled' && signedOut.why === 'no-account' && signedOut.reason.includes('connect Hugging Face to browse its models') && signedOut.liveIds.length === 0)
  const outRows = getHuggingfaceModelOptions()
  check('signed out: the face is the ONE sign-in row', outRows.length === 1 && outRows[0]?.value === HUGGINGFACE_CONNECT_OPTION_VALUE && outRows[0].label.includes('sign in'))
  check('signed out: the row says the ruled sentence', (outRows[0]?.description ?? '').includes('connect Hugging Face to browse its models'))
  check('every row carries the group heading', outRows.every(r => r.group === HUGGINGFACE_MODEL_GROUP))
  writeStoredHuggingfaceApiKey('hf_stored_fixture_token_00001')
  __resetHuggingfaceCatalogueForTest()
  await refreshHuggingfaceCatalogue({ fetchImpl: catalogueFetch, force: true })
  const ready = getHuggingfaceAvailability()
  check('signed in: ready with the live count and the source label', ready.state === 'ready' && ready.modelCount === 5 && ready.keySource === 'stored' && ready.source.includes('stored'))
  const inRows = getHuggingfaceModelOptions()
  check('signed in: live rows selectable, no action row', inRows.length === 5 && inRows.every(r => r.unavailable === undefined && r.value?.startsWith('huggingface/')))
  // The neutrality ruling: model rows carry NO description —
  // the widest stated window rides the typed statedContextWindow (the ctx
  // column); price/provider/tool facts are the capability owners' to
  // answer, never row copy.
  check('live rows carry no description (the neutral grammar)', inRows.every(r => r.description === ''), JSON.stringify(inRows.map(r => [r.value, r.description])))
  check('the widest stated window rides the typed statedContextWindow', inRows[0]?.statedContextWindow === 1_048_576, String(inRows[0]?.statedContextWindow))
  // Catalogue failure with a credential: the dated pins stand in, selectable.
  __resetHuggingfaceCatalogueForTest()
  const failing = (async () => jsonResponse(503, { error: 'down' })) as typeof fetch
  await refreshHuggingfaceCatalogue({ fetchImpl: failing, force: true })
  const pending = getHuggingfaceAvailability()
  check('catalogue failed: still ready (credential present) with the honest note', pending.state === 'ready' && pending.modelCount === 0 && (pending.catalogueNote ?? '').includes('HTTP 503'))
  const pinRows = getHuggingfaceModelOptions()
  check('catalogue failed: the retry row leads and the dated pins stand in, SELECTABLE, no description (the pin window rides the typed field)', pinRows[0]?.value === HUGGINGFACE_CONNECT_OPTION_VALUE && pinRows.length === 1 + HUGGINGFACE_DISPLAY_PINS.length && pinRows.slice(1).every(r => r.unavailable === undefined && r.description === '' && r.statedContextWindow !== undefined))
  // A refused credential.
  __resetHuggingfaceCatalogueForTest()
  const refusing = (async () => jsonResponse(401, { error: 'Invalid username or password.' })) as typeof fetch
  await refreshHuggingfaceCatalogue({ fetchImpl: refusing, force: true })
  const invalid = getHuggingfaceAvailability()
  check('a refused credential answers auth-invalid with the re-connect route', invalid.state === 'disabled' && invalid.why === 'auth-invalid')
  // The summary row past the bound.
  __resetHuggingfaceCatalogueForTest()
  const many = { object: 'list', data: Array.from({ length: 30 }, (_, i) => ({ id: `org/model-${i}`, object: 'model', providers: [{ provider: 'novita', status: 'live', context_length: 1000 }] })) }
  const manyFetch = (async () => jsonResponse(200, many)) as typeof fetch
  await refreshHuggingfaceCatalogue({ fetchImpl: manyFetch, force: true })
  const bounded = getHuggingfaceModelOptions()
  check('the picker bounds the rows and appends the honest summary row', bounded.length === 25 && bounded[24]?.label.includes('30 models live') && bounded[24]?.unavailable !== undefined)
  // Credentialed + MERCURY_DISABLE_NONESSENTIAL_TRAFFIC: the switch stops
  // catalogue traffic outright — zero requests; the pins stand in behind
  // the row that names the switch (dispatch stays essential).
  __resetHuggingfaceCatalogueForTest()
  process.env.MERCURY_DISABLE_NONESSENTIAL_TRAFFIC = '1'
  let darkCalls = 0
  const darkCounting = (async () => {
    darkCalls++
    return jsonResponse(200, FIXTURE)
  }) as typeof fetch
  const dark = await refreshHuggingfaceCatalogue({ fetchImpl: darkCounting, force: true })
  check('switch on: zero requests through the door (credentialed included)', dark === null && darkCalls === 0)
  const darkAvailability = getHuggingfaceAvailability()
  check('switch on: ready (dispatch stays essential) with the note naming the switch', darkAvailability.state === 'ready' && darkAvailability.modelCount === 0 && (darkAvailability.catalogueNote ?? '').includes('MERCURY_DISABLE_NONESSENTIAL_TRAFFIC'))
  const darkRows = getHuggingfaceModelOptions()
  check('switch on: the action row names the switch (no lying retry) and the dated pins stand in, selectable', darkRows[0]?.label === 'Hugging Face — catalogue off' && (darkRows[0]?.description ?? '').includes('MERCURY_DISABLE_NONESSENTIAL_TRAFFIC') && darkRows.length === 1 + HUGGINGFACE_DISPLAY_PINS.length && darkRows.slice(1).every(r => r.unavailable === undefined))
  delete process.env.MERCURY_DISABLE_NONESSENTIAL_TRAFFIC
  writeStoredHuggingfaceApiKey(null)
}

section('5 · the wire')
{
  writeHuggingfaceTokens({ accessToken: 'hf_oauth_fixture_access_0000000009' }, { username: 'u', observedAtMs: 1 })
  const extras = buildHuggingfaceExtras({ wireModel: 'openai/gpt-oss-120b', effortValue: 'high', thinkingEnabled: true, maxOutputTokensOverride: undefined })
  check('extras: include_usage only; no reasoning_effort; no max_tokens without an override', JSON.stringify(extras) === JSON.stringify({ stream_options: { include_usage: true } }))
  check('extras: max_tokens rides only on an explicit override', buildHuggingfaceExtras({ wireModel: 'x', effortValue: undefined, thinkingEnabled: false, maxOutputTokensOverride: 4096 }).max_tokens === 4096)
  check('the lane profile strips the namespace and keeps the suffix', huggingfaceLaneProfile.wireModelId('huggingface/openai/gpt-oss-120b:groq') === 'openai/gpt-oss-120b:groq')
  check('the request URL is the router base seam', huggingfaceLaneProfile.requestUrl() === 'https://router.fixture.example/v1/chat/completions' && huggingfaceChatCompletionsUrl() === huggingfaceLaneProfile.requestUrl())
  check('no bill-to header without the pin', huggingfaceLaneProfile.extraHeaders?.() === undefined)
  process.env.MERCURY_HUGGINGFACE_BILL_TO = 'my-org'
  check('X-HF-Bill-To rides when the org is pinned', huggingfaceLaneProfile.extraHeaders?.()?.['X-HF-Bill-To'] === 'my-org')
  delete process.env.MERCURY_HUGGINGFACE_BILL_TO
  const credential = await huggingfaceLaneProfile.resolveCredential()
  check('the dispatch credential resolves the OAuth token', credential?.apiKey === 'hf_oauth_fixture_access_0000000009')
  __resetHuggingfaceCatalogueForTest()
  await refreshHuggingfaceCatalogue({ fetchImpl: catalogueFetch, force: true })
  check('tool-capability refusal names the model and the reason', (huggingfaceLaneProfile.toolCapabilityRefusal?.('CohereLabs/tiny-aya-fire') ?? '').includes('without tool-call support'))
  check('a tool-capable model proceeds', huggingfaceLaneProfile.toolCapabilityRefusal?.('openai/gpt-oss-120b') === undefined)

  // The documented stream shape (chat-completion reference, fetched 2026-08-22).
  const sse = (obj: unknown): string => `data: ${JSON.stringify(obj)}\n\n`
  const chunks = [
    sse({ id: 'chatcmpl-1', object: 'chat.completion.chunk', created: 1, model: 'openai/gpt-oss-120b', choices: [{ index: 0, delta: { role: 'assistant', content: 'Hel' }, finish_reason: null }], usage: null }),
    sse({ id: 'chatcmpl-1', object: 'chat.completion.chunk', created: 1, model: 'openai/gpt-oss-120b', choices: [{ index: 0, delta: { content: 'lo' }, finish_reason: null }], usage: null }),
    sse({ id: 'chatcmpl-1', object: 'chat.completion.chunk', created: 1, model: 'openai/gpt-oss-120b', choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: 'Read', arguments: '{"file_path":' } }] }, finish_reason: null }], usage: null }),
    sse({ id: 'chatcmpl-1', object: 'chat.completion.chunk', created: 1, model: 'openai/gpt-oss-120b', choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: '"/a"}' } }] }, finish_reason: 'tool_calls' }], usage: null }),
    sse({ id: 'chatcmpl-1', object: 'chat.completion.chunk', created: 1, model: 'openai/gpt-oss-120b', choices: [], usage: { prompt_tokens: 12, completion_tokens: 7, total_tokens: 19 } }),
    'data: [DONE]\n\n',
  ]
  let seenInit: RequestInit | undefined
  let seenUrl = ''
  const streamFetch = (async (url: unknown, init?: RequestInit) => {
    seenUrl = String(url)
    seenInit = init
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const c of chunks) controller.enqueue(new TextEncoder().encode(c))
        controller.close()
      },
    })
    return new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream', ratelimit: '"inference";r=41;t=600' } })
  }) as typeof fetch
  const events: CompatStreamEvent[] = []
  for await (const event of streamCompatChat({
    apiKey: credential!.apiKey,
    url: huggingfaceLaneProfile.requestUrl(),
    extraHeaders: { 'X-HF-Bill-To': 'my-org' },
    request: { model: 'openai/gpt-oss-120b', messages: [{ role: 'user', content: 'hi' }], tools: [{ type: 'function', function: { name: 'Read', parameters: {} } }], tool_choice: 'auto', extra: extras },
    fetchImpl: streamFetch,
    onResponseHeaders: (headers, status) => recordHuggingfaceRateHeaders(headers, status),
  })) {
    events.push(event)
  }
  const body = JSON.parse(String(seenInit?.body ?? '{}')) as Record<string, unknown>
  const headers = (seenInit?.headers ?? {}) as Record<string, string>
  check('request truth: bearer + bill-to + stream + include_usage + tool_choice auto, key never in the body', headers.authorization === 'Bearer hf_oauth_fixture_access_0000000009' && headers['X-HF-Bill-To'] === 'my-org' && body.stream === true && (body.stream_options as { include_usage: boolean }).include_usage === true && body.tool_choice === 'auto' && !JSON.stringify(body).includes('hf_oauth_fixture') && seenUrl.endsWith('/chat/completions'))
  const text = events.filter(e => e.type === 'text-delta').map(e => (e as { text: string }).text).join('')
  const finish = events.find(e => e.type === 'finish') as { reason: string; toolCalls: { name: string; arguments?: unknown }[] } | undefined
  const usage = events.find(e => e.type === 'usage') as { usage: { inputTokens: number; outputTokens: number } } | undefined
  check('stream decode: text deltas, the index-keyed tool call settled exactly once, usage before [DONE]', text === 'Hello' && finish?.reason === 'tool_calls' && finish.toolCalls.length === 1 && finish.toolCalls[0]!.name === 'Read' && JSON.stringify(finish.toolCalls[0]!.arguments) === '{"file_path":"/a"}' && usage?.usage.inputTokens === 12 && usage.usage.outputTokens === 7)
  check('the draft RateLimit header folds into the observed rate', huggingfaceObservedRate()?.remaining === 41 && huggingfaceLimitWindow().state === 'clear')

  // The observed 401 shape and the documented-by-RFC 429.
  const fault401 = mapCompatHttpFailure(401, { error: 'Invalid username or password.' })
  check('the observed 401 string error becomes the fault message', fault401.message === 'Invalid username or password.' && fault401.code === 'http-401' && !fault401.retryable)
  __resetHuggingfaceUsageStateForTest()
  recordHuggingfaceRateHeaders(new Headers({ 'retry-after': '30' }), 429, () => 1_000)
  const limited = huggingfaceLimitWindow(() => 2_000)
  check('429 + Retry-After marks the lane limited until the stated reset', limited.state === 'limited' && limited.resetsAtMs === 31_000)
  check('the window clears once the reset passes', huggingfaceLimitWindow(() => 40_000).state === 'clear')
  __resetHuggingfaceUsageStateForTest()
  recordHuggingfaceRateHeaders(new Headers({ ratelimit: '"pages";r=0;t=120' }), 200, () => 0)
  check('a RateLimit header with r=0 marks the window too', huggingfaceLimitWindow(() => 1).state === 'limited')
  __resetHuggingfaceUsageStateForTest()
  recordHuggingfaceRateHeaders(new Headers({}), 429, () => 0)
  check('a bare 429 still holds a short window (no request burned on the next turn)', huggingfaceLimitWindow(() => 1).state === 'limited')
  check('parseRateLimitHeader reads the lowest remaining across policies', parseRateLimitHeader('"a";r=9;t=5, "b";r=2;t=50')?.remaining === 2 && parseRateLimitHeader(null) === undefined)
  writeHuggingfaceTokens(null)
}

console.log(`\n${failures === 0 ? 'ALL GREEN' : `${failures} FAILURE(S)`}`)
process.exit(failures === 0 ? 0 : 1)
