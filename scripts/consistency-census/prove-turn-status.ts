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
const hud = readFileSync(join(ROOT, 'src/components/Spinner/spinnerHud.ts'), 'utf8')

check('§A no thinkingStatus state machine in Spinner.tsx', !/useState<'thinking'/.test(spinner) && !spinner.includes('setThinkingStatus'))
check('§A no thinkingStatus prop reaches the row', !/thinkingStatus[:=]/.test(row.split('unison W3')[0] ?? row) && !row.includes('thinkingStatus={'))
check('§A no display timeouts for the thinking label anywhere', !spinner.includes('showDurationTimer') && !row.includes('showDurationTimer'))
const liveWords = readFileSync(join(ROOT, 'src/components/Spinner/liveCounterWords.ts'), 'utf8')
check(
  '§A internal stream phases still feed the shared facts without being painted as routine HUD labels',
  row.includes("import { liveCounterPhaseOf, liveCounterWords, turnFactsOfRefs } from './liveCounterWords.js'") &&
    row.includes('phase: liveCounterPhaseOf(mode)') &&
    !hud.includes('waitPhaseText') && !hud.includes('thinkingText') &&
    !/setTimeout|setInterval|useState|useRef|useEffect/.test(liveWords),
)

check('§B the retired per-phase clock is gone from the row', !row.includes('phaseElapsedMs'))
check('§B the whole-turn timer retains seconds as well as minutes', row.includes('effectiveElapsedMs') && hud.includes('const timerText = formatDuration(effectiveElapsedMs)'))

check('§C the HUD never adds a routine phase beside the verb', !hud.includes("key: 'thinking'") && !hud.includes("key: 'phase'") && !hud.includes("key: 'waiting'"))
check('§C the painted message is the verb chain (the one message prop is budgeted and painted)', hud.includes('const messageWidth = stringWidth(facts.message) + 2') && row.includes('<GlimmerMessage\n              message={message}'))

check(
  '§D the HUD order is elapsed, count, reply rate and attention',
  (() => {
    const at = ['timerText', 'tokensText', 'otpsText', 'attentionText'].map(name => hud.indexOf(`fullSegmentTexts.push(${name})`))
    return at.every((pos, i) => pos >= 0 && (i === 0 || pos > at[i - 1]!))
  })(),
)
check('§D token readout persists from zero (no zero→non-zero shuffle: the count admits on the meta gate alone, never an elapsed term)', hud.includes("if (metaGate && tokensText !== null) admit({ key: 'tokens', text: tokensText })"))

check('§E work colour resolves through theme tokens', row.includes('useMercuryTokens') || /Adaptive meta ink/.test(row))
check('§E reduced motion still gates the spinner animation', row.includes('reducedMotion ? null : WORK_TICK_MS') && row.includes('reducedMotion={reducedMotion}'))

console.log(failed === 0 ? '\n ✅ ONE TURN-STATUS PROJECTION HOLDS' : `\n ❌ ${failed} FAILED`)
process.exit(failed === 0 ? 0 : 1)
