#!/usr/bin/env bun
;(globalThis as Record<string, unknown>)['MACRO'] = { VERSION: '1.0.0' }
import { getTheme } from '../../src/screen/theme/theme.js'
import { getPatchForDisplay } from '../../src/platform/text/diff.js'
import {
  DIFF_ADD_BG,
  DIFF_ADD_WORD,
  DIFF_DEL_BG,
  DIFF_DEL_WORD,
} from '../../src/screen/theme/mercuryPalette.js'

let failures = 0
const diffSpineHint = 'for a theme role, fix getTheme in src/screen/theme/theme.ts or the DIFF_* constants in src/screen/theme/mercuryPalette.ts; for the CRLF line, fix getPatchForDisplay in src/platform/text/diff.ts'
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${cond ? (detail ? ` — ${detail}` : '') : ` — ${detail ? `${detail} · ` : ''}${diffSpineHint}`}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
}

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
  check(`${name}: diffAddedDimmed is a dark tint (never light green)`, /^#0[0-9a-f]/i.test(t.diffAddedDimmed), t.diffAddedDimmed)
  check(`${name}: diffRemovedDimmed is a dark tint (never light red)`, /^#[0-3]/i.test(t.diffRemovedDimmed), t.diffRemovedDimmed)
}


section('an unknown name resolves onto the brand spine, exactly as the appearances do')
const unknown = getTheme('not-a-theme')
const darkT = getTheme('dark')
check('the unknown name rides the same brand diffAdded as dark', unknown.diffAdded === darkT.diffAdded, String(unknown.diffAdded))
check('the unknown name rides the same brand diffRemovedWord as dark', unknown.diffRemovedWord === darkT.diffRemovedWord)

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
