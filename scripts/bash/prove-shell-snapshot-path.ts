#!/usr/bin/env bun
// ============================================================================
// prove-shell-snapshot-path — the shell snapshot's baked PATH is real
// on every platform, and win32 suspend routing stays platform-gated.
//
//   §1 The Windows Cygwin-PATH probe rides the RESOLVED snapshot shell
//      (`<binShell> -c 'echo $PATH'`), never {shell:true}: under cmd.exe
//      `echo $PATH` prints the LITERAL `$PATH` with exit 0, so the earlier
//      snapshot baked a one-token broken PATH. The literal can never win;
//      non-POSIX shells (incl. powershell — its name contains "sh") never
//      get probed; probe failures fall back to the real process PATH.
//   §2 UI-074 (already-correct, pinned): win32 ctrl+z never reaches a
//      self-stop route — SUPPORTS_SUSPEND gates the ONLY suspend dispatch and
//      the ONLY self-stop call site (SIGTSTP, raised into the terminal
//      host's stop owner) lives in the suspend handler. The SIGCONT/SIGPIPE
//      registrations elsewhere are functional POSIX handlers, inert-but-
//      harmless on win32 (census: intentional); the stop-signal listeners
//      themselves are platform-gated at their owner.
// ============================================================================
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

let failures = 0
const check = (label: string, cond: boolean, detail = ''): void => {
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ' — ' + detail : ''}`)
  if (!cond) failures++
}

const { isPosixSnapshotShell, resolveSnapshotPathValue } = await import(
  '../../src/utils/bash/ShellSnapshot.ts'
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

// Non-windows platform: the process PATH, no probe at all.
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

// Windows + POSIX shell: the shell's own answer wins.
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

// The cmd.exe literal: exit 0 + '$PATH' — REFUSED.
{
  const val = await resolveSnapshotPathValue('C:\\Git\\bin\\bash.exe', {
    platform: 'windows',
    exec: async () => ({ exitCode: 0, stdout: '$PATH\n' }),
  })
  check('the unexpanded literal can never win (falls back to the real PATH)',
    val === (process.env.PATH ?? ''))
}

// Windows + non-POSIX resolved shell: no probe, real PATH.
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

// Probe failure / nonzero / empty / separator-free answers all fall back.
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

// A REAL POSIX probe on this box (the live mechanism, platform forced).
{
  const val = await resolveSnapshotPathValue('/bin/bash', { platform: 'windows' })
  check('live probe against real /bin/bash returns a plausible PATH',
    val.includes('/') && val !== '$PATH' && val.length > 0)
}

// §1b THE PROBE IS BOUNDED (FN-015 rank 4). The probe fires on the first
// Bash call and the memoized shell configuration awaits it, so a child
// that never exits (the System32 bash.exe launcher waiting on a WSL distro,
// a BASH_ENV script blocked on a dead mapped drive) left EVERY Bash call of
// the session pending with no message. Two hang shapes against the DEFAULT
// executor (the live mechanism), each raced against an outer bound so a
// regression reds instead of wedging the suite:
//   (a) the direct child never exits;
//   (b) the direct child exits at once but a grandchild it started keeps
//       the inherited stdout pipe open — execFile's callback rides `close`,
//       which that pipe withholds past the kill, so the timeout alone was
//       not enough; the settle guard answers regardless.
// The fixture shells are named `bash` so the POSIX-shell gate admits them.
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

console.log('— §2 wiring + suspend routing pins —')
const ROOT = join(import.meta.dir, '..', '..')
const src = (p: string) => readFileSync(join(ROOT, p), 'utf8')
const snapshotTs = src('src/utils/bash/ShellSnapshot.ts')
check('no {shell:true} PATH probe remains in ShellSnapshot',
  !/echo \$PATH',\s*\{\s*shell: true/.test(snapshotTs) && !snapshotTs.includes('shell: true'))
check('the snapshot content generator receives the resolved shell',
  snapshotTs.includes('getClaudeCodeSnapshotContent(shellPath)') &&
    snapshotTs.includes('resolveSnapshotPathValue(binShell)'))
const appTsx = src('src/ink/components/App.tsx')
check('UI-074: SUPPORTS_SUSPEND is the platform gate',
  appTsx.includes("const SUPPORTS_SUSPEND = process.platform !== 'win32'"))
check('UI-074: the ONLY ctrl+z suspend dispatch requires the gate',
  /item\.name === 'z' && item\.ctrl && SUPPORTS_SUSPEND/.test(appTsx))
check('UI-074: exactly one self-stop call site (SIGTSTP into the stop owner), inside the suspend handler',
  (appTsx.match(/process\.kill\(process\.pid, 'SIGTSTP'\)/g) || []).length === 1 &&
    !appTsx.includes("'SIGSTOP'"))

// §3: the rg integration re-resolves the CURRENT version at call time —
// The old snapshot baked ONE absolute vendored path as a plain alias; a
// long-running session broke the moment `mercury update` pruned that
// version's dir (the in-process resolver self-heals; baked alias bytes
// cannot). The resilient function tries baked → current.txt-derived →
// system rg → honest 127.
console.log('— §3 resilient rg function —')
{
  const { deriveVersionedPathParts } = await import('../../src/utils/bash/ShellSnapshot.ts')
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

  check('the resilient function exists and tries the baked path first',
    snapshotTs.includes('createResilientRgFunction') && snapshotTs.includes('if [ -x ${quotedPath} ]'))
  check('managed layouts re-resolve through current.txt at CALL time',
    snapshotTs.includes('current.txt') && snapshotTs.includes('__mercury_rg_cur'))
  check('a system rg on PATH is the next fallback',
    snapshotTs.includes('command -v rg >/dev/null 2>&1; then command rg'))
  check('the terminal fallback is an honest one-line 127, never silence',
    snapshotTs.includes('return 127') && snapshotTs.includes('vendored ripgrep unavailable'))
  check('absolute vendored paths now bake the FUNCTION, not a stale alias',
    /includes\('\/'\) && !rgCommand\.rgPath\.includes\('\\\\'\)/.test(snapshotTs) ||
      snapshotTs.includes("rgCommand.rgPath.includes('/')"))
}

if (failures > 0) {
  console.error(`\nprove-shell-snapshot-path: ${failures} FAILURE(S)`)
  process.exit(1)
}
console.log('\nprove-shell-snapshot-path: all green')
