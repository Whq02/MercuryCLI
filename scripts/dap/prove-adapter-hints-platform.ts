#!/usr/bin/env bun
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.MERCURY_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'adapter-hints-home-'))

let failures = 0
const check = (label: string, cond: boolean, detail = ''): void => {
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ' — ' + detail : ''}`)
  if (!cond) failures++
}
const section = (t: string): void => console.log('\n' + '─'.repeat(76) + '\n' + t)

const dap = await import('../../src/integrations/debugger/dapClient.ts')
const MAC_ONLY = /xcode-select|xcrun|brew install/

section('§1 the hint owners, per host')
{
  const lldb = {
    darwin: dap.lldbDapInstallHint('darwin'),
    win32: dap.lldbDapInstallHint('win32'),
    linux: dap.lldbDapInstallHint('linux'),
  }
  check('darwin keeps the CommandLineTools road', /xcode-select --install/.test(lldb.darwin) && /lldb-dap/.test(lldb.darwin), `${lldb.darwin} (fix lldbDapInstallHint in src/integrations/debugger/client/probes.ts)`)
  check('win32 names LLVM for Windows (lldb-dap.exe) and the MSYS2 gdb road', /winget install LLVM\.LLVM/.test(lldb.win32) && /lldb-dap\.exe/.test(lldb.win32) && /pacman -S mingw-w64-ucrt-x86_64-gdb/.test(lldb.win32), `${lldb.win32} (fix the win32 branch of lldbDapInstallHint in src/integrations/debugger/client/probes.ts)`)
  check('win32 names no macOS-only command', !MAC_ONLY.test(lldb.win32), `${lldb.win32} (remove the macOS-only command from the win32 branch of lldbDapInstallHint in src/integrations/debugger/client/probes.ts)`)
  check('linux names the distribution packages', /apt install lldb/.test(lldb.linux) && /dnf install lldb/.test(lldb.linux) && !MAC_ONLY.test(lldb.linux), `${lldb.linux} (fix the linux branch of lldbDapInstallHint in src/integrations/debugger/client/probes.ts)`)

  const net = { darwin: dap.netcoredbgInstallHint('darwin'), win32: dap.netcoredbgInstallHint('win32'), linux: dap.netcoredbgInstallHint('linux') }
  check('darwin keeps brew for netcoredbg', /brew install netcoredbg/.test(net.darwin), `${net.darwin} (fix netcoredbgInstallHint in src/integrations/debugger/client/probes.ts)`)
  check('win32/linux name the Samsung release archives, no brew', /github\.com\/Samsung\/netcoredbg\/releases/.test(net.win32) && !MAC_ONLY.test(net.win32) && /github\.com\/Samsung\/netcoredbg\/releases/.test(net.linux) && !MAC_ONLY.test(net.linux), `${net.win32} (fix the win32 and linux branches of netcoredbgInstallHint in src/integrations/debugger/client/probes.ts)`)

  const gdb = { darwin: dap.gdbInstallHint('darwin'), win32: dap.gdbInstallHint('win32'), linux: dap.gdbInstallHint('linux') }
  check('every gdb hint names the 14+ floor', [gdb.darwin, gdb.win32, gdb.linux].every(h => /gdb 14\+/.test(h) && /-i=dap/.test(h)), 'gdbInstallHint in src/integrations/debugger/client/probes.ts must name gdb 14+ and -i=dap on every platform')
  check('win32 gdb hint names the MSYS2 package', /pacman -S mingw-w64-ucrt-x86_64-gdb/.test(gdb.win32), `${gdb.win32} (fix the win32 branch of gdbInstallHint in src/integrations/debugger/client/probes.ts)`)
  check('the owners default to the live platform', dap.lldbDapInstallHint() === dap.lldbDapInstallHint(process.platform) && dap.netcoredbgInstallHint() === dap.netcoredbgInstallHint(process.platform) && dap.gdbInstallHint() === dap.gdbInstallHint(process.platform), 'the platform parameter of lldbDapInstallHint, netcoredbgInstallHint and gdbInstallHint in src/integrations/debugger/client/probes.ts must default to process.platform')
}

section('§2 the consumers ride the owners')
{
  const dormant = dap.dormantBuiltinAdapterHints()
  const dotnet = dormant.find(d => d.key === 'dotnet')
  const gdb = dormant.find(d => d.key === 'gdb')
  check('the live dormant dotnet hint (when dormant here) is the owner text', dotnet === undefined || dotnet.hint === dap.netcoredbgInstallHint(), 'dormantBuiltinAdapterHints in src/integrations/debugger/client/adapters.ts must use netcoredbgInstallHint for the dotnet hint')
  check('the live dormant gdb hint (when dormant here) is the owner text', gdb === undefined || gdb.hint === dap.gdbInstallHint(), 'dormantBuiltinAdapterHints in src/integrations/debugger/client/adapters.ts must use gdbInstallHint for the gdb hint')
}

if (failures > 0) {
  console.error(`\nprove-adapter-hints-platform: ${failures} FAILURE(S)`)
  process.exit(1)
}
console.log('\nprove-adapter-hints-platform: all green')
process.exit(0)
