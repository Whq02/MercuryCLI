#!/usr/bin/env bun
import { join } from 'node:path'

let failures = 0
const snapshotFailHint = ' · change isPosixSnapshotShell, resolveSnapshotPathValue or deriveVersionedPathParts in src/platform/shell/bash/shellSnapshot.ts'
const check = (label: string, cond: boolean, detail = ''): void => {
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ' — ' + detail : ''}${cond ? '' : snapshotFailHint}`)
  if (!cond) failures++
}

const { isPosixSnapshotShell, resolveSnapshotPathValue } = await import(
  '../../src/platform/shell/bash/shellSnapshot.ts'
)

console.log('— §1 snapshot PATH truth —')

check('bash/zsh/sh/dash are POSIX snapshot shells (exe tolerated)',
  isPosixSnapshotShell('/bin/bash') &&
    isPosixSnapshotShell('C:\\Program Files\\Git\\bin\\bash.exe') &&
    isPosixSnapshotShell('/usr/bin/zsh') &&
    isPosixSnapshotShell('/bin/dash'))
check('powershell/cmd are NOT (the "sh" substring trap)',
  !isPosixSnapshotShell('C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe') &&
    !isPosixSnapshotShell('pwsh.exe') &&
    !isPosixSnapshotShell('C:\\Windows\\System32\\cmd.exe'))

{
  let called = 0
  const val = await resolveSnapshotPathValue('/bin/bash', {
    platform: 'macos',
    exec: async () => {
      called++
      return { exitCode: 0, stdout: '/probe/should/not/run' }
    },
  })
  check('non-windows: process PATH without probing', val === (process.env.PATH ?? '') && called === 0)
}

{
  const val = await resolveSnapshotPathValue('C:\\Git\\bin\\bash.exe', {
    platform: 'windows',
    exec: async (file, args) => {
      check('probe rides the resolved binary with -c (never {shell:true})',
        file === 'C:\\Git\\bin\\bash.exe' && args[0] === '-c' && args[1] === 'echo $PATH')
      return { exitCode: 0, stdout: '/mingw64/bin:/usr/bin:/c/Users/x/bin\n' }
    },
  })
  check('windows + git-bash: the Cygwin PATH wins', val === '/mingw64/bin:/usr/bin:/c/Users/x/bin')
}

{
  const val = await resolveSnapshotPathValue('C:\\Git\\bin\\bash.exe', {
    platform: 'windows',
    exec: async () => ({ exitCode: 0, stdout: '$PATH\n' }),
  })
  check('the unexpanded literal can never win (falls back to the real PATH)',
    val === (process.env.PATH ?? ''))
}

{
  let called = 0
  const val = await resolveSnapshotPathValue('C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe', {
    platform: 'windows',
    exec: async () => {
      called++
      return { exitCode: 0, stdout: '/x' }
    },
  })
  check('windows + powershell: never probed, real PATH', called === 0 && val === (process.env.PATH ?? ''))
}

{
  const throws = await resolveSnapshotPathValue('bash', {
    platform: 'windows',
    exec: async () => {
      throw new Error('spawn ENOENT')
    },
  })
  const nonzero = await resolveSnapshotPathValue('bash', {
    platform: 'windows',
    exec: async () => ({ exitCode: 1, stdout: '/mingw64/bin' }),
  })
  const empty = await resolveSnapshotPathValue('bash', {
    platform: 'windows',
    exec: async () => ({ exitCode: 0, stdout: '   ' }),
  })
  const flat = await resolveSnapshotPathValue('bash', {
    platform: 'windows',
    exec: async () => ({ exitCode: 0, stdout: 'not-a-path-list' }),
  })
  const fb = process.env.PATH ?? ''
  check('failed/nonzero/empty/implausible probes fall back to the real PATH',
    throws === fb && nonzero === fb && empty === fb && flat === fb)
}

{
  const { locateGitBash } = await import('../../src/platform/files/windowsPaths.ts')
  const located = process.platform === 'win32' ? locateGitBash() : null
  const realBash = located !== null && 'path' in located ? located.path : '/bin/bash'
  const val = await resolveSnapshotPathValue(realBash, { platform: 'windows' })
  check('live probe against real /bin/bash returns a plausible PATH',
    val.includes('/') && val !== '$PATH' && val.length > 0)
}

{
  const { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const root = mkdtempSync(join(tmpdir(), 'snapshot-probe-bound-'))
  const fixtureShell = (name: string, body: string): string => {
    const dir = join(root, name)
    mkdirSync(dir)
    const shell = join(dir, 'bash')
    writeFileSync(shell, `#!/bin/sh\n${body}\n`)
    chmodSync(shell, 0o755)
    return shell
  }
  const neverExits = fixtureShell('never-exits', 'exec sleep 20')
  const pipeHolder = fixtureShell('pipe-holder', 'sleep 20 &\nexit 0')
  const fb = process.env.PATH ?? ''
  const OUTER_BOUND_MS = 4_000
  const bounded = async (shell: string): Promise<{ value?: string; elapsedMs: number; wedged: boolean }> => {
    const started = Date.now()
    let timer: ReturnType<typeof setTimeout> | null = null
    const outer = new Promise<{ wedged: true }>(resolve => {
      timer = setTimeout(() => resolve({ wedged: true }), OUTER_BOUND_MS)
    })
    const probe = resolveSnapshotPathValue(shell, { platform: 'windows', probeTimeoutMs: 600 }).then(
      value => ({ value, wedged: false as const }),
    )
    const outcome = await Promise.race([probe, outer])
    if (timer !== null) clearTimeout(timer)
    return { ...outcome, elapsedMs: Date.now() - started }
  }
  try {
    const direct = await bounded(neverExits)
    check('(a) a probe child that never exits falls back to the process PATH inside the bound',
      !direct.wedged && direct.value === fb && direct.elapsedMs < OUTER_BOUND_MS,
      direct.wedged ? `still pending after ${OUTER_BOUND_MS}ms` : `${direct.elapsedMs}ms`)
    const held = await bounded(pipeHolder)
    check('(b) a grandchild holding the stdout pipe past the kill cannot withhold the answer',
      !held.wedged && held.value === fb && held.elapsedMs < OUTER_BOUND_MS,
      held.wedged ? `still pending after ${OUTER_BOUND_MS}ms` : `${held.elapsedMs}ms`)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}


console.log('— §3 resilient rg function —')
{
  const { deriveVersionedPathParts } = await import('../../src/platform/shell/bash/shellSnapshot.ts')
  const managed = deriveVersionedPathParts('/opt/mercury/versions/1.0.0-beta.1/vendor/ripgrep/arm64-darwin/rg')
  check('managed layout splits on versions/<v>/',
    managed !== null &&
      managed.versionsRoot === '/opt/mercury/versions' &&
      managed.version === '1.0.0-beta.1' &&
      managed.suffix === '/vendor/ripgrep/arm64-darwin/rg')
  const winManaged = deriveVersionedPathParts('C:\\Users\\o\\AppData\\Local\\Mercury\\versions\\1.0.0-beta.2\\vendor\\ripgrep\\x64-win32\\rg.exe')
  check('windows managed layout splits too',
    winManaged !== null && winManaged.version === '1.0.0-beta.2' && winManaged.suffix.endsWith('rg.exe'))
  check('non-managed paths return null (repo checkouts stay plain)',
    deriveVersionedPathParts('/Users/dev/repo/vendor/ripgrep/arm64-darwin/rg') === null)

}

if (failures > 0) {
  console.error(`\nprove-shell-snapshot-path: ${failures} FAILURE(S)`)
  process.exit(1)
}
console.log('\nprove-shell-snapshot-path: all green')
