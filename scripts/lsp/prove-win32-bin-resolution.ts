#!/usr/bin/env bun
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

let failures = 0
const check = (label: string, cond: boolean, detail = ''): void => {
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ' — ' + detail : ''}`)
  if (!cond) failures++
}
const section = (t: string): void => console.log('\n' + '─'.repeat(76) + '\n' + t)

const { pickWin32ExecutableLine, spawnableSpellings } = await import('../../src/platform/processes/which.ts')
const { probeCatalogueEntry } = await import('../../src/integrations/lsp/serverCatalogue.ts')

section('§1 pickWin32ExecutableLine — the first SPAWNABLE where.exe line')
{
  check(
    'the npm shape: the shim precedes its .cmd sibling — the .cmd wins',
    pickWin32ExecutableLine(['C:\\Program Files\\nodejs\\npm', 'C:\\Program Files\\nodejs\\npm.cmd']) ===
      'C:\\Program Files\\nodejs\\npm.cmd',
    'pickWin32ExecutableLine in src/platform/host-os/programs.ts must skip an extensionless shim when a spawnable .cmd sibling is listed',
  )
  check('a lone .exe is itself', pickWin32ExecutableLine(['C:\\tools\\rg.exe']) === 'C:\\tools\\rg.exe', 'pickWin32ExecutableLine in src/platform/host-os/programs.ts must return a lone .exe line unchanged')
  check(
    'a shim in an earlier PATH dir does not shadow an .exe later on PATH',
    pickWin32ExecutableLine(['C:\\a\\foo', 'C:\\b\\foo.exe']) === 'C:\\b\\foo.exe',
    'pickWin32ExecutableLine in src/platform/host-os/programs.ts must prefer any line with a spawnable extension over an earlier extensionless one',
  )
  check(
    'PATH order is kept among spawnable spellings (the earlier .cmd beats a later .exe — where.exe order IS cmd.exe order)',
    pickWin32ExecutableLine(['C:\\a\\foo.cmd', 'C:\\b\\foo.exe']) === 'C:\\a\\foo.cmd',
    'pickWin32ExecutableLine in src/platform/host-os/programs.ts must return the first spawnable line in where.exe order, not rank .exe above .cmd',
  )
  check('extension case is folded (.CMD)', pickWin32ExecutableLine(['C:\\a\\foo.CMD']) === 'C:\\a\\foo.CMD', 'pickWin32ExecutableLine in src/platform/host-os/programs.ts must compare the extension case-insensitively')
  check(
    'nothing spawnable listed ⇒ the bare first line (unchanged last resort)',
    pickWin32ExecutableLine(['C:\\a\\foo']) === 'C:\\a\\foo',
    'pickWin32ExecutableLine in src/platform/host-os/programs.ts must fall back to the first line when none has a spawnable extension',
  )
  check(
    'blank and CR-bearing lines are ignored',
    pickWin32ExecutableLine(['', '  ', 'C:\\a\\foo.bat\r', '']) === 'C:\\a\\foo.bat',
    'pickWin32ExecutableLine in src/platform/host-os/programs.ts must trim each line and drop blank ones',
  )
  check('no lines ⇒ null (never an empty string)', pickWin32ExecutableLine([]) === null && pickWin32ExecutableLine(['', ' ']) === null, 'pickWin32ExecutableLine in src/platform/host-os/programs.ts must return null when there is no non-blank line')
}

section('§2 spawnableSpellings — the win32 probe order, identity elsewhere')
{
  check(
    'win32: direct spawns first (.exe, .com), then the batch shims the client shell-rides (.cmd, .bat), the bare name last',
    JSON.stringify(spawnableSpellings('svelteserver', 'win32')) ===
      JSON.stringify(['svelteserver.exe', 'svelteserver.com', 'svelteserver.cmd', 'svelteserver.bat', 'svelteserver']),
    `${JSON.stringify(spawnableSpellings('svelteserver', 'win32'))} — spawnableSpellings in src/platform/processes/which.ts must list .exe, .com, .cmd, .bat, then the bare name for win32`,
  )
  check('darwin/linux: the bare name only', JSON.stringify(spawnableSpellings('svelteserver', 'darwin')) === '["svelteserver"]' && JSON.stringify(spawnableSpellings('svelteserver', 'linux')) === '["svelteserver"]', 'spawnableSpellings in src/platform/processes/which.ts must return only the bare name off win32')
  check('the platform defaults to the live one', JSON.stringify(spawnableSpellings('x')) === JSON.stringify(spawnableSpellings('x', process.platform)), 'spawnableSpellings in src/platform/processes/which.ts must default its platform argument to process.platform')
}

section('§3 the project-local probe picks the .cmd sibling under win32')
{
  const root = mkdtempSync(join(tmpdir(), 'win32-bin-resolution-'))
  const bin = join(root, 'node_modules', '.bin')
  mkdirSync(bin, { recursive: true })
  writeFileSync(join(bin, 'svelteserver'), '#!/bin/sh\nexec node "$(dirname "$0")/../svelte-language-server/bin/server.js" "$@"\n')
  chmodSync(join(bin, 'svelteserver'), 0o755)
  writeFileSync(join(bin, 'svelteserver.cmd'), '@ECHO off\r\nnode "%~dp0\\..\\svelte-language-server\\bin\\server.js" %*\r\n')
  const entry = {
    id: 'svelte',
    label: 'Svelte LS',
    languages: ['svelte'],
    binaries: ['svelteserver'],
    args: ['--stdio'],
    extensionToLanguage: { '.svelte': 'svelte' },
    rootMarkers: ['package.json'],
    remedy: 'npm i -g svelte-language-server',
  }
  const live = probeCatalogueEntry(entry, root, ['package.json'], 'always')
  check(
    'the live platform (POSIX) keeps the bare shim — it IS the executable there',
    live.binarySource === 'project-local' && (live.binaryPath ?? '').endsWith('/svelteserver'),
    `${live.binaryPath ?? 'undefined'} — probeCatalogueEntry in src/integrations/lsp/serverCatalogue.ts must resolve the project-local node_modules/.bin/svelteserver bare name off win32`,
  )
  const desc = Object.getOwnPropertyDescriptor(process, 'platform')!
  Object.defineProperty(process, 'platform', { value: 'win32', configurable: true })
  try {
    const forced = probeCatalogueEntry(entry, root, ['package.json'], 'always')
    check(
      'forced win32: the .cmd sibling outranks the shim (the client shell-rides exactly that shape)',
      forced.binarySource === 'project-local' && (forced.binaryPath ?? '').endsWith('svelteserver.cmd'),
      `${forced.binaryPath ?? 'undefined'} — probeCatalogueEntry in src/integrations/lsp/serverCatalogue.ts must try the spellings from spawnableSpellings (src/platform/processes/which.ts) so svelteserver.cmd wins on win32`,
    )
    rmSync(join(bin, 'svelteserver.cmd'))
    const shimOnly = probeCatalogueEntry(entry, root, ['package.json'], 'always')
    check(
      'forced win32 with only the shim present: the bare name stays the last resort (unchanged)',
      shimOnly.binarySource === 'project-local' && (shimOnly.binaryPath ?? '').endsWith('/svelteserver'),
      `${shimOnly.binaryPath ?? 'undefined'} — probeCatalogueEntry in src/integrations/lsp/serverCatalogue.ts must still resolve the bare svelteserver when no .cmd sibling exists`,
    )
  } finally {
    Object.defineProperty(process, 'platform', desc)
    rmSync(root, { recursive: true, force: true })
  }
}


if (failures > 0) {
  console.error(`\nprove-win32-bin-resolution: ${failures} FAILURE(S)`)
  process.exit(1)
}
console.log('\nprove-win32-bin-resolution: all green')
