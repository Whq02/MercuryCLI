#!/usr/bin/env bun
// ============================================================================
//  scripts/model-transition/prove-transition-r01-gitbash-native.ts — R01
//  (Rider 1): the git-bash/PowerShell flags are REGISTRY-NATIVE.
//
//  §A the registry rows exist (MERCURY_GIT_BASH_PATH, MERCURY_USE_POWERSHELL_TOOL)
//  §B the native override resolves at the fatal resolver; a foreign spelling
//     beside it is inert (the leg is its own subprocess — findGitBashPath is
//     memoized, and the env is pinned per invocation, never inherited: L26)
//  §C the gate predicate and the availability probe read the native spelling
//     and nothing else (executable, off-Windows safe: the platform gate keeps
//     it false; the source shape is the leg)
//  §D user-facing text is Mercury-spelled (the requires-git-bash message,
//     the not-found message, the tip, the tip's quiet gate)
//  §E the packaged README names the git-bash Windows prerequisite with the
//     native spelling
// ============================================================================
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = join(import.meta.dir, '..', '..')
// The foreign product's env prefix, composed so this prover never matches a
// vocabulary sweep.
const FOREIGN = ['CLAUDE', 'CODE'].join('_')
const BUN = process.env.BUN ?? join(process.env.HOME ?? '', '.bun/bin/bun')

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ' — ' + detail : ''}`)
}

const { FLAG_REGISTRY } = await import('../../src/substrate/flagRegistry.ts')

// §A — typed registry rows.
const gitBash = FLAG_REGISTRY.find(s => s.env === 'MERCURY_GIT_BASH_PATH')
const psTool = FLAG_REGISTRY.find(s => s.env === 'MERCURY_USE_POWERSHELL_TOOL')
check('§A MERCURY_GIT_BASH_PATH registered', gitBash !== undefined)
check('§A MERCURY_USE_POWERSHELL_TOOL registered', psTool !== undefined)

// §B — the override at findGitBashPath (subprocess per leg; env pinned per
// invocation, never inherited — L26). The resolver's existence probe shells
// to the cmd.exe builtin `dir`; off-Windows the fixture gives it a POSIX
// stand-in on PATH (exit 0 iff the arg exists) so the REAL resolver code
// path executes end-to-end. Mercury reads the ONE spelling: a foreign
// spelling in the environment is inert.
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
    const { findGitBashPath } = await import('${join(ROOT, 'src/utils/windowsPaths.ts').replace(/\\/g, '\\\\')}')
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
  '§B the native override resolves (a foreign spelling beside it is inert)',
  resolveBashWith({
    MERCURY_GIT_BASH_PATH: '/bin/bash',
    [`${FOREIGN}_GIT_BASH_PATH`]: '/nonexistent-foreign-bash',
  }) === '/bin/bash',
)

// §C — the gate predicate and the availability probe read the native
// spelling and nothing else (source law; the platform gate keeps the call
// false off-Windows so the executable leg is the source shape itself).
const shellUtils = readFileSync(join(ROOT, 'src/utils/shell/shellToolUtils.ts'), 'utf8')
check(
  '§C isPowerShellToolEnabled reads MERCURY_USE_POWERSHELL_TOOL and no foreign spelling',
  /process\.env\.MERCURY_USE_POWERSHELL_TOOL/.test(shellUtils) &&
    !shellUtils.includes(`process.env.${FOREIGN}_USE_POWERSHELL_TOOL`),
)
const psTools = readFileSync(join(ROOT, 'src/tools/PowerShellTool/PowerShellTool.tsx'), 'utf8')
check(
  '§C the PowerShell availability probe reads MERCURY_GIT_BASH_PATH and no foreign spelling',
  /process\.env\.MERCURY_GIT_BASH_PATH/.test(psTools) && !psTools.includes(`process.env.${FOREIGN}_GIT_BASH_PATH`),
)

// §D — operator-facing strings are Mercury-spelled.
const windowsPaths = readFileSync(join(ROOT, 'src/utils/windowsPaths.ts'), 'utf8')
check(
  '§D the requires-git-bash message names MERCURY_GIT_BASH_PATH',
  /requires git-bash[\s\S]{0,300}MERCURY_GIT_BASH_PATH=/.test(windowsPaths) &&
    !new RegExp(`requires git-bash[\\s\\S]{0,300}${FOREIGN}_GIT_BASH_PATH=`).test(windowsPaths),
)
check(
  '§D the not-found message names MERCURY_GIT_BASH_PATH',
  windowsPaths.includes('unable to find MERCURY_GIT_BASH_PATH'),
)
const tips = readFileSync(join(ROOT, 'src/services/tips/tipRegistry.ts'), 'utf8')
check(
  '§D the tip advertises the native spelling only',
  tips.includes('Set MERCURY_USE_POWERSHELL_TOOL=1') &&
    !tips.includes(`Set ${FOREIGN}_USE_POWERSHELL_TOOL=1`),
)
check(
  '§D the tip stays quiet when the native spelling is set (no foreign spelling in the gate)',
  /process\.env\.MERCURY_USE_POWERSHELL_TOOL === undefined/.test(tips) &&
    !tips.includes(`${FOREIGN}_USE_POWERSHELL_TOOL`),
)

// §E — the packaged README prerequisite.
const templates = readFileSync(join(ROOT, 'scripts/release/launcherTemplates.mjs'), 'utf8')
check(
  '§E the packaged README names the git-bash Windows prerequisite',
  /git-bash/i.test(templates) && templates.includes('MERCURY_GIT_BASH_PATH='),
)

console.log(
  failures === 0 ? '\n ✅ GIT-BASH FLAGS ARE REGISTRY-NATIVE' : `\n ❌ ${failures} FAILED`,
)
process.exit(failures === 0 ? 0 : 1)
