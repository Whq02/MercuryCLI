#!/usr/bin/env bun
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const SRC = readFileSync(join(root, 'src/components/Spinner/SpinnerAnimationRow.tsx'), 'utf-8')

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
check('imports getLiveContextUsage (the live MercuryFrame-published seam)',
  /import\s*\{\s*getLiveContextUsage\s*\}\s*from\s*'\.\.\/\.\.\/utils\/cockpit\/contextUsageLive\.js'/.test(SRC))
check('reads getLiveContextUsage().usedPct into ctxPct', /getLiveContextUsage\(\)\.usedPct/.test(SRC))

check('imports the SPARK ramp + gaugeColor from the kit',
  /import\s*\{[^}]*\bgaugeColor\b[^}]*\}\s*from\s*'\.\.\/mercury-ui\/theme\.js'/.test(SRC) &&
  /import\s*\{[^}]*\bSPARK\b[^}]*\}\s*from\s*'\.\.\/mercury-ui\/glyphs\.js'/.test(SRC))
check('the gauge fill is ramp-colored via gaugeColor(ctxPct)', /gaugeColor\(ctxPct\)/.test(SRC))
check('the spark cell is selected off the SPARK ramp by fill %',
  /SPARK\[Math\.min\(SPARK\.length\s*-\s*1,\s*Math\.floor\(\(ctxPct\s*\/\s*100\)\s*\*\s*SPARK\.length\)\)\]/.test(SRC))
const ctxBlock = SRC.slice(SRC.indexOf('Context-window burn'), SRC.indexOf('Context-window burn') + 1400)
check('the gauge introduces NO raw hex (tokens only)', !/#[0-9a-fA-F]{3,6}\b/.test(ctxBlock))

check('showCtx is present ', /const showCtx\s*=/.test(SRC))
check('showCtx is WIDTH-gated last (availableSpace > usedAfterTokens + ctxWidth)',
  /availableSpace\s*>\s*usedAfterTokens\s*\+\s*ctxWidth/.test(SRC))
check('HONEST: gauge self-omits when usedPct is null (ctxPct != null guard)',
  /ctxPct\s*!=\s*null/.test(SRC) && /ctxPctRaw\s*!=\s*null\s*\?\s*Math\.round\(ctxPctRaw\)\s*:\s*null/.test(SRC))
check("the 'ctx' label rides the adaptive secondary meta token", /<Text color=\{tokens\.textSecondary\}>\{' ctx'\}<\/Text>/.test(SRC))
check('rendered only when showCtx && ctxPct != null (no NaN/null leak)',
  /showCtx\s*&&\s*ctxPct\s*!=\s*null/.test(SRC))

const SPIN = readFileSync(join(root, 'src/components/Spinner.tsx'), 'utf-8')
const Chat = readFileSync(join(root, 'src/screens/Chat.tsx'), 'utf-8')
console.log('\n  -- work-in-flight gauge --')
check('Chat threads activeToolCount={viewInProgressToolUseIDs.size} to the spinner',
  /activeToolCount=\{viewInProgressToolUseIDs\.size\}/.test(Chat))
check('Spinner.tsx forwards activeToolCount to SpinnerAnimationRow',
  /activeToolCount=\{activeToolCount\}/.test(SPIN))
check('wif lights up only on PARALLEL tools (activeToolCount >= 2)',
  /activeToolCount\s*>=\s*2/.test(SRC))
check('wif carries the in-progress spine glyph (GLYPH.inProgress = ◐)',
  /GLYPH\.inProgress.*tools/.test(SRC))
check('wif rides the success spine (tokens.success — TEAL on dark)', /color=\{tokens\.success\}/.test(SRC))
check('showWif is present ', /const showWif\s*=/.test(SRC))
check('showWif is WIDTH-gated AFTER the ctx group (sheds first)',
  /availableSpace\s*>\s*usedAfterCtx\s*\+\s*wifWidth/.test(SRC))

console.log('\n  -- streaming-cadence (tok/s) instrument --')
check('throughput sampled off the RAW response-length delta over the clock',
  /currentResponseLength\s*-\s*rateSampleRef\.current\.len/.test(SRC))
check('EMA-smoothed (steady gauge, not jitter)',
  /smoothedOtpsRef\.current\s*=\s*smoothedOtpsRef\.current\s*\*\s*0\.6\s*\+\s*instant\s*\*\s*0\.4/.test(SRC))
check('sampled every ~250ms (stable cadence read)', /dtMs\s*>=\s*250/.test(SRC))
check('shown ONLY while text streams (responding / tool-input)',
  /mode === 'responding' \|\| mode === 'tool-input'/.test(SRC) && /tok\/s/.test(SRC))
check('zeroed under reducedMotion (no live clock → no rate)',
  /reducedMotion\)\s*\{\s*smoothedOtpsRef\.current\s*=\s*0/.test(SRC))
check('showOtps is WIDTH-gated last (after the wif group; the stamp locals folded away)',
  /const showOtps\s*=/.test(SRC) &&
  /availableSpace\s*>\s*usedAfterWif\s*\+\s*otpsWidth/.test(SRC))
check('the rate rides the adaptive secondary meta token', /<Text key="otps"[\s\S]*?color=\{tokens\.textSecondary\}>/.test(SRC))

console.log('\n  -- the strip height latch: within a turn the working card only grows --')
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '0.0.0-prover' }
const { spinnerStackDecision } = await import('../../src/components/Spinner/SpinnerAnimationRow.tsx')
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
check('SpinnerAnimationRow keys the latch by the turn clock (loadingStartTimeRef.current) after the band decision', /const stacked = spinnerStackDecision\(\{[\s\S]{0,400}turnStripLines\(loadingStartTimeRef\.current, stacked \? 2 : 1\)/.test(SRC))
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
