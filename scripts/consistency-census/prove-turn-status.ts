#!/usr/bin/env bun
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

check('§A no thinkingStatus state machine in Spinner.tsx', !/useState<'thinking'/.test(spinner) && !spinner.includes('setThinkingStatus'))
check('§A no thinkingStatus prop reaches the row', !/thinkingStatus[:=]/.test(row.split('unison W3')[0] ?? row) && !row.includes('thinkingStatus={'))
check('§A no display timeouts for the thinking label anywhere', !spinner.includes('showDurationTimer') && !row.includes('showDurationTimer'))
check('§A the live thinking label keys off the stream mode alone', row.includes("const inThinking = mode === 'thinking'") && row.includes('const thinkingText = inThinking ? thinkingLabelFull : null'))

check('§B the retired per-phase clock is gone from the row', !row.includes('phaseElapsedMs'))
check('§B the whole-turn timer is the single default time basis', row.includes('effectiveElapsedMs') && row.includes('timerText'))

check('§C one phrase: the thinking label is admitted exactly when it exists', row.includes('const wantsThinking = thinkingText !== null'))
check('§C the painted message is the verb chain', row.includes('const message = messageProp'))

check(
  '§D the HUD order law is in-source (action · elapsed · burn · work-in-flight: the segment pushes sit in that order)',
  (() => {
    const at = ['thinkingText', 'timerText', 'tokensText', 'ctxText', 'wifText'].map(name => row.indexOf(`fullSegmentTexts.push(${name})`))
    return at.every((pos, i) => pos >= 0 && (i === 0 || pos > at[i - 1]!))
  })(),
)
check('§D token readout persists from zero (no zero→non-zero shuffle)', row.includes('const tokensAfterMs = 0'))

check('§E work colour resolves through theme tokens', row.includes('useMercuryTokens') || /Adaptive meta ink/.test(row))
check('§E reduced motion disables the thinking shimmer', row.includes('inThinking && !reducedMotion'))

console.log(failed === 0 ? '\n ✅ ONE TURN-STATUS PROJECTION HOLDS' : `\n ❌ ${failed} FAILED`)
process.exit(failed === 0 ? 0 : 1)
