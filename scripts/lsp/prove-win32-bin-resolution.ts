#!/usr/bin/env bun
// ============================================================================
//  scripts/lsp/prove-win32-bin-resolution.ts — an npm-delivered language
//  server resolves to a SPAWNABLE spelling on Windows (FN-015 rank 18).
//
//  npm writes three files per bin on Windows: the extensionless POSIX shim
//  (for git-bash), <name>.cmd and <name>.ps1. Both resolution rungs picked
//  the shim: the project-local probe tested the bare name first, and the
//  PATH rung took where.exe's FIRST line, which lists the shim ahead of its
//  .cmd sibling. An extensionless file spawns ENOENT under node (libuv
//  appends .com/.exe and never tries the bare path), and the client's
//  batch-shim shell ride is keyed on .cmd/.bat — so every npm row
//  (svelteserver, vue-language-server, astro-ls, tailwindcss-language-server,
//  intelephense, yaml-language-server, bash-language-server,
//  docker-langserver, the pyright PATH fallback) was OFFERED by health and
//  could never start, with the init-failure backoff painting it as
//  intermittently broken rather than absent.
//    §1 pickWin32ExecutableLine — the first where.exe line carrying a
//       spawnable extension, in PATH order; the bare first line only when
//       nothing spawnable was listed (unchanged behaviour there).
//    §2 spawnableSpellings — the win32 probe order; identity elsewhere.
//    §3 the project-local probe under a FORCED win32 platform picks the
//       .cmd sibling over the shim; the real platform keeps the bare name.
//    §4 call-shaped pins: both where.exe arms route through the picker; the
//       local probe iterates the spellings.
//  The live where.exe leg is Windows-box work.
//
//  Run: ~/.bun/bin/bun run scripts/lsp/prove-win32-bin-resolution.ts
// ============================================================================
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

let failures = 0
const check = (label: string, cond: boolean, detail = ''): void => {
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ' — ' + detail : ''}`)
  if (!cond) failures++
}
const section = (t: string): void => console.log('\n' + '─'.repeat(76) + '\n' + t)

const { pickWin32ExecutableLine, spawnableSpellings } = await import('../../src/utils/which.ts')
const { probeCatalogueEntry } = await import('../../src/services/lsp/serverCatalogue.ts')

section('§1 pickWin32ExecutableLine — the first SPAWNABLE where.exe line')
{
  check(
    'the npm shape: the shim precedes its .cmd sibling — the .cmd wins',
    pickWin32ExecutableLine(['C:\\Program Files\\nodejs\\npm', 'C:\\Program Files\\nodejs\\npm.cmd']) ===
      'C:\\Program Files\\nodejs\\npm.cmd',
  )
  check('a lone .exe is itself', pickWin32ExecutableLine(['C:\\tools\\rg.exe']) === 'C:\\tools\\rg.exe')
  check(
    'a shim in an earlier PATH dir does not shadow an .exe later on PATH',
    pickWin32ExecutableLine(['C:\\a\\foo', 'C:\\b\\foo.exe']) === 'C:\\b\\foo.exe',
  )
  check(
    'PATH order is kept among spawnable spellings (the earlier .cmd beats a later .exe — where.exe order IS cmd.exe order)',
    pickWin32ExecutableLine(['C:\\a\\foo.cmd', 'C:\\b\\foo.exe']) === 'C:\\a\\foo.cmd',
  )
  check('extension case is folded (.CMD)', pickWin32ExecutableLine(['C:\\a\\foo.CMD']) === 'C:\\a\\foo.CMD')
  check(
    'nothing spawnable listed ⇒ the bare first line (unchanged last resort)',
    pickWin32ExecutableLine(['C:\\a\\foo']) === 'C:\\a\\foo',
  )
  check(
    'blank and CR-bearing lines are ignored',
    pickWin32ExecutableLine(['', '  ', 'C:\\a\\foo.bat\r', '']) === 'C:\\a\\foo.bat',
  )
  check('no lines ⇒ null (never an empty string)', pickWin32ExecutableLine([]) === null && pickWin32ExecutableLine(['', ' ']) === null)
}

section('§2 spawnableSpellings — the win32 probe order, identity elsewhere')
{
  check(
    'win32: direct spawns first (.exe, .com), then the batch shims the client shell-rides (.cmd, .bat), the bare name last',
    JSON.stringify(spawnableSpellings('svelteserver', 'win32')) ===
      JSON.stringify(['svelteserver.exe', 'svelteserver.com', 'svelteserver.cmd', 'svelteserver.bat', 'svelteserver']),
    JSON.stringify(spawnableSpellings('svelteserver', 'win32')),
  )
  check('darwin/linux: the bare name only', JSON.stringify(spawnableSpellings('svelteserver', 'darwin')) === '["svelteserver"]' && JSON.stringify(spawnableSpellings('svelteserver', 'linux')) === '["svelteserver"]')
  check('the platform defaults to the live one', JSON.stringify(spawnableSpellings('x')) === JSON.stringify(spawnableSpellings('x', process.platform)))
}

section('§3 the project-local probe picks the .cmd sibling under win32')
{
  const root = mkdtempSync(join(tmpdir(), 'win32-bin-resolution-'))
  const bin = join(root, 'node_modules', '.bin')
  mkdirSync(bin, { recursive: true })
  // The npm layout: the POSIX shim AND its .cmd sibling (the .ps1 is inert here).
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
    live.binaryPath ?? 'undefined',
  )
  const desc = Object.getOwnPropertyDescriptor(process, 'platform')!
  Object.defineProperty(process, 'platform', { value: 'win32', configurable: true })
  try {
    const forced = probeCatalogueEntry(entry, root, ['package.json'], 'always')
    check(
      'forced win32: the .cmd sibling outranks the shim (the client shell-rides exactly that shape)',
      forced.binarySource === 'project-local' && (forced.binaryPath ?? '').endsWith('svelteserver.cmd'),
      forced.binaryPath ?? 'undefined',
    )
    rmSync(join(bin, 'svelteserver.cmd'))
    const shimOnly = probeCatalogueEntry(entry, root, ['package.json'], 'always')
    check(
      'forced win32 with only the shim present: the bare name stays the last resort (unchanged)',
      shimOnly.binarySource === 'project-local' && (shimOnly.binaryPath ?? '').endsWith('/svelteserver'),
      shimOnly.binaryPath ?? 'undefined',
    )
  } finally {
    Object.defineProperty(process, 'platform', desc)
    rmSync(root, { recursive: true, force: true })
  }
}

section('§4 call-shaped pins')
{
  const which = readFileSync(join(import.meta.dir, '../../src/utils/which.ts'), 'utf8')
  const picks = which.match(/pickWin32ExecutableLine\(result\.stdout\.split\(\/\\r\?\\n\/\)\)/g) ?? []
  check('both where.exe arms (async which + whichSync) route their lines through the picker', picks.length === 2, `sites=${picks.length}`)
  check('no arm takes the first where.exe line outright any more', !/split\(\/\\r\?\\n\/\)\[0\]/.test(which))
  const catalogue = readFileSync(join(import.meta.dir, '../../src/services/lsp/serverCatalogue.ts'), 'utf8')
  check('the project-local probe iterates the spawnable spellings', /for \(const spelling of spawnableSpellings\(bin\)\)/.test(catalogue))
}

if (failures > 0) {
  console.error(`\nprove-win32-bin-resolution: ${failures} FAILURE(S)`)
  process.exit(1)
}
console.log('\nprove-win32-bin-resolution: all green')
