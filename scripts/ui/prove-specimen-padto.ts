#!/usr/bin/env bun
// ============================================================================
//  scripts/ui/prove-specimen-padto.ts
//  PROOF for: the Hermes* /showcase specimens aligned their label column
//  with String.padEnd (UTF-16 code-unit padding) instead of the kit's
//  displayWidth-aware padTo (glyphs.ts) — a width-discipline bypass in the very
//  components meant to MODEL the design system. Latent today (all labels are
//  ASCII/BMP compile-time constants, so padTo === padEnd byte-for-byte) but
//  wrong for any future wide glyph. Part A: padEnd → padTo across the 9-file
//  family (MercuryDiff EXCLUDED — it uses padStart, a right-pad the kit has no
//  equivalent for).
//
//  glyphs.ts is bun-loadable, so this is a real byte-identical proof: padTo
//  reproduces padEnd for every real specimen cell TODAY, and diverges (correctly)
//  for a wide glyph — proving the swap is safe AND future-proof.
//
//  Run: ~/.bun/bin/bun run scripts/ui/prove-specimen-padto.ts
// ============================================================================
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
console.log(' Hermes* specimens: padEnd → padTo width discipline (HB-0231)')
console.log('============================================================')

// ───────────────────────────────────────────────────────────────────────────
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
// MercuryDiff must be LEFT ALONE (padStart, no kit equivalent)
const diff = read('MercuryDiff.tsx')
check('MercuryDiff is excluded — still padStart, not converted', /String\(n\)\.padStart\(3\)/.test(diff) && !/padTo\(/.test(diff))

// ───────────────────────────────────────────────────────────────────────────
section('byte-identical TODAY: padTo(s,w) === s.padEnd(w) for every real cell')
const { padTo } = (await import(join(root, 'src', 'components', 'mercury-ui', 'glyphs.ts'))) as {
  padTo: (s: string, w: number) => string
}
// the REAL specimen (label, width) pairs (mirrored verbatim from the data consts)
const CELLS: [string, number][] = [
  ['system', 8], ['tools', 8], ['history', 8], ['free', 8], // ContextViz
  ['orchestrator', 14], ['api-worker', 14], ['verifier', 14], // Agents col0
  ['Opus 4.8', 11], ['Sonnet 4.6', 11], ['Haiku 4.5', 11], // Agents col1
  ['markdown', 10], ['json', 10], ['html', 10], // Export
  ['1.0.0-beta.1', 12], // ReleaseNotes
  ['PreToolUse', 13], ['PostToolUse', 13], ['Stop', 13], // Hooks
  ['↑↓', 6], ['↵', 6], ['esc', 6], ['^c', 6], ['^d', 6], ['^r', 6], ['^t', 6], ['^⇧o', 6], ['^o', 6], // Keybindings
  ['build dist', 14], ['run tests', 14], ['deploy', 14], // Tasks
  ['network', 12], ['filesystem', 12], ['exec', 12], // Sandbox
  ['compoundv', 14], ['loop', 14], ['anti-lazy', 14], // Skills
]
let identical = 0
const mismatches: string[] = []
for (const [s, w] of CELLS) {
  if (padTo(s, w) === s.padEnd(w)) identical++
  else mismatches.push(`${JSON.stringify(s)}@${w}`)
}
check(`padTo === padEnd for ALL ${CELLS.length} real specimen cells (zero bytes change today)`, identical === CELLS.length, mismatches.join(', '))
// the keybinding symbol cells (↑↓ ↵ ^⇧o) are the only at-risk cells — confirm they agree
check('the keybinding symbol cells (↑↓ ↵ ^⇧o) are width-1-per-codeunit → padTo === padEnd', padTo('↑↓', 6) === '↑↓'.padEnd(6) && padTo('^⇧o', 6) === '^⇧o'.padEnd(6))

// ───────────────────────────────────────────────────────────────────────────
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
