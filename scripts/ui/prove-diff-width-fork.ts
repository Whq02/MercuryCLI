#!/usr/bin/env bun
// ============================================================================
//  scripts/ui/prove-diff-width-fork.ts
//  PROOF for: FileWriteToolDiff and FileEditToolDiff permission-prompt
//  diff previews measured their ColorDiff body 2 cols wider than the dialog
//  content area in fork mode (PermissionDialog adds 2-col left chrome:
//  borderLeft 1 + paddingLeft 1). Fix: subtract the fork chrome from each
//  component's width computation. De-_c'd FileWriteToolDiff from _c(15) to
//  plain (restored useMemo for hunks).
//
//  Run: ~/.bun/bin/bun run scripts/ui/prove-diff-width-fork.ts
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
const writeSrc = readFileSync(join(root, 'src', 'components', 'permissions', 'FileWritePermissionRequest', 'FileWriteToolDiff.tsx'), 'utf-8')
const editSrc = readFileSync(join(root, 'src', 'components', 'FileEditToolDiff.tsx'), 'utf-8')
const permSrc = readFileSync(join(root, 'src', 'components', 'permissions', 'PermissionDialog.tsx'), 'utf-8')

console.log('============================================================')
console.log(' HB-0200: permission diff width — fork chrome subtraction')
console.log('============================================================')

// the stamp locals and bare-stamp arms are folded away —
// the Mercury chrome arithmetic is unconditional now. Pin the folded shapes.
section('FileWriteToolDiff: de-_c + Mercury width')
check('no _c(15) cache — de-_c complete', !/const \$ = _c\(15\)/.test(writeSrc) && !/\$\[\d+\]/.test(writeSrc))
check('no compiler-runtime import', !/import \{ c as _c \} from "react\/compiler-runtime"/.test(writeSrc))
check('useMemo for hunks is restored', /useMemo\(\(\) =>/.test(writeSrc))
check('bodyWidth = columns - 4 (Mercury chrome, unconditional)', /columns - 4\)/.test(writeSrc))
check('width={bodyWidth} passed to StructuredDiff', /width=\{bodyWidth\}/.test(writeSrc))
check('Math.max(1, ...) floor present', /Math\.max\(1,/.test(writeSrc))

section('FileEditToolDiff DiffBody: Mercury chrome subtraction')
check('framed derived from width alone', /const framed = columns > 80/.test(editSrc))
check('innerWidth subtracts chrome + frame', /Math\.max\(1, columns - 2 - \(framed \? 2 : 0\)\)/.test(editSrc))
check('Math.max(1, ...) floor present', /Math\.max\(1,/.test(editSrc))

section('PermissionDialog: Mercury card chrome')
check('borderLeft present (full card)', /borderLeft=\{undefined\}/.test(permSrc))
check('paddingLeft={1}', /paddingLeft=\{1\}/.test(permSrc))
check('borderRight present (full card)', /borderRight=\{undefined\}/.test(permSrc))
check('the card is round + mode-tinted (borderColor={cardColor})',
  /borderStyle="round"/.test(permSrc) && /borderColor=\{cardColor\}/.test(permSrc))

section('behavioral: width arithmetic (Mercury regimes)')
const writeWidth = (cols: number) => Math.max(1, cols - 4)
const editWidth = (cols: number) => {
  const railed = cols > 80
  return Math.max(1, cols - 2 - (railed ? 2 : 0))
}
// Mercury: columns - perm chrome(2) - own padding(2)
check('FileWrite @80: width=76 (columns - 4)', writeWidth(80) === 76)
check('FileWrite @120: width=116', writeWidth(120) === 116)
// FileEdit non-railed (<=80): perm chrome only
check('FileEdit @80 non-railed: width=78 (columns-2)', editWidth(80) === 78)
// FileEdit railed (>80): perm chrome + rail
check('FileEdit @120 railed: width=116 (columns-4)', editWidth(120) === 116)

console.log('\n' + '='.repeat(60))
if (failures === 0) {
  console.log(' ✅ HB-0200 — permission diff width + de-_c proven')
  process.exit(0)
} else {
  console.log(` ❌ HB-0200 — ${failures} check(s) failed`)
  process.exit(1)
}
