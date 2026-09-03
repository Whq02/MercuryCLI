#!/usr/bin/env bun
// ============================================================================
//  scripts/compact/prove-compact-gauge-truth.ts — the compact gauge tells the
//  truth: "Context left until auto-compact" and the header's ctx % come from
//  ONE owner over ONE window, the default threshold is the full usable
//  window, a set threshold is honoured, and a model switch re-anchors the
//  gauge (never a previous model's window, never a usage anchor from before
//  a cross-family switch).
//
//  The operator's screen: "Context left until auto-compact: 0%" beside a
//  header saying 22% ctx, with no threshold set. Two scales (room measured
//  against the ceiling, used measured against the window) and an early
//  buffer the operator never chose. The laws under proof (fixture-fed,
//  cpu-pure):
//
//    G1  ONE OWNER: usedPct + leftUntilCompactPct = compactAtPct (to the
//        rounding) on one window; the warning line's number IS the ladder
//        owner's pctLeft; the same count reaches the trigger
//    G2  THE DEFAULT THRESHOLD IS THE FULL USABLE WINDOW: the blocking
//        limit — effective (window − the summary reserve) − the manual-
//        compact headroom; no early buffer; a 1M model folds at 97.7 %, a
//        200 k fallback at 88.5 %
//    G3  A SET THRESHOLD IS HONOURED: the percent override to the token
//        (never above the usable edge); the settings window folds into the
//        usable window
//    G4  THE SWITCH RE-ANCHORS: the same transcript viewed under a model
//        with another window re-derives window, used % and fold point from
//        the seated model; a usage anchor stamped by another family is dead
//        (the fill estimates until the seated model answers) and the
//        trigger's count agrees; a same-family anchor stands
//    G5  THE CONTRADICTION IS DEAD: 22 % used on a 200 k window reads a
//        positive room and an ok level — never 0 % left
//
//  Run:  ~/.bun/bin/bun run scripts/compact/prove-compact-gauge-truth.ts
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
process.env.MERCURY_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'prove-compact-gauge-'))
process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'

const { enableConfigs } = await import('../../src/utils/config.ts')
enableConfigs()
const compact = await import('../../src/services/compact/autoCompact.ts')
const { resolveContextWindow } = await import('../../src/utils/model/capabilities.ts')
const tokens = await import('../../src/utils/tokens.ts')
const { contextFillView } = await import('../../src/utils/contextFill.ts')

// ── transcripts whose canonical count is EXACT ──────────────────────────────
type Usage = { input_tokens: number; output_tokens: number; cache_creation_input_tokens: number; cache_read_input_tokens: number }
let n = 0
const asst = (id: string, model: string, u: Usage, text: string): unknown => ({
  type: 'assistant',
  uuid: `a-${++n}`,
  timestamp: new Date().toISOString(),
  message: { id, model, role: 'assistant', content: [{ type: 'text', text }], usage: u, stop_reason: 'end_turn' },
})
const user = (text: string): unknown => ({
  type: 'user',
  uuid: `u-${++n}`,
  timestamp: new Date().toISOString(),
  message: { role: 'user', content: [{ type: 'text', text }] },
})
const usageOf = (total: number): Usage => ({ input_tokens: total - 600, output_tokens: 500, cache_creation_input_tokens: 100, cache_read_input_tokens: 0 })

const OPUS = 'claude-opus-5' // the first-party 1M pin
const FALLBACK = 'compat/my-model' // the labelled 200k fallback
const GPT = 'gpt-5.6-sol' // another family's id

console.log('============================================================')
console.log(' compact gauge truth — one owner, the full usable window, the switch re-anchors')
console.log('============================================================')

section('G1 · one owner: used % + left % = the fold point, on one window')
{
  const seq = [user('hi'), asst('resp-A', OPUS, usageOf(290_000), 'answer')]
  const view = contextFillView(seq as never, OPUS)
  const ladder = compact.calculateTokenWarningState(290_000, OPUS)
  check('the view reads the settled usage (290,000 · usage · 29 % of 1,000,000)', view.usedTokens === 290_000 && view.fillSource === 'usage' && view.window === 1_000_000 && view.usedPct === 29, JSON.stringify(view))
  check("the warning line's number IS the ladder owner's pctLeft", view.leftUntilCompactPct !== null && view.leftUntilCompactPct === ladder.pctLeft, JSON.stringify({ view: view.leftUntilCompactPct, ladder: ladder.pctLeft }))
  check('used % + left % = compactAtPct (to the rounding)', view.compactAtPct !== null && view.leftUntilCompactPct !== null && Math.abs(view.usedPct! + view.leftUntilCompactPct - view.compactAtPct) <= 1, JSON.stringify({ used: view.usedPct, left: view.leftUntilCompactPct, compactAt: view.compactAtPct }))
  check('the trigger counts the same tokens the view shows', tokens.tokenCountWithEstimation(seq as never, OPUS) === view.usedTokens)
  const warning = src('src/components/TokenWarning.tsx')
  check("the warning line paints the owner's pctLeft as 'Context left until auto-compact'", /calculateTokenWarningState\(tokenUsage, model\)/.test(warning) && warning.includes('Context left until auto-compact: {percent}%') && /const percent = pctLeft/.test(warning))
  const auto = src('src/services/compact/autoCompact.ts')
  check('pctLeft is measured over the model window (the one scale), never over the ceiling', /\(\(ceiling - tokenUsage\) \/ window\) \* 100/.test(auto) && !/\(\(ceiling - tokenUsage\) \/ ceiling\)/.test(auto))
}

section('G2 · the default threshold is the full usable window')
{
  for (const [model, expectPct] of [
    [OPUS, 97.7],
    [FALLBACK, 88.5],
  ] as const) {
    const window = resolveContextWindow(model).effectiveWindow
    const effective = compact.getEffectiveContextWindowSize(model)
    const threshold = compact.getAutoCompactThreshold(model)
    const blocking = compact.getBlockingLimit(model)
    check(`${model}: threshold === the blocking limit === effective − 3,000 (${threshold.toLocaleString()} of ${window.toLocaleString()})`, threshold === blocking && threshold === effective - 3_000, JSON.stringify({ window, effective, threshold, blocking }))
    const view = contextFillView([user('hi'), asst('resp-B', model === FALLBACK ? 'compat/my-model' : OPUS, usageOf(10_000), 'x')] as never, model)
    check(`  compactAtPct reads ${expectPct} % of the window`, view.compactAtPct !== null && Math.abs(view.compactAtPct - expectPct) < 0.01, String(view.compactAtPct))
  }
  const auto = src('src/services/compact/autoCompact.ts')
  check('no early buffer remains in the owner (the 13k constant is retired)', !/AUTOCOMPACT_BUFFER_TOKENS/.test(auto) && !/13_000/.test(auto))
}

section('G3 · a set threshold is honoured')
{
  process.env.MERCURY_AUTOCOMPACT_PCT_OVERRIDE = '50'
  const effective = compact.getEffectiveContextWindowSize(OPUS)
  const half = compact.getAutoCompactThreshold(OPUS)
  check('a 50 % override folds at half the usable window, to the token', half === Math.floor(effective / 2), JSON.stringify({ effective, half }))
  const halfView = contextFillView([user('hi'), asst('resp-C', OPUS, usageOf(290_000), 'x')] as never, OPUS)
  check('  the gauge follows it: compactAtPct = the override over the window, and used + left still add up', halfView.compactAtPct !== null && Math.abs(halfView.compactAtPct - (half / 1_000_000) * 100) < 0.01 && halfView.leftUntilCompactPct !== null && Math.abs(halfView.usedPct! + halfView.leftUntilCompactPct - halfView.compactAtPct) <= 1, JSON.stringify(halfView))
  process.env.MERCURY_AUTOCOMPACT_PCT_OVERRIDE = '100'
  check('a 100 % override is the full usable window — never above the usable edge', compact.getAutoCompactThreshold(OPUS) === compact.getBlockingLimit(OPUS))
  delete process.env.MERCURY_AUTOCOMPACT_PCT_OVERRIDE
  const settingsEffective = compact.getEffectiveContextWindowSize(OPUS, 100_000)
  check('a settings window of 100,000 folds into the usable window (100,000 − the 20,000 reserve = 80,000)', settingsEffective === 80_000, String(settingsEffective))
  check('  and the blocking limit under it is 77,000 — the fold point a set window yields', compact.getBlockingLimit(OPUS, 100_000) === 77_000, String(compact.getBlockingLimit(OPUS, 100_000)))
}

section('G4 · the switch re-anchors the gauge')
{
  const seq = [user('hi'), asst('resp-D', OPUS, usageOf(90_000), 'answer')]
  const underOpus = contextFillView(seq as never, OPUS)
  const underSonnet = contextFillView(seq as never, 'claude-sonnet-5')
  check('a same-family switch keeps the anchor (the count is comparable) and re-derives the window from the seated model', underOpus.fillSource === 'usage' && underOpus.usedTokens === 90_000 && underSonnet.fillSource === 'usage' && underSonnet.usedTokens === 90_000 && underSonnet.window > 0 && underSonnet.usedPct === Math.round((90_000 / underSonnet.window) * 100), JSON.stringify({ underOpus, underSonnet }))
  const gptSeq = [user('hi'), asst('resp-E', GPT, usageOf(90_000), 'sol answers')]
  const underGpt = contextFillView(gptSeq as never, GPT)
  const switched = contextFillView(gptSeq as never, OPUS)
  check("under the model that stamped it, the GPT usage anchors the fill ('usage' · 90,000 over that model's own window)", underGpt.fillSource === 'usage' && underGpt.usedTokens === 90_000 && underGpt.window > 0 && underGpt.usedPct === Math.round((90_000 / underGpt.window) * 100), JSON.stringify(underGpt))
  check("after a cross-family switch the gauge re-anchors on the seated model (1,000,000 — not the GPT window — and its own fold point) and the foreign anchor is dead: the fill estimates ('estimate'), never the previous model's 90,000", switched.window === 1_000_000 && switched.window !== underGpt.window && switched.compactAtPct !== underGpt.compactAtPct && switched.fillSource === 'estimate' && switched.usedTokens !== null && switched.usedTokens < 90_000, JSON.stringify({ switched, gptWindow: underGpt.window }))
  check("  the trigger's count agrees with the view (one fence)", tokens.tokenCountWithEstimation(gptSeq as never, OPUS) === switched.usedTokens && tokens.tokenCountWithEstimation(gptSeq as never, GPT) === 90_000)
  check('  the fence is the seated model, not a process-global (no model ⇒ the anchor stands)', tokens.tokenCountWithEstimation(gptSeq as never) === 90_000)
  const compatSeq = [user('hi'), asst('resp-G', OPUS, usageOf(90_000), 'answer')]
  const underCompat = contextFillView(compatSeq as never, FALLBACK)
  check('a compat slot is another wire: the home-lane anchor is foreign there too (estimate over the 200,000 fallback window)', underCompat.fillSource === 'estimate' && underCompat.window === 200_000, JSON.stringify(underCompat))
}

section('G5 · the contradiction is dead')
{
  const ladder = compact.calculateTokenWarningState(44_000, FALLBACK)
  // 177,000 − 44,000 = 133,000 of 200,000 → 66.5 → 67 % left to the 88.5 % fold point.
  check('22 % used on a 200k window: a positive room (67 % left to the 88.5 % fold point) and an ok level — never 0 %', ladder.level === 'ok' && ladder.pctLeft === 67, JSON.stringify(ladder))
  const view = contextFillView([user('hi'), asst('resp-F', 'compat/my-model', usageOf(44_000), 'x')] as never, FALLBACK)
  check('  the view says the same: used 22 · left 66/67 · fold 88.5', view.usedPct === 22 && view.leftUntilCompactPct !== null && view.leftUntilCompactPct >= 66 && view.leftUntilCompactPct <= 67, JSON.stringify(view))
}

console.log(failures === 0 ? '\n ✅ COMPACT GAUGE TRUTH — one owner, the full usable window, the switch re-anchors' : `\n ❌ ${failures} FAILED`)
process.exit(failures === 0 ? 0 : 1)
