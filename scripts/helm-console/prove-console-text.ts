#!/usr/bin/env bun
import { readFileSync } from 'node:fs'
import { displayWidth } from '../../src/components/mercury-ui/glyphs.js'
import { fmtTok, wrapPlain } from '../../src/utils/cockpit/helmConsoleText.js'

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ` — ${detail}` : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
}

console.log('============================================================')
console.log(' helm console text shaping — wrap · fmt')
console.log('============================================================')

section('wrapPlain — width honesty')
const w = 21
const lines = wrapPlain(
  'The quick brown fox jumps over the lazy dog and keeps going for a while longer.',
  w,
)
check('every line ≤ budget', lines.every(l => displayWidth(l) <= w), lines.map(l => displayWidth(l)).join(','))
check('no content lost', lines.join(' ').replace(/\s+/g, ' ') === 'The quick brown fox jumps over the lazy dog and keeps going for a while longer.')
const cjk = wrapPlain('漢字がたくさん並んでいる行はセルの幅で折り返す必要がある', 10)
check('CJK wraps by cell width', cjk.every(l => displayWidth(l) <= 10), cjk.map(l => displayWidth(l)).join(','))
const longWord = wrapPlain('averyveryverylongunbrokenidentifier_that_keeps_going', 12)
check('long word hard-breaks within budget', longWord.every(l => displayWidth(l) <= 12))
check('hard-broken word reassembles', longWord.join('') === 'averyveryverylongunbrokenidentifier_that_keeps_going')
const paras = wrapPlain('one\n\ntwo', 10)
check('paragraph break survives as a blank line', paras.length === 3 && paras[1] === '')

section('fmtTok — boundaries')
check('999 → 999', fmtTok(999) === '999')
check('1000 → 1k', fmtTok(1000) === '1k')
check('1500 → 1.5k', fmtTok(1500) === '1.5k')
check('9999 → 10k', fmtTok(9999) === '10k')
check('41234 → 41k', fmtTok(41234) === '41k')
check('1.2m', fmtTok(1_200_000) === '1.2m')
check('negative/NaN → 0', fmtTok(-5) === '0' && fmtTok(Number.NaN) === '0')

section('width-oracle delegation (structural)')
const src = readFileSync('src/utils/cockpit/helmConsoleText.ts', 'utf8')
check('imports the glyphs facade', src.includes("from '../../components/mercury-ui/glyphs.js'"))
check('defines no width primitive of its own', !/function\s+(charWidth|displayWidth|stringWidth)\s*\(/.test(src))

console.log('')
if (failures > 0) {
  console.log(`❌ prove-console-text: ${failures} FAILURE(S)`)
  process.exit(1)
}
console.log('✅ prove-console-text: ALL GREEN')
