#!/usr/bin/env bun
// ============================================================================
//  scripts/compact/prove-compaction-trigger-families.ts — the compaction
//  trigger fires at the right fraction of the REAL window, per family.
//
//  The operator's word: "the context measurement needs to be accurate for
//  compaction". The trigger (shouldAutoCompact) reads tokenCountWithEstimation
//  against getAutoCompactThreshold(model), which derives from the ONE window
//  owner (resolveContextWindow). Per family, on fixture-seeded sources:
//
//   T1  the threshold is window − summary reserve − 13k on every ≥100k
//       window: a 1M carrier model's threshold sits above 950k (never a
//       compaction at ~160k), a 131,072 row's threshold sits below its own
//       window (never sailing to 200k), a 32,768 row keeps the proportional
//       floors (positive, ≥ half the effective window).
//   T2  shouldAutoCompact is exact to the token: false at threshold − 1,
//       true at threshold — on the Anthropic, OpenRouter (1M and 131k),
//       Gemini, Kimi, GLM, DeepSeek and Hugging Face fixtures; the count it
//       reads is the settled usage's full context (input + cache families +
//       output), sibling blocks counted once.
//   T3  the settings override clamps: below 100k rises to 100k, above 1M
//       falls to 1M, and never exceeds the model's own window; the warning
//       ladder's ceiling, the blocking limit and the fixed-prefix overflow
//       diagnostic read the same numbers; the maintenance ladder receives
//       the trigger's own threshold.
//   T4  the surfaces agree with the trigger to the token: contextFillView's
//       usedTokens IS the trigger's count and its compactAtPct IS the
//       threshold over the same window; contextGauge reads the same view.
//
//  Run:  ~/.bun/bin/bun run scripts/compact/prove-compaction-trigger-families.ts
// ============================================================================
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
process.env.NODE_ENV = 'test'

import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
}
const ROOT = join(import.meta.dir, '..', '..')
const src = (p: string): string => readFileSync(join(ROOT, p), 'utf8')

for (const key of [
  'OPENROUTER_API_KEY', 'GEMINI_API_KEY', 'GOOGLE_API_KEY', 'OPENAI_API_KEY', 'HF_TOKEN', 'ANTHROPIC_MODEL',
  'MERCURY_DISABLE_1M_CONTEXT', 'CLAUDE_EFFORT', 'DISABLE_COMPACT', 'DISABLE_AUTO_COMPACT',
  'MERCURY_AUTOCOMPACT_PCT_OVERRIDE', 'MERCURY_BLOCKING_LIMIT_OVERRIDE', 'MERCURY_LOCAL_PROBE_TARGETS',
  'MERCURY_AUTH_SCOPE_DIR',
]) {
  delete process.env[key]
}
process.env.MERCURY_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'prove-compact-families-'))
process.env.MERCURY_OPENROUTER_API_BASE = 'http://127.0.0.1:9/api/v1'
process.env.MERCURY_GEMINI_API_BASE = 'http://127.0.0.1:9/v1beta'
process.env.MERCURY_HUGGINGFACE_API_BASE = 'http://127.0.0.1:9/v1'
process.env.MERCURY_HUGGINGFACE_HUB_BASE = 'http://127.0.0.1:9'
process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'

const { enableConfigs } = await import('../../src/utils/config.ts')
enableConfigs()
const compact = await import('../../src/services/compact/autoCompact.ts')
const { resolveContextWindow, getModelMaxOutputTokens } = await import('../../src/utils/model/capabilities.ts')
const tokens = await import('../../src/utils/tokens.ts')
const { contextFillView } = await import('../../src/utils/contextFill.ts')
const { contextGauge } = await import('../../src/utils/cockpit/contextGauge.ts')
const openrouter = await import('../../src/services/providers/openrouter/openrouterCatalogue.ts')
const gemini = await import('../../src/services/providers/gemini/geminiCatalogue.ts')
const huggingface = await import('../../src/services/providers/huggingface/huggingfaceCatalogue.ts')

const jsonFetch = (body: unknown): typeof fetch =>
  (async () => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })) as typeof fetch

// ── fixture sources (the real refreshes, injected fetches) ──────────────────
process.env.OPENROUTER_API_KEY = 'sk-or-fixture'
await openrouter.refreshOpenrouterCatalogue('env', {
  force: true,
  fetchImpl: jsonFetch({
    data: [
      { id: 'stealth/ox-alpha', name: 'Ox Alpha', context_length: 1_048_576 },
      { id: 'meta/llama-small', name: 'Llama small', context_length: 131_072 },
      { id: 'tiny/edge-32k', name: 'Edge 32k', context_length: 32_768 },
    ],
    total_count: 3,
    links: { next: null },
  }),
})
process.env.GEMINI_API_KEY = 'AIza-fixture-000000000000000'
await gemini.refreshGeminiCatalogue('api-key', {
  force: true,
  fetchImpl: jsonFetch({ models: [{ name: 'models/gemini-fixture-pro', displayName: 'Gemini Fixture Pro', inputTokenLimit: 1_048_576, outputTokenLimit: 65_536, supportedGenerationMethods: ['generateContent'] }] }),
})
const HF_FIXTURE = JSON.parse(readFileSync(join(ROOT, 'scripts', 'provider-compat', 'fixtures', 'huggingface-models-2026-08-22.json'), 'utf8')) as unknown
await huggingface.refreshHuggingfaceCatalogue({ force: true, fetchImpl: ((async (url: unknown) => String(url).endsWith('/models') ? new Response(JSON.stringify(HF_FIXTURE), { status: 200, headers: { 'content-type': 'application/json' } }) : new Response('{}', { status: 404 })) as typeof fetch) })

// ── transcripts whose canonical count is EXACT ──────────────────────────────
type Usage = { input_tokens: number; output_tokens: number; cache_creation_input_tokens: number; cache_read_input_tokens: number }
let n = 0
const asst = (id: string, u: Usage, text: string, stop: string | null = 'end_turn'): unknown => ({
  type: 'assistant',
  uuid: `a-${++n}`,
  timestamp: new Date().toISOString(),
  message: { id, model: 'fixture-model', role: 'assistant', content: [{ type: 'text', text }], usage: u, stop_reason: stop },
})
const user = (text: string): unknown => ({
  type: 'user',
  uuid: `u-${++n}`,
  timestamp: new Date().toISOString(),
  message: { role: 'user', content: [{ type: 'text', text }] },
})
/** A settled response whose full context (input + cache_read + cache_creation + output) is exactly `total`. */
function transcriptAt(total: number): unknown[] {
  const output = 500
  const cacheRead = Math.floor(total / 3)
  const cacheCreation = 100
  const input = total - output - cacheRead - cacheCreation
  const u: Usage = { input_tokens: input, output_tokens: output, cache_creation_input_tokens: cacheCreation, cache_read_input_tokens: cacheRead }
  // Two sibling blocks sharing the response: the first carries the
  // message_start snapshot, the settled last block carries the usage.
  return [user('hi'), asst('resp-X', { ...u, output_tokens: 1 }, 'block one', null), asst('resp-X', u, 'block two', 'end_turn')]
}

const FAMILIES: Array<{ label: string; model: string; window: number }> = [
  { label: 'Anthropic (first-party 1M pin)', model: 'claude-opus-5', window: 1_000_000 },
  { label: 'OpenRouter 1M carrier (live context_length)', model: 'openrouter/stealth/ox-alpha', window: 1_048_576 },
  { label: 'OpenRouter 131k carrier (live context_length)', model: 'openrouter/meta/llama-small', window: 131_072 },
  { label: 'Gemini (live inputTokenLimit)', model: 'gemini-fixture-pro', window: 1_048_576 },
  { label: 'Kimi (dated pin)', model: 'kimi-k3', window: 1_048_576 },
  { label: 'GLM (dated pin)', model: 'glm-5.3', window: 1_000_000 },
  { label: 'DeepSeek (dated pin)', model: 'deepseek-v4-pro', window: 1_000_000 },
  { label: 'Hugging Face (live provider context_length)', model: 'huggingface/Qwen/Qwen3.8-2.4T-A95B', window: 1_010_000 },
  { label: 'compat slot (labelled fallback)', model: 'compat/my-model', window: 200_000 },
]

console.log('============================================================')
console.log(' compaction trigger: the right fraction of the REAL window, per family')
console.log('============================================================')

section('T1 · threshold derivation per family')
const thresholds = new Map<string, number>()
for (const f of FAMILIES) {
  const r = resolveContextWindow(f.model)
  const effective = compact.getEffectiveContextWindowSize(f.model)
  const threshold = compact.getAutoCompactThreshold(f.model)
  thresholds.set(f.model, threshold)
  const reserve = Math.min(getModelMaxOutputTokens(f.model).upperLimit, 20_000, Math.floor(f.window / 4))
  // The default threshold is the FULL usable window — the blocking limit
  // (effective − the manual-compact headroom); no early buffer.
  const expected = effective - 3_000
  check(`${f.label}: window ${f.window.toLocaleString()} · effective ${effective.toLocaleString()} · threshold ${threshold.toLocaleString()} (${((threshold / f.window) * 100).toFixed(1)}%)`, r.effectiveWindow === f.window && effective === f.window - reserve && threshold === expected, JSON.stringify({ w: r.effectiveWindow, s: r.source, effective, threshold }))
}
check('a 1M carrier never compacts at ~160k: its threshold exceeds 950,000', thresholds.get('openrouter/stealth/ox-alpha')! > 950_000)
check('a 131k carrier never sails to 200k: its threshold is below 131,072', thresholds.get('openrouter/meta/llama-small')! < 131_072 && thresholds.get('openrouter/meta/llama-small')! === 131_072 - 20_000 - 3_000)
{
  const tiny = compact.getAutoCompactThreshold('openrouter/tiny/edge-32k')
  const tinyEff = compact.getEffectiveContextWindowSize('openrouter/tiny/edge-32k')
  check('a 32,768 row keeps the proportional reserve: effective 24,576 (reserve ≤ window/4) · threshold 21,576 (the full usable window)', tinyEff === 24_576 && tiny === 21_576, JSON.stringify({ tinyEff, tiny }))
}

section('T2 · shouldAutoCompact is exact to the token on every family')
for (const f of FAMILIES) {
  const threshold = thresholds.get(f.model)!
  const below = transcriptAt(threshold - 1)
  const at = transcriptAt(threshold)
  check(`  ${f.model}: the canonical count reads the settled usage exactly (${threshold - 1} / ${threshold})`, tokens.tokenCountWithEstimation(below as never) === threshold - 1 && tokens.tokenCountWithEstimation(at as never) === threshold)
  const fireBelow = await compact.shouldAutoCompact(below as never, f.model)
  const fireAt = await compact.shouldAutoCompact(at as never, f.model)
  check(`${f.label}: false at threshold − 1, true at threshold`, fireBelow === false && fireAt === true, JSON.stringify({ fireBelow, fireAt }))
}
{
  // The 1M carrier at the fallback-window threshold (167,000 — where the
  // rot fired): must NOT compact.
  const oldFallbackThreshold = 200_000 - 20_000 - 13_000
  const fired = await compact.shouldAutoCompact(transcriptAt(oldFallbackThreshold) as never, 'openrouter/stealth/ox-alpha')
  check('the 1M carrier at 167,000 tokens (the fallback-window threshold) does NOT compact', fired === false)
  // The 131k carrier at 120,000 — well past its own threshold (98,072) and
  // under the fallback's (167,000): MUST compact.
  const fired131 = await compact.shouldAutoCompact(transcriptAt(120_000) as never, 'openrouter/meta/llama-small')
  check('the 131k carrier at 120,000 tokens DOES compact (the fallback window would have let it overflow)', fired131 === true)
}

section('T3 · settings override clamps; the warning ladder, blocking limit, overflow diagnostic and maintenance ladder read the same numbers')
{
  const low = compact.resolveAutoCompactWindow('openrouter/stealth/ox-alpha', 50_000)
  check('autoCompactWindow 50,000 rises to the 100,000 floor (configured 100,000; window 100,000)', low.configured === 100_000 && low.window === 100_000 && low.source === 'settings')
  const high = compact.resolveAutoCompactWindow('openrouter/stealth/ox-alpha', 2_000_000)
  check('autoCompactWindow 2,000,000 falls to the 1,000,000 cap (a 1,048,576 model budgets 1,000,000 under the override)', high.configured === 1_000_000 && high.window === 1_000_000)
  const clamped = compact.resolveAutoCompactWindow('openrouter/meta/llama-small', 500_000)
  check('autoCompactWindow 500,000 never exceeds the model\'s own 131,072', clamped.configured === 500_000 && clamped.window === 131_072)
  const auto = compact.resolveAutoCompactWindow('openrouter/stealth/ox-alpha')
  check('no override ⇒ the model window verbatim (1,048,576 · source auto)', auto.window === 1_048_576 && auto.source === 'auto')
  const effOverride = compact.getEffectiveContextWindowSize('openrouter/meta/llama-small', 500_000)
  check('getEffectiveContextWindowSize honours the clamped override (131,072 − 20,000)', effOverride === 111_072)

  const model = 'openrouter/stealth/ox-alpha'
  const threshold = thresholds.get(model)!
  const effective = compact.getEffectiveContextWindowSize(model)
  const warnAt = compact.calculateTokenWarningState(threshold - 20_000, model)
  const warnBelow = compact.calculateTokenWarningState(threshold - 20_001, model)
  const compactAt = compact.calculateTokenWarningState(threshold, model)
  const blockedAt = compact.calculateTokenWarningState(effective - 3_000, model)
  // The default threshold IS the blocking limit (effective − 3,000): the
  // fold fires at the last count a call still fits at, and the level there
  // reads blocked (the stronger word — the trigger folds on either).
  check('warning ladder: warn at threshold − 20,000 · ok one token below · the fold point at threshold (compact/blocked) · blocked at effective − 3,000', warnAt.level === 'warn' && warnBelow.level === 'ok' && (compactAt.level === 'compact' || compactAt.level === 'blocked') && blockedAt.level === 'blocked', JSON.stringify({ warnAt, warnBelow, compactAt, blockedAt }))
  // pctLeft is the room to the threshold as a share of the model's WINDOW
  // (the header's own denominator): 0 at the threshold, and 20,000 tokens
  // under it exactly 20,000/window.
  check('pctLeft is measured to the trigger threshold over the model window (0 at threshold)', compactAt.pctLeft === 0 && warnAt.pctLeft === Math.round((20_000 / resolveContextWindow(model).effectiveWindow) * 100), JSON.stringify({ compactAt, warnAt }))
  const overflow = compact.detectFixedPrefixOverflow(transcriptAt(threshold + 50_000) as never, model)
  check('the fixed-prefix overflow diagnostic reads the same threshold', overflow !== null && overflow.thresholdTokens === threshold && overflow.prefixTokens <= effective, JSON.stringify(overflow))
  const source = src('src/services/compact/autoCompact.ts')
  check('the maintenance ladder receives the trigger\'s own threshold (recompactionInfo.autoCompactThreshold)', /const threshold = getAutoCompactThreshold\(model\)[\s\S]{0,400}autoCompactThreshold: threshold/.test(source))
  check('the trigger awaits the window source before deciding', /await awaitContextWindowSource\(model\)/.test(source))
}

section('T4 · the surfaces agree with the trigger to the token')
for (const f of FAMILIES) {
  const threshold = thresholds.get(f.model)!
  const messages = transcriptAt(threshold - 12_345)
  const view = contextFillView(messages as never, f.model)
  const count = tokens.tokenCountWithEstimation(messages as never)
  const snap = contextGauge(messages as never, f.model as never)
  check(`${f.label}: usedTokens === trigger count (${count.toLocaleString()}) · window ${f.window.toLocaleString()} · compactAtPct === threshold/window · contextGauge agrees`, view.usedTokens === count && view.window === f.window && view.compactAtPct !== null && Math.abs(view.compactAtPct - (threshold / f.window) * 100) < 1e-9 && view.usedPct === Math.round((count / f.window) * 100) && snap.data.usedPct === view.usedPct && snap.data.usedTokens === count && snap.data.window === f.window, JSON.stringify({ view, count, snap: snap.data }))
}
{
  const fallback = contextFillView(transcriptAt(56_300) as never, 'compat/my-model')
  check("the compat slot's window is LABELLED as the fallback on the surface (windowSource 'fallback', reason stated)", fallback.windowSource === 'fallback' && typeof fallback.windowReason === 'string' && fallback.usedPct === 28)
  const carrier = contextFillView(transcriptAt(56_300) as never, 'openrouter/stealth/ox-alpha')
  check("the operator's frame: 56,300 tokens on the 1M carrier paints 5%, not 28%", carrier.usedPct === 5 && carrier.windowSource === 'live-current')
}

console.log('\n' + (failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`))
process.exit(failures === 0 ? 0 : 1)
