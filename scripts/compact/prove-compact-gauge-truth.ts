#!/usr/bin/env bun
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
process.env.NODE_ENV = 'test'

import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

let failures = 0
function check(label: string, cond: boolean, detail = '', hint = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}${!cond && hint ? ` — to fix: ${hint}` : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
}

for (const key of [
  'OPENROUTER_API_KEY', 'GEMINI_API_KEY', 'GOOGLE_API_KEY', 'OPENAI_API_KEY', 'HF_TOKEN', 'MERCURY_MODEL',
  'MERCURY_DISABLE_1M_CONTEXT', 'MERCURY_COMPACT', 'MERCURY_AUTO_COMPACT',
  'MERCURY_AUTOCOMPACT_PCT_OVERRIDE', 'MERCURY_BLOCKING_LIMIT_OVERRIDE', 'MERCURY_LOCAL_PROBE_TARGETS',
  'MERCURY_AUTH_SCOPE_DIR',
]) {
  delete process.env[key]
}
process.env.MERCURY_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'prove-compact-gauge-'))
process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'

const { enableConfigs } = await import('../../src/platform/settings/config.ts')
enableConfigs()
const compact = await import('../../src/engine/compaction/autoFold.ts')
const { resolveContextWindow } = await import('../../src/models/facts/capabilities.ts')
const tokens = await import('../../src/engine/context-window/contextTokenCount.ts')
const { contextFillView } = await import('../../src/engine/context-window/contextFill.ts')

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

const OPUS = 'claude-opus-5'
const FALLBACK = 'compat/my-model'
const GPT = 'gpt-5.6-sol'

console.log('============================================================')
console.log(' compact gauge truth — one owner, bounded turn reserve, the switch re-anchors')
console.log('============================================================')

section('G1 · one owner: used % + left % = the fold point, on one window')
{
  const seq = [user('hi'), asst('resp-A', OPUS, usageOf(290_000), 'answer')]
  const view = contextFillView(seq as never, OPUS)
  const ladder = compact.calculateTokenWarningState(290_000, OPUS)
  check('the view reads the settled usage (290,000 · usage · 29 % of 1,000,000)', view.usedTokens === 290_000 && view.fillSource === 'usage' && view.window === 1_000_000 && view.usedPct === 29, JSON.stringify(view), 'contextFillView in src/engine/context-window/contextFill.ts must anchor on the settled usage and the resolved window')
  check("the warning line's number IS the ladder owner's pctLeft", view.leftUntilCompactPct !== null && view.leftUntilCompactPct === ladder.pctLeft, JSON.stringify({ view: view.leftUntilCompactPct, ladder: ladder.pctLeft }), 'contextFillView in src/engine/context-window/contextFill.ts must take leftUntilCompactPct from calculateTokenWarningState in src/engine/compaction-window/autoFoldWindow.ts')
  check('used % + left % = compactAtPct (to the rounding)', view.compactAtPct !== null && view.leftUntilCompactPct !== null && Math.abs(view.usedPct! + view.leftUntilCompactPct - view.compactAtPct) <= 1, JSON.stringify({ used: view.usedPct, left: view.leftUntilCompactPct, compactAt: view.compactAtPct }), 'contextFillView in src/engine/context-window/contextFill.ts must derive usedPct, leftUntilCompactPct and compactAtPct from one window')
  check('the trigger counts the same tokens the view shows', tokens.tokenCountWithEstimation(seq as never, OPUS) === view.usedTokens, '', 'tokenCountWithEstimation in src/engine/context-window/contextTokenCount.ts and contextFillView in src/engine/context-window/contextFill.ts must count the same tokens')
}

section('G2 · the default threshold leaves 20k below the usable edge')
{
  for (const [model, expectPct] of [
    [OPUS, 95.7],
    [FALLBACK, 78.5],
  ] as const) {
    const window = resolveContextWindow(model).effectiveWindow
    const effective = compact.getEffectiveContextWindowSize(model)
    const threshold = compact.getAutoCompactThreshold(model)
    const blocking = compact.getBlockingLimit(model)
    check(`${model}: threshold is 20,000 below the blocking limit (${threshold.toLocaleString()} of ${window.toLocaleString()})`, threshold === blocking - 20_000 && threshold === effective - 23_000, JSON.stringify({ window, effective, threshold, blocking }), 'getAutoCompactThreshold, getBlockingLimit and getEffectiveContextWindowSize in src/engine/compaction-window/autoFoldWindow.ts must keep the 20,000 and 23,000 token reserves')
    const view = contextFillView([user('hi'), asst('resp-B', model === FALLBACK ? 'compat/my-model' : OPUS, usageOf(10_000), 'x')] as never, model)
    check(`  compactAtPct reads ${expectPct} % of the window`, view.compactAtPct !== null && Math.abs(view.compactAtPct - expectPct) < 0.01, String(view.compactAtPct), 'compactAtPct in contextFillView (src/engine/context-window/contextFill.ts) must be the fold threshold over the window')
  }
}

section('G3 · a set threshold is honoured')
{
  process.env.MERCURY_AUTOCOMPACT_PCT_OVERRIDE = '50'
  const effective = compact.getEffectiveContextWindowSize(OPUS)
  const half = compact.getAutoCompactThreshold(OPUS)
  check('a 50 % override folds at half the usable window, to the token', half === Math.floor(effective / 2), JSON.stringify({ effective, half }), 'getAutoCompactThreshold in src/engine/compaction-window/autoFoldWindow.ts must apply MERCURY_AUTOCOMPACT_PCT_OVERRIDE to the usable window')
  const halfView = contextFillView([user('hi'), asst('resp-C', OPUS, usageOf(290_000), 'x')] as never, OPUS)
  check('  the gauge follows it: compactAtPct = the override over the window, and used + left still add up', halfView.compactAtPct !== null && Math.abs(halfView.compactAtPct - (half / 1_000_000) * 100) < 0.01 && halfView.leftUntilCompactPct !== null && Math.abs(halfView.usedPct! + halfView.leftUntilCompactPct - halfView.compactAtPct) <= 1, JSON.stringify(halfView), 'contextFillView in src/engine/context-window/contextFill.ts must read the overridden threshold from autoCompactWindow.ts')
  process.env.MERCURY_AUTOCOMPACT_PCT_OVERRIDE = '100'
  check('a 100 % override is the full usable window — never above the usable edge', compact.getAutoCompactThreshold(OPUS) === compact.getBlockingLimit(OPUS), '', 'getAutoCompactThreshold in src/engine/compaction-window/autoFoldWindow.ts must cap a percentage override at the blocking limit')
  delete process.env.MERCURY_AUTOCOMPACT_PCT_OVERRIDE
  const settingsEffective = compact.getEffectiveContextWindowSize(OPUS, 100_000)
  check('a settings window of 100,000 folds into the usable window (100,000 − the 20,000 reserve = 80,000)', settingsEffective === 80_000, String(settingsEffective), 'getEffectiveContextWindowSize in src/engine/compaction-window/autoFoldWindow.ts must subtract the 20,000 reserve from a settings window')
  check('  and the blocking limit under it is 77,000 — the fold point a set window yields', compact.getBlockingLimit(OPUS, 100_000) === 77_000, String(compact.getBlockingLimit(OPUS, 100_000)), 'getBlockingLimit in src/engine/compaction-window/autoFoldWindow.ts must derive its limit from the settings window')
}

section('G4 · the switch re-anchors the gauge')
{
  const seq = [user('hi'), asst('resp-D', OPUS, usageOf(90_000), 'answer')]
  const underOpus = contextFillView(seq as never, OPUS)
  const underSonnet = contextFillView(seq as never, 'claude-sonnet-5')
  check('a same-family switch keeps the anchor (the count is comparable) and re-derives the window from the seated model', underOpus.fillSource === 'usage' && underOpus.usedTokens === 90_000 && underSonnet.fillSource === 'usage' && underSonnet.usedTokens === 90_000 && underSonnet.window > 0 && underSonnet.usedPct === Math.round((90_000 / underSonnet.window) * 100), JSON.stringify({ underOpus, underSonnet }), 'contextFillView in src/engine/context-window/contextFill.ts must keep a same-family anchor and re-derive the window from the seated model')
  const gptSeq = [user('hi'), asst('resp-E', GPT, usageOf(90_000), 'sol answers')]
  const underGpt = contextFillView(gptSeq as never, GPT)
  const switched = contextFillView(gptSeq as never, OPUS)
  check("under the model that stamped it, the GPT usage anchors the fill ('usage' · 90,000 over that model's own window)", underGpt.fillSource === 'usage' && underGpt.usedTokens === 90_000 && underGpt.window > 0 && underGpt.usedPct === Math.round((90_000 / underGpt.window) * 100), JSON.stringify(underGpt), 'contextFillView in src/engine/context-window/contextFill.ts must anchor on usage stamped by the seated model')
  check("after a cross-family switch the gauge re-anchors on the seated model (1,000,000 — not the GPT window — and its own fold point) and the foreign anchor is dead: the fill estimates ('estimate'), never the previous model's 90,000", switched.window === 1_000_000 && switched.window !== underGpt.window && switched.compactAtPct !== underGpt.compactAtPct && switched.fillSource === 'estimate' && switched.usedTokens !== null && switched.usedTokens < 90_000, JSON.stringify({ switched, gptWindow: underGpt.window }), 'contextFillView in src/engine/context-window/contextFill.ts must treat a usage anchor from another model family as foreign and estimate the fill')
  check("  the trigger's count agrees with the view (one fence)", tokens.tokenCountWithEstimation(gptSeq as never, OPUS) === switched.usedTokens && tokens.tokenCountWithEstimation(gptSeq as never, GPT) === 90_000, '', 'tokenCountWithEstimation in src/engine/context-window/contextTokenCount.ts must apply the same foreign-anchor fence as contextFillView')
  check('  the fence is the seated model, not a process-global (no model ⇒ the anchor stands)', tokens.tokenCountWithEstimation(gptSeq as never) === 90_000, '', 'tokenCountWithEstimation in src/engine/context-window/contextTokenCount.ts must keep the anchor when no model is passed')
  const compatSeq = [user('hi'), asst('resp-G', OPUS, usageOf(90_000), 'answer')]
  const underCompat = contextFillView(compatSeq as never, FALLBACK)
  check('a compat slot is another wire: the home-lane anchor is foreign there too (estimate over the 200,000 fallback window)', underCompat.fillSource === 'estimate' && underCompat.window === 200_000, JSON.stringify(underCompat), 'contextFillView in src/engine/context-window/contextFill.ts must treat the home-lane anchor as foreign for a compat model and use the 200,000 fallback window')
}

section('G5 · the contradiction is dead')
{
  const ladder = compact.calculateTokenWarningState(44_000, FALLBACK)
  check('22 % used on a 200k window: positive room (57 % left to the 78.5 % fold point), never 0 %', ladder.level === 'ok' && ladder.pctLeft !== undefined && ladder.pctLeft >= 56 && ladder.pctLeft <= 57, JSON.stringify(ladder), 'calculateTokenWarningState in src/engine/compaction-window/autoFoldWindow.ts must return pctLeft against the fold point, never 0 while room remains')
  const view = contextFillView([user('hi'), asst('resp-F', 'compat/my-model', usageOf(44_000), 'x')] as never, FALLBACK)
  check('  the view says the same: used 22 · left 57 · fold 78.5', view.usedPct === 22 && view.leftUntilCompactPct !== null && view.leftUntilCompactPct >= 56 && view.leftUntilCompactPct <= 57, JSON.stringify(view), 'contextFillView in src/engine/context-window/contextFill.ts must report the same used and left percentages as calculateTokenWarningState')
}

console.log(failures === 0 ? '\n ✅ COMPACT GAUGE TRUTH — one owner, bounded turn reserve, the switch re-anchors' : `\n ❌ ${failures} FAILED`)
process.exit(failures === 0 ? 0 : 1)
