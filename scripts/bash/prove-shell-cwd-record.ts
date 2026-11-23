#!/usr/bin/env bun
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }


let failures = 0
const recordFailHint = 'change nativeCwdFromShellRecord in src/platform/files/windowsPaths.ts'
const check = (label: string, cond: boolean, detail = ''): void => {
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ' — ' + detail : ''}${cond ? '' : ` · ${recordFailHint}`}`)
  if (!cond) failures++
}
const section = (t: string): void => console.log('\n' + '─'.repeat(76) + '\n' + t)

const { nativeCwdFromShellRecord } = await import('../../src/platform/files/windowsPaths.ts')
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


if (failures > 0) {
  console.error(`\nprove-shell-cwd-record: ${failures} FAILURE(S)`)
  process.exit(1)
}
console.log('\nprove-shell-cwd-record: all green')
process.exit(0)
