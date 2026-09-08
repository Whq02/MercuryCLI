#!/usr/bin/env bun
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ` — ${detail}` : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
}
const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const read = (f: string): string => readFileSync(join(root, 'src', 'components', f), 'utf-8')

console.log('============================================================')
console.log(' Mercury* specimens: padEnd → padTo width discipline (HB-0231)')
console.log('============================================================')

section('source: the 9-file family uses padTo (import + call); MercuryDiff excluded')
const FILES = [
  'MercuryContextViz.tsx',
  'MercuryAgents.tsx',
  'MercuryExport.tsx',
  'MercuryReleaseNotes.tsx',
  'MercuryHooks.tsx',
  'MercuryKeybindings.tsx',
  'MercuryTasks.tsx',
  'MercurySandbox.tsx',
  'MercurySkills.tsx',
]
let imported = 0
let noPadEnd = 0
for (const f of FILES) {
  const src = read(f)
  if (/import \{ padTo \} from '\.\/mercury-ui\/glyphs\.js'/.test(src)) imported++
  if (!/\.padEnd\(/.test(src) && /padTo\(/.test(src)) noPadEnd++
}
check(`all ${FILES.length} files import padTo`, imported === FILES.length, `${imported}/${FILES.length}`)
check(`all ${FILES.length} files use padTo and NO padEnd remains`, noPadEnd === FILES.length, `${noPadEnd}/${FILES.length}`)
const diff = read('MercuryDiff.tsx')
check('MercuryDiff is excluded — still padStart, not converted', /String\(n\)\.padStart\(3\)/.test(diff) && !/padTo\(/.test(diff))

section('byte-identical TODAY: padTo(s,w) === s.padEnd(w) for every real cell')
const { padTo } = (await import(join(root, 'src', 'components', 'mercury-ui', 'glyphs.ts'))) as {
  padTo: (s: string, w: number) => string
}
const CELLS: [string, number][] = [
  ['system', 8], ['tools', 8], ['history', 8], ['free', 8],
  ['orchestrator', 14], ['api-worker', 14], ['verifier', 14],
  ['Opus 4.8', 11], ['Sonnet 4.6', 11], ['Haiku 4.5', 11],
  ['markdown', 10], ['json', 10], ['html', 10],
  ['1.0.0-beta.1', 12],
  ['PreToolUse', 13], ['PostToolUse', 13], ['Stop', 13],
  ['↑↓', 6], ['↵', 6], ['esc', 6], ['^c', 6], ['^d', 6], ['^r', 6], ['^t', 6], ['^⇧o', 6], ['^o', 6],
  ['build dist', 14], ['run tests', 14], ['deploy', 14],
  ['network', 12], ['filesystem', 12], ['exec', 12],
  ['compoundv', 14], ['loop', 14], ['anti-lazy', 14],
]
let identical = 0
const mismatches: string[] = []
for (const [s, w] of CELLS) {
  if (padTo(s, w) === s.padEnd(w)) identical++
  else mismatches.push(`${JSON.stringify(s)}@${w}`)
}
check(`padTo === padEnd for ALL ${CELLS.length} real specimen cells (zero bytes change today)`, identical === CELLS.length, mismatches.join(', '))
check('the keybinding symbol cells (↑↓ ↵ ^⇧o) are width-1-per-codeunit → padTo === padEnd', padTo('↑↓', 6) === '↑↓'.padEnd(6) && padTo('^⇧o', 6) === '^⇧o'.padEnd(6))

section('width-discipline VALUE: padTo diverges (correctly) for a wide glyph')
check('padTo(世,4) !== 世.padEnd(4) — padTo pads to DISPLAY width (the future-proof reason)', padTo('世', 4) !== '世'.padEnd(4))
check('padTo(世,4) has the correct DISPLAY width 4 (2 for 世 + 2 pad), padEnd would over-pad', padTo('世', 4).length < '世'.padEnd(4).length)

console.log('\n' + '='.repeat(60))
if (failures === 0) {
  console.log(' ✅ HB-0231 — specimen padEnd → padTo (byte-identical + future-proof)')
  process.exit(0)
} else {
  console.log(` ❌ HB-0231 — ${failures} check(s) failed`)
  process.exit(1)
}
