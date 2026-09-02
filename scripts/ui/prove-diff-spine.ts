#!/usr/bin/env bun
// ============================================================================
//  scripts/ui/prove-diff-spine.ts
//  PROOF: the StructuredDiff word-level FALLBACK and the primary
//  RawAnsi color-diff path must paint the SAME warm teal/crimson spine — the
//  fallback's six Ink diff roles must not fall through mercuryWarmInkOverlay to
//  plain green/red, so one Edit/Write/git-diff hunk rendered teal-crimson on the
//  primary path and plain green-red on the fallback (highlighting off
//  / syntaxHighlightingDisabled / skipHighlighting / render-throws).
//
//  This locks: (a) fork DARK themes remap all six diff-bg roles to the brand
//  tints; (b) those tints EXACTLY equal the native color-diff stamp branch (no
//  drift); (c) ANSI / light / daltonized themes are NOT remapped (accessibility +
//  light terminals keep their own palettes — the fix is inside shouldWarmInk).
//
//  Run: ~/.bun/bin/bun run scripts/ui/prove-diff-spine.ts
// ============================================================================
;(globalThis as Record<string, unknown>)['MACRO'] = { VERSION: '1.0.0' }
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { getTheme } from '../../src/utils/theme.js'
import { getPatchForDisplay } from '../../src/utils/diff.js'
import {
  DIFF_ADD_BG,
  DIFF_ADD_WORD,
  DIFF_DEL_BG,
  DIFF_DEL_WORD,
} from '../../src/components/mercuryPalette.js'

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ` — ${detail}` : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
}
const ROOT = join(import.meta.dir, '..', '..')

console.log('============================================================')
console.log(' diff-spine — fallback matches the primary color-diff (HB-0218)')
console.log('============================================================')

section('fork DARK themes remap all six diff-bg roles to the brand tints')
for (const name of ['dark', 'true-black'] as const) {
  const t = getTheme(name)
  check(`${name}: diffAdded → DIFF_ADD_BG`, t.diffAdded === DIFF_ADD_BG, t.diffAdded)
  check(`${name}: diffRemoved → DIFF_DEL_BG`, t.diffRemoved === DIFF_DEL_BG, t.diffRemoved)
  check(`${name}: diffAddedWord → DIFF_ADD_WORD`, t.diffAddedWord === DIFF_ADD_WORD, t.diffAddedWord)
  check(`${name}: diffRemovedWord → DIFF_DEL_WORD`, t.diffRemovedWord === DIFF_DEL_WORD, t.diffRemovedWord)
  // dimmed variants recede toward the canvas (darker than the base row, never light).
  check(`${name}: diffAddedDimmed is a dark tint (never light green)`, /^#0[0-9a-f]/i.test(t.diffAddedDimmed), t.diffAddedDimmed)
  check(`${name}: diffRemovedDimmed is a dark tint (never light red)`, /^#[0-3]/i.test(t.diffRemovedDimmed), t.diffRemovedDimmed)
}

section('the brand tints EXACTLY equal the native color-diff stamp branch (no drift)')
// native-ts/color-diff/index.ts stamp branch uses these rgb() literals.
const cd = readFileSync(join(ROOT, 'src', 'native-ts', 'color-diff', 'index.ts'), 'utf-8')
const hexToRgb = (h: string): string => {
  const n = parseInt(h.slice(1), 16)
  return `rgb(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255})`
}
check(`color-diff addLine == DIFF_ADD_BG (${hexToRgb(DIFF_ADD_BG)})`, cd.includes(`addLine: ${hexToRgb(DIFF_ADD_BG)}`))
check(`color-diff addWord == DIFF_ADD_WORD (${hexToRgb(DIFF_ADD_WORD)})`, cd.includes(`addWord: ${hexToRgb(DIFF_ADD_WORD)}`))
check(`color-diff deleteLine == DIFF_DEL_BG (${hexToRgb(DIFF_DEL_BG)})`, cd.includes(`deleteLine: ${hexToRgb(DIFF_DEL_BG)}`))
check(`color-diff deleteWord == DIFF_DEL_WORD (${hexToRgb(DIFF_DEL_WORD)})`, cd.includes(`deleteWord: ${hexToRgb(DIFF_DEL_WORD)}`))

section('accessibility / light themes are NOT remapped (fix is inside shouldWarmInk)')
const ansi = getTheme('dark-ansi')
check('dark-ansi keeps ansi diff colors (colorblind-safe)', String(ansi.diffAdded).startsWith('ansi:'), String(ansi.diffAdded))
const light = getTheme('light')
check('light keeps its own light-green diffAdded', String(light.diffAdded).startsWith('rgb('), String(light.diffAdded))
check('light diffAdded is NOT the dark brand tint', light.diffAdded !== DIFF_ADD_BG)

section('HB-0220: CRLF in a diff input is normalized → no \\r in hunk lines (Windows)')
const crlfHunks = getPatchForDisplay({
  filePath: 'x.txt',
  fileContents: 'alpha\nbeta\ngamma\n',
  edits: [{ old_string: 'beta', new_string: 'beta one\r\nbeta two' }],
})
const crlfLines = crlfHunks.flatMap(h => h.lines)
check(
  'CRLF new_string produces no \\r-terminated hunk line',
  !crlfLines.some(l => l.includes('\r')),
  JSON.stringify(crlfLines),
)

console.log('\n' + '═'.repeat(76))
if (failures === 0) console.log('✅ ALL DIFF-SPINE PROOFS PASS')
else console.log(`❌ ${failures} DIFF-SPINE PROOF(S) FAILED`)
console.log('═'.repeat(76))
process.exit(failures === 0 ? 0 : 1)
