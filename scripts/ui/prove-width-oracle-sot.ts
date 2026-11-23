#!/usr/bin/env bun
import { charWidth, displayWidth, truncateToWidth } from '../../src/screen/theme/glyphs.ts'
import { stringWidth } from '../../src/screen/renderer/stringWidth.ts'
import { truncateToWidth as rigorousTruncateToWidth } from '../../src/platform/text/truncate.ts'

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ` — ${detail}` : ''}`)
}

console.log('============================================================')
console.log(' width-oracle SOT — no second width primitive')
console.log('============================================================')

const widthSamples = ['', 'a', 'hello', '漢', '日本語テスト', 'e\u0301', '\u200b', '🚀', '👩‍💻', '⚠️', '\x1b[31mred\x1b[0m', '\x1b[1;32m✓ ok\x1b[0m']
const widthDrift = widthSamples.filter(s => charWidth(s) !== stringWidth(s) || displayWidth(s) !== stringWidth(s))
check(
  'glyphs.ts charWidth/displayWidth agree with stringWidth',
  widthDrift.length === 0,
  widthDrift.map(s => JSON.stringify(s)).join(', '),
)
const truncDrift: string[] = []
for (const s of widthSamples) {
  if (truncateToWidth(s, 0) !== '' || truncateToWidth(s, -1) !== '') truncDrift.push(`${JSON.stringify(s)}@<=0`)
  for (const max of [1, 2, 3, 5, 8, 20]) {
    if (truncateToWidth(s, max) !== rigorousTruncateToWidth(s, max)) truncDrift.push(`${JSON.stringify(s)}@${max}`)
  }
}
check(
  'glyphs.ts truncateToWidth agrees with the rigorous truncator',
  truncDrift.length === 0,
  truncDrift.join(', '),
)

console.log(failures === 0 ? '\nALL WIDTH-SOT PROOFS PASS' : `\n${failures} PROOF(S) FAILED`)
process.exit(failures === 0 ? 0 : 1)
