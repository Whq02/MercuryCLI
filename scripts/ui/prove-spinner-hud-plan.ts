#!/usr/bin/env bun
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env['MERCURY_CONFIG_DIR'] = mkdtempSync(join(tmpdir(), 'spinner-hud-plan-'))

const { planSpinnerHud, spinnerStackDecision, STACK_EXIT_SLACK, hudTokensText } = await import('../../src/components/Spinner/spinnerHud.ts')
const { liveCounterWords, turnFactsOfRefs } = await import('../../src/components/Spinner/liveCounterWords.ts')
const { stripLinesForEpoch } = await import('../../src/components/Spinner/stripHeight.ts')
const { THINKING_WORD } = await import('../../src/components/messages/thinkingGrammar.tsx')
const { stringWidth } = await import('../../src/ink/stringWidth.ts')
type HudFacts = Parameters<typeof planSpinnerHud>[0]

let failures = 0
let checks = 0
function check(label: string, cond: boolean, detail = ''): void {
  checks++
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}
const section = (t: string): void => console.log(`\n${'─'.repeat(76)}\n${t}`)

const NOW = 1_700_000_000_000
const words = (chars: number, mode: string, elapsedMs: number, wire: number | null = null) =>
  liveCounterWords({ ...turnFactsOfRefs(chars, wire), phase: mode === 'thinking' ? 'thinking' : mode === 'responding' ? 'writing' : mode === 'tool-use' || mode === 'tool-input' ? 'working' : 'waiting', sentAtMs: NOW - elapsedMs }, NOW)

function facts(over: Partial<HudFacts> = {}): HudFacts {
  const mode = over.mode ?? 'responding'
  const elapsed = over.effectiveElapsedMs ?? 12_000
  const liveWords = over.liveWords ?? words(4000, mode, elapsed)
  return {
    mode,
    message: 'Pondering…',
    columns: 120,
    verbose: false,
    still: false,
    suffixText: '',
    stillWaiting: false,
    thinkingLabel: `${THINKING_WORD} (max)`,
    liveWords,
    livePhase: liveWords.phase,
    effectiveElapsedMs: elapsed,
    hasRunningCrewmates: false,
    displayedTokens: liveWords.figure.total,
    tokensEstimated: liveWords.figure.estimated,
    crewmateOnlyTokens: null,
    ctxPct: null,
    activeToolCount: 0,
    otps: 0,
    interruptHint: null,
    foregroundedIdleQuiet: false,
    wasStacked: false,
    ...over,
  }
}
const oneLine = (wanted: number): number => wanted
const keys = (plan: ReturnType<typeof planSpinnerHud>): string => plan.ordered.map(s => s.key).join(',')

section('§1 the order law: phase · elapsed · tokens · ctx · tools · tok/s · promise · thinking · still waiting')
{
  const wide = planSpinnerHud(facts({ ctxPct: 37, activeToolCount: 3, otps: 42, stillWaiting: true }), oneLine)
  check('the admitted segments paint in the order law on a wide line', keys(wide) === 'timer,tokens,waiting', keys(wide))
  check('the three gauges are visible beside them', wide.showCtx && wide.showWif && wide.showOtps)
  check('the gauge texts carry the words: ◐ N tools and ~N tok/s', wide.wifText === '◐ 3 tools' && wide.otpsText === '~42 tok/s', `${wide.wifText} ${wide.otpsText}`)
  check('the meta group is visible and not thinking-only', wide.metaVisible && !wide.onlyThinking && wide.gaugesVisible)
  const thinking = planSpinnerHud(facts({ mode: 'thinking' }), oneLine)
  check('a thinking turn admits its label with the effort suffix after the elapsed and the count', keys(thinking) === 'timer,tokens,thinking' && thinking.ordered.at(-1)!.text === `${THINKING_WORD} (max)`, keys(thinking))
  const fresh = planSpinnerHud(facts({ mode: 'thinking', effectiveElapsedMs: 400, liveWords: words(0, 'thinking', 400) }), oneLine)
  check('under one second with no tokens, only the thinking label stands — the group is thinking-only', keys(fresh) === 'thinking' && fresh.onlyThinking && fresh.metaVisible, keys(fresh))
  const reading = planSpinnerHud(facts({ mode: 'requesting', effectiveElapsedMs: 2000, liveWords: liveCounterWords({ ...turnFactsOfRefs(0, null), phase: 'waiting', sentAtMs: NOW - 2000, wait: { kind: 'first-byte', cold: false, promptTokens: 1200, model: 'm', attempt: 1, sinceMs: NOW - 2000, budgetMs: 60_000 } }, NOW) }), oneLine)
  check('a first-byte wait admits the phase word first and the promise last', keys(reading) === 'phase,timer,promise' && reading.ordered[0]!.text === 'reading the prompt', keys(reading))
  const otpsOff = planSpinnerHud(facts({ mode: 'thinking', otps: 42 }), oneLine)
  check('tok/s shows only while text streams (responding / tool-input)', !otpsOff.showOtps && planSpinnerHud(facts({ mode: 'tool-input', otps: 9 }), oneLine).showOtps)
  const oneTool = planSpinnerHud(facts({ activeToolCount: 1 }), oneLine)
  check('the tools gauge lights only on parallel tools (two or more)', !oneTool.showWif && oneTool.wifText === '')
  const noCtx = planSpinnerHud(facts({ ctxPct: null }), oneLine)
  check('the context gauge self-omits when the live usage is unknown', !noCtx.showCtx && noCtx.ctxSpark === '')
}

section('§2 the shed law on a narrow line: the gauges shed right to left, the segments by admission order')
{
  const tight = planSpinnerHud(facts({ columns: 52, ctxPct: 37, activeToolCount: 3, otps: 42 }), oneLine)
  check('on a 52-column line the row stacks (segment B wants more than the space beside the verb)', tight.stacked && tight.secondRow)
  const narrow = planSpinnerHud(facts({ columns: 40, ctxPct: 37, activeToolCount: 3, otps: 42 }), () => 1)
  check('held to one line at 40 columns, the elapsed and the count admit and the gauges shed', keys(narrow) === 'timer,tokens' && !narrow.showCtx && !narrow.showWif && !narrow.showOtps, `${keys(narrow)} ctx=${narrow.showCtx} wif=${narrow.showWif} otps=${narrow.showOtps}`)
  const mid = planSpinnerHud(facts({ columns: 60, ctxPct: 37, activeToolCount: 3, otps: 42 }), () => 1)
  check('with a little more room the ctx gauge comes back before the tools and the rate', mid.showCtx && !mid.showOtps, `ctx=${mid.showCtx} wif=${mid.showWif} otps=${mid.showOtps}`)
  const thinkingTight = planSpinnerHud(facts({ mode: 'thinking', columns: 33 }), () => 1)
  check('the thinking label drops its effort suffix before dropping the word', thinkingTight.ordered.some(s => s.key === 'thinking' && s.text === THINKING_WORD), keys(thinkingTight))
}

section('§3 the stack hysteresis: stacking engages when the cost exceeds the space; unstacking waits for the slack')
{
  check('a cost over the space stacks', spinnerStackDecision({ eligible: true, cost: 30, space: 29, wasStacked: false }))
  check('a cost inside the space does not stack from a one-line state', !spinnerStackDecision({ eligible: true, cost: 28, space: 29, wasStacked: false }))
  check(`a stacked row stays stacked until the cost fits with ${STACK_EXIT_SLACK} cells to spare`, spinnerStackDecision({ eligible: true, cost: 25, space: 29, wasStacked: true }) && !spinnerStackDecision({ eligible: true, cost: 22, space: 29, wasStacked: true }))
  check('an ineligible row (nothing to say in segment B) never stacks', !spinnerStackDecision({ eligible: false, cost: 99, space: 1, wasStacked: true }))
  const latch = { epoch: 0, lines: 1 }
  const twoLines = planSpinnerHud(facts({ columns: 52, ctxPct: 37, activeToolCount: 3, otps: 42 }), wanted => stripLinesForEpoch(latch, 7, wanted))
  const backToOne = planSpinnerHud(facts({ columns: 120, wasStacked: twoLines.stacked }), wanted => stripLinesForEpoch(latch, 7, wanted))
  check('within one turn the strip never shrinks: a row that stacked keeps its second line even when the words fit again', twoLines.secondRow && backToOne.secondRow && !backToOne.stacked)
  const nextTurn = planSpinnerHud(facts({ columns: 120 }), wanted => stripLinesForEpoch(latch, 8, wanted))
  check('a new turn (a new epoch) starts on one line again', !nextTurn.secondRow)
}

section('§4 segment B and the crewmate shapes')
{
  const hint = planSpinnerHud(facts({ interruptHint: 'esc interrupts @kilo', columns: 40 }), oneLine)
  check('a foregrounded running crewmate shows the interrupt hint; the row is eligible to stack on its width', hint.segBVisible && hint.stacked === (stringWidth('esc interrupts @kilo') + 5 > 40 - 2 - stringWidth('Pondering…') - 2 - 5))
  const quiet = planSpinnerHud(facts({ foregroundedIdleQuiet: true }), oneLine)
  check('a foregrounded idle crewmate keeps segment B quiet', !quiet.segBVisible && !quiet.stacked)
  const stillRow = planSpinnerHud(facts({ still: true, suffixText: 'hook: lint' }), oneLine)
  check('a still row (a fold) shows no segment B at all', !stillRow.segBVisible)
  const suffixOnly = planSpinnerHud(facts({ suffixText: 'hook: lint', effectiveElapsedMs: 0, liveWords: words(0, 'responding', 0) }), oneLine)
  check('a hook suffix alone makes segment B visible', suffixOnly.segBVisible && suffixOnly.ordered.length === 0)
  check('crewmate token words: the summed figure with the ~ estimate mark, none at zero', hudTokensText({ crewmateOnlyTokens: null, hasRunningCrewmates: true, displayedTokens: 1234, tokensEstimated: true, liveWords: words(0, 'responding', 0) }) === '~1.2k tokens' && hudTokensText({ crewmateOnlyTokens: null, hasRunningCrewmates: true, displayedTokens: 0, tokensEstimated: true, liveWords: words(0, 'responding', 0) }) === null)
  check('without crewmates the count is the live counter\'s own words', hudTokensText({ crewmateOnlyTokens: null, hasRunningCrewmates: false, displayedTokens: 0, tokensEstimated: true, liveWords: words(4000, 'responding', 0) }) === '↓ ~1k tokens', String(hudTokensText({ crewmateOnlyTokens: null, hasRunningCrewmates: false, displayedTokens: 0, tokensEstimated: true, liveWords: words(4000, 'responding', 0) })))
}

section('§5 the plan is pure: the same facts give the same plan, and no input is mutated')
{
  const f = facts({ ctxPct: 37, activeToolCount: 2, otps: 5 })
  const before = JSON.stringify(f)
  const a = planSpinnerHud(f, oneLine)
  const b = planSpinnerHud(f, oneLine)
  check('two calls on the same facts agree cell for cell', JSON.stringify(a) === JSON.stringify(b))
  check('the facts are untouched', JSON.stringify(f) === before)
}

console.log(`\n${failures === 0 ? '✅' : '❌'} SPINNER-HUD-PLAN ${failures === 0 ? 'GREEN' : 'RED'} — ${checks - failures}/${checks} checks`)
process.exit(failures === 0 ? 0 : 1)
