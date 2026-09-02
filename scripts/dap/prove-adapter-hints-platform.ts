#!/usr/bin/env bun
// ============================================================================
//  scripts/dap/prove-adapter-hints-platform.ts — a failed native launch
//  names a remedy that exists on THIS host (FN-015 rank 71).
//
//  A Windows box carrying neither lldb-dap nor gdb 14+ launched build\app.exe
//  through the native default (lldb) and was told to run xcode-select
//  --install, with brew install netcoredbg beside it in the dormant-lane
//  list — neither command exists on Windows, and nothing in that list named
//  an adapter installable there. The install hints are now per host: the
//  darwin text stays, win32 names LLVM for Windows (lldb-dap.exe) and the
//  MSYS2 gdb, linux names the distribution packages; the netcoredbg hint
//  names the release archives off macOS.
//    §1 the three hint owners per platform — no macOS-only command off
//       darwin; every arm names an installable road.
//    §2 the builtin table and the dormant-lane list consume the owners
//       (call-shaped) — the live text on this host matches the owner's.
//
//  Run: ~/.bun/bin/bun run scripts/dap/prove-adapter-hints-platform.ts
// ============================================================================
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.MERCURY_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'adapter-hints-home-'))

let failures = 0
const check = (label: string, cond: boolean, detail = ''): void => {
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ' — ' + detail : ''}`)
  if (!cond) failures++
}
const section = (t: string): void => console.log('\n' + '─'.repeat(76) + '\n' + t)

const dap = await import('../../src/services/dap/dapClient.ts')
const MAC_ONLY = /xcode-select|xcrun|brew install/

section('§1 the hint owners, per host')
{
  const lldb = {
    darwin: dap.lldbDapInstallHint('darwin'),
    win32: dap.lldbDapInstallHint('win32'),
    linux: dap.lldbDapInstallHint('linux'),
  }
  check('darwin keeps the CommandLineTools road', /xcode-select --install/.test(lldb.darwin) && /lldb-dap/.test(lldb.darwin))
  check('win32 names LLVM for Windows (lldb-dap.exe) and the MSYS2 gdb road', /winget install LLVM\.LLVM/.test(lldb.win32) && /lldb-dap\.exe/.test(lldb.win32) && /pacman -S mingw-w64-ucrt-x86_64-gdb/.test(lldb.win32), lldb.win32)
  check('win32 names no macOS-only command', !MAC_ONLY.test(lldb.win32), lldb.win32)
  check('linux names the distribution packages', /apt install lldb/.test(lldb.linux) && /dnf install lldb/.test(lldb.linux) && !MAC_ONLY.test(lldb.linux), lldb.linux)

  const net = { darwin: dap.netcoredbgInstallHint('darwin'), win32: dap.netcoredbgInstallHint('win32'), linux: dap.netcoredbgInstallHint('linux') }
  check('darwin keeps brew for netcoredbg', /brew install netcoredbg/.test(net.darwin))
  check('win32/linux name the Samsung release archives, no brew', /github\.com\/Samsung\/netcoredbg\/releases/.test(net.win32) && !MAC_ONLY.test(net.win32) && /github\.com\/Samsung\/netcoredbg\/releases/.test(net.linux) && !MAC_ONLY.test(net.linux), net.win32)

  const gdb = { darwin: dap.gdbInstallHint('darwin'), win32: dap.gdbInstallHint('win32'), linux: dap.gdbInstallHint('linux') }
  check('every gdb hint names the 14+ floor', [gdb.darwin, gdb.win32, gdb.linux].every(h => /gdb 14\+/.test(h) && /-i=dap/.test(h)))
  check('win32 gdb hint names the MSYS2 package', /pacman -S mingw-w64-ucrt-x86_64-gdb/.test(gdb.win32), gdb.win32)
  check('the owners default to the live platform', dap.lldbDapInstallHint() === dap.lldbDapInstallHint(process.platform) && dap.netcoredbgInstallHint() === dap.netcoredbgInstallHint(process.platform) && dap.gdbInstallHint() === dap.gdbInstallHint(process.platform))
}

section('§2 the consumers ride the owners')
{
  const src = readFileSync(join(import.meta.dir, '../../src/services/dap/dapClient.ts'), 'utf8')
  // Code lines only (comments may narrate the old text): each literal
  // remedy lives exactly once, inside its owner's darwin arm.
  const code = src.split('\n').filter(line => !/^\s*(\/\/|\*)/.test(line)).join('\n')
  check('the xcode-select text lives once, inside the darwin owner arm', (code.match(/xcode-select --install/g) ?? []).length === 1)
  check('the brew-netcoredbg text lives once, inside the owner', (code.match(/brew install netcoredbg/g) ?? []).length === 1)
  check('the lldb row takes its unresolved hint from the owner', /: lldbDapInstallHint\(\)/.test(src))
  check('the dotnet row and its dormant entry take the owner', (src.match(/netcoredbgInstallHint\(\)/g) ?? []).length === 2)
  check('the dormant gdb entry takes the owner', /key: 'gdb', hint: gdbInstallHint\(\)/.test(src))
  // Live text on THIS host: the dormant list's entries match the owners.
  const dormant = dap.dormantBuiltinAdapterHints()
  const dotnet = dormant.find(d => d.key === 'dotnet')
  const gdb = dormant.find(d => d.key === 'gdb')
  check('the live dormant dotnet hint (when dormant here) is the owner text', dotnet === undefined || dotnet.hint === dap.netcoredbgInstallHint())
  check('the live dormant gdb hint (when dormant here) is the owner text', gdb === undefined || gdb.hint === dap.gdbInstallHint())
}

if (failures > 0) {
  console.error(`\nprove-adapter-hints-platform: ${failures} FAILURE(S)`)
  process.exit(1)
}
console.log('\nprove-adapter-hints-platform: all green')
process.exit(0)
