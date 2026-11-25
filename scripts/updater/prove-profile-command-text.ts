#!/usr/bin/env bun
import { commandFiles } from '../../src/platform/profiles/profiles.ts'

let failures = 0
const check = (label: string, ok: boolean, detail = ''): void => {
  if (!ok) failures++
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${ok ? '' : ` — ${detail} — fix the Windows branch of commandFiles in src/platform/profiles/profiles.ts`}`)
}
const show = (value: unknown): string => JSON.stringify(value)
const windows = (userHome: string, versions: string): Parameters<typeof commandFiles>[0] => ({
  bin: String.raw`C:\Users\Ada Lovelace\AppData\Local\Mercury\bin`,
  command: String.raw`C:\Users\Ada Lovelace\AppData\Local\Mercury\bin\mercury.cmd`,
  program: { MERCURY_VERSIONS_DIR: versions },
  isWindows: true,
  userHome,
})
const linesOf = (text: string): string[] => text.split('\r\n')

console.log('============================================================')
console.log(' The three Windows files of a profile\'s command, as text')
console.log('============================================================')

console.log('── a home under the user folder, whose name holds a space ──')
{
  const files = commandFiles(windows(String.raw`C:\Users\Ada Lovelace`, String.raw`C:\Users\Ada Lovelace\.mercury\versions`), 2, String.raw`C:\Users\Ada Lovelace\.mercury2`)
  check('three files beside mercury.cmd: the cmd file, the Git Bash file, the PowerShell file', show(files.map(file => file.path)) === show([String.raw`C:\Users\Ada Lovelace\AppData\Local\Mercury\bin\mercury2.cmd`, String.raw`C:\Users\Ada Lovelace\AppData\Local\Mercury\bin\mercury2`, String.raw`C:\Users\Ada Lovelace\AppData\Local\Mercury\bin\mercury2.ps1`]), show(files.map(file => file.path)))
  const cmd = ['@echo off', 'rem mercury-managed-profile 2', 'setlocal DisableDelayedExpansion', String.raw`set "MERCURY_CONFIG_DIR=%USERPROFILE%\.mercury2"`, String.raw`set "MERCURY_VERSIONS_DIR=%USERPROFILE%\.mercury\versions"`, '"%~dp0mercury.cmd" %*', ''].join('\r\n')
  check('the cmd file: its marker, delayed expansion off, both homes spelt from %USERPROFILE%, then mercury.cmd beside it', files[0]?.text === cmd, show(files[0]?.text))
  const sh = `#!/bin/sh\n# mercury-managed-profile 2\nMERCURY_CONFIG_DIR='C:\\Users\\Ada Lovelace\\.mercury2' MERCURY_VERSIONS_DIR='C:\\Users\\Ada Lovelace\\.mercury\\versions' exec "$(dirname "$0")/mercury" "$@"\n`
  check('the Git Bash file: its marker, both homes quoted whole, then mercury beside it', files[1]?.text === sh, show(files[1]?.text))
  const entry = String.raw`& (Join-Path $PSScriptRoot 'mercury.ps1') @args`
  const ps1 = `\uFEFF${[
    '# mercury-managed-profile 2',
    '$kept_MERCURY_CONFIG_DIR = $env:MERCURY_CONFIG_DIR',
    '$kept_MERCURY_VERSIONS_DIR = $env:MERCURY_VERSIONS_DIR',
    String.raw`$env:MERCURY_CONFIG_DIR = 'C:\Users\Ada Lovelace\.mercury2'`,
    String.raw`$env:MERCURY_VERSIONS_DIR = 'C:\Users\Ada Lovelace\.mercury\versions'`,
    `try { if ($MyInvocation.ExpectingInput) { $input | ${entry} } else { ${entry} } }`,
    'finally { $env:MERCURY_CONFIG_DIR = $kept_MERCURY_CONFIG_DIR; $env:MERCURY_VERSIONS_DIR = $kept_MERCURY_VERSIONS_DIR }',
    'exit $LASTEXITCODE',
    '',
  ].join('\r\n')}`
  check('the PowerShell file: a BOM, its marker, both variables kept, set, and put back in a finally, the exit code handed on', files[2]?.text === ps1, show(files[2]?.text))
}

console.log('── a home outside the user folder, with a percent sign, an exclamation mark and a quote in its path ──')
{
  const files = commandFiles(windows(String.raw`C:\Users\Ada Lovelace`, String.raw`D:\100% sure!\it's\.mercury\versions`), 3, String.raw`D:\100% sure!\it's\.mercury3`)
  check('the cmd file writes the path as it is, each percent sign doubled', show(linesOf(files[0]?.text ?? '').slice(3, 5)) === show([String.raw`set "MERCURY_CONFIG_DIR=D:\100%% sure!\it's\.mercury3"`, String.raw`set "MERCURY_VERSIONS_DIR=D:\100%% sure!\it's\.mercury\versions"`]), show(files[0]?.text))
  check('the Git Bash file closes and reopens its quotes around the quote', (files[1]?.text ?? '').includes(String.raw`MERCURY_CONFIG_DIR='D:\100% sure!\it'\''s\.mercury3' MERCURY_VERSIONS_DIR='D:\100% sure!\it'\''s\.mercury\versions' exec`), show(files[1]?.text))
  check('the PowerShell file doubles the quote', show(linesOf(files[2]?.text ?? '').slice(3, 5)) === show([String.raw`$env:MERCURY_CONFIG_DIR = 'D:\100% sure!\it''s\.mercury3'`, String.raw`$env:MERCURY_VERSIONS_DIR = 'D:\100% sure!\it''s\.mercury\versions'`]), show(files[2]?.text))
  check('every file carries the marker of profile 3 and none that of profile 2', files.every(file => file.text.includes('mercury-managed-profile 3') && !file.text.includes('mercury-managed-profile 2')), show(files.map(file => file.path)))
}

console.log('── a user folder spelt with a lower-case drive letter and a closing backslash, and a letter outside ASCII ──')
{
  const files = commandFiles(windows('c:\\Users\\J\u00f6rg\\', 'C:\\Users\\J\u00f6rg\\.mercury\\versions'), 2, 'C:\\Users\\J\u00f6rg\\.mercury2')
  check('the cmd file still spells both homes from %USERPROFILE%', show(linesOf(files[0]?.text ?? '').slice(3, 5)) === show([String.raw`set "MERCURY_CONFIG_DIR=%USERPROFILE%\.mercury2"`, String.raw`set "MERCURY_VERSIONS_DIR=%USERPROFILE%\.mercury\versions"`]), show(files[0]?.text))
  check('so no byte outside ASCII stands in the cmd file, which cmd.exe reads in the console\'s code page', /^[\x00-\x7f]*$/.test(files[0]?.text ?? '\u00ff'), show(files[0]?.text))
}

console.log(failures === 0 ? '\nprove-profile-command-text: ALL HOLD' : `\nprove-profile-command-text: ${failures} FAIL`)
process.exit(failures === 0 ? 0 : 1)
