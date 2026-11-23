#!/usr/bin/env bun
import { join } from 'node:path'


let failures = 0
const check = (label: string, cond: boolean, hint?: string): void => {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && hint ? ` — ${hint}` : ''}`)
}

console.log('============================================================')
console.log(' in-turn cockpit HUD — context-burn gauge source invariants')
console.log('============================================================')

console.log('\n  -- work-in-flight gauge --')
{
  const { openStatusPart } = await import('./chatScenarios.ts')
  const { IDLE_LIVE } = await import('../../src/engine/connector/seatLive.ts')
  const status = await openStatusPart('spinner-hud-status', { keepHome: true })
  const counts: unknown[] = []
  for (const ids of [['toolu_1'], ['toolu_1', 'toolu_2', 'toolu_3'], []]) {
    await status.plant({ seatLive: { ...IDLE_LIVE, inFlight: true, phase: 'tool', inProgressToolUseIDs: new Set(ids) } })
    counts.push(status.handed.spinner?.activeToolCount)
  }
  await status.close()
  check('Chat threads activeToolCount={viewInProgressToolUseIDs.size} to the spinner', counts.join() === '1,3,0', `read ${counts.join()}; make src/screen/chat/useChatStatus.tsx pass activeToolCount={viewInProgressToolUseIDs.size} to the Spinner`)
}

console.log('\n  -- the strip height latch: within a turn the working card only grows --')
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '0.0.0-prover' }
const { spinnerStackDecision } = await import('../../src/screen/spinner/spinnerHud.ts')
const { stringWidth } = await import('../../src/screen/renderer/stringWidth.ts')
type LatchModule = { stripLinesForEpoch: (latch: { epoch: number; lines: number }, epoch: number, wanted: number) => number; turnStripLines: (epoch: number, wanted: number) => number }
const latchModule = await import('../../src/screen/spinner/stripHeight.ts').then(m => m as LatchModule).catch(() => null)
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
detail('the latch module stands beside the stacking decision (src/screen/spinner/stripHeight.ts)', latchModule !== null, 'missing')
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

console.log('\n' + '='.repeat(60))
if (failures === 0) {
  console.log(' ✅ cockpit HUD gauges (ctx-burn + work-in-flight) — sourced, ramped, fork+width-gated, honest')
  process.exit(0)
} else {
  console.log(` ❌ context-burn gauge — ${failures} invariant(s) broken`)
  process.exit(1)
}
