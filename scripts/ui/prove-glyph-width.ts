#!/usr/bin/env bun
import { GLYPH, SPARK } from '../../src/components/mercury-ui/glyphs.js'
import { charWidth, displayWidth, padTo } from '../../src/components/mercury-ui/glyphs.js'
import { stringWidth } from '../../src/ink/stringWidth.js'

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ` — ${detail}` : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
}

console.log('============================================================')
console.log(' glyph-width — vocab is width-1 under the canonical model (HB-0006)')
console.log('============================================================')

section('every GLYPH vocab token measures exactly 1 cell')
const wide: string[] = []
for (const [name, glyph] of Object.entries(GLYPH)) {
  const w = stringWidth(glyph)
  if (w !== 1) wide.push(`${name}=${JSON.stringify(glyph)} (w=${w})`)
}
check(
  'no GLYPH token measures != 1 under the canonical (ambiguous-as-narrow) width',
  wide.length === 0,
  wide.length ? `wide tokens:\n      - ${wide.join('\n      - ')}` : `all ${Object.keys(GLYPH).length} tokens width-1`,
)

section('SPARK ramp cells are all width-1 (so a gauge column never drifts)')
const wideSpark = SPARK.filter(c => stringWidth(c) !== 1)
check('every SPARK cell is width-1', wideSpark.length === 0, wideSpark.length ? wideSpark.join(' ') : `all ${SPARK.length} cells width-1`)

section('charWidth/displayWidth delegate to the canonical stringWidth (no parallel system)')
for (const s of ['a', GLYPH.ok, GLYPH.fail, '世', 'café', '👨‍👩‍👧', '']) {
  check(`charWidth("${s}") === stringWidth`, charWidth(s.length ? [...s][0]! : '') === stringWidth(s.length ? [...s][0]! : ''))
  check(`displayWidth("${s}") === stringWidth("${s}")`, displayWidth(s) === stringWidth(s))
}

section('padTo aligns to the SAME width the renderer measures')
check('padTo("●", 4) yields display width 4', displayWidth(padTo(GLYPH.ok, 4)) === 4)
check('padTo("世界", 6) yields display width 6 (wide-CJK content)', displayWidth(padTo('世界', 6)) === 6)

section('self-test: the guard WOULD catch a genuinely-wide glyph drifting in')
check('a CJK ideograph measures width-2 (would fail the vocab assert)', stringWidth('好') === 2)
check('a VS16 emoji presentation measures width-2', stringWidth('✳️') === 2)
check('ambiguous-as-narrow contract holds: ● is width-1 here (Ink agrees)', stringWidth('●') === 1)

section('E1 (WG-3): Cf format characters occupy NO cell, both paths')
check('LRM/RLM are zero (native route)', stringWidth('‎') === 0 && stringWidth('‏') === 0)
check('embeddings/overrides are zero (native route refused, corrected path)', stringWidth('‪') === 0 && stringWidth('‮') === 0)
check('isolates and ALM are zero', stringWidth('⁦') === 0 && stringWidth('⁩') === 0 && stringWidth('؜') === 0)
check('an LRO-wrapped word measures its letters alone', stringWidth('‭ABC‬') === 3)
check('content around a mark is unmoved', stringWidth('a‎b') === 2)
check(
  'the JS path (forced via a width-0 routing mark) classifies the same',
  stringWidth('‪֑') === 0 && stringWidth('؜֑') === 0 && stringWidth('⁦֑') === 0,
)
{
  const { readFileSync } = await import('node:fs')
  const src = readFileSync(new URL('../../src/ink/stringWidth.ts', import.meta.url), 'utf8')
  check(
    'the native route refuses every directional format (the corrected-implementation discipline)',
    src.includes('DIRECTIONAL_FORMAT_RE') && src.includes('!DIRECTIONAL_FORMAT_RE.test(text)'),
  )
}

console.log('\n' + '═'.repeat(76))
if (failures === 0) console.log('✅ ALL GLYPH-WIDTH PROOFS PASS')
else console.log(`❌ ${failures} GLYPH-WIDTH PROOF(S) FAILED`)
console.log('═'.repeat(76))
process.exit(failures === 0 ? 0 : 1)
