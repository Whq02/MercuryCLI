#!/usr/bin/env bun
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync, chmodSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'

type Ran = { code: number; ms: number; text: string }
type Row = { first: Ran; second: Ran; carried: Ran; wiped: Ran; absence: string | null; snapshots: number; otherShellStarts: number; pathHead: string }

if (process.argv.includes('--row')) {
  ;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
  const home = homedir()
  const { exec, setCwd } = await import('../../src/utils/Shell.ts')
  const snapshot = (await import('../../src/utils/bash/ShellSnapshot.ts')) as { shellSnapshotAbsence?: () => string | null }
  setCwd(home)
  const run = async (command: string): Promise<Ran> => {
    const started = Date.now()
    const handle = await exec(command, new AbortController().signal, 'bash', { timeout: 60_000 })
    const result = await handle.result
    return { code: result.code, ms: Date.now() - started, text: `${result.stdout ?? ''}${result.stderr ?? ''}`.trim() }
  }
  const first = await run('echo "ran: bash=${BASH_VERSION:-no} zsh=${ZSH_VERSION:-no} path-head=${PATH%%:*}"')
  const second = await run('echo second-ran')
  const carried = await run('alias ll 2>/dev/null; myfunc 2>/dev/null; above_guard 2>/dev/null; true')
  const wiped = await run('echo wiped; rm -f "$TMPDIR"/mercury-cwd-*; exit 0')
  const snapshots = join(process.env.MERCURY_CONFIG_DIR ?? '', 'shell-snapshots')
  const marker = join(home, 'other-shell-was-started')
  const row: Row = {
    first,
    second,
    carried,
    wiped,
    absence: snapshot.shellSnapshotAbsence?.() ?? null,
    snapshots: existsSync(snapshots) ? readdirSync(snapshots).length : 0,
    otherShellStarts: existsSync(marker) ? readFileSync(marker, 'utf8').trim().split('\n').length : 0,
    pathHead: (process.env.PATH ?? '').split(':')[0] ?? '',
  }
  console.log(`ROW ${JSON.stringify(row)}`)
  process.exit(0)
}

if (process.argv.includes('--start-up-files')) {
  ;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
  const { checkPathSafetyForAutoEdit } = await import('../../src/utils/permissions/filesystem.ts')
  const home = homedir()
  const asked = Object.fromEntries(['.bash_profile', '.bash_login', '.profile', '.bashrc', 'notes.txt'].map(name => [name, checkPathSafetyForAutoEdit(join(home, name)).safe === false]))
  console.log(`FILES ${JSON.stringify(asked)}`)
  process.exit(0)
}

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}

console.log('============================================================')
console.log(' A bash login file that hands the shell over, exits, reads or waits: every command still runs')
console.log('============================================================')

if (process.platform === 'win32') {
  console.log('  [SKIP] this proof drives the macOS and Linux road; the Windows road has its own proofs')
  process.exit(0)
}

const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'login-file-hands-over-')))
const ZSH = '/bin/zsh'
const realZsh = existsSync(ZSH)

function home(name: string, files: Record<string, string>): string {
  const dir = join(scratch, name)
  mkdirSync(dir)
  for (const [file, text] of Object.entries(files)) writeFileSync(join(dir, file), text)
  return dir
}

const standIn = join(scratch, 'other-shell')
writeFileSync(standIn, '#!/bin/sh\necho started >> "$HOME/other-shell-was-started"\ncat > /dev/null\n')
chmodSync(standIn, 0o755)
const other = realZsh ? ZSH : standIn

const HOMES: Record<string, { dir: string; env?: Record<string, string> }> = {
  'hands-over': {
    dir: home('hands-over', {
      '.bash_profile': `export SHELL=${other}\n[ -z "$ZSH_VERSION" ] && exec "$SHELL" -l\n`,
      '.zshenv': 'echo started >> "$HOME/other-shell-was-started"\n',
    }),
  },
  exits: { dir: home('exits', { '.bash_profile': 'exit 0\n' }) },
  'reads-stdin': { dir: home('reads-stdin', { '.bash_profile': 'read -r answer\necho "got:$answer"\n' }) },
  slow: { dir: home('slow', { '.bash_profile': 'sleep 11\n' }) },
  'ends-unread': {
    dir: home('ends-unread', { '.bashenv': 'case "$BASH_EXECUTION_STRING" in *mercury-cwd-*) exit 0 ;; esac\n' }),
  },
  'login-file-only': { dir: home('login-file-only', { '.bash_profile': 'alias ll="ls -la"\nmyfunc() { echo fn-from-the-login-file; }\n' }) },
  'guarded-bashrc': {
    dir: home('guarded-bashrc', {
      '.profile': 'if [ -n "$BASH_VERSION" ]; then\n  if [ -f "$HOME/.bashrc" ]; then\n    . "$HOME/.bashrc"\n  fi\nfi\n',
      '.bashrc': 'above_guard() { echo fn-above-the-guard; }\ncase $- in\n    *i*) ;;\n      *) return;;\nesac\nalias ll="ls -la"\nmyfunc() { echo fn-below-the-guard; }\n',
    }),
  },
}
HOMES['ends-unread']!.env = { BASH_ENV: join(HOMES['ends-unread']!.dir, '.bashenv') }

function drive(name: string): Promise<{ row: Row | null; said: string }> {
  const { dir, env } = HOMES[name]!
  const childEnv: Record<string, string> = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined || /^(?:BASH_ENV|ENV|MERCURY_SHELL_PREFIX|MERCURY_SHELL_ENGINE|MERCURY_WINDOWS_SHELL_ROAD)$/.test(key)) continue
    childEnv[key] = value
  }
  mkdirSync(join(dir, 'temp'))
  Object.assign(childEnv, { HOME: dir, SHELL: ZSH, MERCURY_CONFIG_DIR: join(dir, 'config-home'), TMPDIR: join(dir, 'temp') }, env ?? {})
  return new Promise(done => {
    const child = spawn(process.execPath, [import.meta.path, '--row', name], { env: childEnv, stdio: ['ignore', 'pipe', 'pipe'] })
    let said = ''
    child.stdout.on('data', chunk => { said += String(chunk) })
    child.stderr.on('data', chunk => { said += String(chunk) })
    child.once('close', () => {
      const line = said.split('\n').find(text => text.startsWith('ROW '))
      done({ row: line === undefined ? null : (JSON.parse(line.slice(4)) as Row), said: said.slice(-400) })
    })
  })
}

const FAST_MS = 8_000
const BOUND_MS = 10_000

try {
  const names = Object.keys(HOMES)
  const answers = await Promise.all(names.map(drive))
  const of = (name: string): { row: Row | null; said: string } => answers[names.indexOf(name)]!
  const ranInBash = (ran: Ran | undefined): boolean => ran !== undefined && ran.code === 0 && /ran: bash=\d/.test(ran.text) && ran.text.includes('zsh=no')
  const told = (name: string): string => JSON.stringify(of(name).row ?? of(name).said).slice(0, 700)

  for (const name of ['hands-over', 'exits', 'reads-stdin', 'slow']) {
    const row = of(name).row
    check(`${name}: the first command runs in bash and prints`, ranInBash(row?.first), told(name))
    check(`${name}: the second command runs at once`, row?.second.code === 0 && row.second.text === 'second-ran' && row.second.ms < FAST_MS, told(name))
    check(`${name}: no command reads the login file — PATH is the launcher's, first folder first, and nothing the file prints is in the output`, row !== null && row.first.text.includes(`path-head=${row.pathHead}`) && !row.first.text.includes('got:') && !row.second.text.includes('got:'), told(name))
  }

  const handsOver = of('hands-over').row
  check('hands-over: the first command does not wait for the other shell', handsOver !== null && handsOver.first.ms < FAST_MS, told('hands-over'))
  check(
    `hands-over: the user's own file started ${realZsh ? 'zsh' : 'the other shell'} once, in the one login run, and no command started it again`,
    handsOver !== null && handsOver.otherShellStarts === 1,
    told('hands-over'),
  )
  check('hands-over: no snapshot stands, and the record of why says the login run ended before it wrote one', handsOver !== null && handsOver.snapshots === 0 && /ended before it wrote the snapshot/.test(handsOver.absence ?? ''), told('hands-over'))

  const exits = of('exits').row
  check('exits: the first command does not wait', exits !== null && exits.first.ms < FAST_MS, told('exits'))
  check('exits: no snapshot stands, and the record of why says the login run ended before it wrote one', exits !== null && exits.snapshots === 0 && /ended before it wrote the snapshot/.test(exits.absence ?? ''), told('exits'))

  const reads = of('reads-stdin').row
  check('reads-stdin: the login run finds its standard input closed, so the first command does not wait', reads !== null && reads.first.ms < FAST_MS, told('reads-stdin'))
  check('reads-stdin: the snapshot is taken', reads !== null && reads.snapshots === 1 && reads.absence === null, told('reads-stdin'))

  const slow = of('slow').row
  check(
    `slow: the login run is ended at its bound of ${BOUND_MS / 1000} s, so the first command waits that long once and no longer`,
    slow !== null && slow.first.ms >= BOUND_MS - 1_000 && slow.first.ms < BOUND_MS + FAST_MS,
    told('slow'),
  )
  check('slow: no snapshot stands, and the record of why says the login run was killed at the bound', slow !== null && slow.snapshots === 0 && /did not end within 10 s and was killed/.test(slow.absence ?? ''), told('slow'))

  const loginOnly = of('login-file-only').row
  check(
    'login-file-only: what ~/.bash_profile defines is carried to a command though no ~/.bashrc exists — its alias and its function',
    loginOnly !== null && loginOnly.carried.text.includes("alias ll='ls -la'") && loginOnly.carried.text.includes('fn-from-the-login-file') && loginOnly.snapshots === 1,
    told('login-file-only'),
  )
  const guarded = of('guarded-bashrc').row
  check(
    'guarded-bashrc: a ~/.bashrc that returns for a shell that is not interactive carries what stands above that line and nothing below it',
    guarded !== null && guarded.carried.text.includes('fn-above-the-guard') && !guarded.carried.text.includes('fn-below-the-guard') && !guarded.carried.text.includes('alias ll'),
    told('guarded-bashrc'),
  )

  check(
    'a command that removes the file its directory is written to and ends the shell itself is still a command that ran: exit 0 and its output, with no word about an unread command',
    loginOnly !== null && loginOnly.wiped.code === 0 && loginOnly.wiped.text === 'wiped',
    JSON.stringify(loginOnly?.wiped),
  )

  const filesHome = home('start-up-files', {})
  const files = await new Promise<Record<string, boolean> | null>(done => {
    const child = spawn(process.execPath, [import.meta.path, '--start-up-files'], { env: { ...process.env, HOME: filesHome, MERCURY_CONFIG_DIR: join(filesHome, 'config-home') }, stdio: ['ignore', 'pipe', 'pipe'] })
    let said = ''
    child.stdout.on('data', chunk => { said += String(chunk) })
    child.once('close', () => {
      const line = said.split('\n').find(text => text.startsWith('FILES '))
      done(line === undefined ? null : (JSON.parse(line.slice(6)) as Record<string, boolean>))
    })
  })
  check(
    'a write to any file bash reads at login is asked about: ~/.bash_profile, ~/.bash_login and ~/.profile, and ~/.bashrc with them; a plain file in the same folder is not',
    files !== null && files['.bash_profile'] === true && files['.bash_login'] === true && files['.profile'] === true && files['.bashrc'] === true && files['notes.txt'] === false,
    JSON.stringify(files),
  )

  const unread = of('ends-unread').row
  check(
    'ends-unread: a shell that ends before it reads the command is not an exit 0 with nothing — the result is an error that says so',
    unread !== null && unread.first.code !== 0 && /ended before it read this command/.test(unread.first.text) && !unread.first.text.includes('ran:') && unread.second.code !== 0 && /ended before it read this command/.test(unread.second.text),
    told('ends-unread'),
  )
} finally {
  rmSync(scratch, { recursive: true, force: true })
}

console.log(failures === 0 ? '\nprove-login-file-hands-over: ALL LAWS HOLD' : `\nprove-login-file-hands-over: ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
