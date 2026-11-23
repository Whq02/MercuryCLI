#!/usr/bin/env bun
import { displayWidth } from '../../src/screen/theme/glyphs.js'
import { wrapPlain } from '../../src/screen/cockpit/wrapPlain.js'

let failures = 0
function check(label: string, cond: boolean, detail = '', hint = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ` — ${detail}` : ''}${!cond && hint ? ` — ${hint}` : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
}

console.log('============================================================')
console.log(' cockpit text shaping — wrap')
console.log('============================================================')

section('wrapPlain — width honesty')
const w = 21
const lines = wrapPlain(
  'The quick brown fox jumps over the lazy dog and keeps going for a while longer.',
  w,
)
check('every line ≤ budget', lines.every(l => displayWidth(l) <= w), lines.map(l => displayWidth(l)).join(','), 'fix wrapPlain in src/screen/cockpit/wrapPlain.ts so no joined line is wider than the width argument')
check('no content lost', lines.join(' ').replace(/\s+/g, ' ') === 'The quick brown fox jumps over the lazy dog and keeps going for a while longer.', '', 'wrapPlain in src/screen/cockpit/wrapPlain.ts must only break between words and never drop one')
const cjk = wrapPlain('漢字がたくさん並んでいる行はセルの幅で折り返す必要がある', 10)
check('CJK wraps by cell width', cjk.every(l => displayWidth(l) <= 10), cjk.map(l => displayWidth(l)).join(','), 'wrapPlain in src/screen/cockpit/wrapPlain.ts should split wide characters through breakWord using charWidth cells')
const longWord = wrapPlain('averyveryverylongunbrokenidentifier_that_keeps_going', 12)
check('long word hard-breaks within budget', longWord.every(l => displayWidth(l) <= 12), '', 'fix breakWord in src/screen/cockpit/wrapPlain.ts so a word wider than the budget is cut into chunks within it')
check('hard-broken word reassembles', longWord.join('') === 'averyveryverylongunbrokenidentifier_that_keeps_going', '', 'breakWord in src/screen/cockpit/wrapPlain.ts must keep every character of a hard-broken word in order')
const paras = wrapPlain('one\n\ntwo', 10)
check('paragraph break survives as a blank line', paras.length === 3 && paras[1] === '', '', 'wrapPlain in src/screen/cockpit/wrapPlain.ts must push an empty line for each blank paragraph')


console.log('')
if (failures > 0) {
  console.log(`❌ prove-wrap-plain: ${failures} FAILURE(S)`)
  process.exit(1)
}
console.log('✅ prove-wrap-plain: ALL GREEN')
