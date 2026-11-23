#!/usr/bin/env bun
;(globalThis as Record<string, unknown>)['MACRO'] = { VERSION: '1.0.0' }
delete process.env.MERCURY_HIP
delete process.env.MERCURY_HIP
import {
  isQuicksilverLine,
  quicksilverMode,
  sampleSpinnerVerb,
} from '../../src/screen/spinner/spinnerVerbs.js'
import { getFlagSpec } from '../../src/platform/substrate/flagRegistry.js'

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ` — ${detail}` : ''}${cond ? '' : ' — to fix: quicksilverMode, isQuicksilverLine and sampleSpinnerVerb are in src/screen/spinner/spinnerVerbs.ts; the MERCURY_HIP flag row is in FLAG_REGISTRY'}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
}

console.log('============================================================')
console.log(' quicksilver main vocab — mode contract · membership · swing')
console.log('============================================================')

section('quicksilverMode — live env contract (canonical wins, alias resolves)')
check("unset ⇒ 'mixed' (main vocab standing)", quicksilverMode() === 'mixed')
process.env.MERCURY_HIP = '0'
check("MERCURY_HIP '0' ⇒ off", quicksilverMode() === 'off')
process.env.MERCURY_HIP = 'false'
check("MERCURY_HIP 'false' ⇒ off", quicksilverMode() === 'off')
process.env.MERCURY_HIP = '1'
check("MERCURY_HIP '1' ⇒ only", quicksilverMode() === 'only')
process.env.MERCURY_HIP = 'true'
check("MERCURY_HIP 'true' ⇒ only", quicksilverMode() === 'only')
delete process.env.MERCURY_HIP
process.env.MERCURY_HIP = '0'
check("legacy MERCURY_HIP alone still resolves ('0' ⇒ off)", quicksilverMode() === 'off')
process.env.MERCURY_HIP = '1'
check('canonical beats legacy when both are set (1 + 0 ⇒ only)', quicksilverMode() === 'only')
delete process.env.MERCURY_HIP
delete process.env.MERCURY_HIP
check('unset again ⇒ mixed (no caching)', quicksilverMode() === 'mixed')

section('isQuicksilverLine — membership (adjacents in, desert out)')
check('CODE adjacent classified quicksilver', isQuicksilverLine('Shipping heat'))
check('FLOW adjacent classified quicksilver', isQuicksilverLine('Talk less, ship more'))
check('interjection classified quicksilver', isQuicksilverLine('Molten'))
check('desert verb NOT quicksilver', !isQuicksilverLine('Scuttling'))
check('base verb NOT quicksilver', !isQuicksilverLine('Thinking'))
check('empty string NOT quicksilver', !isQuicksilverLine(''))


section('sampleSpinnerVerb — the fresh-pick contract (less deduped)')
{
  const pool = Array.from({ length: 40 }, (_, i) => `qsv-${i}`)
  const draws: string[] = []
  for (let i = 0; i < 200; i++) draws.push(sampleSpinnerVerb(pool))
  let windowClean = true
  for (let i = 0; i < draws.length; i++) {
    const recent = draws.slice(Math.max(0, i - 16), i)
    if (recent.includes(draws[i]!)) windowClean = false
  }
  check('no repeat inside the 16-draw memory window (200 draws, pool 40)', windowClean)
  check('every draw is a pool member', draws.every(d => pool.includes(d)))
  const pair = ['qsv-a', 'qsv-b']
  const pairDraws = Array.from({ length: 12 }, () => sampleSpinnerVerb(pair))
  check(
    'a 2-entry pool alternates (window caps at half the pool — no deadlock)',
    pairDraws.every((d, i) => i === 0 || d !== pairDraws[i - 1]),
  )
  const solo = Array.from({ length: 3 }, () => sampleSpinnerVerb(['qsv-solo']))
  check('a 1-entry pool repeats honestly (no hang, no throw)', solo.every(d => d === 'qsv-solo'))
}


section('flag registry — MERCURY_HIP promoted (legacy alias bounded)')
const hipRow = getFlagSpec('MERCURY_HIP')
check("kind flipped to 'mixed' with the main-vocab contract", hipRow?.kind === 'mixed' && hipRow.summary.includes('MAIN VOCAB'))

console.log('')
if (failures > 0) {
  console.log(`❌ prove-hip-vocab: ${failures} FAILURE(S)`)
  process.exit(1)
}
console.log('✅ prove-hip-vocab: ALL GREEN')
