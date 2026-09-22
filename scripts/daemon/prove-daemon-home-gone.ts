#!/usr/bin/env bun
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, openSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { bound, DIST, makeTally, NODE, PROBE_KEY, SCRATCH_ROOT, sleep } from './dupline-world.ts'

const tally = makeTally('prove-daemon-home-gone')
const KEEP = process.argv.includes('--keep')
const scratch = realpathSync(mkdtempSync(join(SCRATCH_ROOT, 'daemon-home-gone-')))
const home = join(scratch, 'home')
const daemonDir = join(home, 'daemon')
const work = join(scratch, 'work')
const logPath = join(scratch, 'daemon.log')
const BOOT_BOUND_MS = 60_000
const EXIT_BOUND_MS = 90_000
console.log(`build under proof: ${DIST}`)
console.log(`world: ${scratch}`)

mkdirSync(daemonDir, { recursive: true })
mkdirSync(work, { recursive: true })
writeFileSync(join(home, '.mercury.json'), JSON.stringify({ hasCompletedOnboarding: true, lastOnboardingVersion: '99.0.0', numStartups: 10, theme: 'dark', customApiKeyResponses: { approved: [PROBE_KEY.slice(-20)], rejected: [] } }))
writeFileSync(join(home, 'settings.json'), '{}')
writeFileSync(join(work, 'README.md'), '# fixture\n')

const env: NodeJS.ProcessEnv = {
  ...process.env,
  MERCURY_CONFIG_DIR: home,
  MERCURY_DAEMON_DIR: daemonDir,
  MERCURY_CREDENTIAL_STORE: 'file',
  MERCURY_DAEMON_PERSIST: '1',
  ANTHROPIC_API_KEY: PROBE_KEY,
  ANTHROPIC_BASE_URL: 'http://127.0.0.1:1',
  MERCURY_LOCAL_PROBE_TARGETS: 'none',
  MERCURY_TERMINAL_TITLE: '0',
  BROWSER: '/usr/bin/true',
}
delete env.NODE_ENV
delete env.MERCURY_DAEMON_OWNER_PID
delete env.MERCURY_DAEMON_OWNER_FD

const logOf = (): string => (existsSync(logPath) ? readFileSync(logPath, 'utf8') : '')
const listing = (): string[] => {
  if (!existsSync(daemonDir)) return []
  const out: string[] = []
  const walk = (dir: string, rel: string): void => {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name)
      const r = rel === '' ? name : `${rel}/${name}`
      try {
        const st = statSync(p)
        if (st.isDirectory()) walk(p, r)
        else out.push(`${r} (${st.size} bytes)`)
      } catch {
        out.push(`${r} (unreadable)`)
      }
    }
  }
  walk(daemonDir, '')
  return out.sort()
}

const logFd = openSync(logPath, 'a')
const daemon = spawn(NODE, [DIST, 'daemon', 'run', work], { cwd: work, env, stdio: ['ignore', logFd, logFd] })
let exitCode: number | null | 'running' = 'running'
const exited = new Promise<number | null>(resolve =>
  daemon.on('exit', code => {
    exitCode = code
    resolve(code)
  }),
)

tally.section('a daemon boots in a scratch world and records its plane')
let booted = false
for (const until = Date.now() + bound(BOOT_BOUND_MS); Date.now() < until; ) {
  if (existsSync(join(daemonDir, 'supervisor.json')) && logOf().includes('control socket up')) {
    booted = true
    break
  }
  if (exitCode !== 'running') break
  await sleep(250)
}
const before = listing()
console.log(`the daemon directory before the removal:\n  ${before.join('\n  ')}`)
tally.check('the daemon booted and wrote its supervisor record', booted, logOf().slice(-600))

tally.section("the daemon directory is removed under the running daemon")
rmSync(daemonDir, { recursive: true, force: true })
const removedAt = Date.now()
tally.check('the daemon directory is gone', !existsSync(daemonDir))
const reappeared: Array<{ atMs: number; files: string[] }> = []
let firstSeen: string[] | null = null
while (Date.now() - removedAt < bound(EXIT_BOUND_MS)) {
  if (existsSync(daemonDir)) {
    const files = listing()
    const key = files.join('|')
    if (firstSeen === null || key !== reappeared[reappeared.length - 1]!.files.join('|')) {
      reappeared.push({ atMs: Date.now() - removedAt, files })
      firstSeen ??= files
    }
  }
  if (exitCode !== 'running') break
  await sleep(250)
}
const settled = await Promise.race([exited, sleep(bound(5_000)).then(() => 'running' as const)])
const exitedInMs = Date.now() - removedAt
const log = logOf()
const goneLines = log.split('\n').filter(line => line.includes('[daemon] home-gone:'))
console.log(
  reappeared.length === 0
    ? 'nothing reappeared at the daemon directory'
    : `the daemon directory reappeared:\n  ${reappeared.map(r => `${r.atMs} ms: ${r.files.length === 0 ? '(empty directory)' : r.files.join(', ')}`).join('\n  ')}`,
)
console.log(settled === 'running' ? `the daemon is still running ${exitedInMs} ms after the removal` : `the daemon exited with ${String(settled)} ${exitedInMs} ms after the removal`)
console.log(goneLines.length > 0 ? `the daemon said:\n  ${goneLines.join('\n  ')}` : 'the daemon said nothing about its directory')

tally.section('nothing is written at the path and the daemon leaves')
tally.check('no file reappears under the removed daemon directory', reappeared.every(r => r.files.length === 0), reappeared.map(r => `${r.atMs} ms: ${r.files.join(', ')}`).join(' | '))
tally.check(`the daemon exits within ${EXIT_BOUND_MS / 1000} s of the removal`, settled !== 'running', `still running after ${exitedInMs} ms`)
tally.check('the daemon exits clean (0)', settled === 0, `exit ${String(settled)}`)
tally.check('the daemon logs one line that names the gone directory and where it noticed', goneLines.length === 1 && goneLines[0]!.includes(daemonDir) && /noticed at/.test(goneLines[0]!), goneLines.join(' | ') || 'no such line')
tally.check('after the exit the daemon directory is still absent', !existsSync(daemonDir), listing().join(', '))

if (settled === 'running') {
  try {
    daemon.kill('SIGTERM')
  } catch {
  }
  await Promise.race([exited, sleep(bound(5_000))])
  if (exitCode === 'running') {
    try {
      daemon.kill('SIGKILL')
    } catch {
    }
  }
}
if (tally.failed() === 0 && !KEEP) rmSync(scratch, { recursive: true, force: true })
else console.log(`\nworld kept: ${scratch} (the daemon log: ${logPath})`)
tally.finish()
