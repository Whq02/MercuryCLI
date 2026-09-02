#!/usr/bin/env bun
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { readFileSync } from 'node:fs'
import { join } from 'node:path'

let failures = 0
const check = (label: string, cond: boolean, detail = ''): void => {
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ' — ' + detail : ''}`)
  if (!cond) failures++
}
const section = (t: string): void => console.log('\n' + '─'.repeat(76) + '\n' + t)

const { nativeCwdFromShellRecord } = await import('../../src/utils/windowsPaths.ts')
type Verdict = { path: string } | { refused: string }
const pathOf = (v: Verdict): string => ('path' in v ? v.path : `REFUSED: ${v.refused}`)

section('§1 the record parser')
{
  const windowsLineWins = nativeCwdFromShellRecord('/c/Users/o/proj\nC:/Users/o/proj\n')
  check('the Win32 line (pwd -W) wins and is spelled native', pathOf(windowsLineWins) === 'C:\\Users\\o\\proj', pathOf(windowsLineWins))
  const virtualRootPlaced = nativeCwdFromShellRecord('/tmp\nC:/Program Files/Git/tmp\n')
  check('an MSYS virtual root is placed by the shell itself (/tmp → the install tree)', pathOf(virtualRootPlaced) === 'C:\\Program Files\\Git\\tmp', pathOf(virtualRootPlaced))
  const msysDrive = nativeCwdFromShellRecord('/c/Users/o/proj\n')
  check('no Win32 line: an MSYS drive path converts (the single-letter arm)', pathOf(msysDrive) === 'C:\\Users\\o\\proj', pathOf(msysDrive))
  const cygdrive = nativeCwdFromShellRecord('/cygdrive/d/data\n')
  check('no Win32 line: a cygdrive path converts', pathOf(cygdrive) === 'D:\\data', pathOf(cygdrive))
  const unc = nativeCwdFromShellRecord('//server/share/proj\n//server/share/proj\n')
  check('a UNC directory stays UNC', pathOf(unc) === '\\\\server\\share\\proj', pathOf(unc))
  const tmpRefused = nativeCwdFromShellRecord('/tmp\n')
  check(
    'no Win32 line + a virtual root: REFUSED (never drive-relative \\tmp), the reason names both spellings',
    'refused' in tmpRefused && tmpRefused.refused.includes('/tmp') && tmpRefused.refused.includes('\\tmp') && /virtual root/.test(tmpRefused.refused),
    pathOf(tmpRefused),
  )
  const usrRefused = nativeCwdFromShellRecord('/usr/local\n')
  check('…and so is /usr/local', 'refused' in usrRefused && usrRefused.refused.includes('\\usr\\local'), pathOf(usrRefused))
  const crlf = nativeCwdFromShellRecord('/c/x\r\nC:/x\r\n')
  check('CRLF line endings are tolerated', pathOf(crlf) === 'C:\\x', pathOf(crlf))
  const empty = nativeCwdFromShellRecord('')
  check('an empty record is refused (the command died before writing)', 'refused' in empty, pathOf(empty))
  const rootOnly = nativeCwdFromShellRecord('/\nC:/Program Files/Git\n')
  check('the MSYS root itself places through the Win32 line', pathOf(rootOnly) === 'C:\\Program Files\\Git', pathOf(rootOnly))
}

section('§2 the provider chain and the engine consumer')
{
  const provider = readFileSync(join(import.meta.dir, '../../src/utils/shell/bashProvider.ts'), 'utf8')
  const posixLine = provider.indexOf('pwd -P >| ${quote([cwdFileInShell])}')
  const win32Line = provider.indexOf('{ pwd -W >> ${quote([cwdFileInShell])} 2>/dev/null || true; }')
  check('the POSIX record line is still written first', posixLine !== -1)
  check('the Win32 record line is appended on Windows, inside its own group (a bash without -W appends nothing; the user command keeps the chain status)', win32Line !== -1 && win32Line > posixLine, `posix@${posixLine} win32@${win32Line}`)
  check('…and only on Windows', /if \(isWindows\) \{\s*\n[^\n]*\n?[\s\S]{0,900}pwd -W/.test(provider))
  const shell = readFileSync(join(import.meta.dir, '../../src/utils/Shell.ts'), 'utf8')
  check('the engine consumer routes the record through nativeCwdFromShellRecord', /nativeCwdFromShellRecord\(/.test(shell))
  check('a refusal is logged with its reason, not swallowed', /bash cwd tracking:.*refused/.test(shell) || /cwd tracking[^\n]*\$\{[^\n]*refused/.test(shell))
  check('the old blind conversion of the recorded line is gone', !/recorded = posixPathToWindowsPath\(recorded\)/.test(shell))
}

if (failures > 0) {
  console.error(`\nprove-shell-cwd-record: ${failures} FAILURE(S)`)
  process.exit(1)
}
console.log('\nprove-shell-cwd-record: all green')
process.exit(0)
