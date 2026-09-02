#!/usr/bin/env bun
// ============================================================================
//  scripts/helm-console/prove-hip-vocab.ts
//  PROOF: the QUICKSILVER thinking-line cadence (constants/spinnerVerbs.ts —
//  the main-vocab promotion, re-cut mercury-native;
//  the flag keeps its MERCURY_HIP env spelling, hence this filename):
//    · quicksilverMode(): unset ⇒ 'mixed' (standing default) · '0' ⇒ 'off' ·
//      '1' ⇒ 'only' — re-read live; canonical MERCURY_HIP wins over the
//      retired MERCURY_HIP alias, which still resolves alone;
//    · isQuicksilverLine(): classifies quicksilver entries (incl. the
//      CODE/FLOW adjacent sets) and rejects desert/base verbs;
//    · pool composition is DETERMINISTIC — no Math.random anywhere in the
//      compose path (the old coin flip made two spinners in one turn
//      disagree about whether quicksilver existed);
//    · the PICK is fresh — sampleSpinnerVerb() remembers recent draws and
//      avoids them, degrading gracefully
//      on tiny pools;
//    · identity-forward coverage: scribe AND the router party AND fable all
//      guarantee the quicksilver-heavy pool;
//    · the SpinnerGlyph swing: quicksilver cadence maps through
//      QUICKSILVER_SWING, standard cadence and reduced-motion stay untouched.
//  Run:  ~/.bun/bin/bun run scripts/helm-console/prove-hip-vocab.ts
// ============================================================================
;(globalThis as Record<string, unknown>)['MACRO'] = { VERSION: '1.0.0' }
delete process.env.MERCURY_HIP
delete process.env.MERCURY_HIP
import { readFileSync } from 'node:fs'
import {
  isQuicksilverLine,
  quicksilverMode,
  sampleSpinnerVerb,
} from '../../src/constants/spinnerVerbs.js'

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ` — ${detail}` : ''}`)
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

section('deterministic composition + identity coverage (structural)')
const src = readFileSync('src/constants/spinnerVerbs.ts', 'utf8')
const srcCode = src
  .split('\n')
  .filter(l => !l.trim().startsWith('//'))
  .join('\n')
check('no Math.random CALL in the vocab module (comments exempt)', !srcCode.includes('Math.random'))
check(
  'identity-forward covers the scribe (the retired party arm left the disjunction)',
  src.includes('} else if (isScribeModeOn()) {'),
)
check('quicksilver-heavy weighting in identity modes', src.includes('[...desert, ...quicksilver, ...quicksilver]'))
check('mixed default folds quicksilver into the pool', src.includes('[...desert, ...quicksilver]'))
check('adjacent sets present', src.includes('MERCURY_QUICKSILVER_CODE') && src.includes('MERCURY_QUICKSILVER_FLOW'))
check(
  'the original-writing law is stated where the set lives (no quoted lyrics)',
  src.includes('ORIGINAL house writing'),
)

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

section('SpinnerGlyph swing (structural)')
const glyph = readFileSync('src/components/Spinner/SpinnerGlyph.tsx', 'utf8')
check('QUICKSILVER_SWING bar defined', glyph.includes('const QUICKSILVER_SWING'))
check('cadence prop gates the swing', glyph.includes("cadence === 'quicksilver'"))
check('reduced-motion path untouched by cadence', /if \(reducedMotion\) \{[\s\S]{0,400}REDUCED_MOTION_DOT/.test(glyph))
const row = readFileSync('src/components/Spinner/SpinnerAnimationRow.tsx', 'utf8')
// Voice law: cadence keys off the DISPLAYED HEAD segment — the
// verb head of a voice-law byline, the bare verb on the legacy chain.
check('animation row derives cadence from the displayed head', row.includes('isQuicksilverLine(displayedHead)'))
check('…and threads it to the glyph', row.includes('cadence={cadence}'))

section('flag registry — MERCURY_HIP promoted (legacy alias bounded)')
const reg = readFileSync('src/substrate/flagRegistry.ts', 'utf8')
check("kind flipped to 'mixed' with the main-vocab contract", /MERCURY_HIP'[^}]*kind: 'mixed'[^}]*MAIN VOCAB/.test(reg))

console.log('')
if (failures > 0) {
  console.log(`❌ prove-hip-vocab: ${failures} FAILURE(S)`)
  process.exit(1)
}
console.log('✅ prove-hip-vocab: ALL GREEN')
