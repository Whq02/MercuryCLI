#!/usr/bin/env bun
// ============================================================================
//  scripts/model-routing/prove-effort-wire-truth.ts — the request carried
//  what the dial said, on every provider family, and the surface copy names
//  the tier the request carries.
//
//  THE LAW: ONE per-model vocabulary owner (utils/model/capabilities.ts
//  effortVocabularyFor) and ONE resolution owner (utils/effort.ts
//  resolveEffortTruth) answer every effort question; each wire builder steps
//  the request through the SAME vocabulary the owner steps through, so the
//  effort field of the request as built — or its absence — equals the
//  owner's `wire`, and the label every surface prints equals that field.
//  Honest absence is one word: a model that takes no effort setting says
//  'no effort control' everywhere, offers no stop and sends no key.
//
//   §1 the first-party wire: output_config.effort ≡ the owner, per family,
//      per request; a no-dial family sends nothing and no beta header
//   §2 the GPT wire: reasoning.effort of the built Responses request ≡ the
//      owner across the live-catalogue states (live · known-empty ·
//      unstated · unavailable)
//   §3 the GLM wire: reasoning_effort of the built chat request ≡ the owner,
//      per model (glm-5.3 low|high|max · glm-5.2 the seven-level set)
//   §4 the compat wires, thinking on: Moonshot · DeepSeek · Gemini (live
//      row) · OpenRouter (live rows) · a local Ollama server (discovered
//      through a fixture probe) · Hugging Face · the compat slot — every
//      builder's dial ≡ the owner's wire
//   §5 thinking off (FN-018 rank 15, the one stated rule): the lanes whose
//      effort dial is their reasoning dial send no dial and the owner says
//      so (suppressedBy); the independent knobs are sent regardless; the
//      coordinator's receipt detail rides the same law
//   §6 honest absence: every no-dial id labels itself with the one word
//   §7 the surfaces read the owner (print mode · the coordinator picker ·
//      the studio · /model · /submodels · the router's Anthropic rows)
//   §8 the two effort doors (the W6 packet): the flag refuses with a
//      sentence that says so and names the ladder; the env door ignores an
//      off-ladder word — an integer included — and says so
//   §9 the harness effort fact (FN-018 rank 24) is the owner's applied tier
//   §10 the shape: the predicates are projections of the vocabulary owner
//
//  Hermetic: a scratch config home, unroutable provider bases, fixture
//  catalogues through the real refresh seams; no network, no billables.
//  Run:  ~/.bun/bin/bun run scripts/model-routing/prove-effort-wire-truth.ts
// ============================================================================
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
process.env.NODE_ENV = 'test'

import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

for (const key of [
  'OPENAI_API_KEY',
  'ZAI_API_KEY',
  'OPENROUTER_API_KEY',
  'GEMINI_API_KEY',
  'MERCURY_CONFIG_DIR',
  'MERCURY_AUTH_SCOPE_DIR',
  'MERCURY_EFFORT_LEVEL',
  'MERCURY_OPENAI_API_BASE',
  'MERCURY_OPENROUTER_API_BASE',
  'MERCURY_OPENROUTER_AUTH_BASE',
  'MERCURY_GEMINI_API_BASE',
  'MERCURY_COMPAT_BASE_URL',
  'MERCURY_LOCAL_PROBE_TARGETS',
  'MAX_THINKING_TOKENS',
  'CLAUDE_EFFORT',
  'MERCURY_EFFORT',
]) {
  delete process.env[key]
}
process.env.MERCURY_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'prove-effort-wire-'))
process.env.MERCURY_OPENAI_API_BASE = 'http://127.0.0.1:9'
process.env.MERCURY_OPENROUTER_API_BASE = 'https://fixture.invalid/api/v1'
process.env.MERCURY_OPENROUTER_AUTH_BASE = 'https://fixture.invalid/auth'
process.env.MERCURY_GEMINI_API_BASE = 'https://fixture.invalid/v1beta'
process.env.MERCURY_LOCAL_PROBE_TARGETS = 'ollama=http://fixture.invalid:11434'
process.env.OPENAI_API_KEY = 'prover-key'
process.env.OPENROUTER_API_KEY = 'sk-or-v1-EFFORTWIREPROOF000000000'
process.env.GEMINI_API_KEY = 'AIza-EFFORT-WIRE-PROOF-00000'

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
}
const ROOT = join(import.meta.dir, '..', '..')
const src = (rel: string): string => readFileSync(join(ROOT, rel), 'utf8')

const configModule = (await import('../../src/utils/config.ts')) as unknown as { enableConfigs?: () => void }
configModule.enableConfigs?.()

const effort = await import('../../src/utils/effort.ts')
const caps = await import('../../src/utils/model/capabilities.ts')
const thinking = await import('../../src/utils/thinking.ts')
const requestParams = await import('../../src/services/providers/anthropic/requestParams.ts')
const betas = await import('../../src/constants/betas.ts')
const openaiCatalogue = await import('../../src/services/providers/openai/openaiCatalogue.ts')
const responsesBridge = await import('../../src/services/providers/openai/responsesBridge.ts')
const gptPins = await import('../../src/services/providers/openai/gptPins.ts')
const glmPins = await import('../../src/services/providers/zai/glmPins.ts')
const zaiCodec = await import('../../src/services/providers/zai/zaiCodec.ts')
const wire = await import('../../src/services/providers/openaicompat/compatWire.ts')
const openrouter = await import('../../src/services/providers/openrouter/openrouterCatalogue.ts')
const gemini = await import('../../src/services/providers/gemini/geminiCatalogue.ts')
const localDiscovery = await import('../../src/services/providers/local/localDiscovery.ts')
const localCatalogue = await import('../../src/services/providers/local/localCatalogue.ts')
const localCallModel = await import('../../src/services/providers/local/localCallModel.ts')
const routerAnthropic = await import('../../src/utils/router/providers/anthropic.ts')
const harness = await import('../../src/services/mission/harnessApplication.ts')
const harnessProfiles = await import('../../src/services/mission/harnessProfiles.ts')
const coordinatorModels = await import('../../src/services/concourse/coordinatorModels.ts')

type Level = 'low' | 'medium' | 'high' | 'xhigh' | 'max'
const LEVELS: Level[] = ['low', 'medium', 'high', 'xhigh', 'max']
const REQUESTS: Array<Level | undefined> = [...LEVELS, undefined]
const DEFAULT_LABEL = 'default'
const ABSENT = effort.NO_EFFORT_CONTROL_LABEL

// ── the rig: fixture catalogues through the real refresh seams ──────────────
const GPT_ROWS = [
  { id: 'gpt-5.6-sol', display_name: 'GPT-5.6 Sol', visibility: 'list', priority: 1, supported_reasoning_levels: ['low', 'medium', 'high', 'xhigh', 'max'], default_reasoning_level: 'low' },
  { id: 'gpt-5.6-luna', display_name: 'GPT-5.6 Luna', visibility: 'list', priority: 2, supported_reasoning_levels: ['low', 'medium', 'high'], default_reasoning_level: 'medium' },
  { id: 'gpt-5.6-deep', display_name: 'GPT-5.6 Deep', visibility: 'list', priority: 3, supported_reasoning_levels: ['high', 'xhigh'], default_reasoning_level: 'high' },
  { id: 'gpt-5.6-void', display_name: 'GPT-5.6 Void', visibility: 'list', priority: 4, supported_reasoning_levels: [], default_reasoning_level: 'medium' },
  { id: 'gpt-5.6-bare', display_name: 'GPT-5.6 Bare', visibility: 'list', priority: 5 },
]
const jsonResponse = (body: unknown): Response =>
  new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })
const gptFetch: typeof fetch = (async () => jsonResponse({ data: GPT_ROWS })) as unknown as typeof fetch
const OPENROUTER_PAGE = {
  data: [
    {
      id: 'google/gemini-fixture-pro',
      name: 'Gemini Fixture Pro',
      context_length: 1_050_000,
      supported_parameters: ['tools', 'reasoning'],
      reasoning: { supported_efforts: ['low', 'medium', 'high', 'xhigh'], default_effort: 'medium' },
    },
    {
      id: 'deep/deep-fixture-tall',
      name: 'Deep Fixture Tall',
      context_length: 128_000,
      supported_parameters: ['tools', 'reasoning'],
      reasoning: { supported_efforts: ['high', 'max'] },
    },
    { id: 'qwen/qwen-fixture-small', name: 'Qwen Fixture Small', context_length: 32_000, supported_parameters: ['tools', 'reasoning'] },
    { id: 'anthropic/claude-opus-5', name: 'Anthropic: Claude Opus 5 (via the carrier)', context_length: 200_000, supported_parameters: ['tools'] },
    { id: 'mistral/mistral-fixture-bare', name: 'Mistral Fixture Bare' },
  ],
  total_count: 5,
  links: { next: null },
}
const openrouterFetch: typeof fetch = (async () => jsonResponse(OPENROUTER_PAGE)) as unknown as typeof fetch
const GEMINI_PAGE = {
  models: [
    { name: 'models/gemini-fixture-pro', displayName: 'Gemini Fixture Pro', inputTokenLimit: 1_048_576, outputTokenLimit: 65_536, supportedGenerationMethods: ['generateContent'], thinking: true },
    { name: 'models/gemini-fixture-lite', displayName: 'Gemini Fixture Lite', supportedGenerationMethods: ['generateContent'] },
  ],
}
const geminiFetch: typeof fetch = (async () => jsonResponse(GEMINI_PAGE)) as unknown as typeof fetch
// An Ollama fixture: one thinking model, one plain model.
const OLLAMA_CAPS: Record<string, string[]> = {
  'qwen3:8b': ['completion', 'tools', 'thinking'],
  'llama3.2:latest': ['completion', 'tools'],
}
const ollamaFetch: typeof fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
  if (url.endsWith('/api/tags')) return jsonResponse({ models: Object.keys(OLLAMA_CAPS).map(model => ({ model, name: model })) })
  if (url.endsWith('/api/version')) return jsonResponse({ version: '0.fixture' })
  if (url.endsWith('/api/ps')) return jsonResponse({ models: [] })
  if (url.endsWith('/api/show')) {
    const model = String((JSON.parse(String(init?.body ?? '{}')) as { model?: string }).model ?? '')
    return jsonResponse({ capabilities: OLLAMA_CAPS[model] ?? [] })
  }
  return new Response('', { status: 404 })
}) as unknown as typeof fetch

async function armEveryCatalogue(): Promise<void> {
  openaiCatalogue.__resetOpenaiCatalogueForTest()
  await openaiCatalogue.refreshOpenaiCatalogue('api-key', { force: true, fetchImpl: gptFetch })
  openrouter.__resetOpenrouterCatalogueForTest()
  await openrouter.refreshOpenrouterCatalogue('env', { force: true, fetchImpl: openrouterFetch })
  gemini.__resetGeminiCatalogueForTest()
  await gemini.refreshGeminiCatalogue('api-key', { force: true, fetchImpl: geminiFetch })
  localDiscovery.__resetLocalDiscoveryForTest()
  await localDiscovery.refreshLocalDiscovery({ force: true, fetchImpl: ollamaFetch, env: process.env })
}
function liveRow(id: string): Parameters<typeof openaiCatalogue.resolveGptReasoningProfile>[1] {
  const row = openaiCatalogue.getCachedOpenaiCatalogue('api-key')?.models.find(m => m.id === id)
  if (!row) throw new Error(`fixture row missing: ${id}`)
  return row
}
const wireLabel = (w: string | undefined): string => w ?? DEFAULT_LABEL

console.log('the request carried what the dial said — every provider family')
await armEveryCatalogue()
thinking.noteSessionThinkingConfig({ type: 'adaptive' })
check('rig: the GPT fixture catalogue landed', openaiCatalogue.getCachedOpenaiCatalogue('api-key')?.models.length === GPT_ROWS.length)
check('rig: the OpenRouter fixture catalogue landed', openrouter.getCachedOpenrouterCatalogue('env')?.models.length === 5)
check('rig: the Gemini fixture catalogue landed', gemini.getCachedGeminiCatalogue('api-key')?.models.length === 2)
check('rig: the Ollama fixture was discovered', localCatalogue.localRecordFor('local/qwen3:8b')?.server === 'ollama' && localCatalogue.localRecordFor('local/llama3.2:latest') !== undefined)

// ── §1 the first-party wire ─────────────────────────────────────────────────
section('§1 the first-party wire: output_config.effort ≡ the owner, per family, per request')
{
  const anthropicWire = (model: string, request: Level | undefined): { effort: string | undefined; beta: boolean } => {
    const outputConfig: Record<string, unknown> = {}
    const betasOut: string[] = []
    requestParams.configureEffortParams(effort.resolveAppliedEffort(model, request), outputConfig as never, {}, betasOut, model)
    return { effort: outputConfig.effort as string | undefined, beta: betasOut.includes(betas.EFFORT_BETA_HEADER) }
  }
  for (const model of ['claude-opus-5', 'claude-sonnet-5', 'claude-fable-5-1', 'claude-opus-4-8', 'claude-opus-4-6', 'claude-sonnet-4-6']) {
    for (const request of REQUESTS) {
      const truth = effort.resolveEffortTruth(model, request)
      const sent = anthropicWire(model, request)
      check(`${model} · ${request ?? 'unset'}: output_config.effort ≡ owner.wire (${String(truth.wire)})`, sent.effort === truth.wire, `sent ${String(sent.effort)}`)
      check(`${model} · ${request ?? 'unset'}: the label IS the wire tier`, truth.label === (truth.wire ?? 'high'))
      check(`${model} · ${request ?? 'unset'}: the effort beta rides`, sent.beta)
    }
  }
  check('sonnet-4-6 · xhigh steps to high on the wire and in the word', anthropicWire('claude-sonnet-4-6', 'xhigh').effort === 'high' && effort.resolveEffortTruth('claude-sonnet-4-6', 'xhigh').label === 'high' && effort.resolveEffortTruth('claude-sonnet-4-6', 'xhigh').adjustedFrom === 'xhigh')
  const haiku = anthropicWire('claude-haiku-4-5-20251001', 'max')
  check('a no-dial first-party family sends no effort and no effort beta', haiku.effort === undefined && !haiku.beta)
  process.env.MERCURY_EFFORT_LEVEL = 'auto'
  const deferred = anthropicWire('claude-opus-5', 'max')
  check('env=auto: no effort key, the beta rides, the label is the documented default word', deferred.effort === undefined && deferred.beta && effort.resolveEffortTruth('claude-opus-5', 'max').label === 'high')
  delete process.env.MERCURY_EFFORT_LEVEL
}

// ── §2 the GPT wire ─────────────────────────────────────────────────────────
section('§2 the GPT wire: reasoning.effort of the built request ≡ the owner across the catalogue states')
{
  const gptWire = (model: string, request: Level | undefined): string | undefined => {
    const profile = openaiCatalogue.resolveGptReasoningProfile(effort.resolveWireRequestedEffort(model, request), liveRow(model))
    const body = responsesBridge.buildOpenaiResponsesRequest({ model, messages: [], ...(profile.wireEffort ? { reasoningEffort: profile.wireEffort } : {}) })
    return body.reasoning?.effort
  }
  for (const model of ['gpt-5.6-sol', 'gpt-5.6-luna', 'gpt-5.6-deep']) {
    for (const request of REQUESTS) {
      const truth = effort.resolveEffortTruth(model, request)
      const sent = gptWire(model, request)
      check(`${model} · ${request ?? 'unset'}: reasoning.effort ≡ owner.wire (${String(truth.wire)})`, sent === truth.wire, `sent ${String(sent)}`)
      check(`${model} · ${request ?? 'unset'}: the label IS the wire tier`, truth.label === wireLabel(truth.wire))
    }
  }
  check('luna · max steps to high; the request names the adjustment', effort.resolveEffortTruth('gpt-5.6-luna', 'max').adjustedFrom === 'max' && gptWire('gpt-5.6-luna', 'max') === 'high')
  const voidTruth = effort.resolveEffortTruth('gpt-5.6-void', 'max')
  check('known-empty: no key, no stop, the one absence word', gptWire('gpt-5.6-void', 'max') === undefined && voidTruth.wire === undefined && voidTruth.selectable.length === 0 && voidTruth.label === ABSENT && !caps.modelSupportsEffort('gpt-5.6-void'))
  const bareTruth = effort.resolveEffortTruth('gpt-5.6-bare', 'max')
  check("unstated: the ladder is offered, the key is omitted, the label says 'default'", gptWire('gpt-5.6-bare', 'max') === undefined && bareTruth.wire === undefined && bareTruth.label === DEFAULT_LABEL && bareTruth.selectable.length === 5)
  openaiCatalogue.__resetOpenaiCatalogueForTest()
  const unavailable = effort.resolveEffortTruth('gpt-5.6-sol', 'max')
  check("unavailable: the key is omitted and the label says 'default'", unavailable.wire === undefined && unavailable.label === DEFAULT_LABEL && unavailable.catalogue === 'gpt-unavailable')
  await openaiCatalogue.refreshOpenaiCatalogue('api-key', { force: true, fetchImpl: gptFetch })
}

// ── §3 the GLM wire ─────────────────────────────────────────────────────────
section('§3 the GLM wire: reasoning_effort of the built chat request ≡ the owner, per model')
{
  // The zai wire's own expression (zaiCallModel), reproduced from the pins it reads.
  const glmWire = (model: string, request: Level | undefined): string | undefined => {
    const requested = effort.resolveWireRequestedEffort(model, request)
    const vocabulary = glmPins.glmEffortsFor(model)
    const wireEffort =
      requested && vocabulary
        ? glmPins.glmAcceptsEffort(model, requested)
          ? requested
          : gptPins.nearestSupportedWireEffort(requested, [...vocabulary])
        : undefined
    const body = zaiCodec.buildZaiChatRequest({ model, system: '', messages: [], ...(wireEffort ? { reasoningEffort: wireEffort } : {}), thinkingEnabled: true })
    return (body as { reasoning_effort?: string }).reasoning_effort
  }
  for (const model of ['glm-5.2', 'glm-5.3']) {
    for (const request of REQUESTS) {
      const truth = effort.resolveEffortTruth(model, request)
      const sent = glmWire(model, request)
      check(`${model} · ${request ?? 'unset'}: reasoning_effort ≡ owner.wire (${String(truth.wire)})`, sent === truth.wire, `sent ${String(sent)}`)
      check(`${model} · ${request ?? 'unset'}: the label IS the wire tier`, truth.label === wireLabel(truth.wire))
    }
  }
  check('glm-5.3 · xhigh → high, medium → low, adjusted and said', effort.resolveEffortTruth('glm-5.3', 'xhigh').label === 'high' && effort.resolveEffortTruth('glm-5.3', 'medium').label === 'low' && effort.resolveEffortTruth('glm-5.3', 'medium').adjustedFrom === 'medium')
  const zaiSrc = src('src/services/providers/zai/zaiCallModel.ts')
  check('the zai wire steps through glmEffortsFor with the shared nearest-below', zaiSrc.includes('glmEffortsFor(modelId)') && zaiSrc.includes('nearestSupportedWireEffort(effortValue, [...vocabulary])'))
}

// ── §4 the compat wires, thinking on ────────────────────────────────────────
section('§4 the compat wires, thinking on: every builder\'s dial ≡ the owner\'s wire')
{
  const base = (wireModel: string, request: Level | undefined, model = wireModel) => ({
    wireModel,
    effortValue: effort.resolveWireRequestedEffort(model, request),
    thinkingEnabled: true,
    maxOutputTokensOverride: undefined,
  })
  const qwen = localCatalogue.localRecordFor('local/qwen3:8b')!
  const families: Array<{ model: string; dial: (request: Level | undefined) => string | undefined; vocabulary: readonly string[] }> = [
    { model: 'kimi-k3', vocabulary: ['low', 'high', 'max'], dial: r => (wire.buildMoonshotExtras(base('kimi-k3', r)) as { reasoning_effort?: string }).reasoning_effort },
    { model: 'deepseek-v4-flash', vocabulary: ['low', 'high', 'max'], dial: r => ((wire.buildDeepseekExtras(base('deepseek-v4-flash', r)) as { thinking?: { reasoning_effort?: string } }).thinking ?? {}).reasoning_effort },
    { model: 'gemini-fixture-pro', vocabulary: ['low', 'medium', 'high'], dial: r => (wire.buildGeminiExtras({ ...base('gemini-fixture-pro', r), acceptsEffort: gemini.geminiEffortVocabularyFor('gemini-fixture-pro').length > 0 }) as { reasoning_effort?: string }).reasoning_effort },
    { model: 'openrouter/google/gemini-fixture-pro', vocabulary: ['low', 'medium', 'high', 'xhigh'], dial: r => ((wire.buildOpenrouterExtras({ ...base('google/gemini-fixture-pro', r, 'openrouter/google/gemini-fixture-pro'), vocabulary: openrouter.openrouterEffortVocabularyFor('openrouter/google/gemini-fixture-pro') }) as { reasoning?: { effort?: string } }).reasoning ?? {}).effort },
    { model: 'openrouter/deep/deep-fixture-tall', vocabulary: ['high', 'max'], dial: r => ((wire.buildOpenrouterExtras({ ...base('deep/deep-fixture-tall', r, 'openrouter/deep/deep-fixture-tall'), vocabulary: openrouter.openrouterEffortVocabularyFor('openrouter/deep/deep-fixture-tall') }) as { reasoning?: { effort?: string } }).reasoning ?? {}).effort },
    { model: 'openrouter/qwen/qwen-fixture-small', vocabulary: wire.OPENROUTER_REASONING_EFFORTS, dial: r => ((wire.buildOpenrouterExtras({ ...base('qwen/qwen-fixture-small', r, 'openrouter/qwen/qwen-fixture-small'), vocabulary: openrouter.openrouterEffortVocabularyFor('openrouter/qwen/qwen-fixture-small') }) as { reasoning?: { effort?: string } }).reasoning ?? {}).effort },
    { model: 'local/qwen3:8b', vocabulary: wire.LOCAL_SERVER_EFFORTS.ollama, dial: r => (wire.buildLocalExtras({ ...base('qwen3:8b', r, 'local/qwen3:8b'), server: qwen.server, acceptsEffort: localCallModel.localModelAcceptsEffort(qwen) }) as { reasoning_effort?: string }).reasoning_effort },
  ]
  for (const family of families) {
    const owner = effort.resolveEffortTruth(family.model, undefined)
    check(`${family.model}: the owner's vocabulary is the builder's table`, JSON.stringify(owner.providerVocabulary) === JSON.stringify([...family.vocabulary]), JSON.stringify(owner.providerVocabulary))
    check(`${family.model}: the stops offered are the ladder words of that table`, JSON.stringify(owner.selectable) === JSON.stringify(LEVELS.filter(l => family.vocabulary.includes(l))), JSON.stringify(owner.selectable))
    for (const request of REQUESTS) {
      const truth = effort.resolveEffortTruth(family.model, request)
      const sent = family.dial(request)
      check(`${family.model} · ${request ?? 'unset'}: the builder's dial ≡ owner.wire (${String(truth.wire)})`, sent === truth.wire, `sent ${String(sent)}`)
      check(`${family.model} · ${request ?? 'unset'}: the label IS the wire tier`, truth.label === wireLabel(truth.wire))
      check(`${family.model} · ${request ?? 'unset'}: adjustedFrom exactly when the tier moved`, (truth.adjustedFrom !== undefined) === (request !== undefined && truth.wire !== request))
    }
  }
  check('an OpenRouter row stating only high|max: medium shows and sends high (the ladder branch used to show medium)', effort.resolveEffortTruth('openrouter/deep/deep-fixture-tall', 'medium').label === 'high' && effort.resolveEffortTruth('openrouter/deep/deep-fixture-tall', 'medium').selectable.join(',') === 'high,max')
  for (const [model, extras] of [
    ['huggingface/openai/gpt-oss-120b', wire.buildHuggingfaceExtras(base('openai/gpt-oss-120b', 'high', 'huggingface/openai/gpt-oss-120b'))],
    ['compat/fixture-model', wire.buildCompatSlotExtras(base('fixture-model', 'high', 'compat/fixture-model'))],
  ] as const) {
    check(`${model}: the builder sends no dial and the owner offers none`, !('reasoning_effort' in extras) && !('reasoning' in extras) && !caps.modelSupportsEffort(model))
  }
  const llama = localCatalogue.localRecordFor('local/llama3.2:latest')!
  const llamaExtras = wire.buildLocalExtras({ ...base('llama3.2:latest', 'high', 'local/llama3.2:latest'), server: llama.server, acceptsEffort: localCallModel.localModelAcceptsEffort(llama) }) as { reasoning_effort?: string }
  check('a local model with no thinking capability: no dial sent, none offered', llamaExtras.reasoning_effort === undefined && !caps.modelSupportsEffort('local/llama3.2:latest'))
}

// ── §5 thinking off ─────────────────────────────────────────────────────────
section('§5 thinking off: the dial-is-the-reasoning-dial lanes send nothing and the owner says so; the independent knobs are sent')
{
  thinking.noteSessionThinkingConfig({ type: 'disabled' })
  const off = (wireModel: string, request: Level, model = wireModel) => ({ wireModel, effortValue: effort.resolveWireRequestedEffort(model, request), thinkingEnabled: false, maxOutputTokensOverride: undefined })
  const gated: Array<[string, string | undefined]> = [
    ['deepseek-v4-flash', ((wire.buildDeepseekExtras(off('deepseek-v4-flash', 'high')) as { thinking?: { reasoning_effort?: string } }).thinking ?? {}).reasoning_effort],
    ['gemini-fixture-pro', (wire.buildGeminiExtras({ ...off('gemini-fixture-pro', 'high'), acceptsEffort: true }) as { reasoning_effort?: string }).reasoning_effort],
    ['openrouter/google/gemini-fixture-pro', ((wire.buildOpenrouterExtras({ ...off('google/gemini-fixture-pro', 'high', 'openrouter/google/gemini-fixture-pro'), vocabulary: openrouter.openrouterEffortVocabularyFor('openrouter/google/gemini-fixture-pro') }) as { reasoning?: { effort?: string } }).reasoning ?? {}).effort],
  ]
  for (const [model, sent] of gated) {
    const truth = effort.resolveEffortTruth(model, 'high')
    check(`${model}: the builder sends no dial while thinking is off`, sent === undefined, `sent ${String(sent)}`)
    check(`${model}: the owner says so — wire undefined, suppressedBy thinking-off, label 'default', the request kept as intent`, truth.wire === undefined && truth.suppressedBy === 'thinking-off' && truth.label === DEFAULT_LABEL && truth.requested === 'high' && truth.adjustedFrom === undefined, JSON.stringify(truth))
    check(`${model}: the stops stay offered (the dial exists; thinking is what is off)`, truth.supportsEffort && truth.selectable.length > 0)
  }
  const qwen = localCatalogue.localRecordFor('local/qwen3:8b')!
  const independent: Array<[string, string | undefined]> = [
    ['kimi-k3', (wire.buildMoonshotExtras(off('kimi-k3', 'high')) as { reasoning_effort?: string }).reasoning_effort],
    ['local/qwen3:8b', (wire.buildLocalExtras({ ...off('qwen3:8b', 'high', 'local/qwen3:8b'), server: qwen.server, acceptsEffort: localCallModel.localModelAcceptsEffort(qwen) }) as { reasoning_effort?: string }).reasoning_effort],
  ]
  for (const [model, sent] of independent) {
    const truth = effort.resolveEffortTruth(model, 'high')
    check(`${model}: the knob is independent of thinking — sent, and the owner's wire says high`, sent === 'high' && truth.wire === 'high' && truth.suppressedBy === undefined)
  }
  check('glm-5.2 is not thinking-gated (the zai wire sends reasoning_effort beside its thinking flag)', effort.resolveEffortTruth('glm-5.2', 'high').wire === 'high')
  thinking.noteSessionThinkingConfig({ type: 'adaptive' })
  check('thinking back on: DeepSeek resolves its dial again', effort.resolveEffortTruth('deepseek-v4-flash', 'high').wire === 'high')
  const explicit = effort.resolveEffortTruth('deepseek-v4-flash', 'high', { thinkingEnabled: false })
  check('a caller with its own thinking-off call context suppresses regardless of the session latch', explicit.suppressedBy === 'thinking-off' && explicit.wire === undefined)
  // The coordinator calls with thinking disabled: its receipt detail rides the same law.
  const detail = coordinatorModels.coordinatorEffortDetail
  check('coordinator detail · DeepSeek: saved, not sent', String(detail('deepseek-v4-flash', 'high')).includes('not sent'))
  check('coordinator detail · kimi-k3 medium: runs low', String(detail('kimi-k3', 'medium')).includes('runs low'))
  check('coordinator detail · opus-5 high: no clause (runs as asked)', detail('claude-opus-5', 'high') === undefined)
  check('coordinator detail · a no-dial model: the absence word', String(detail('huggingface/openai/gpt-oss-120b', 'high')).includes(ABSENT))
  check('coordinator detail · sonnet-4-6 xhigh: runs high', String(detail('claude-sonnet-4-6', 'xhigh')).includes('runs high'))
}

// ── §6 honest absence ───────────────────────────────────────────────────────
section('§6 honest absence: every no-dial id labels itself with the one word')
{
  for (const model of [
    'claude-haiku-4-5-20251001',
    'glm-4',
    'kimi-k2.7-code',
    'huggingface/openai/gpt-oss-120b',
    'compat/fixture-model',
    'gemini-fixture-lite',
    'openrouter/mistral/mistral-fixture-bare',
    'openrouter/anthropic/claude-opus-5',
    'local/llama3.2:latest',
    'gpt-5.6-void',
  ]) {
    const truth = effort.resolveEffortTruth(model, 'max')
    check(`${model}: no dial — supportsEffort false, no stops, no key, label '${ABSENT}', the request kept as intent`, !truth.supportsEffort && truth.selectable.length === 0 && truth.wire === undefined && truth.label === ABSENT && truth.requested === 'max' && !caps.modelSupportsEffort(model) && !caps.modelSupportsMaxEffort(model), JSON.stringify(truth))
    check(`${model}: the chip word and the suffix stay silent`, effort.getEffortSuffix(model, 'max') === '')
  }
  check("a carrier's first-party slug never joins the first-party ladder by substring", caps.effortVocabularyFor('openrouter/anthropic/claude-opus-5').kind === 'none')
}

// ── §7 the surfaces ─────────────────────────────────────────────────────────
section('§7 the surfaces read the owner')
{
  const print = src('src/cli/print.ts')
  check('print: the initialize catalogue lists the owner\'s stops per model', print.includes('resolveEffortTruth(resolved, undefined).selectable'))
  check('print: get_settings reports the applied tier beside the raw request', print.includes('effort: effortTruth.supportsEffort ? (effortTruth.wire ?? null) : undefined') && print.includes('effortRequested:'))
  const picker = src('src/components/concourse/CoordinatorModelPicker.tsx')
  check('the coordinator picker offers the model\'s own stops, resolved for its thinking-off call', picker.includes('coordinatorEffortOptions(effortPick.modelId)') && picker.includes("{ thinkingEnabled: false }"))
  const studio = src('src/components/agents/studio/StudioEditor.tsx')
  check('the studio offers no stops for a no-dial model (no full-ladder fallback)', studio.includes('const options = stops.map(') && !studio.includes('stops : EFFORT_LEVELS'))
  const modelCmd = src('src/commands/model/model.tsx')
  check('/model\'s parenthetical says not sent / runs at from the owner', modelCmd.includes('resolveEffortTruth(normalised, effortValue)') && modelCmd.includes('not sent'))
  const submodels = src('src/components/SubModelPicker.tsx')
  check('/submodels shows each row\'s range and the level a pinned model runs', submodels.includes('effortRange(entry.modelId)') && submodels.includes('headerEffort'))
  check('the router\'s Anthropic rows derive their ladder per model', routerAnthropic.routeEffortsFor('claude-sonnet-4-6').join(',') === 'high,max' && routerAnthropic.routeEffortsFor('claude-opus-5').join(',') === 'high,xhigh,max' && src('src/utils/router/providers/anthropic.ts').includes('efforts: routeEffortsFor(m.ref.model)'))
  const hint = src('src/commands/effort/index.ts')
  check('the /effort hint derives from the ladder', hint.includes("EFFORT_LEVELS.join('|')"))
}

// ── §8 the two effort doors ─────────────────────────────────────────────────
section('§8 the two effort doors say what they do')
{
  const refused = effort.parseCliEffort('banana')
  check('the flag refuses an off-ladder word with a sentence that names the ladder', refused.level === undefined && refused.refusal !== undefined && refused.refusal.includes('low, medium, high, xhigh, max'), String(refused.refusal))
  check("…and never claims the run went ahead ('ignoring')", !/ignoring/i.test(String(refused.refusal)))
  check('the flag keeps the one normalizer: med → medium, max effort → max', effort.parseCliEffort('med').level === 'medium' && effort.parseCliEffort('max effort').level === 'max')
  const mainSrc = src('src/main.tsx')
  check('--help names the ladder and the flag door prints the owner\'s refusal sentence', mainSrc.includes("Reasoning effort level (${EFFORT_LEVELS.join(', ')})") && mainSrc.includes('`Unrecognised effort level "${value}". Valid values: ${EFFORT_LEVELS.join(\', \')}.`') && String(effort.parseCliEffort('banana').refusal) === 'Unrecognised effort level "banana". Valid values: low, medium, high, xhigh, max.')
  check('the owner carries no sentence that claims the value was ignored', !/ignoring it in favour/.test(src('src/utils/effort.ts')))
  check('the boot notes an ignored env word (interactive: a boot note; headless: stderr)', mainSrc.includes("if (effortEnv.state === 'ignored') addBootNote('warn', effortEnv.sentence)") && mainSrc.includes("if (effortEnv.state === 'ignored') process.stderr.write(`${effortEnv.sentence}\\n`)"))
  const view = (raw: string | undefined) => effort.describeEffortEnvOverride(raw === undefined ? {} : { MERCURY_EFFORT_LEVEL: raw })
  check('env absent', view(undefined).state === 'absent' && view(undefined).override === undefined)
  check('env auto/unset defers (null)', view('auto').state === 'deferred' && view('auto').override === null && view('unset').override === null)
  check("env 'x high' pins xhigh through the normalizer", view('x high').state === 'level' && view('x high').override === 'xhigh')
  const junk = view('banana')
  check('env junk is ignored and the sentence says so, naming the ladder', junk.state === 'ignored' && junk.override === undefined && 'sentence' in junk && junk.sentence.includes('ignored') && junk.sentence.includes('low, medium, high, xhigh, max'))
  check('an integer is off the ladder on the env door too (no wire encodes one)', view('3').state === 'ignored' && view('7').override === undefined)
  process.env.MERCURY_EFFORT_LEVEL = '3'
  check('getEffortEnvOverride ignores the integer (resolves as unset)', effort.getEffortEnvOverride() === undefined && effort.resolveEffortTruth('claude-opus-5', 'low').wire === 'low')
  delete process.env.MERCURY_EFFORT_LEVEL
}

// ── §9 the harness effort fact ──────────────────────────────────────────────
section('§9 the harness effort fact is the owner\'s applied tier')
{
  check('kimi-k3 · medium ⇒ the fact is low (the tier the request carries)', harness.harnessEffortFact('kimi-k3', 'medium') === 'low')
  check('opus-5 · max ⇒ max', harness.harnessEffortFact('claude-opus-5', 'max') === 'max')
  check('a no-dial model ⇒ null', harness.harnessEffortFact('huggingface/openai/gpt-oss-120b', 'high') === null)
  check('an absent model ⇒ null', harness.harnessEffortFact(null, 'high') === null && harness.harnessEffortFact('', 'high') === null)
  check("the reason codes carry 'effort-fact-absent' beside 'effort-incompatible'", (harnessProfiles.HARNESS_REASON_CODES as readonly string[]).includes('effort-fact-absent') && (harnessProfiles.HARNESS_REASON_CODES as readonly string[]).includes('effort-incompatible'))
  const profilesSrc = src('src/services/mission/harnessProfiles.ts')
  check('an absent fact declines under its own code; a mismatch under the other', profilesSrc.includes("if (facts.effortLevel === null) return 'effort-fact-absent'") && profilesSrc.includes("if (!profile.compatibility.effortLevels.includes(facts.effortLevel)) return 'effort-incompatible'"))
  const boundaries = [
    ['src/components/mercury-ui/HarnessChip.tsx', 'harnessEffortFact(model, effortValue)'],
    ['src/components/mercury-ui/parity/HarnessView.tsx', 'harnessEffortFact(mainModel, effortValue)'],
    ['src/run-core/turn-machine.ts', 'refreshGovernorCeilings(iter.currentModel, iter.appState.effortValue)'],
    ['src/run-core/turn-machine.ts', 'toolUseContext.getAppState?.()?.effortValue'],
    ['src/commands/context/context-noninteractive.ts', 'harnessContextPolicyRequest(params.mainLoopModel, params.effortValue)'],
    ['src/tools/AgentTool/AgentTool.tsx', 'harnessEffortFact('],
  ] as const
  for (const [file, needle] of boundaries) {
    check(`${file.split('/').pop()} threads the fact`, src(file).includes(needle))
  }
}

// ── §10 the shape ───────────────────────────────────────────────────────────
section('§10 the shape: one vocabulary owner, the predicates its projections')
{
  const edge = src('src/utils/model/capabilities.ts')
  check('modelSupportsEffort is a projection of the vocabulary view', edge.includes("return effortVocabularyFor(model).kind !== 'none'"))
  check('the ceilings are projections too', edge.includes("return vocabularyOffers(effortVocabularyFor(model), 'max')") && edge.includes("return vocabularyOffers(effortVocabularyFor(model), 'xhigh')"))
  const effortSrc = src('src/utils/effort.ts')
  check('the resolution reads the one view and keeps no provider pin of its own', effortSrc.includes('const view = effortVocabularyFor(model)') && !/KIMI_EFFORTS|DEEPSEEK_EFFORTS|GLM_EFFORTS\b/.test(effortSrc))
  const kinds = ['claude-opus-5', 'gpt-5.6-sol', 'glm-5.3', 'kimi-k3', 'deepseek-v4-flash', 'gemini-fixture-pro', 'openrouter/qwen/qwen-fixture-small', 'local/qwen3:8b', 'gpt-5.6-bare', 'claude-haiku-4-5-20251001'].map(m => caps.effortVocabularyFor(m).kind)
  check('the view kinds across the estate', kinds.join(',') === 'ladder,provider,provider,provider,provider,provider,provider,provider,offered,none', kinds.join(','))
  check('the thinking-gated lanes are exactly DeepSeek, Gemini and OpenRouter', ['deepseek-v4-flash', 'gemini-fixture-pro', 'openrouter/qwen/qwen-fixture-small'].every(m => { const v = caps.effortVocabularyFor(m); return v.kind === 'provider' && v.thinkingGated }) && ['kimi-k3', 'glm-5.2', 'local/qwen3:8b', 'gpt-5.6-sol'].every(m => { const v = caps.effortVocabularyFor(m); return v.kind === 'provider' && !v.thinkingGated }))
}

console.log(`\n${failures === 0 ? 'PASS' : 'FAIL'} prove-effort-wire-truth${failures ? ` (${failures} failure(s))` : ''}`)
process.exit(failures === 0 ? 0 : 1)
