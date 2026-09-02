#!/usr/bin/env bun
// ============================================================================
//  scripts/memory/prove-card-dedup-regime.ts
//  PROOF (audit-cycle-1): experience-card dedup respects the regime cues.
//
//  Bug (was): normalizedLesson() dropped EVERY `**`-prefixed line, including the
//  `**Applies when:**` / `**Not when:**` regime cues. So two cards under the same
//  problemClass with identical prose but DIFFERENT regimes — exactly the case the
//  AdaptiveHarness scope doctrine says to keep as distinct cards — collapsed to one
//  dedup key, and the second was silently refused as a near-duplicate.
//
//  Fix: keep the regime-cue CONTENT in the normalizer (markers stripped) while still
//  dropping the Status / Source-refs / Green-gate banners (those DO vary per card and
//  must stay excluded, or real duplicates would stop deduping — the inverse bug).
//
//  Run:  ~/.bun/bin/bun run scripts/memory/prove-card-dedup-regime.ts
// ============================================================================
;(globalThis as Record<string, unknown>)['MACRO'] = { VERSION: '1.0.0' }
import { normalizedLesson } from '../../src/memdir/experienceCards.js'

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ` — ${detail}` : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
}

const PROSE = 'Use flock for the cross-process lock.'
const cardA = `---\nslug: a\n---\n**Status:** fresh · 2026-06-19\n${PROSE}\n**Applies when:** flow mode\n**Green-gate:** 8 suites green`
const cardB = `---\nslug: b\n---\n**Status:** stale\n${PROSE}\n**Applies when:** normal mode\n**Green-gate:** build only`
const cardC = `---\nslug: c\n---\n**Status:** whatever\n${PROSE}\n**Applies when:** flow mode\n**Source refs:** xyz`

console.log('============================================================')
console.log(' experience-card dedup — regime cues are load-bearing')
console.log('============================================================')

section('regime-distinct cards do NOT collapse (the fix)')
check('same prose, DIFFERENT Applies-when ⇒ distinct dedup keys (2nd no longer refused)', normalizedLesson(cardA) !== normalizedLesson(cardB))
check('the Applies-when cue content survives the normalizer', /applies when: flow mode/.test(normalizedLesson(cardA)) && /applies when: normal mode/.test(normalizedLesson(cardB)))

section('real duplicates STILL dedup (banners excluded — no over-distinguish)')
check('same prose + same Applies-when, DIFFERENT Status/Source/Green-gate banners ⇒ SAME key', normalizedLesson(cardA) === normalizedLesson(cardC))
check('Status / Green-gate / Source-refs banners are excluded from the key', !/status:|green-gate:|source refs:/i.test(normalizedLesson(cardA)))
check('the shared prose survives (real dedup still works on substance)', /use flock for the cross-process lock\./.test(normalizedLesson(cardA)))

console.log('\n' + '═'.repeat(76))
if (failures === 0) console.log('✅ ALL CARD-DEDUP-REGIME PROOFS PASS')
else console.log(`❌ ${failures} CARD-DEDUP-REGIME PROOF(S) FAILED`)
console.log('═'.repeat(76))
process.exit(failures === 0 ? 0 : 1)
