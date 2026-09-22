#!/usr/bin/env bun
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const ROOT = resolve(import.meta.dir, '..', '..')
process.env.MERCURY_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'shell-providers-detach-home-'))
process.env.MERCURY_CREDENTIAL_STORE = 'file'
delete process.env.NODE_ENV

let failures = 0
const check = (label: string, ok: boolean, detail = ''): void => {
  if (!ok) failures++
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${!ok && detail ? ` — ${detail}` : ''}`)
}

const detachedLine = (path: string): string => readFileSync(join(ROOT, path), 'utf8').split('\n').find(l => /^\s*detached:/.test(l))?.trim() ?? ''
const RULE = /^detached:\s*getPlatform\(\)\s*!==\s*'windows',?$/

console.log('[1] both shell providers key the spawn option on the same platform rule')
{
  const bash = detachedLine('src/utils/shell/bashProvider.ts')
  const powershell = detachedLine('src/utils/shell/powershellProvider.ts')
  console.log(`  bash: ${bash}\n  powershell: ${powershell}`)
  check('the POSIX provider detaches on POSIX and never on Windows', RULE.test(bash), bash)
  check('the PowerShell provider carries the same rule, never a bare literal', RULE.test(powershell), powershell)
  check('the two lines read the same', bash.replace(/,$/, '') === powershell.replace(/,$/, ''))
}

console.log('[2] the live providers answer the same value on this platform')
{
  const { createPowerShellProvider } = await import('../../src/utils/shell/powershellProvider.ts')
  const { getPlatform } = await import('../../src/utils/platform.ts')
  const powershell = createPowerShellProvider('pwsh')
  const expected = getPlatform() !== 'windows'
  check(`the PowerShell provider's detached is ${expected} here (${getPlatform()})`, powershell.detached === expected, String(powershell.detached))
}

console.log('[3] the one spawn site hands the provider\'s value to the child, unchanged')
{
  const shell = readFileSync(join(ROOT, 'src/utils/Shell.ts'), 'utf8')
  check('Shell.ts spawns with detached: provider.detached', /detached:\s*provider\.detached/.test(shell))
}

console.log(failures === 0 ? '\nGREEN' : `\nRED (${failures})`)
process.exit(failures === 0 ? 0 : 1)
