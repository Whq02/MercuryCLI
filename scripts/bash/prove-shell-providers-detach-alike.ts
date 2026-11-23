#!/usr/bin/env bun
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.MERCURY_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'shell-providers-detach-home-'))
process.env.MERCURY_CREDENTIAL_STORE = 'file'
delete process.env.NODE_ENV

let failures = 0
const check = (label: string, ok: boolean, detail = ''): void => {
  if (!ok) failures++
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${!ok && detail ? ` — ${detail}` : ''}`)
}



console.log('[2] the live providers answer the same value on this platform')
{
  const { createPowerShellProvider } = await import('../../src/platform/shell/powershellProvider.ts')
  const { getPlatform } = await import('../../src/platform/environment/platform.ts')
  const powershell = createPowerShellProvider('pwsh')
  const expected = getPlatform() !== 'windows'
  check(`the PowerShell provider's detached is ${expected} here (${getPlatform()})`, powershell.detached === expected, `${String(powershell.detached)} — the provider's detached field is set by childGetsOwnProcessGroup in src/platform/shell/powershellProvider.ts; it must be true off Windows and false on Windows, like the other shell providers`)
}


console.log(failures === 0 ? '\nGREEN' : `\nRED (${failures})`)
process.exit(failures === 0 ? 0 : 1)
