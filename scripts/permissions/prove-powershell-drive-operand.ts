#!/usr/bin/env bun
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
