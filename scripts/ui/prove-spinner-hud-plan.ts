#!/usr/bin/env bun
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'

const HOME = mkdtempSync(join(process.env.MERCURY_CONFIG_DIR!, 'spinner-hud-plan-'))
process.env.MERCURY_CONFIG_DIR = HOME
delete process.env.MERCURY_HOME
process.env.MERCURY_CREDENTIAL_STORE = 'file'

const { planSpinnerHud, spinnerStackDecision, STACK_EXIT_SLACK, hudTokensText } = await import('../../src/components/Spinner/spinnerHud.ts')
const { liveCounterWords, turnFactsOfRefs } = await import('../../src/components/Spinner/liveCounterWords.ts')
const { stripLinesForEpoch } = await import('../../src/components/Spinner/stripHeight.ts')
type HudFacts = Parameters<typeof planSpinnerHud>[0]

let failures = 0
let checks = 0
function check(label: string, cond: boolean, detail = ''): void {
  checks++
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}
const NOW = 1_700_000_000_000
const words = (chars: number, mode: string, elapsedMs: number, wire: number | null = null) =>
  liveCounterWords({ ...turnFactsOfRefs(chars, wire), phase: mode === 'thinking' ? 'thinking' : mode === 'responding' ? 'writing' : mode === 'tool-use' || mode === 'tool-input' ? 'working' : 'waiting', sentAtMs: NOW - elapsedMs }, NOW)

function facts(over: Partial<HudFacts> = {}): HudFacts {
  const mode = over.mode ?? 'responding'
  const elapsed = over.effectiveElapsedMs ?? 12_000
  return { mode, message: 'Fencing the wolves…', columns: 120, verbose: false, still: false, suffixText: '', liveWords: words(4000, mode, elapsed), effectiveElapsedMs: elapsed, otps: 0, wasStacked: false, ...over }
}
const oneLine = (wanted: number): number => wanted
const keys = (plan: ReturnType<typeof planSpinnerHud>): string => plan.ordered.map(s => s.key).join(',')
const text = (plan: ReturnType<typeof planSpinnerHud>): string => plan.ordered.map(s => s.text).join(' · ')

{
  const wide = planSpinnerHud(facts({ otps: 42 }), oneLine)
  check('elapsed and one total count, with the response rate', keys(wide) === 'timer,tokens' && text(wide) === '12s · ↓ ~1k' && wide.showOtps && wide.otpsText === '~42 tok/s', text(wide))
  const thinking = planSpinnerHud(facts({ mode: 'thinking', otps: 42 }), oneLine)
  check('thinking has no phase label or response rate', keys(thinking) === 'timer,tokens' && !thinking.showOtps, text(thinking))
  const fresh = planSpinnerHud(facts({ mode: 'thinking', effectiveElapsedMs: 400, liveWords: words(0, 'thinking', 400) }), oneLine)
  check('known empty counters stay zero, with no invented phase', keys(fresh) === 'tokens' && text(fresh) === '↓ 0', text(fresh))
  const unknown = planSpinnerHud(facts({ mode: 'thinking', liveWords: liveCounterWords({ ...turnFactsOfRefs(0, null), firstByteAtMs: NOW - 1000, thinkingBlocks: 1, phase: 'thinking', sentAtMs: NOW - 12000 }, NOW) }), oneLine)
  check('withheld thinking has no made-up zero or block count', keys(unknown) === 'timer', text(unknown))
  const reading = planSpinnerHud(facts({ mode: 'requesting', effectiveElapsedMs: 65000, liveWords: liveCounterWords({ ...turnFactsOfRefs(0, null), phase: 'waiting', sentAtMs: NOW - 65000, wait: { kind: 'first-byte', cold: false, promptTokens: 1200, model: 'm', attempt: 1, sinceMs: NOW - 65000, budgetMs: 60000 } }, NOW) }), oneLine)
  check('long prefill shows the full clock and known zero, not a budget or phase', text(reading) === '1m 5s · ↓ 0', text(reading))
  check('tool-input can show an observed response rate', planSpinnerHud(facts({ mode: 'tool-input', otps: 9 }), oneLine).showOtps)
  check('active tools do not borrow a response rate', !planSpinnerHud(facts({ mode: 'tool-use', otps: 9 }), oneLine).showOtps)
}
{
  const tight = planSpinnerHud(facts({ columns: 40, otps: 42 }), oneLine)
  check('a narrow row still stacks when its content needs it', tight.stacked && tight.secondRow)
  const narrow = planSpinnerHud(facts({ columns: 38, otps: 42 }), () => 1)
  check('a forced narrow line keeps the elapsed before shedding count and rate', keys(narrow) === 'timer' && !narrow.showOtps, text(narrow))
  const mid = planSpinnerHud(facts({ columns: 52, otps: 42 }), () => 1)
  check('a little more room keeps the count before the rate', keys(mid) === 'timer,tokens' && !mid.showOtps, text(mid))
  const reconnect = planSpinnerHud(facts({ columns: 80, mode: 'thinking', effectiveElapsedMs: 130000, liveWords: liveCounterWords({ ...turnFactsOfRefs(0, null), phase: 'thinking', sentAtMs: NOW - 130000, wait: { kind: 'retry', attempt: 2, of: 5, sinceMs: NOW, delayMs: 5000, reason: 'no tokens for 2 min', reconnecting: true, silentMs: 120000 } }, NOW) }), oneLine)
  check('actual reconnection follows time and count once', text(reconnect) === '2m 10s · ↓ 0 · reconnecting 2 of 5', text(reconnect))
  const attentionOnly = planSpinnerHud(facts({ columns: 50, liveWords: liveCounterWords({ ...turnFactsOfRefs(0, null), phase: 'waiting', sentAtMs: NOW - 130000, wait: { kind: 'retry', attempt: 2, of: 5, sinceMs: NOW, delayMs: 0, reason: 'connection closed', reconnecting: true } }, NOW) }), () => 1)
  check('attention is not shed to make room for routine counters', text(attentionOnly).includes('reconnecting 2 of 5'), text(attentionOnly))
}
{
  check('a cost over the space stacks', spinnerStackDecision({ eligible: true, cost: 30, space: 29, wasStacked: false }))
  check('a cost inside the space does not stack from a one-line state', !spinnerStackDecision({ eligible: true, cost: 28, space: 29, wasStacked: false }))
  check(`stack exit keeps ${STACK_EXIT_SLACK} cells of slack`, spinnerStackDecision({ eligible: true, cost: 25, space: 29, wasStacked: true }) && !spinnerStackDecision({ eligible: true, cost: 22, space: 29, wasStacked: true }))
  check('an empty segment never stacks', !spinnerStackDecision({ eligible: false, cost: 99, space: 1, wasStacked: true }))
  const latch = { epoch: 0, lines: 1 }
  const twoLines = planSpinnerHud(facts({ columns: 40, otps: 42 }), wanted => stripLinesForEpoch(latch, 7, wanted))
  const backToOne = planSpinnerHud(facts({ columns: 120, wasStacked: twoLines.stacked }), wanted => stripLinesForEpoch(latch, 7, wanted))
  check('the strip never shrinks within the same turn', twoLines.secondRow && backToOne.secondRow && !backToOne.stacked)
  check('a new turn starts on one line', !planSpinnerHud(facts(), wanted => stripLinesForEpoch(latch, 8, wanted)).secondRow)
}
{
  check('a still row shows no metadata', !planSpinnerHud(facts({ still: true, suffixText: 'hook: lint' }), oneLine).segBVisible)
  const suffix = planSpinnerHud(facts({ mode: 'tool-use', suffixText: 'hook: lint', effectiveElapsedMs: 0, liveWords: words(0, 'tool-use', 0) }), oneLine)
  check('an actionable hook suffix still stands', suffix.segBVisible && suffix.ordered.length === 0, keys(suffix))
  check('the wire total loses the estimate marker', hudTokensText({ liveWords: words(4000, 'responding', 0, 1200) }) === '↓ 1.2k')
  const f = facts({ otps: 5 })
  const before = JSON.stringify(f)
  check('the plan stays deterministic', JSON.stringify(planSpinnerHud(f, oneLine)) === JSON.stringify(planSpinnerHud(f, oneLine)))
  check('the plan never mutates its facts', JSON.stringify(f) === before)
}
rmSync(HOME, { recursive: true, force: true })
console.log(`SPINNER-HUD-PLAN: ${checks - failures}/${checks} checks`)
process.exit(failures === 0 ? 0 : 1)
