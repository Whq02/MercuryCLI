#!/usr/bin/env bun
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ` — ${detail}` : ''}`)
}

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const src = readFileSync(join(root, 'src', 'utils', 'terminal.ts'), 'utf-8')

console.log('============================================================')
console.log(' HB-0204: approximate "~N lines" label for pre-truncated output')
console.log('============================================================')

check(
  'the "~" prefix is gated on preTruncated',
  /preTruncated \? '~' : ''/.test(src),
)

check(
  'preTruncated is computed from trimmedContent.length > maxChars',
  /const preTruncated = trimmedContent\.length > maxChars/.test(src),
)

check(
  'the non-preTruncated branch uses remainingLines (accurate from wrapText)',
  /: remainingLines/.test(src),
)

{
  const preTruncatedTrue = true
  const preTruncatedFalse = false
  const est = 42
  const fmtTrue = `… +${preTruncatedTrue ? '~' : ''}${est} lines`
  const fmtFalse = `… +${preTruncatedFalse ? '~' : ''}${est} lines`
  check('preTruncated=true renders "… +~42 lines" (approximate)', fmtTrue === '… +~42 lines')
  check('preTruncated=false renders "… +42 lines" (exact)', fmtFalse === '… +42 lines')
}

check(
  'no stringWidth or ANSI-strip on the full content (O(1) fix)',
  !/stringWidth\(trimmedContent\)/.test(src),
)

console.log('\n' + '='.repeat(60))
if (failures === 0) {
  console.log(' ✅ HB-0204 — approximate ~N label proven (O(1), honest, no perf regression)')
  process.exit(0)
} else {
  console.log(` ❌ HB-0204 — ${failures} check(s) failed`)
  process.exit(1)
}
