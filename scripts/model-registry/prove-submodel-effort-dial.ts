#!/usr/bin/env bun
// ============================================================================
//  scripts/model-registry/prove-submodel-effort-dial.ts — the sub-model
//  containers' effort dial: `e` on a /submodels row opens the effort strip
//  over ONLY the levels the one effort owner offers that model, the pick
//  persists per container, and the container's calls carry it.
//
//    §1 the persistence owner — normalize → typed refusal naming the ladder
//       → applied per container; validated at read (a hand-poisoned spelling
//       reads absent); null clears without residue; the model pick and the
//       effort pick are independent
//    §2 cross-family accuracy — for every catalogue family (the first-party
//       ladder · GPT live/known-empty/unstated · GLM · Kimi · DeepSeek ·
//       Gemini · OpenRouter · a local server · Hugging Face · the compat
//       slot) the strip lists exactly the owner's selectable levels under
//       the container's call context and never a level the owner denies;
//       Minerva's thinking-off calls turn a reasoning-dial lane into the
//       receipt while the console (session thinking on) keeps its levels
//    §3 the dispatch — the chosen level rides each family's wire field
//       exactly as the main seat's dial does (output_config.effort ·
//       reasoning.effort · reasoning_effort); a model that lacks the chosen
//       level runs the model default with a receipt, never a foreign level;
//       the console fork's app state carries the dial or no dial
//    §4 the copy — "runs @high (chosen)" · "runs @medium (the model default)"
//       · the fallback sentence · the absence word; the model-pick receipt
//       names the effort beside the model
//    §5 the panel, driven — the real SubModelPicker under a raw-capable
//       stdin: e opens the strip with exactly the owner's levels, → moves
//       the bracket, ↵ persists per container and the row reads "(chosen)",
//       esc keeps; a no-control row answers the receipt and opens nothing
//    §6 the wiring — both Minerva runners and the room spread the dispatch
//       answer; the console passes its dial; the footer advertises e; the
//       main picker paints the same strip component
//
//  Hermetic: a scratch config home, the file credential plane, unroutable
//  provider bases, fixture catalogues through the real refresh seams.
//  Run:  ~/.bun/bin/bun run scripts/model-registry/prove-submodel-effort-dial.ts
// ============================================================================
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
process.env.NODE_ENV = 'test'

import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import stripAnsi from 'strip-ansi'

for (const key of [
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'MERCURY_OAUTH_TOKEN',
  'MERCURY_OAUTH_TOKEN_FILE_DESCRIPTOR',
  'OPENAI_API_KEY',
  'ZAI_API_KEY',
  'OPENROUTER_API_KEY',
  'GEMINI_API_KEY',
  'MERCURY_CONFIG_DIR',
  'MERCURY_AUTH_SCOPE_DIR',
  'MERCURY_EFFORT_LEVEL',
  'MERCURY_MINERVA_MODEL',
  'MERCURY_CONSOLE_MODEL',
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
process.env.MERCURY_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'prove-submodel-effort-'))
process.env.MERCURY_CREDENTIAL_STORE = 'file'
process.env.MERCURY_EVOLUTION_LEDGER = '0'
process.env.FORCE_COLOR = '0'
process.env.MERCURY_OPENAI_API_BASE = 'http://127.0.0.1:9'
process.env.MERCURY_OPENROUTER_API_BASE = 'https://fixture.invalid/api/v1'
process.env.MERCURY_OPENROUTER_AUTH_BASE = 'https://fixture.invalid/auth'
process.env.MERCURY_GEMINI_API_BASE = 'https://fixture.invalid/v1beta'
process.env.MERCURY_LOCAL_PROBE_TARGETS = 'ollama=http://fixture.invalid:11434'
// A fixture Anthropic key: the first-party family is credentialed, so the
// live registry the panel composes (§5) offers its static rows selectable.
process.env.ANTHROPIC_API_KEY = 'sk-ant-api03-effort-dial-proof-00000000'
process.env.OPENAI_API_KEY = 'prover-key'
process.env.OPENROUTER_API_KEY = 'sk-or-v1-EFFORTDIALPROOF00000000'
process.env.GEMINI_API_KEY = 'AIza-EFFORT-DIAL-PROOF-00000'

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
const sleep = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms))
const ESC = String.fromCharCode(27)

const { enableConfigs, getGlobalConfig, saveGlobalConfig } = await import('../../src/utils/config.ts')
enableConfigs()
const slots = await import('../../src/utils/model/subModelSlots.ts')
const effort = await import('../../src/utils/effort.ts')
const thinking = await import('../../src/utils/thinking.ts')
const requestParams = await import('../../src/services/providers/anthropic/requestParams.ts')
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
const sideQuestion = await import('../../src/utils/sideQuestion.ts')

type Level = 'low' | 'medium' | 'high' | 'xhigh' | 'max'
const LEVELS: Level[] = ['low', 'medium', 'high', 'xhigh', 'max']
type Container = 'minerva' | 'console'
const CONTAINERS: Container[] = ['minerva', 'console']

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
    { id: 'google/gemini-fixture-pro', name: 'Gemini Fixture Pro', context_length: 1_050_000, supported_parameters: ['tools', 'reasoning'], reasoning: { supported_efforts: ['low', 'medium', 'high', 'xhigh'], default_effort: 'medium' } },
    { id: 'deep/deep-fixture-tall', name: 'Deep Fixture Tall', context_length: 128_000, supported_parameters: ['tools', 'reasoning'], reasoning: { supported_efforts: ['high', 'max'] } },
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

// An injected catalogue for the writer (the persistence pins): first-party
// ids the ladder owner knows, one GPT row, one Kimi row — routes declare
// themselves; nothing here re-spells the production lineup.
const reads = {
  options: () => [
    { value: 'claude-opus-5', label: 'Opus 5', description: '' },
    { value: 'claude-sonnet-4-6', label: 'Sonnet 4.6', description: '' },
    { value: 'claude-haiku-4-5-20251001', label: 'Haiku 4.5', description: '' },
    { value: 'gpt-5.6-luna', label: 'GPT-5.6 Luna', description: '' },
    { value: 'kimi-k3', label: 'Kimi K3', description: '' },
  ],
  presences: () => [
    { id: 'anthropic', available: true, credentialed: true, credentialLabel: 'Anthropic API key' },
    { id: 'openai', available: true, credentialed: true, credentialLabel: 'OpenAI API key' },
    { id: 'moonshot', available: true, credentialed: true, credentialLabel: 'Moonshot API key' },
  ],
  providers: () =>
    [
      { id: 'anthropic', description: { capabilities: ['streaming', 'tool-calls', 'structured-output'] } },
      { id: 'openai', description: { capabilities: ['streaming', 'tool-calls', 'structured-output'] } },
      { id: 'moonshot', description: { capabilities: ['streaming', 'tool-calls'] } },
    ] as never,
} as never

console.log('the sub-model effort dial — e on a row, true levels only, persisted per container, carried by the calls')
await armEveryCatalogue()
thinking.noteSessionThinkingConfig({ type: 'adaptive' })
check('rig: the GPT fixture catalogue landed', openaiCatalogue.getCachedOpenaiCatalogue('api-key')?.models.length === GPT_ROWS.length)
check('rig: the OpenRouter fixture catalogue landed', openrouter.getCachedOpenrouterCatalogue('env')?.models.length === 5)
check('rig: the Gemini fixture catalogue landed', gemini.getCachedGeminiCatalogue('api-key')?.models.length === 2)
check('rig: the Ollama fixture was discovered', localCatalogue.localRecordFor('local/qwen3:8b')?.server === 'ollama' && localCatalogue.localRecordFor('local/llama3.2:latest') !== undefined)

// ── §1 the persistence owner ────────────────────────────────────────────────
section('§1 the persistence owner: normalize · refuse typed · per container · validated at read · no residue')
{
  check('nothing saved ⇒ no effort for either container', slots.resolveSubModelEffort('minerva') === undefined && slots.resolveSubModelEffort('console') === undefined)
  const junk = slots.setSubModelEffort('minerva', 'ludicrous speed')
  check('junk refuses typed, naming the whole ladder', !junk.ok && /low \| medium \| high \| xhigh \| max/.test(junk.ok ? '' : junk.reason), JSON.stringify(junk))
  check('…config untouched', getGlobalConfig().subModels === undefined, JSON.stringify(getGlobalConfig().subModels))
  const spoken = slots.setSubModelEffort('minerva', 'x high')
  check("'x high' applies through the one normalizer; the config carries the canonical word", spoken.ok && getGlobalConfig().subModels?.effort?.minerva === 'xhigh', JSON.stringify(getGlobalConfig().subModels))
  check('…the receipt says it applies when a model is pinned (Minerva is unset)', spoken.ok && spoken.receipt === 'Minerva effort set to xhigh — applies when a model is pinned', JSON.stringify(spoken))
  const low = slots.setSubModelEffort('console', 'low')
  check('the two containers persist independently', low.ok && getGlobalConfig().subModels?.effort?.minerva === 'xhigh' && getGlobalConfig().subModels?.effort?.console === 'low' && slots.resolveSubModelEffort('console') === 'low')
  saveGlobalConfig(c => ({ ...c, subModels: { ...c.subModels, effort: { ...c.subModels?.effort, minerva: 'ultra' } } }))
  check('a hand-poisoned spelling reads absent (no guess, no substitute); the sibling stands', slots.resolveSubModelEffort('minerva') === undefined && slots.resolveSubModelEffort('console') === 'low')
  const cleared = slots.setSubModelEffort('minerva', null)
  check('null clears the one container alone', cleared.ok && getGlobalConfig().subModels?.effort?.minerva === undefined && getGlobalConfig().subModels?.effort?.console === 'low', JSON.stringify(getGlobalConfig().subModels))
  check('…with a receipt that names the default', cleared.ok && cleared.receipt === 'Minerva effort cleared — the model default applies')
  slots.setSubModelEffort('console', null)
  check('clearing the last effort leaves NO residue key', getGlobalConfig().subModels === undefined, JSON.stringify(getGlobalConfig().subModels))
  const written = slots.setSubModel('minerva', 'claude-opus-5', reads)
  check('rig: a model pick lands over the injected catalogue', written.ok, JSON.stringify(written))
  slots.setSubModelEffort('minerva', 'high')
  check('a model pick and an effort pick coexist in the sub-models config', getGlobalConfig().subModels?.minerva === 'claude-opus-5' && getGlobalConfig().subModels?.effort?.minerva === 'high', JSON.stringify(getGlobalConfig().subModels))
  slots.setSubModel('minerva', null, reads)
  check("clearing the model keeps the effort (the dial is the container's, not the model's)", slots.resolveSubModel('minerva').origin === 'unset' && slots.resolveSubModelEffort('minerva') === 'high', JSON.stringify(getGlobalConfig().subModels))
  slots.setSubModelEffort('minerva', null)
  check('the env model pin locks the model, not the dial: the effort still writes', (() => { process.env.MERCURY_MINERVA_MODEL = 'claude-opus-5'; const r = slots.setSubModelEffort('minerva', 'low'); delete process.env.MERCURY_MINERVA_MODEL; slots.setSubModelEffort('minerva', null); return r.ok && r.receipt.includes('claude-opus-5 runs @low (chosen)') })())
}

// ── §2 cross-family accuracy ────────────────────────────────────────────────
section("§2 cross-family accuracy: the strip lists exactly the owner's levels under the container's call context")
{
  const roster = [
    'claude-opus-5', 'claude-sonnet-5', 'claude-fable-5-1', 'claude-opus-4-8', 'claude-opus-4-6', 'claude-sonnet-4-6', 'claude-haiku-4-5-20251001',
    'gpt-5.6-sol', 'gpt-5.6-luna', 'gpt-5.6-deep', 'gpt-5.6-void', 'gpt-5.6-bare',
    'glm-5.2', 'glm-5.3', 'glm-4',
    'kimi-k3', 'deepseek-v4-flash',
    'gemini-fixture-pro', 'gemini-fixture-lite',
    'openrouter/google/gemini-fixture-pro', 'openrouter/deep/deep-fixture-tall', 'openrouter/qwen/qwen-fixture-small', 'openrouter/anthropic/claude-opus-5', 'openrouter/mistral/mistral-fixture-bare',
    'local/qwen3:8b', 'local/llama3.2:latest',
    'huggingface/openai/gpt-oss-120b', 'compat/fixture-model',
  ]
  let gatedSeen = 0
  for (const container of CONTAINERS) {
    for (const model of roster) {
      const ctx = slots.subModelEffortContext(container)
      const truth = effort.resolveEffortTruth(model, undefined, ctx)
      const strip = slots.subModelEffortStrip(container, model)
      if (strip.kind === 'levels') {
        check(
          `${container} · ${model}: the strip is exactly the owner's [${truth.selectable.join(' ')}]`,
          truth.supportsEffort && truth.suppressedBy === undefined && JSON.stringify(strip.levels) === JSON.stringify(truth.selectable) && strip.levels.every(l => LEVELS.includes(l)) && strip.levels.includes(strip.current),
          JSON.stringify(strip),
        )
      } else {
        const why = !truth.supportsEffort ? 'no effort control' : truth.suppressedBy === 'thinking-off' ? 'thinking-off suppressed' : 'UNEXPLAINED'
        if (truth.supportsEffort && truth.suppressedBy === 'thinking-off') gatedSeen++
        check(`${container} · ${model}: no strip — ${why}; the receipt names the model`, why !== 'UNEXPLAINED' && strip.receipt.includes(model), JSON.stringify(strip))
      }
    }
  }
  check('Minerva (thinking off) turns at least one reasoning-dial lane into the receipt', gatedSeen > 0, String(gatedSeen))
  for (const model of roster) {
    const gated = effort.resolveEffortTruth(model, 'high', { thinkingEnabled: false }).suppressedBy === 'thinking-off'
    const supports = effort.resolveEffortTruth(model, undefined).supportsEffort
    const minerva = slots.subModelEffortStrip('minerva', model).kind
    const console_ = slots.subModelEffortStrip('console', model).kind
    check(`${model}: Minerva ${gated || !supports ? 'answers the receipt' : 'offers levels'}; the console ${supports ? 'offers levels' : 'answers the receipt'}`, minerva === (gated || !supports ? 'none' : 'levels') && console_ === (supports ? 'levels' : 'none'), `minerva=${minerva} console=${console_}`)
  }
  slots.setSubModelEffort('console', 'max')
  const opusStrip = slots.subModelEffortStrip('console', 'claude-opus-5')
  check("the bracket sits on the chosen level where offered ('max' on opus-5)", opusStrip.kind === 'levels' && opusStrip.current === 'max', JSON.stringify(opusStrip))
  const lunaStrip = slots.subModelEffortStrip('console', 'gpt-5.6-luna')
  check("…and on the owner's default where the pick is not offered (luna: low|medium|high, default medium)", lunaStrip.kind === 'levels' && lunaStrip.current === 'medium' && lunaStrip.current === effort.resolveEffortTruth('gpt-5.6-luna', undefined).applied, JSON.stringify(lunaStrip))
  slots.setSubModelEffort('console', null)
  const restStrip = slots.subModelEffortStrip('console', 'claude-opus-5')
  check('no pick ⇒ the bracket is the model default (opus-5: high)', restStrip.kind === 'levels' && restStrip.current === 'high' && restStrip.current === effort.resolveEffortTruth('claude-opus-5', undefined).applied, JSON.stringify(restStrip))
  const bareStrip = slots.subModelEffortStrip('console', 'gpt-5.6-bare')
  check("an unstated GPT catalogue row offers the owner's full ladder (dispatch re-validates live); the bracket rests on high", bareStrip.kind === 'levels' && bareStrip.levels.length === 5 && bareStrip.current === 'high', JSON.stringify(bareStrip))
}

// ── §3 the dispatch ─────────────────────────────────────────────────────────
section("§3 the dispatch: the chosen level rides each family's wire field; a model that lacks it runs the model default, never a foreign level")
{
  const anthropicWire = (model: string, value: Level | undefined): string | undefined => {
    const outputConfig: Record<string, unknown> = {}
    requestParams.configureEffortParams(effort.resolveAppliedEffort(model, value), outputConfig as never, {}, [], model)
    return outputConfig.effort as string | undefined
  }
  const gptWire = (model: string, value: Level | undefined): string | undefined => {
    const profile = openaiCatalogue.resolveGptReasoningProfile(effort.resolveWireRequestedEffort(model, value), liveRow(model))
    const body = responsesBridge.buildOpenaiResponsesRequest({ model, messages: [], ...(profile.wireEffort ? { reasoningEffort: profile.wireEffort } : {}) })
    return body.reasoning?.effort
  }
  const glmWire = (model: string, value: Level | undefined): string | undefined => {
    const requested = effort.resolveWireRequestedEffort(model, value)
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
  const compat = (wireModel: string, value: Level | undefined, thinkingEnabled: boolean, model = wireModel) => ({
    wireModel,
    effortValue: effort.resolveWireRequestedEffort(model, value),
    thinkingEnabled,
    maxOutputTokensOverride: undefined,
  })

  // first-party
  slots.setSubModelEffort('minerva', 'xhigh')
  const opus = slots.subModelDispatchEffort('minerva', 'claude-opus-5')
  check('opus-5 · xhigh chosen: the call carries xhigh and output_config.effort is xhigh', opus.effortValue === 'xhigh' && opus.fallback === undefined && anthropicWire('claude-opus-5', opus.effortValue) === 'xhigh', JSON.stringify(opus))
  const sonnet = slots.subModelDispatchEffort('minerva', 'claude-sonnet-4-6')
  const sonnetDefault = effort.resolveEffortTruth('claude-sonnet-4-6', undefined, { thinkingEnabled: false })
  check(
    'sonnet-4-6 lacks xhigh: no level rides, the wire is the model default, the receipt says so — never the nearest tier',
    sonnet.effortValue === undefined && /claude-sonnet-4-6 does not offer xhigh — runs @/.test(sonnet.fallback ?? '') && /\(the model default\); xhigh stays saved/.test(sonnet.fallback ?? '') && anthropicWire('claude-sonnet-4-6', sonnet.effortValue) === sonnetDefault.wire && effort.resolveEffortTruth('claude-sonnet-4-6', 'xhigh').wire === 'high' && anthropicWire('claude-sonnet-4-6', sonnet.effortValue) !== 'high',
    JSON.stringify({ sonnet, defaultWire: sonnetDefault.wire }),
  )
  const haiku = slots.subModelDispatchEffort('minerva', 'claude-haiku-4-5-20251001')
  check('a no-dial first-party family: no level, the receipt names the absence and the saved pick', haiku.effortValue === undefined && /claude-haiku-4-5-20251001 has no effort control — xhigh stays saved/.test(haiku.fallback ?? '') && anthropicWire('claude-haiku-4-5-20251001', haiku.effortValue) === undefined, JSON.stringify(haiku))
  slots.setSubModelEffort('minerva', null)
  check('no pick: the call carries nothing and the wire is the model default (opus-5: high)', slots.subModelDispatchEffort('minerva', 'claude-opus-5').effortValue === undefined && anthropicWire('claude-opus-5', undefined) === effort.resolveEffortTruth('claude-opus-5', undefined).wire)

  // GPT (the console: session thinking on)
  slots.setSubModelEffort('console', 'high')
  const luna = slots.subModelDispatchEffort('console', 'gpt-5.6-luna')
  check('luna · high chosen: reasoning.effort is high', luna.effortValue === 'high' && gptWire('gpt-5.6-luna', luna.effortValue) === 'high', JSON.stringify(luna))
  slots.setSubModelEffort('console', 'low')
  const deep = slots.subModelDispatchEffort('console', 'gpt-5.6-deep')
  check('deep (high|xhigh) · low chosen: no level rides, the wire is its catalogue default (high), never low', deep.effortValue === undefined && /gpt-5.6-deep does not offer low/.test(deep.fallback ?? '') && gptWire('gpt-5.6-deep', deep.effortValue) === 'high', JSON.stringify(deep))
  const voidRow = slots.subModelDispatchEffort('console', 'gpt-5.6-void')
  check('a known-empty GPT row: no level, the absence receipt, no key on the wire', voidRow.effortValue === undefined && /gpt-5.6-void has no effort control/.test(voidRow.fallback ?? '') && gptWire('gpt-5.6-void', voidRow.effortValue) === undefined, JSON.stringify(voidRow))
  slots.setSubModelEffort('console', 'max')
  const bare = slots.subModelDispatchEffort('console', 'gpt-5.6-bare')
  check('an unstated GPT row: the chosen level rides the call for the builder to resolve live; the fixture wire omits the key', bare.effortValue === 'max' && bare.fallback === undefined && gptWire('gpt-5.6-bare', bare.effortValue) === undefined, JSON.stringify(bare))

  // GLM
  const glm = slots.subModelDispatchEffort('console', 'glm-5.3')
  check('glm-5.3 · max chosen: reasoning_effort is max', glm.effortValue === 'max' && glmWire('glm-5.3', glm.effortValue) === 'max', JSON.stringify(glm))
  slots.setSubModelEffort('console', 'medium')
  const glmMedium = slots.subModelDispatchEffort('console', 'glm-5.3')
  check('glm-5.3 (low|high|max) · medium chosen: no level rides and no key is sent — never low, the nearest tier', glmMedium.effortValue === undefined && /glm-5.3 does not offer medium/.test(glmMedium.fallback ?? '') && glmWire('glm-5.3', glmMedium.effortValue) === undefined && effort.resolveEffortTruth('glm-5.3', 'medium').wire === 'low', JSON.stringify(glmMedium))

  // the compat wires: Kimi rides on both containers; DeepSeek only where thinking is on
  slots.setSubModelEffort('console', 'low')
  slots.setSubModelEffort('minerva', 'low')
  const kimiConsole = slots.subModelDispatchEffort('console', 'kimi-k3')
  const kimiMinerva = slots.subModelDispatchEffort('minerva', 'kimi-k3')
  check('kimi-k3 · low chosen: reasoning_effort low on the console (thinking on) and on Minerva (its dial is independent of thinking)',
    kimiConsole.effortValue === 'low' && (wire.buildMoonshotExtras(compat('kimi-k3', kimiConsole.effortValue, true)) as { reasoning_effort?: string }).reasoning_effort === 'low' &&
      kimiMinerva.effortValue === 'low' && (wire.buildMoonshotExtras(compat('kimi-k3', kimiMinerva.effortValue, false)) as { reasoning_effort?: string }).reasoning_effort === 'low',
    JSON.stringify({ kimiConsole, kimiMinerva }))
  slots.setSubModelEffort('console', 'high')
  slots.setSubModelEffort('minerva', 'high')
  const dsConsole = slots.subModelDispatchEffort('console', 'deepseek-v4-flash')
  const dsMinerva = slots.subModelDispatchEffort('minerva', 'deepseek-v4-flash')
  const dsWire = (value: Level | undefined, thinkingEnabled: boolean): string | undefined =>
    ((wire.buildDeepseekExtras(compat('deepseek-v4-flash', value, thinkingEnabled)) as { thinking?: { reasoning_effort?: string } }).thinking ?? {}).reasoning_effort
  check('deepseek · high chosen: the console (thinking on) sends thinking.reasoning_effort high', dsConsole.effortValue === 'high' && dsWire(dsConsole.effortValue, true) === 'high', JSON.stringify(dsConsole))
  check("deepseek · high chosen: Minerva (thinking off) carries no level, says so, and the builder sends no dial", dsMinerva.effortValue === undefined && /sends no effort dial on Minerva's thinking-off calls/.test(dsMinerva.fallback ?? '') && dsWire(dsMinerva.effortValue, false) === undefined, JSON.stringify(dsMinerva))
  slots.setSubModelEffort('console', null)
  slots.setSubModelEffort('minerva', null)

  // the console fork's app state
  const parent = { effortValue: 'max', toolPermissionContext: { mode: 'default', shouldAvoidPermissionPrompts: false }, other: 'kept' } as never
  const dialled = sideQuestion.sideQuestionAppState(parent, 'low') as unknown as { effortValue?: string; toolPermissionContext: { shouldAvoidPermissionPrompts: boolean; mode: string }; other: string }
  const undialled = sideQuestion.sideQuestionAppState(parent, null) as unknown as { effortValue?: string }
  check("the fork's app state carries the console's level (low over the main seat's max)", dialled.effortValue === 'low' && dialled.other === 'kept' && dialled.toolPermissionContext.mode === 'default')
  check("…and NO level for the model default (null ⇒ undefined), never the main seat's dial", undialled.effortValue === undefined)
  check("…keeping the unshared fork's prompt stance (prompts avoided)", dialled.toolPermissionContext.shouldAvoidPermissionPrompts === true)
}

// ── §4 the copy ─────────────────────────────────────────────────────────────
section('§4 the copy: one clause for what the model runs; the model-pick receipt names the effort')
{
  const clause = (container: Container, model: string): string => slots.subModelEffortClause(container, model)
  slots.setSubModelEffort('minerva', null)
  const opusDefault = effort.resolveEffortTruth('claude-opus-5', undefined, { thinkingEnabled: false }).label
  check(`no pick: runs @${opusDefault} (the model default)`, clause('minerva', 'claude-opus-5') === `runs @${opusDefault} (the model default)`, clause('minerva', 'claude-opus-5'))
  check('no pick, no effort control: the one absence word', clause('minerva', 'claude-haiku-4-5-20251001') === effort.NO_EFFORT_CONTROL_LABEL, clause('minerva', 'claude-haiku-4-5-20251001'))
  slots.setSubModelEffort('minerva', 'xhigh')
  check('chosen and offered: runs @xhigh (chosen)', clause('minerva', 'claude-opus-5') === 'runs @xhigh (chosen)', clause('minerva', 'claude-opus-5'))
  check('chosen, not offered: the fallback sentence names the default and the saved pick', /^claude-sonnet-4-6 does not offer xhigh — runs @.+ \(the model default\); xhigh stays saved$/.test(clause('minerva', 'claude-sonnet-4-6')), clause('minerva', 'claude-sonnet-4-6'))
  check('chosen over no effort control: the absence and the saved pick', clause('minerva', 'claude-haiku-4-5-20251001') === 'claude-haiku-4-5-20251001 has no effort control — xhigh stays saved and applies when Minerva runs an effort-capable model', clause('minerva', 'claude-haiku-4-5-20251001'))
  slots.setSubModelEffort('console', 'max')
  check('an unstated GPT row: runs @default, the pick named as resolved live', clause('console', 'gpt-5.6-bare') === 'runs @default (max chosen — resolved live at dispatch)', clause('console', 'gpt-5.6-bare'))
  slots.setSubModelEffort('console', null)
  const pick = slots.setSubModel('minerva', 'claude-opus-5', reads)
  check('the model-pick receipt names the effort beside the model', pick.ok && pick.receipt === 'Minerva model set to Opus 5 (Anthropic) — runs @xhigh (chosen) — live on the next curator pass', JSON.stringify(pick))
  const pick2 = slots.setSubModel('minerva', 'claude-sonnet-4-6', reads)
  check('…and the fallback at the moment the pick stops applying (a model change under a standing pick)', pick2.ok && /Sonnet 4\.6 \(Anthropic\) — claude-sonnet-4-6 does not offer xhigh — runs @/.test(pick2.receipt), JSON.stringify(pick2))
  const set = slots.setSubModelEffort('minerva', 'high')
  check("the effort receipt names the pinned model's clause", set.ok && set.receipt === 'Minerva effort set to high — claude-sonnet-4-6 runs @high (chosen)', JSON.stringify(set))
  process.env.MERCURY_EFFORT_LEVEL = 'low'
  check('the env door outranks the dial and the clause says so', clause('minerva', 'claude-sonnet-4-6') === 'runs @low (pinned by MERCURY_EFFORT_LEVEL)', clause('minerva', 'claude-sonnet-4-6'))
  delete process.env.MERCURY_EFFORT_LEVEL
  slots.setSubModel('minerva', null, reads)
  slots.setSubModelEffort('minerva', null)
}

// ── §5 the panel, driven ────────────────────────────────────────────────────
section('§5 the panel, driven: e opens the strip, → moves, ↵ persists and the row says (chosen), esc keeps; a no-control row answers the receipt')
{
  const React = (await import('react')).default
  const { render } = await import('../../src/ink.js')
  const { SubModelPicker } = await import('../../src/components/SubModelPicker.js')
  const SYNC_BEGIN = `${ESC}[?2026h`
  const SYNC_END = `${ESC}[?2026l`
  const lastFrame = (output: string): string => {
    const windows: string[] = []
    let cursor = 0
    for (;;) {
      const begin = output.indexOf(SYNC_BEGIN, cursor)
      if (begin === -1) break
      const start = begin + SYNC_BEGIN.length
      const end = output.indexOf(SYNC_END, start)
      if (end === -1) break
      windows.push(output.slice(start, end))
      cursor = end + SYNC_END.length
    }
    for (let i = windows.length - 1; i >= 0; i--) {
      if (stripAnsi(windows[i]!).trim() !== '') return stripAnsi(windows[i]!)
    }
    // A non-terminal stdout gets full frames with no sync markers: the
    // buffer is every frame so far, each opening on the panel's own tab
    // strip — the last segment is the settled frame.
    const HEADER = '[MINERVA]'
    const segments = stripAnsi(output).split(HEADER)
    return segments.length > 1 ? HEADER + segments[segments.length - 1]! : stripAnsi(output)
  }
  const mountPanel = async (initialModelId: string) => {
    const stdin = Object.assign(new PassThrough(), {
      isTTY: true,
      isRaw: false,
      setRawMode() { return this },
      ref() { return this },
      unref() { return this },
    })
    const stdout = Object.assign(new PassThrough(), { columns: 120, rows: 40 })
    let output = ''
    stdout.on('data', (chunk: Buffer | string) => { output += chunk.toString() })
    const instance = await render(
      React.createElement(SubModelPicker, { onClose: () => {}, onRoute: () => {}, initialContainer: 'minerva', initialModelId }),
      { stdout: stdout as never, stdin: stdin as never, patchConsole: false },
    )
    await sleep(150)
    return {
      press: async (bytes: string): Promise<void> => { stdin.write(bytes); await sleep(120) },
      frame: (): string => lastFrame(output),
      unmount: (): void => { instance.unmount() },
    }
  }
  const flat = (frame: string): string => frame.replace(/\s+/g, ' ')

  const registry = slots.composeSubModelRegistry()
  const opusRow = registry.entries.find(entry => entry.modelId === 'claude-opus-5')
  check('rig: the live registry offers claude-opus-5 selectable (the fixture Anthropic key)', opusRow?.state === 'selectable', JSON.stringify(opusRow ?? registry.families))
  slots.setSubModelEffort('minerva', null)
  const opusLevels = effort.resolveEffortTruth('claude-opus-5', undefined, { thinkingEnabled: false }).selectable
  const panel = await mountPanel('claude-opus-5')
  const rest = flat(panel.frame())
  check('at rest the hovered row spells the range and runs @high (the model default)', new RegExp(`effort ${opusLevels.join(' · ')} — runs @high \\(the model default\\)`).test(rest), rest)
  await panel.press('e')
  const opened = flat(panel.frame())
  const stripLine = `effort ${opusLevels.map(l => (l === 'high' ? `[${l}]` : l)).join(' ')}`
  check("e opens the strip with exactly the owner's levels, the bracket on the default", opened.includes(stripLine), opened)
  check('…the note line teaches the strip keys', /Opus 5 · ←→ choose · ↵ sets the minerva effort · esc keeps it/.test(opened), opened)
  await panel.press(`${ESC}[C`)
  check('→ moves the bracket one stop', flat(panel.frame()).includes('[xhigh]'), flat(panel.frame()))
  await panel.press('\r')
  const picked = flat(panel.frame())
  check('↵ persists per container (subModels.effort.minerva)', getGlobalConfig().subModels?.effort?.minerva === 'xhigh', JSON.stringify(getGlobalConfig().subModels))
  check('…the row reads runs @xhigh (chosen) and the receipt paints on the note line', /runs @xhigh \(chosen\)/.test(picked) && /Minerva effort set to xhigh/.test(picked), picked)
  check('…and the strip is gone', !picked.includes('[xhigh] max') && !/←→ choose/.test(picked), picked)
  await panel.press('e')
  check('reopening brackets the chosen level', flat(panel.frame()).includes('[xhigh]'), flat(panel.frame()))
  await panel.press(`${ESC}[D`)
  check('← moves back', flat(panel.frame()).includes('[high]'), flat(panel.frame()))
  await panel.press(ESC)
  await sleep(300)
  const kept = flat(panel.frame())
  check('esc keeps the saved level and closes the strip', getGlobalConfig().subModels?.effort?.minerva === 'xhigh' && !/←→ choose/.test(kept) && /minerva effort kept/.test(kept), kept)
  panel.unmount()

  const llamaRow = registry.entries.find(entry => entry.modelId === 'local/llama3.2:latest')
  check('rig: the discovered local server lists llama3.2 selectable', llamaRow?.state === 'selectable', JSON.stringify(llamaRow ?? registry.families))
  const panel2 = await mountPanel('local/llama3.2:latest')
  await panel2.press('e')
  const answered = flat(panel2.frame())
  check('e over a no-control model answers the receipt on the note line and opens no strip', /local\/llama3\.2:latest has no effort control/.test(answered) && !/←→ choose/.test(answered) && !/\[high\]/.test(answered), answered)
  panel2.unmount()
  slots.setSubModelEffort('minerva', null)
}

// ── §6 the wiring ───────────────────────────────────────────────────────────
section('§6 the wiring: the runners spread the dispatch answer, the console passes its dial, the surfaces share one strip')
{
  const minerva = src('src/utils/tabula/minerva.ts')
  check('the boot pass spreads the dispatch answer into its call options', /\.\.\.minervaEffort\(slot\.model\),\s*querySource: 'tabula_minerva',/.test(minerva))
  check('the chat runner too', /\.\.\.minervaEffort\(slot\.model\),\s*querySource: 'tabula_minerva_chat',/.test(minerva))
  check('…through the one dispatch composer, logging a fallback', minerva.includes("subModelDispatchEffort('minerva', model)") && minerva.includes('logForDebugging(`minerva effort: ${dispatch.fallback}`)'))
  check('the room spreads the same answer', /\.\.\.minervaEffort\(slot\.model\),\s*querySource: 'tabula_minerva_chat',/.test(src('src/utils/tabula/minervaRoom.ts')))
  const consoleAsk = src('src/utils/cockpit/helmConsoleAsk.ts')
  check('the console passes its dial, or null for NO level, to the fork', consoleAsk.includes("subModelDispatchEffort('console', slot.model)") && consoleAsk.includes('effortValue: effort.effortValue ?? null,'))
  const sq = src('src/utils/sideQuestion.ts')
  check('the fork composes its app state through the pure composer only when a dial is passed', sq.includes('sideQuestionAppState(cacheSafeParams.toolUseContext.getAppState(), effortValue)') && sq.includes('...(effortValue !== undefined'))
  check('the footer advertises e', src('src/commands/submodels/submodels.tsx').includes('· e effort ·'))
  const panel = src('src/components/SubModelPicker.tsx')
  check('the e action is gated to model rows and the list yields while the strip is up', panel.includes("key: 'e',") && panel.includes("when: row => row.kind === 'entry' && row.entry.kind === 'model'") && panel.includes('active: active && strip === null'))
  check('the strip is a modal overlay layer with its own esc', panel.includes("useRegisterOverlay('effort-strip', active && strip !== null)") && panel.includes("decodeNavKey(input, key, { orientation: 'horizontal' })"))
  check('the panel and the main picker paint the ONE strip component', panel.includes('<EffortStrip') && src('src/components/MercuryModelPicker.tsx').includes('<EffortStrip') && src('src/components/mercury-ui/EffortStrip.tsx').includes('export function EffortStrip('))
  check("the panel reads no effort table of its own (the owner's composers only)", !panel.includes('resolveEffortTruth') && panel.includes('subModelEffortStrip(container, ') && panel.includes('subModelEffortClause(container, '))
}

console.log('\n' + '═'.repeat(60))
console.log(failures ? `❌ SUBMODEL-EFFORT-DIAL RED (${failures})` : '✅ SUBMODEL-EFFORT-DIAL GREEN')
process.exit(failures ? 1 : 0)
