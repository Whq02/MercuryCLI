#!/usr/bin/env bun
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const REPO = join(import.meta.dir, '..', '..')
const DIST = process.argv[2] ?? join(REPO, 'dist', 'mercury.mjs')
if (!existsSync(DIST)) {
  console.error(`x ${DIST} missing — run \`bun run build.ts\` first, or name a bundle as the first argument`)
  process.exit(1)
}
if (process.platform === 'win32') {
  console.log('prove-warm-consent-boot: the owner-pid self-warm rides a POSIX owner pid — nothing to drive on win32')
  process.exit(0)
}

const SCRATCH = mkdtempSync(join(tmpdir(), 'warm-consent-boot-'))
const home = join(SCRATCH, 'home')
const daemonDir = join(SCRATCH, 'daemon')
const work = join(SCRATCH, 'work')
for (const d of [home, daemonDir, work]) mkdirSync(d, { recursive: true })

process.env.MERCURY_CONFIG_DIR = home
process.env.MERCURY_DAEMON_DIR = daemonDir
process.env.MERCURY_CREDENTIAL_STORE = 'file'
process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'
for (const k of ['MERCURY_HOME', 'CI', 'NODE_ENV', 'MERCURY_WARM_RUNNER', 'MERCURY_DAEMON_NO_SELF_WARM', 'MERCURY_DAEMON_SELF_WARM_CONSENT', 'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'MERCURY_OAUTH_TOKEN']) {
  delete process.env[k]
}

const { seedFirstRun } = await import('../lib/firstRunSeed.ts')
seedFirstRun(home, [work])
writeFileSync(
  join(home, '.credentials.json'),
  JSON.stringify({ claudeAiOauth: { accessToken: 'sk-ant-oat01-fixture', refreshToken: 'sk-ant-ort01-fixture', expiresAt: Date.now() + 3600_000, scopes: ['user:inference'], subscriptionType: 'max' } }),
)
writeFileSync(join(work, 'README.md'), '# warm consent boot fixture\n')

const { daemonControlRpc } = await import('../../src/daemon/controlSocket.ts')
const { enableConfigs, saveGlobalConfig } = await import('../../src/utils/config/globalConfig.ts')
enableConfigs()
saveGlobalConfig(c => ({ ...c, switchboardCapacity: { askedAt: Date.now(), allowed: true, recommendedSeats: 8 } }))

const guard = setTimeout(() => {
  console.log('\nx TIMEOUT — prove-warm-consent-boot exceeded 150s')
  process.exit(1)
}, 150_000)
guard.unref?.()

let failures = 0
const check = (label: string, cond: boolean, detail = ''): void => {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}
const section = (t: string): void => console.log('\n' + '-'.repeat(76) + '\n' + t + '\n' + '-'.repeat(76))
const wait = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms))
async function untilAsync(cond: () => Promise<boolean> | boolean, ms = 60_000): Promise<boolean> {
  const deadline = Date.now() + ms
  for (;;) {
    if (await cond()) return true
    if (Date.now() > deadline) return false
    await wait(200)
  }
}

const logPath = join(daemonDir, 'daemon.log')
const daemonLog = (): string => (existsSync(logPath) ? readFileSync(logPath, 'utf8') : '')
const logLines = (needle: string): string[] => daemonLog().split('\n').filter(l => l.includes(needle))

let daemon: ChildProcess | null = null
let daemonExit: Promise<void> = Promise.resolve()
function bootDaemon(consent: boolean): void {
  const logFd = openSync(logPath, 'a')
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    MERCURY_CONFIG_DIR: home,
    MERCURY_DAEMON_DIR: daemonDir,
    MERCURY_CREDENTIAL_STORE: 'file',
    MERCURY_LOCAL_PROBE_TARGETS: 'none',
    MERCURY_CUSTOM_OAUTH_URL: 'http://127.0.0.1:1',
    MERCURY_UPDATE_NOTICE: '0',
    MERCURY_TURN_RECEIPT: '0',
    MERCURY_VERIFY_EVIDENCE: '0',
    MERCURY_DAEMON_OWNER_PID: String(process.pid),
    ...(consent ? { MERCURY_DAEMON_SELF_WARM_CONSENT: '1' } : {}),
  }
  daemon = spawn(process.execPath.includes('bun') ? 'node' : process.execPath, [DIST, 'daemon', 'run', work], {
    cwd: work,
    env,
    stdio: ['ignore', logFd, logFd],
  })
  const child = daemon
  daemonExit = new Promise<void>(r => child.once('exit', () => r()))
}
async function stopDaemon(): Promise<void> {
  if (daemon === null) return
  await daemonControlRpc({ op: 'shutdown', reapWorkers: true }, { timeoutMs: 5_000 }).catch(() => undefined)
  const gone = await Promise.race([daemonExit.then(() => true), wait(15_000).then(() => false)])
  if (!gone) {
    try {
      daemon.kill('SIGKILL')
    } catch {
      daemon = null
    }
  }
  daemon = null
}

console.log('warm-consent boot — the boot self-warm wears the launch consent, so the arming keeps it (no consent-drift throwaway)')
console.log(`  bundle ${DIST}\n  home ${home}\n  daemon dir ${daemonDir}`)

try {
  section('the owned daemon self-warms at boot wearing the launch consent')
  bootDaemon(true)
  check('the daemon answers ping', await untilAsync(async () => (await daemonControlRpc({ op: 'ping' })).ok, 60_000))
  check('the boot self-warm pre-spawned a runner', await untilAsync(() => logLines('warm runner pre-spawned').length >= 1, 40_000), daemonLog().split('\n').slice(-8).join(' | '))

  section("the screen's own arming carries the same consent: it KEEPS the boot-warmed runner")
  const warmReply = (await daemonControlRpc({ op: 'concourseWarm', workspaceDir: work, bypassConsent: true } as never, { timeoutMs: 15_000 })) as { ok?: boolean; state?: string; detail?: string }
  check("the consented arming answers 'kept' (the fix: no consent-drift retirement, no second spawn)", warmReply.ok === true && warmReply.state === 'kept', JSON.stringify(warmReply))
  await wait(1_000)
  check('no warm runner was retired for consent drift (the throwaway is gone)', logLines('consent drift').length === 0, logLines('warm runner').slice(-6).join(' | '))
  check('exactly ONE warm runner was pre-spawned across the boot (not two)', logLines('warm runner pre-spawned').length === 1, logLines('warm runner pre-spawned').join(' | '))

  section('the first admission CLAIMS the boot-warmed runner')
  const admit = (await daemonControlRpc({ op: 'sessionAdmit', workspaceDir: work, isolation: 'shared', bornBlank: true, bypassConsent: true } as never, { timeoutMs: 30_000 })) as { ok?: boolean; runnerId?: string; error?: string }
  check('the admission is served', admit.ok === true, JSON.stringify(admit))
  check('the admission claimed the warm runner (no cold spawn for the first chat)', await untilAsync(() => logLines('warm claim acked').length >= 1, 20_000), logLines('warm').slice(-8).join(' | '))
} finally {
  clearTimeout(guard)
  await stopDaemon()
  if (failures === 0) rmSync(SCRATCH, { recursive: true, force: true })
  else console.log(`[forensics] world kept: ${SCRATCH}`)
}

console.log(`\n${failures === 0 ? 'OK' : 'FAIL'} prove-warm-consent-boot: ${failures} failure(s)`)
process.exit(failures === 0 ? 0 : 1)
