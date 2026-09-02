#!/usr/bin/env bun
// ============================================================================
//  scripts/consistency-census/prove-turn-status.ts — W3 (UN-19/20): ONE turn-status
//  projection — one phrase, one clock, no parallel phase owner.
//
//  §A RETIREMENT — Spinner.tsx carries no thinkingStatus state machine
//     (no useState<'thinking'…>, no chained display timeouts); the row
//     derives the live label from displayed-phase truth and the
//     completed-span postscript from the pure tracker (pulseByline).
//  §B ONE CLOCK — the byline composes WITHOUT a time tail (no formatPhase
//     elapsed export, no elapsedMs input); the row's single time basis is
//     the whole-turn timer (effectiveElapsedMs → timerText), and the
//     retired per-phase clock (phaseElapsedMs) is absent.
//  §C ONE PHRASE — the live "thinking" label cannot double with the byline's
//     thinking narration (the dedup law rides displayed-phase truth).
//  §D GEOMETRY — the HUD segment order law is in-source and the token
//     readout persists from zero (wantsTimerAndTokens from turn start), so
//     zero→non-zero cannot shuffle positions.
//
//  The behavioral postscript/tracker laws live in the pulse domain suite
//  (scripts/pulse/spinner/prove-byline-priority.ts §postscript); rendered
//  captures at 80/120 are retained as consistency receipts (L28).
// ============================================================================
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = join(import.meta.dir, '..', '..')
let failed = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failed++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ' — ' + detail : ''}`)
}

const spinner = readFileSync(join(ROOT, 'src/components/Spinner.tsx'), 'utf8')
const row = readFileSync(join(ROOT, 'src/components/Spinner/SpinnerAnimationRow.tsx'), 'utf8')
const byline = readFileSync(join(ROOT, 'src/components/Spinner/pulseByline.ts'), 'utf8')

// §A — the parallel owner is retired
check('§A no thinkingStatus state machine in Spinner.tsx', !/useState<'thinking'/.test(spinner) && !spinner.includes('setThinkingStatus'))
check('§A no thinkingStatus prop reaches the row', !/thinkingStatus[:=]/.test(row.split('unison W3')[0] ?? row) && !row.includes('thinkingStatus={'))
check('§A the row tracks the span via the pure pulse-clock tracker', row.includes('nextThinkingSpan(') && row.includes('thinkingPostscript('))
check('§A no display timeouts for the postscript anywhere', !spinner.includes('showDurationTimer') && !row.includes('showDurationTimer'))

// §B — one clock
check('§B the byline has no time tail (formatPhaseElapsed retired)', !byline.includes('formatPhaseElapsed') && !/elapsedMs/.test(byline))
check('§B the retired per-phase clock is gone from the row', !row.includes('phaseElapsedMs'))
check('§B the whole-turn timer is the single default time basis', row.includes('effectiveElapsedMs') && row.includes('timerText'))

// §C — one phrase (no overlapping old/new labels)
check('§C live thinking label defers to the byline narration', /wantsThinking =\s*\n?\s*thinkingText !== null && !\(phaseByline !== null && inThinking\)/.test(row))
check('§C the live label keys off displayed-phase truth', row.includes("displayedPhase === 'thinking'"))

// §D — geometry
check('§D the HUD order law is in-source (action · elapsed · burn · work-in-flight)', row.includes('action · elapsed · token/ctx burn · work-in-flight'))
check('§D token readout persists from zero (no zero→non-zero shuffle)', row.includes('const tokensAfterMs = 0'))

// §E — degradation (UN-22): colour rides tokens; reduced-motion strips
// decorative motion without delaying truth (dwell bypass + shimmer off).
check('§E work colour resolves through theme tokens (AURORA adaptive ink)', row.includes('useMercuryTokens') || /Adaptive meta ink/.test(row))
check('§E reduced motion bypasses dwell (state truth is never delayed)', readFileSync(join(ROOT, 'src/components/Spinner/pulseByline.ts'), 'utf8').includes('if (reducedMotion) return snap.phase'))
check('§E reduced motion disables the thinking shimmer', row.includes('inThinking && !reducedMotion'))

console.log(failed === 0 ? '\n ✅ ONE TURN-STATUS PROJECTION HOLDS' : `\n ❌ ${failed} FAILED`)
process.exit(failed === 0 ? 0 : 1)
