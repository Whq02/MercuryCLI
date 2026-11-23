#!/usr/bin/env bun
import { execFileSync } from 'node:child_process'
import { join } from 'node:path'

const ROOT = join(import.meta.dir, '..', '..')
const BUN = process.env.BUN ?? process.execPath

let failures = 0
function check(label: string, cond: boolean, detail = '', hint = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ' — ' + detail : ''}${!cond && hint ? ' — to fix: ' + hint : ''}`)
}

const { FLAG_REGISTRY } = await import('../../src/platform/substrate/flagRegistry.ts')

const gitBash = FLAG_REGISTRY.find(s => s.env === 'MERCURY_GIT_BASH_PATH')
const psTool = FLAG_REGISTRY.find(s => s.env === 'MERCURY_USE_POWERSHELL_TOOL')
check('§A MERCURY_GIT_BASH_PATH registered', gitBash !== undefined, '', 'add an entry with env MERCURY_GIT_BASH_PATH to FLAG_REGISTRY')
check('§A MERCURY_USE_POWERSHELL_TOOL registered', psTool !== undefined, '', 'add an entry with env MERCURY_USE_POWERSHELL_TOOL to FLAG_REGISTRY')

import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
const shimDir = mkdtempSync(join(tmpdir(), 'ctm-r01-shim-'))
writeFileSync(
  join(shimDir, 'dir'),
  '#!/bin/sh\n# fixture `dir`: POSIX stand-in for the cmd.exe builtin\ntest -e "$1"\n',
)
chmodSync(join(shimDir, 'dir'), 0o755)

function resolveBashWith(env: Record<string, string | undefined>): string {
  const script = `
    ;(globalThis as any).MACRO = { VERSION: '1.0.0' }
    const { findGitBashPath } = await import('${join(ROOT, 'src/platform/files/windowsPaths.ts').replace(/\\/g, '\\\\')}')
    console.log(findGitBashPath())
  `
  return execFileSync(BUN, ['-e', script], {
    encoding: 'utf8',
    env: {
      PATH: `${shimDir}:${process.env.PATH ?? ''}`,
      HOME: process.env.HOME,
      MERCURY_GIT_BASH_PATH: undefined,
      ...env,
    },
  }).trim()
}
check(
  '§B the MERCURY_GIT_BASH_PATH override resolves',
  resolveBashWith({ MERCURY_GIT_BASH_PATH: '/bin/bash' }) === '/bin/bash',
  '',
  'make findGitBashPath in src/platform/files/windowsPaths.ts return the MERCURY_GIT_BASH_PATH value when it names an existing file',
)


const { GIT_BASH_REMEDY } = await import('../../src/platform/files/windowsPaths.ts')
check(
  '§D the message a machine with no bash is given names MERCURY_GIT_BASH_PATH',
  GIT_BASH_REMEDY.includes('MERCURY_GIT_BASH_PATH='),
  '',
  'put the text MERCURY_GIT_BASH_PATH= in GIT_BASH_REMEDY in src/platform/files/windowsPaths.ts',
)

console.log(
  failures === 0 ? '\n ✅ GIT-BASH FLAGS ARE REGISTRY-NATIVE' : `\n ❌ ${failures} FAILED`,
)
process.exit(failures === 0 ? 0 : 1)
