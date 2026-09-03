#!/usr/bin/env bun
// ============================================================================
//  scripts/context/prove-context-fill-agreement.ts — the context NUMERATOR.
//
//  The operator's rail painted "ctx 28% · 200k" after a one-word turn on a
//  1M carrier model. The window half is the owner's (prove-context-window-
//  families); this prover pins the USED half and the agreement law:
//
//   N1  every dialect's usage envelope folds to the canonical disjoint
//       envelope and the used-count equals the wire's own total exactly
//       once — OpenAI-compat / OpenRouter (prompt_tokens ⊇ cached_tokens),
//       DeepSeek (prompt_cache_hit + miss), Moonshot (top-level
//       cached_tokens), the Responses lane (input_tokens ⊇ cached), the
//       Anthropic wire (input + both cache families + output).
//   N2  a response minted as one assistant record per content block (the
//       runtimes' shape) counts its output ONCE: the settled usage on the
//       last block covers every sibling, so the tail estimate skips them;
//       an UNSETTLED record (message_start snapshot, no stop_reason) keeps
//       the siblings estimated so in-flight output is never dropped.
//   N3  the interleaved tool results after a response are counted (the
//       anchor-at-first-sibling law), never left out.
//   N4  the all-zero per-block placeholder every engine lane mints is not
//       a usage record: mid-stream the count rides the previous response,
//       never a confident 0%.
//   N5  the ONE fill derivation (utils/contextFill) is what the rail, the
//       deck, contextGauge, /model and /context read: its token figure IS
//       tokenCountWithEstimation (the compaction trigger's count) over the
//       one window owner; a fresh session reads null (never a fake gauge);
//       a usage-less response reads an estimate LABELLED ≈; a fallback
//       window is LABELLED ~.
//   N6  the publish seam carries the figure and both provenance words and
//       bumps its version only when the slot changes (the rails subscribe).
//
//  Run:  ~/.bun/bin/bun run scripts/context/prove-context-fill-agreement.ts
// ============================================================================
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
process.env.NODE_ENV = 'test'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
for (const key of ['OPENROUTER_API_KEY', 'GEMINI_API_KEY', 'GOOGLE_API_KEY', 'OPENAI_API_KEY', 'HF_TOKEN', 'ANTHROPIC_MODEL', 'MERCURY_DISABLE_1M_CONTEXT', 'CLAUDE_EFFORT']) {
  delete process.env[key]
}
process.env.MERCURY_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'prove-ctx-fill-'))
process.env.MERCURY_OPENROUTER_API_BASE = 'http://127.0.0.1:9/api/v1'

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

const tokens = await import('../../src/utils/tokens.ts')
const context = await import('../../src/utils/context.ts')
const fillOwner = await import('../../src/utils/contextFill.ts')
const live = await import('../../src/utils/cockpit/contextUsageLive.ts')
const tokEst = await import('../../src/services/tokenEstimation.ts')
const { decodeCompatUsage } = await import('../../src/services/providers/openaicompat/compatChatClient.ts')
const { mapCompatUsageToAnthropic } = await import('../../src/services/providers/openaicompat/compatChatCallModel.ts')
const { mapOpenaiUsageToAnthropic } = await import('../../src/services/providers/openai/openaiCallModel.ts')

type Usage = { input_tokens: number; output_tokens: number; cache_creation_input_tokens: number; cache_read_input_tokens: number }
const usage = (input: number, output: number, cc = 0, cr = 0): Usage => ({
  input_tokens: input,
  output_tokens: output,
  cache_creation_input_tokens: cc,
  cache_read_input_tokens: cr,
})
let n = 0
const asst = (id: string, u: Usage | undefined, text: string, stop: string | null = 'end_turn'): unknown => ({
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
const toolResult = (text: string): unknown => ({
  type: 'user',
  uuid: `t-${++n}`,
  timestamp: new Date().toISOString(),
  message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: text }] },
})
const rough = (messages: unknown[]): number => tokEst.roughTokenCountEstimationForMessages(messages as never)

console.log('============================================================')
console.log(' context fill: the numerator, once, on every dialect')
console.log('============================================================')

section('N1 · every dialect folds to the canonical envelope; the count is the wire total once')
{
  // OpenAI-compat / OpenRouter: prompt_tokens is INCLUSIVE of the cached prefix.
  const compat = mapCompatUsageToAnthropic(decodeCompatUsage({ prompt_tokens: 56_000, completion_tokens: 300, total_tokens: 56_300, prompt_tokens_details: { cached_tokens: 20_000 } }))
  check('OpenAI-compat/OpenRouter: 56,000 prompt (20,000 cached) + 300 ⇒ input 36,000 · cache_read 20,000 · output 300', compat.input_tokens === 36_000 && compat.cache_read_input_tokens === 20_000 && compat.output_tokens === 300, JSON.stringify(compat))
  check('  used-count = 56,300 (prompt + completion — the cached prefix counted once)', tokens.getTokenCountFromUsage(compat as never) === 56_300, String(tokens.getTokenCountFromUsage(compat as never)))
  const noCache = mapCompatUsageToAnthropic(decodeCompatUsage({ prompt_tokens: 56_000, completion_tokens: 300 }))
  check('  no cached_tokens stated ⇒ input 56,000 · cache_read 0 · count 56,300', noCache.input_tokens === 56_000 && noCache.cache_read_input_tokens === 0 && tokens.getTokenCountFromUsage(noCache as never) === 56_300)
  // DeepSeek: prompt_tokens = hit + miss.
  const deepseek = mapCompatUsageToAnthropic(decodeCompatUsage({ prompt_tokens: 1_000, completion_tokens: 50, prompt_cache_hit_tokens: 600, prompt_cache_miss_tokens: 400 }))
  check('DeepSeek: 1,000 prompt (600 hit + 400 miss) + 50 ⇒ input 400 · cache_read 600 · count 1,050', deepseek.input_tokens === 400 && deepseek.cache_read_input_tokens === 600 && tokens.getTokenCountFromUsage(deepseek as never) === 1_050, JSON.stringify(deepseek))
  // Moonshot: top-level cached_tokens ⊆ prompt_tokens.
  const moonshot = mapCompatUsageToAnthropic(decodeCompatUsage({ prompt_tokens: 2_000, completion_tokens: 10, cached_tokens: 1_500 }))
  check('Moonshot: 2,000 prompt (1,500 cached) + 10 ⇒ input 500 · cache_read 1,500 · count 2,010', moonshot.input_tokens === 500 && moonshot.cache_read_input_tokens === 1_500 && tokens.getTokenCountFromUsage(moonshot as never) === 2_010)
  // Responses lane: input_tokens ⊇ input_tokens_details.cached_tokens.
  const responses = mapOpenaiUsageToAnthropic({ inputTokens: 1_000, outputTokens: 50, cachedInputTokens: 400 } as never)
  check('Responses: 1,000 input (400 cached) + 50 ⇒ input 600 · cache_read 400 · count 1,050', responses.input_tokens === 600 && responses.cache_read_input_tokens === 400 && tokens.getTokenCountFromUsage(responses as never) === 1_050)
  // Anthropic wire: disjoint fields, both cache families.
  check('Anthropic: input 100 + cache_creation 5 + cache_read 7 + output 10 ⇒ count 122', tokens.getTokenCountFromUsage(usage(100, 10, 5, 7) as never) === 122)
  // A wire that reports NO usage: the fold yields the zero placeholder, which is not usage (N4).
  const none = mapCompatUsageToAnthropic(undefined)
  check('a usage-less wire folds to the zero placeholder — and it is not a usage record', tokens.getTokenUsage(asst('none', none as never, 'x') as never) === undefined)
}

section('N2 · per-block siblings count once when settled; estimated while unsettled')
{
  const big = 'x'.repeat(4_000)
  // Anthropic-shaped: every block minted with the message_start snapshot
  // (output_tokens 1, stop_reason null); the LAST carries the final usage +
  // stop_reason.
  const seq = [user('hi'), asst('resp-A', usage(1_000, 1), big, null), asst('resp-A', usage(1_000, 1), big, null), asst('resp-A', usage(1_000, 300), big, 'tool_use'), toolResult(big), toolResult(big)]
  const got = tokens.tokenCountWithEstimation(seq as never)
  const want = 1_300 + rough([toolResult(big), toolResult(big)])
  check('settled 3-block response + 2 tool results = usage (1,300) + the two tool results, siblings NOT re-estimated', got === want, `${got} vs ${want}`)
  check('  (the old law double-counted the two sibling blocks: +~2,000)', got < want + rough([asst('resp-A', undefined, big)]), String(got))
  const fill = tokens.contextFill(seq as never)
  check('  contextFill reports the wire source', fill.source === 'usage' && fill.tokens === got)
  // Mid-stream: the latest block carries only the message_start snapshot.
  const midStream = [user('hi'), asst('resp-B', usage(1_000, 1), big, null), asst('resp-B', usage(1_000, 1), big, null)]
  const mid = tokens.tokenCountWithEstimation(midStream as never)
  check('unsettled (no stop_reason): the sibling blocks ARE estimated — in-flight output never dropped', mid === 1_001 + rough([asst('resp-B', undefined, big)]), String(mid))
  // The contract prover's sibling shape: two splits with interleaved tool
  // results, the usage-bearing LAST split settled.
  const a1 = asst('resp-C', usage(1_000, 50), 'first split block', null)
  const t1 = toolResult('tool result one')
  const a2 = asst('resp-C', usage(1_000, 50), 'second split block', 'tool_use')
  const t2 = toolResult('tool result two')
  const split = tokens.tokenCountWithEstimation([user('prompt'), a1, t1, a2, t2] as never)
  check('settled split response: usage + tool results only (the second split is inside output_tokens)', split === 1_050 + rough([t1, t2]), String(split))
}

section('N3 · interleaved tool results after the response are counted')
{
  const big = 'y'.repeat(8_000)
  const seq = [user('go'), asst('resp-D', usage(5_000, 100), 'calling tools', 'tool_use'), toolResult(big), toolResult(big), toolResult(big)]
  const got = tokens.tokenCountWithEstimation(seq as never)
  check('three tool results after the last usage ride the count', got === 5_100 + rough([toolResult(big), toolResult(big), toolResult(big)]) && got > 10_000, String(got))
}

section('N4 · the all-zero per-block placeholder is not usage')
{
  const zero = usage(0, 0)
  check('getTokenUsage(all-zero) ⇒ undefined', tokens.getTokenUsage(asst('resp-E', zero, 'partial', null) as never) === undefined)
  check('a real usage still surfaces', tokens.getTokenUsage(asst('resp-E', usage(1, 0), 'x') as never) !== undefined)
  const loop = { ...zero, iterations: [{ input_tokens: 700, output_tokens: 50 }] }
  check('a server-tool-loop record whose counts live in `iterations` alone is NOT a placeholder', tokens.getTokenUsage(asst('resp-E2', loop as never, 'loop') as never) !== undefined && tokens.finalContextTokensFromLastResponse([asst('resp-E2', loop as never, 'loop')] as never) === 750)
  const midStream = [asst('resp-P', usage(5_000, 50), 'previous answer'), user('go'), asst('resp-Q', zero, 'partial', null)]
  const current = tokens.getCurrentUsage(midStream as never)
  check('mid-stream on a chat dialect: getCurrentUsage rides the PREVIOUS response (5,050), never zeros', current?.input_tokens === 5_000 && current.output_tokens === 50, JSON.stringify(current))
  const count = tokens.tokenCountWithEstimation(midStream as never)
  check('  the count = 5,050 + the estimate of what followed (never 0)', count === 5_050 + rough([user('go'), asst('resp-Q', zero, 'partial', null)]) && count > 5_050, String(count))
  check('tokenCountFromLastAPIResponse also skips the placeholder', tokens.tokenCountFromLastAPIResponse(midStream as never) === 5_050)
}

section('N5 · the ONE fill derivation every surface reads')
{
  const { contextFillView, contextWindowLabel, contextPercentLabel } = fillOwner
  const fresh = contextFillView([user('hi')] as never, 'claude-opus-5')
  check('fresh session (no response) ⇒ usedTokens null · usedPct null · window from the owner (1,000,000)', fresh.usedTokens === null && fresh.usedPct === null && fresh.window === 1_000_000 && fresh.fillSource === null, JSON.stringify(fresh))
  const seq = [user('hi'), asst('resp-F', usage(280_000, 10_000), 'answer')]
  const view = contextFillView(seq as never, 'claude-opus-5')
  check('usage-bearing: usedTokens === tokenCountWithEstimation (290,000) · pct 29 · source usage', view.usedTokens === tokens.tokenCountWithEstimation(seq as never) && view.usedTokens === 290_000 && view.usedPct === 29 && view.fillSource === 'usage', JSON.stringify(view))
  check('  the deck reads the token figure, not 29% × window (which would paint 290k for a 285k count)', Math.round(view.usedTokens! / 1000) === 290)
  const compactAt = view.compactAtPct
  check('  compactAtPct is the trigger threshold over the same window (977,000 / 1,000,000 = 97.7 — the full usable window)', compactAt !== null && Math.abs(compactAt - 97.7) < 0.01, String(compactAt))
  check('  leftUntilCompactPct rides the same window: used 29 + left 68 = the 97.7 fold point (to the rounding)', view.leftUntilCompactPct !== null && Math.abs(view.usedPct! + view.leftUntilCompactPct - compactAt!) <= 1, JSON.stringify({ used: view.usedPct, left: view.leftUntilCompactPct, compactAt }))
  // The same messages against a fallback-window model.
  const fallback = contextFillView(seq as never, 'compat/some-model')
  check('a fallback window resolves 200,000 with windowSource fallback and a reason', fallback.window === 200_000 && fallback.windowSource === 'fallback' && typeof fallback.windowReason === 'string')
  check('  pct = 290,000 / 200,000 clamps to 100', fallback.usedPct === 100)
  check("  the rail label marks it: '~200k'", contextWindowLabel(fallback.window, fallback.windowSource) === '~200k')
  check("  a stated window carries no mark: '1000k'", contextWindowLabel(view.window, view.windowSource) === '1000k')
  // A response with NO usage at all (a wire that reports none).
  const usageless = [user('hi'), asst('resp-G', undefined, 'an answer without usage')]
  const est = contextFillView(usageless as never, 'claude-opus-5')
  check('a usage-less response reads an ESTIMATE, labelled — never a confident percent', est.fillSource === 'estimate' && est.usedTokens === rough(usageless) && est.usedPct !== null, JSON.stringify(est))
  check("  the rail label: '≈0%' (estimate) vs '29%' (usage)", contextPercentLabel(est.usedPct, est.fillSource) === `≈${est.usedPct}%` && contextPercentLabel(29, 'usage') === '29%' && contextPercentLabel(null, null) === '—')
  // contextGauge and the picker header ride the same owner.
  const { contextGauge } = await import('../../src/utils/cockpit/contextGauge.ts')
  const snap = contextGauge(seq as never, 'claude-opus-5' as never)
  check('contextGauge: live · usedPct 29 · usedTokens 290,000 · window 1,000,000', snap.state === 'live' && snap.data.usedPct === 29 && snap.data.usedTokens === 290_000 && snap.data.window === 1_000_000, JSON.stringify(snap))
  const freshSnap = contextGauge([user('hi')] as never, 'claude-opus-5' as never)
  check('contextGauge: fresh session ⇒ unavailable (never a fake gauge)', freshSnap.state === 'unavailable')
  // Percent math.
  check('contextFillPercent: 56,300 / 1,048,576 = 5 · 56,300 / 200,000 = 28 · unknown window ⇒ null', context.contextFillPercent(56_300, 1_048_576).used === 5 && context.contextFillPercent(56_300, 200_000).used === 28 && context.contextFillPercent(56_300, 0).used === null)
  check('calculateContextPercentages counts the response output (the daemon roster / stream-json envelope)', context.calculateContextPercentages({ input_tokens: 100_000, cache_creation_input_tokens: 0, cache_read_input_tokens: 50_000, output_tokens: 50_000 }, 1_000_000).used === 20)
  // Source pins: the surfaces read the owner, not their own arithmetic.
  const frame = src('src/components/MercuryFrame.tsx')
  check('MercuryFrame reads contextFillView and publishes its figure + provenance', /contextFillView\(messages, windowModel\)/.test(frame) && /usedTokens: fill\.usedTokens/.test(frame) && /windowSource: fill\.windowSource/.test(frame))
  check('MercuryFrame subscribes to the catalogue epoch (re-derives when a source lands)', /useCatalogueEpoch\(\)/.test(frame))
  const analyze = src('src/utils/analyzeContext.ts')
  check('/context headline is contextFill (the trigger count) when usage exists', /const fill = contextFill\(originalMessages \?\? messages\)/.test(analyze) && /fill\.source === 'usage' \? fill\.tokens : actualUsage/.test(analyze))
  const picker = src('src/commands/model/mercuryModel.tsx')
  // Re-cut (FN-018 rank 13): the gauge reads the ONE fill derivation over the
  // session-effective model the frame publishes (the focused pin, the session
  // override, then the global model), never the global model alone.
  check('/model header gauge reads contextFillView over the session-effective model', /contextFillView\(messages, windowModel\)/.test(picker) && /const windowModel = getFocusedSessionConnector\(\)\.modelFacts\(\)\.sessionPin \?\? mainLoopModelForSession \?\? mainLoopModel \?\? getMainLoopModel\(\)/.test(picker))
  for (const rail of ['src/components/HelmLanesRail.tsx', 'src/components/HelmTelemetryRail.tsx', 'src/components/DeckPane.tsx']) {
    const text = src(rail)
    check(`${rail.split('/').pop()} subscribes to the publish version and labels via the owner`, /useSyncExternalStore\(subscribeLiveContextUsage, getLiveContextUsageVersion, getLiveContextUsageVersion\)/.test(text) && /contextWindowLabel\(/.test(text))
  }
}

section('N6 · the publish seam carries figure + provenance; version bumps on change only')
{
  const v0 = live.getLiveContextUsageVersion()
  live.publishContextUsage(28, 200_000, 83.5, undefined, { usedTokens: 56_300, fillSource: 'usage', windowSource: 'fallback' })
  const v1 = live.getLiveContextUsageVersion()
  const slot = live.getLiveContextUsage()
  check('a publish lands the figure and both provenance words', slot.usedPct === 28 && slot.window === 200_000 && slot.usedTokens === 56_300 && slot.fillSource === 'usage' && slot.windowSource === 'fallback' && v1 === v0 + 1, JSON.stringify(slot))
  live.publishContextUsage(28, 200_000, 83.5, undefined, { usedTokens: 56_300, fillSource: 'usage', windowSource: 'fallback' })
  check('an identical re-publish does not bump the version (no repaint storm)', live.getLiveContextUsageVersion() === v1)
  let notified = 0
  const off = live.subscribeLiveContextUsage(() => { notified++ })
  live.publishContextUsage(5, 1_048_576, 96.9, undefined, { usedTokens: 56_300, fillSource: 'usage', windowSource: 'live-current' })
  check('the window landing (200k fallback → 1,048,576 live) notifies subscribers and re-labels', notified === 1 && live.getLiveContextUsage().windowSource === 'live-current' && live.getLiveContextUsage().usedPct === 5)
  off()
  live.publishContextUsage(6, 1_048_576, 96.9)
  check('a legacy 3-arg publish still lands (detail null) and no longer notifies the removed subscriber', notified === 1 && live.getLiveContextUsage().usedPct === 6 && live.getLiveContextUsage().usedTokens === null)
}

console.log('\n' + (failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`))
process.exit(failures === 0 ? 0 : 1)
