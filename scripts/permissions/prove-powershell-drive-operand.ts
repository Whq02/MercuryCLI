#!/usr/bin/env bun
// ============================================================================
//  scripts/permissions/prove-powershell-drive-operand.ts — a drive-qualified
//  PowerShell operand is ABSOLUTE (FN-015 rank 52).
//
//  The PowerShell tool's path containment resolved an operand against the
//  session directory by slash concatenation, treating only a leading '/'
//  as absolute. An operand such as Get-Content C:\Users\Public\notes.txt
//  — separator-normalised to C:/Users/Public/notes.txt — was therefore
//  concatenated onto the session directory (C:\proj/C:/Users/Public/…),
//  a string the containment check answered as inside the tree: the
//  out-of-tree read ran with no approval card, and a Read deny rule naming
//  the real path could not bite because the matcher was handed the
//  concatenation. On the write side the embedded colon tripped the
//  NTFS-stream rung instead, with suggestions built from the mangled path.
//    §1 resolveOperandPath (pure): a drive-qualified spelling stands as
//       written; POSIX-rooted spellings stand; relative spellings join the
//       session directory.
//    §2 call-shaped: both resolution sites in resolveAndDecide ride it.
//  The ladder past this point rides win32 path semantics (drive-letter
//  resolution, the rule matcher over native spellings) that a POSIX node
//  cannot imitate, so the live card and deny-rule legs are Windows-box work.
//
//  Run: ~/.bun/bin/bun run scripts/permissions/prove-powershell-drive-operand.ts
// ============================================================================
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.MERCURY_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'ps-drive-operand-home-'))

let failures = 0
const check = (label: string, cond: boolean, detail = ''): void => {
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ' — ' + detail : ''}`)
  if (!cond) failures++
}
const section = (t: string): void => console.log('\n' + '─'.repeat(76) + '\n' + t)

const { resolveOperandPath } = await import('../../src/tools/PowerShellTool/pathValidation.ts')

section('§1 resolveOperandPath')
{
  const CWD = 'C:\\proj'
  check('a drive-qualified operand stands as written (never concatenated onto the session directory)', resolveOperandPath('C:/Users/Public/notes.txt', CWD) === 'C:/Users/Public/notes.txt', resolveOperandPath('C:/Users/Public/notes.txt', CWD))
  check('…lowercase drive too', resolveOperandPath('c:/users/public/notes.txt', CWD) === 'c:/users/public/notes.txt')
  check('…another drive too', resolveOperandPath('D:/data/x.csv', CWD) === 'D:/data/x.csv')
  check('a POSIX-rooted operand stands as written', resolveOperandPath('/c/Users/Public/notes.txt', CWD) === '/c/Users/Public/notes.txt')
  check('a relative operand joins the session directory', resolveOperandPath('src/a.ts', CWD) === 'C:\\proj/src/a.ts', resolveOperandPath('src/a.ts', CWD))
  check('a dot-relative operand joins the session directory', resolveOperandPath('./src/a.ts', CWD) === 'C:\\proj/./src/a.ts')
  check('a bare drive with no separator is NOT treated as absolute (a drive-relative spelling keeps its later NTFS-stream ask)', resolveOperandPath('C:notes.txt', CWD) === 'C:\\proj/C:notes.txt')
}

section('§2 the resolution sites ride it')
{
  const src = readFileSync(join(import.meta.dir, '../../src/tools/PowerShellTool/pathValidation.ts'), 'utf8')
  const sites = src.match(/resolveOperandPath\((?:base|path), cwd\)/g) ?? []
  check('both resolution sites (the glob base and the operand) call resolveOperandPath', sites.length === 2, `sites=${sites.length}`)
  check('no slash-concatenating resolver remains under the old name', !/function resolveAbsolute\(/.test(src))
  check('the drive-qualified test is the separator-normalised spelling (X:/)', /\^\[A-Za-z\]:\\\//.test(src))
}

if (failures > 0) {
  console.error(`\nprove-powershell-drive-operand: ${failures} FAILURE(S)`)
  process.exit(1)
}
console.log('\nprove-powershell-drive-operand: all green')
process.exit(0)
