#!/usr/bin/env bun
// ============================================================================
//  scripts/provider-compat/prove-carrier-capability-truth.ts — a carrier row
//  (openrouter/<vendor>/<model> · gemini-*) answers the capability edge with
//  ITS OWN live-stated facts, and a Claude/GPT slug behind a carrier never
//  joins the first-party tables by substring.
//
//  The live class this closes: every OpenRouter row budgeted the Anthropic
//  200k default (a 1M row compacted at 200k; a 32k row ran unbudgeted into
//  the provider's context 400), an opus-5 slug behind the carrier lit the
//  first-party 1M pin and the 64k/128k output table, the effort chip offered
//  max/xhigh on rows whose wire sent no dial at all, and structured outputs
//  read true for a wire whose codec cannot request them.
//
//  Laws, over the REAL modules (catalogues seeded through the real refresh
//  with injected fetches; every base pinned to a non-resolvable host):
//   C1  window: the OpenRouter row's context_length is the budget; an
//       unstated row keeps the LABELLED conservative default; a Claude slug
//       behind the carrier reads the ROW's window, never the 1M pin
//   C2  output: the row's max_completion_tokens is the ceiling; unstated ⇒
//       the conservative default, never the first-party family table
//   C3  effort: the row's stated reasoning vocabulary is the dial (display),
//       and buildOpenrouterExtras sends from the SAME list (dispatch);
//       no vocabulary ⇒ no dial and no key
//   C4  Gemini: inputTokenLimit / outputTokenLimit / thinking decide window,
//       output and the reasoning_effort dial; a non-thinking row sends none
//   C5  first-party-only features read false off the Anthropic lane:
//       structured outputs · advisor · knowledge cutoff — for
//       carrier AND compat spellings
//   C6  the resolved capability record agrees with the predicates for a
//       carrier id; first-party ids are untouched (opus-5 stays 1M, max)
//   C7  the kill-switch clamps a stated >200k carrier window like every lane
//
//  Run:  ~/.bun/bin/bun run scripts/provider-compat/prove-carrier-capability-truth.ts
// ============================================================================
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
process.env.NODE_ENV = 'test'

import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

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

console.log('============================================================')
console.log(' carrier capability truth — the row answers, never a borrowed table')
console.log('============================================================')

// ── hermetic ground ─────────────────────────────────────────────────────────
for (const key of [
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'CLAUDE_CODE_OAUTH_TOKEN',
  'OPENROUTER_API_KEY',
  'GOOGLE_API_KEY',
  'GEMINI_API_KEY',
  'MERCURY_CONFIG_DIR',
  'MERCURY_AUTH_SCOPE_DIR',
  'MERCURY_DISABLE_1M_CONTEXT',
  'MERCURY_OPENROUTER_API_BASE',
  'MERCURY_OPENROUTER_AUTH_BASE',
  'MERCURY_GEMINI_API_BASE',
  'MERCURY_COMPAT_BASE_URL',
  'CLAUDE_EFFORT',
  'MERCURY_EFFORT',
]) {
  delete process.env[key]
}
process.env.MERCURY_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'prove-carrier-caps-'))
process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'
process.env.MERCURY_OPENROUTER_API_BASE = 'https://fixture.invalid/api/v1'
process.env.MERCURY_OPENROUTER_AUTH_BASE = 'https://fixture.invalid/auth'
process.env.MERCURY_GEMINI_API_BASE = 'https://fixture.invalid/v1beta'
process.env.OPENROUTER_API_KEY = 'sk-or-v1-CARRIERCAPSPROOF00000000'
process.env.GEMINI_API_KEY = 'AIza-CARRIER-CAPS-PROOF-00000'

const openrouter = await import('../../src/services/providers/openrouter/openrouterCatalogue.ts')
const gemini = await import('../../src/services/providers/gemini/geminiCatalogue.ts')
const caps = await import('../../src/utils/model/capabilities.ts')
const effort = await import('../../src/utils/effort.ts')
const wire = await import('../../src/services/providers/openaicompat/compatWire.ts')

// The OpenRouter rows, in the live /models shape (fields observed live and
// documented: context_length, top_provider.max_completion_tokens,
// supported_parameters, and the per-row `reasoning` contract).
const OPENROUTER_PAGE = {
  data: [
    {
      id: 'google/gemini-fixture-pro',
      name: 'Gemini Fixture Pro',
      context_length: 1_050_000,
      top_provider: { max_completion_tokens: 32_768 },
      supported_parameters: ['tools', 'reasoning'],
      reasoning: { supported_efforts: ['low', 'medium', 'high', 'xhigh'], default_effort: 'medium' },
    },
    {
      id: 'qwen/qwen-fixture-small',
      name: 'Qwen Fixture Small',
      context_length: 32_000,
      supported_parameters: ['tools', 'reasoning'],
    },
    {
      id: 'anthropic/claude-opus-5',
      name: 'Anthropic: Claude Opus 5 (via the carrier)',
      context_length: 200_000,
      supported_parameters: ['tools'],
    },
    { id: 'mistral/mistral-fixture-bare', name: 'Mistral Fixture Bare' },
  ],
  total_count: 4,
  links: { next: null },
}
const openrouterFetch: typeof fetch = (async () =>
  new Response(JSON.stringify(OPENROUTER_PAGE), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })) as unknown as typeof fetch

const GEMINI_PAGE = {
  models: [
    {
      name: 'models/gemini-fixture-pro',
      displayName: 'Gemini Fixture Pro',
      inputTokenLimit: 1_048_576,
      outputTokenLimit: 65_536,
      supportedGenerationMethods: ['generateContent'],
      thinking: true,
    },
    {
      name: 'models/gemini-fixture-lite',
      displayName: 'Gemini Fixture Lite',
      supportedGenerationMethods: ['generateContent'],
    },
  ],
}
const geminiFetch: typeof fetch = (async () =>
  new Response(JSON.stringify(GEMINI_PAGE), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })) as unknown as typeof fetch

openrouter.__resetOpenrouterCatalogueForTest()
gemini.__resetGeminiCatalogueForTest()
const orSnapshot = await openrouter.refreshOpenrouterCatalogue('env', { force: true, fetchImpl: openrouterFetch })
const gmSnapshot = await gemini.refreshGeminiCatalogue('api-key', { force: true, fetchImpl: geminiFetch })
check('rig: the OpenRouter fixture catalogue landed', orSnapshot?.models.length === 4)
check('rig: the Gemini fixture catalogue landed', gmSnapshot?.models.length === 2)
check(
  'rig: the row reasoning contract decodes (supported_efforts + default)',
  orSnapshot?.models[0]?.reasoning?.supportedEfforts?.join(',') === 'low,medium,high,xhigh' &&
    orSnapshot?.models[0]?.reasoning?.defaultEffort === 'medium',
)

// ============================================================================
section('C1 · the window is the row\'s stated context_length — never a borrowed default')
// ============================================================================
{
  const pro = caps.resolveContextWindow('openrouter/google/gemini-fixture-pro')
  check('a stated 1,050,000 row budgets 1,050,000 (source live-current)', pro.effectiveWindow === 1_050_000 && pro.source === 'live-current', JSON.stringify(pro))
  const small = caps.resolveContextWindow('openrouter/qwen/qwen-fixture-small')
  check('a stated 32,000 row budgets 32,000 (the compact owner fires before the provider 400)', small.effectiveWindow === 32_000, JSON.stringify(small))
  const bare = caps.resolveContextWindow('openrouter/mistral/mistral-fixture-bare')
  check(
    'an unstated row keeps the conservative default, LABELLED as the catalogue\'s silence',
    bare.effectiveWindow === 200_000 && bare.source === 'fallback' && /OpenRouter catalogue states no context length/.test(bare.fallbackReason ?? ''),
    JSON.stringify(bare),
  )
  const claude = caps.resolveContextWindow('openrouter/anthropic/claude-opus-5')
  check(
    'a Claude slug behind the carrier reads the ROW\'s 200k — the first-party 1M pin never lights by substring',
    claude.effectiveWindow === 200_000 && claude.source === 'live-current',
    JSON.stringify(claude),
  )
  const unlisted = caps.resolveContextWindow('openrouter/nobody/unlisted-model')
  check('an unlisted slug keeps the labelled default (nothing invented)', unlisted.effectiveWindow === 200_000 && unlisted.source === 'fallback')
  check('getContextWindowForModel IS the resolution\'s effective figure', caps.getContextWindowForModel('openrouter/google/gemini-fixture-pro') === 1_050_000)
  const dressed = caps.resolveContextWindow('openrouter/google/gemini-fixture-pro[1m]')
  check(
    'a legacy [1m]-dressed carrier id resolves as its base row (activation honestly unavailable)',
    dressed.effectiveWindow === 1_050_000 && dressed.activation.kind === 'unavailable',
    JSON.stringify(dressed),
  )
}

// ============================================================================
section('C2 · output: the row\'s max_completion_tokens, never the first-party family table')
// ============================================================================
{
  const pro = caps.getModelMaxOutputTokens('openrouter/google/gemini-fixture-pro')
  check('a stated 32,768 ceiling is the upper limit; the default stays within it', pro.upperLimit === 32_768 && pro.default === 32_000, JSON.stringify(pro))
  const claude = caps.getModelMaxOutputTokens('openrouter/anthropic/claude-opus-5')
  check(
    'an unstated Claude slug behind the carrier gets the conservative default — not Opus 5\'s 64k/128k',
    claude.default === 32_000 && claude.upperLimit === 64_000,
    JSON.stringify(claude),
  )
  check('the thinking-budget ceiling follows the same output truth', caps.getMaxThinkingTokensForModel('openrouter/google/gemini-fixture-pro') === 32_767)
}

// ============================================================================
section('C3 · effort: the row\'s vocabulary is the dial, and the wire sends from the same list')
// ============================================================================
{
  const pro = 'openrouter/google/gemini-fixture-pro'
  check('a row stating supported_efforts offers a dial', caps.modelSupportsEffort(pro) === true)
  check('xhigh offered exactly when the row lists it', caps.modelSupportsXHighEffort(pro) === true)
  check('max NOT offered when the row omits it', caps.modelSupportsMaxEffort(pro) === false)
  check('the ceiling composes from the row (xhigh)', caps.getMaxSupportedEffortLevel(pro) === 'xhigh')
  check(
    'selectable levels are the row\'s list ∩ Mercury\'s ladder',
    effort.selectableEffortLevels(pro).join(',') === 'low,medium,high,xhigh',
    effort.selectableEffortLevels(pro).join(','),
  )
  const generic = 'openrouter/qwen/qwen-fixture-small'
  check('a row listing `reasoning` among supported_parameters without a stated list offers the documented ladder', caps.modelSupportsEffort(generic) && caps.modelSupportsMaxEffort(generic))
  const claude = 'openrouter/anthropic/claude-opus-5'
  check(
    'a Claude slug behind the carrier with NO reasoning statement offers NO dial (the wire sends none) — never opus-5\'s max/xhigh by substring',
    caps.modelSupportsEffort(claude) === false && caps.modelSupportsMaxEffort(claude) === false && effort.selectableEffortLevels(claude).length === 0,
  )
  check('an unlisted slug offers no dial (nothing invented)', caps.modelSupportsEffort('openrouter/nobody/unlisted-model') === false)

  const vocabulary = openrouter.openrouterEffortVocabularyFor(pro)
  const base = { wireModel: 'google/gemini-fixture-pro', thinkingEnabled: true, maxOutputTokensOverride: undefined }
  const high = wire.buildOpenrouterExtras({ ...base, effortValue: 'high', vocabulary })
  check('the wire sends reasoning.effort from the row\'s vocabulary', (high.reasoning as { effort?: string })?.effort === 'high', JSON.stringify(high))
  const max = wire.buildOpenrouterExtras({ ...base, effortValue: 'max', vocabulary })
  check('a max request steps to the nearest listed level (xhigh)', (max.reasoning as { effort?: string })?.effort === 'xhigh', JSON.stringify(max))
  const noDial = wire.buildOpenrouterExtras({ ...base, effortValue: 'high', vocabulary: openrouter.openrouterEffortVocabularyFor(claude) })
  check('no vocabulary ⇒ no reasoning key on the wire (display ≡ dispatch)', !('reasoning' in noDial), JSON.stringify(noDial))
  const off = wire.buildOpenrouterExtras({ ...base, thinkingEnabled: false, effortValue: 'high', vocabulary })
  check('thinking disabled ⇒ no reasoning key (the provider default governs)', !('reasoning' in off))
  const none = wire.buildOpenrouterExtras({ ...base, effortValue: undefined, vocabulary })
  check('no requested effort ⇒ no reasoning key; include_usage always rides', !('reasoning' in none) && (none.stream_options as { include_usage?: boolean }).include_usage === true)
  check('the displayed wire word agrees with the step-down (max → xhigh)', effort.getDisplayedEffortLabel(pro, 'max') === 'xhigh', effort.getDisplayedEffortLabel(pro, 'max'))
}

// ============================================================================
section('C4 · Gemini: the row\'s limits and thinking statement decide')
// ============================================================================
{
  const pro = caps.resolveContextWindow('gemini-fixture-pro')
  check('inputTokenLimit is the budget (1,048,576 · live-current)', pro.effectiveWindow === 1_048_576 && pro.source === 'live-current', JSON.stringify(pro))
  const lite = caps.resolveContextWindow('gemini-fixture-lite')
  check('a row stating no limit keeps the labelled conservative default', lite.effectiveWindow === 200_000 && /Gemini catalogue states no context length/.test(lite.fallbackReason ?? ''), JSON.stringify(lite))
  const out = caps.getModelMaxOutputTokens('gemini-fixture-pro')
  check('outputTokenLimit is the ceiling (65,536)', out.upperLimit === 65_536 && out.default === 32_000, JSON.stringify(out))
  check('a thinking row offers the documented ladder (low · medium · high — no xhigh/max)', caps.modelSupportsEffort('gemini-fixture-pro') && !caps.modelSupportsXHighEffort('gemini-fixture-pro') && !caps.modelSupportsMaxEffort('gemini-fixture-pro'))
  check('selectable = low,medium,high', effort.selectableEffortLevels('gemini-fixture-pro').join(',') === 'low,medium,high')
  check('a row NOT stating thinking offers no dial', caps.modelSupportsEffort('gemini-fixture-lite') === false)
  const base = { wireModel: 'gemini-fixture-pro', thinkingEnabled: true, maxOutputTokensOverride: undefined }
  const x = wire.buildGeminiExtras({ ...base, effortValue: 'xhigh', acceptsEffort: true })
  check('the wire steps xhigh down to high (the documented ceiling)', x.reasoning_effort === 'high', JSON.stringify(x))
  const lo = wire.buildGeminiExtras({ ...base, effortValue: 'low', acceptsEffort: true })
  check('low rides verbatim', lo.reasoning_effort === 'low')
  const noDial = wire.buildGeminiExtras({ ...base, effortValue: 'high', acceptsEffort: false })
  check('a non-thinking row sends no reasoning_effort', !('reasoning_effort' in noDial))
  check('the profile reads the SAME vocabulary the edge offers', gemini.geminiEffortVocabularyFor('gemini-fixture-pro').join(',') === 'low,medium,high' && gemini.geminiEffortVocabularyFor('gemini-fixture-lite').length === 0)
}

// ============================================================================
section('C5 · Anthropic-wire features read false off the Anthropic lane')
// ============================================================================
{
  const carrier = 'openrouter/anthropic/claude-opus-5'
  check('structured outputs: false behind the carrier (the codec cannot request them)', caps.modelSupportsStructuredOutputs(carrier) === false)
  check('structured outputs: false on the compat slot', caps.modelSupportsStructuredOutputs('compat/claude-opus-5') === false)
  check('structured outputs: first-party opus-5 stays true', caps.modelSupportsStructuredOutputs('claude-opus-5') === true)
  check('advisor: false for compat/opus-4-6; true first-party', caps.modelSupportsAdvisor('compat/claude-opus-4-6') === false && caps.modelSupportsAdvisor('claude-opus-4-6') === true)
  check('advisor server: same law', caps.isValidAdvisorModel('compat/claude-sonnet-4-6') === false && caps.isValidAdvisorModel('claude-sonnet-4-6') === true)
  check('knowledge cutoff: null for every carrier/compat spelling', caps.getModelKnowledgeCutoff('compat/claude-opus-4-8') === null && caps.getModelKnowledgeCutoff('openrouter/anthropic/claude-opus-5') === null && caps.getModelKnowledgeCutoff('anthropic/claude-fable-5') === null)
  check('knowledge cutoff: first-party arms untouched', caps.getModelKnowledgeCutoff('claude-opus-4-8') === 'January 2026' && caps.getModelKnowledgeCutoff('claude-opus-5') === 'May 2026')
  check('effort: the compat slot offers no dial (its wire sends none)', caps.modelSupportsEffort('compat/claude-opus-5') === false && effort.selectableEffortLevels('compat/claude-opus-5').length === 0)
  check('effort: a bare vendor slug never joins the first-party tables', caps.modelSupportsEffort('anthropic/claude-opus-5') === false)
  check('auto mode stays provider-neutral (routed lanes keep flow)', caps.modelSupportsAutoMode(carrier) === true)
}

// ============================================================================
section('C6 · the resolved record agrees with the predicates; first-party untouched')
// ============================================================================
{
  const r = caps.resolveModelCapabilities('openrouter/anthropic/claude-opus-5')
  check(
    'record: window 200k (the row) · cutoff null · structured false · effort unsupported',
    r.context.window === 200_000 &&
      r.identity.knowledgeCutoff === null &&
      r.tools.structuredOutputs === false &&
      r.effort.supported === false &&
      r.context.outputMax === 64_000,
    JSON.stringify(r),
  )
  const fp = caps.resolveModelCapabilities('claude-opus-5')
  check('first-party opus-5: 1M · max effort · structured (byte-identical law)', fp.context.window === 1_000_000 && fp.effort.max === true && fp.tools.structuredOutputs === true && fp.context.outputMax === 128_000)
  check('first-party sonnet-4-5 still reads no effort', caps.modelSupportsEffort('claude-sonnet-4-5') === false)
}

// ============================================================================
section('C7 · the 1M kill-switch clamps a stated carrier window like every lane')
// ============================================================================
{
  process.env.MERCURY_DISABLE_1M_CONTEXT = '1'
  const clamped = caps.resolveContextWindow('openrouter/google/gemini-fixture-pro')
  check('a stated 1,050,000 clamps to 200k with the kill-switch reason', clamped.effectiveWindow === 200_000 && /kill-switch/.test(clamped.fallbackReason ?? ''), JSON.stringify(clamped))
  const gm = caps.resolveContextWindow('gemini-fixture-pro')
  check('the Gemini row clamps the same way', gm.effectiveWindow === 200_000 && /kill-switch/.test(gm.fallbackReason ?? ''))
  delete process.env.MERCURY_DISABLE_1M_CONTEXT
  check('the switch off: the stated window returns', caps.resolveContextWindow('openrouter/google/gemini-fixture-pro').effectiveWindow === 1_050_000)
}

console.log('\n' + '='.repeat(60))
console.log(` ${checks} checks, ${failures} failures`)
console.log('='.repeat(60))
process.exit(failures > 0 ? 1 : 0)
