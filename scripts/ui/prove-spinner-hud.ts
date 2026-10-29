#!/usr/bin/env bun
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const ROW = readFileSync(join(root, 'src/components/Spinner/SpinnerAnimationRow.tsx'), 'utf-8')
const HUD = readFileSync(join(root, 'src/components/Spinner/spinnerHud.ts'), 'utf-8')
const RATE = readFileSync(join(root, 'src/components/Spinner/useOutputRate.ts'), 'utf-8')
const SRC = `${ROW}\n${HUD}\n${RATE}`

let failures = 0
const check = (label: string, cond: boolean): void => {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}`)
}

console.log('============================================================')
console.log(' in-turn cockpit HUD — context-burn gauge source invariants')
console.log('============================================================')

check('INC-4549 floor: an unstamped turn clock is floored to the spinner mount frame',
  /if \(loadingStartTimeRef\.current === 0\) \{\s*loadingStartTimeRef\.current = now/.test(SRC))
check('the quiet HUD reads no extra context gauge', !ROW.includes('getLiveContextUsage'))

check('the quiet HUD has only elapsed, tokens and attention segments', HUD.includes("const HUD_ORDER = ['timer', 'tokens', 'attention']"))
check('the gauge introduces NO raw hex (tokens only)', !/#[0-9a-fA-F]{3,6}\b/.test(HUD))

check('context and tool gauges stay off the quiet HUD', !HUD.includes('showCtx') && !HUD.includes('showWif'))
check('the metadata remains dimmed in its existing placement', ROW.includes('<Text dimColor>') && ROW.includes('metaNodes.map'))

const SPIN = readFileSync(join(root, 'src/components/Spinner.tsx'), 'utf-8')
const Chat = readFileSync(join(root, 'src/screens/Chat.tsx'), 'utf-8')
console.log('\n  -- work-in-flight gauge --')
check('Chat threads activeToolCount={viewInProgressToolUseIDs.size} to the spinner',
  /activeToolCount=\{viewInProgressToolUseIDs\.size\}/.test(Chat))
check('Spinner.tsx forwards activeToolCount to SpinnerAnimationRow',
  /activeToolCount=\{activeToolCount\}/.test(SPIN))
check('the active tool label remains the head instead of another tool counter', SPIN.includes('chosenVerb = activeToolLabel') && !HUD.includes(' tools'))

console.log('\n  -- streaming-cadence (tok/s) instrument --')
check('the response rate reads reply characters, not combined thinking characters', ROW.includes('liveTurnFactsRef?.current.replyChars ?? currentResponseLength'))
check('EMA smoothing keeps the existing coefficients', RATE.includes('sample.current.rate * 0.6 + instant * 0.4'))
check('rate sampling keeps its 250 ms cadence', RATE.includes('dtMs >= 250'))
check('rate only shows in response/tool-input modes', HUD.includes("mode === 'responding' || mode === 'tool-input'"))
check('rate resets when inactive or the counter resets', RATE.includes('!active') && RATE.includes('chars < sample.current.chars'))
check('reduced motion does not invent a rate', ROW.includes('!reducedMotion'))
check('rate remains width gated after the primary counters', HUD.includes('availableSpace > used + otpsWidth'))
check('the rate rides the adaptive secondary meta token', /<Text key="otps"[\s\S]*?color=\{tokens\.textSecondary\}>/.test(SRC))

console.log('\n  -- the strip height latch: within a turn the working card only grows --')
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '0.0.0-prover' }
const { spinnerStackDecision } = await import('../../src/components/Spinner/spinnerHud.ts')
const { stringWidth } = await import('../../src/ink/stringWidth.ts')
type LatchModule = { stripLinesForEpoch: (latch: { epoch: number; lines: number }, epoch: number, wanted: number) => number; turnStripLines: (epoch: number, wanted: number) => number }
const latchModule = await import('../../src/components/Spinner/stripHeight.ts').then(m => m as LatchModule).catch(() => null)
const HOLD = readFileSync(join(root, 'src/components/Spinner/StreamingHoldRow.tsx'), 'utf-8')
const detail = (label: string, cond: boolean, why: string): void => check(cond ? label : `${label} — ${why}`, cond)
const PHASE_WORDS: (string | null)[] = [
  'reading the prompt · first byte expected within 3m 11s',
  'thinking',
  '2s · ↓ ~18 thinking tokens · ▁ 0% ctx · thinking',
  null,
  '6s · ↓ ~18 thinking · 38 tokens · ▁ 0% ctx',
  'reading the prompt · 8s · ↓ ~18 thinking · 30 tokens · ▁ 0% ctx · first byte expected within 3m 11s',
  'thinking',
  '12s · ↓ ~37 thinking · 30 tokens · ▁ 0% ctx · thinking',
  null,
]
const walk = (epoch: number, space: number, wordsSeq: (string | null)[], latch: { epoch: number; lines: number }, band = { stacked: false }): number[] =>
  wordsSeq.map(words => {
    if (words === null) {
      band.stacked = false
      return latchModule === null ? 1 : latchModule.stripLinesForEpoch(latch, epoch, 1)
    }
    band.stacked = spinnerStackDecision({ eligible: true, cost: stringWidth(words) + 3, space, wasStacked: band.stacked })
    const wanted = band.stacked ? 2 : 1
    return latchModule === null ? wanted : latchModule.stripLinesForEpoch(latch, epoch, wanted)
  })
const neverFalls = (seq: number[]): number => seq.findIndex((v, i) => i > 0 && v < seq[i - 1]!)
const fallWords = (seq: number[]): string => {
  const at = neverFalls(seq)
  return at === -1 ? 'never falls' : `fell ${seq[at - 1]} → ${seq[at]} at step ${at + 1} (${PHASE_WORDS[at] ?? 'the hold row'})`
}
detail('the latch module stands beside the stacking decision (src/components/Spinner/stripHeight.ts)', latchModule !== null, 'missing')
{
  const latch = { epoch: 0, lines: 1 }
  const at120 = walk(1, 49, PHASE_WORDS, latch)
  detail(`at a 120-column capsule the first frame needs two lines and the card keeps them through every flip: ${at120.join(',')}`, at120[0] === 2 && neverFalls(at120) === -1, fallWords(at120))
  const wide = walk(1, 200, [PHASE_WORDS[1]], latch, { stacked: false })
  detail('a resize to a wide terminal mid-turn recomputes from the new width but never shrinks the card', wide[0] === 2, `read ${wide[0]}`)
  const next = walk(2, 49, [PHASE_WORDS[1], PHASE_WORDS[3], PHASE_WORDS[5]], latch)
  detail(`a new epoch starts at the height its first frame needs and grows once at the widest words: ${next.join(',')}`, next[0] === 1 && next[2] === 2 && neverFalls(next) === -1, fallWords(next))
}
{
  const latch = { epoch: 0, lines: 1 }
  const at178 = walk(7, 75, PHASE_WORDS, latch)
  detail(`at a 178-column capsule the card starts on one line, grows once at the widest words and never falls back: ${at178.join(',')}`, at178[0] === 1 && at178.includes(2) && neverFalls(at178) === -1 && at178.filter((v, i) => i > 0 && v > at178[i - 1]!).length === 1, fallWords(at178))
  const shared = latchModule === null ? [] : [latchModule.turnStripLines(9, 2), latchModule.turnStripLines(9, 1), latchModule.turnStripLines(10, 1)]
  detail(`the shared turn latch the rows read: ${shared.join(',')}`, shared.length === 3 && shared[0] === 2 && shared[1] === 2 && shared[2] === 1, 'no latch')
}
check('the plan keys the latch by the turn clock after the band decision (the row hands it turnStripLines on loadingStartTimeRef.current)', /const stacked = spinnerStackDecision\(\{[\s\S]{0,400}stripLines\(stacked \? 2 : 1\)/.test(HUD) && /wanted => turnStripLines\(loadingStartTimeRef\.current, wanted\)/.test(ROW))
check('the stacked second row is reserved even when segment B has nothing to say (height={1})', /secondRow \? \([\s\S]{0,80}<Box flexDirection="row" height=\{1\} width="100%">/.test(SRC))
check('StreamingHoldRow reads the same turn latch and its footprint rides it', /turnStripLines\(loadingStartTimeRef\.current, 1\)/.test(HOLD) && /<Box height=\{stripLines\} width="100%">/.test(HOLD))

console.log('\n' + '='.repeat(60))
if (failures === 0) {
  console.log(' ✅ cockpit HUD gauges (ctx-burn + work-in-flight) — sourced, ramped, fork+width-gated, honest')
  process.exit(0)
} else {
  console.log(` ❌ context-burn gauge — ${failures} invariant(s) broken`)
  process.exit(1)
}
