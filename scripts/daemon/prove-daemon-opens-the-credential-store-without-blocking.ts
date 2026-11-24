#!/usr/bin/env bun
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { mock } from 'bun:test'

const SCENES = ['warm', 'admission', 'start'] as const
type Scene = (typeof SCENES)[number]
const scene = process.argv.find(arg => arg.startsWith('--scene='))?.slice(8)
if (scene === undefined) {
  let failed = 0
  for (const name of SCENES) {
    const result = spawnSync(process.execPath, [import.meta.filename, `--scene=${name}`], { stdio: 'inherit', env: process.env })
    if (result.status !== 0) failed++
  }
  console.log(failed === 0 ? '\nprove-daemon-opens-the-credential-store-without-blocking: all green' : `\nprove-daemon-opens-the-credential-store-without-blocking: ${failed} scene(s) FAILED`)
  process.exit(failed === 0 ? 0 : 1)
}
const isScene = (name: string): name is Scene => SCENES.some(known => known === name)
if (!isScene(scene)) throw new Error(`no such scene: ${scene}`)

const SCRATCH = mkdtempSync(join(tmpdir(), 'daemon-store-'))
const home = join(SCRATCH, 'home')
const recordsDir = join(SCRATCH, 'daemon')
const workspaceDir = join(SCRATCH, 'work')
for (const dir of [home, recordsDir, workspaceDir]) mkdirSync(dir, { recursive: true })
process.env.MERCURY_CONFIG_DIR = home
delete process.env.MERCURY_HOME
delete process.env.MERCURY_CREDENTIAL_STORE
for (const name of ['MERCURY_WARM_RUNNER_IDLE_RETIRE_MINUTES', 'MERCURY_WARM_RUNNER', 'MERCURY_DAEMON_NO_SELF_WARM']) delete process.env[name]

type Answer = { ok: true; bytes: Buffer }
const calls: Array<{ how: 'blocking' | 'in the background'; way: 'protect' | 'unprotect' }> = []
const turned = (bytes: Buffer): Answer => ({ ok: true, bytes: Buffer.from(bytes).reverse() })
const later = (answer: Answer): Promise<Answer> => new Promise(resolve => setTimeout(() => resolve(answer), 40))
const standIn = {
  scheme: 'dpapi-user',
  protect: (secret: Buffer): Answer => {
    calls.push({ how: 'blocking', way: 'protect' })
    return turned(secret)
  },
  unprotect: (token: Buffer): Answer => {
    calls.push({ how: 'blocking', way: 'unprotect' })
    return turned(token)
  },
  protectAsync: (secret: Buffer): Promise<Answer> => {
    calls.push({ how: 'in the background', way: 'protect' })
    return later(turned(secret))
  },
  unprotectAsync: (token: Buffer): Promise<Answer> => {
    calls.push({ how: 'in the background', way: 'unprotect' })
    return later(turned(token))
  },
}
const realProtector = { ...(await import('../../src/platform/secure-storage/systemProtector.ts')) }
mock.module('../../src/platform/secure-storage/systemProtector.ts', () => ({ ...realProtector, systemProtectorFor: () => standIn, sealsUnder: () => true }))
const realKeychain = { ...(await import('../../src/platform/secure-storage/macOsKeychainHelpers.ts')) }
mock.module('../../src/platform/secure-storage/macOsKeychainHelpers.ts', () => ({ ...realKeychain, keychainReachable: () => false }))

const { createKeyCustody, SEALED_FIELD } = await import('../../src/platform/secure-storage/sealedRecord.ts')
const sealed = createKeyCustody({ ...standIn, protect: turned, unprotect: turned }).seal({ claudeAiOauth: { accessToken: 'proof-token-not-a-real-one', refreshToken: 'proof-refresh-not-a-real-one', expiresAt: Date.now() + 3600_000, scopes: ['user:inference'], subscriptionType: 'max' } })
if (!sealed.ok) throw new Error(`the stand-in store could not be sealed: ${sealed.why}`)
writeFileSync(join(home, '.credentials.json'), JSON.stringify({ [SEALED_FIELD]: sealed.text }), { mode: 0o600 })

const { enableConfigs, saveGlobalConfig } = await import('../../src/platform/config/globalConfig.ts')
enableConfigs()
saveGlobalConfig(c => ({ ...c, switchboardCapacity: { askedAt: Date.now(), allowed: true, recommendedSeats: 8 } }))
const sup = await import('../../src/daemon/concourse-workers/concourseWorkers.ts')
const warm = await import('../../src/daemon/runner-link/warmRunner.ts')
const signIn = await import('../../src/daemon/session-seat/signInView.ts')
const { getSecureStorage } = await import('../../src/platform/secure-storage/index.ts')

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${scene}: ${label}${cond ? '' : ` — ${[detail, 'change: the daemon opens the credential store in the background (signInStoreOpened in src/daemon/session-seat/signInView.ts) as it starts (daemonRun, src/daemon/control/main.ts), and its warm road (ensureWarmRunnerFlight, src/daemon/runner-link/warmRunner.ts) and its admission (src/daemon/concourse-workers/admit.ts) await that before they read a sign-in, so the store’s key is never opened by a blocking call of the system protector'].filter(Boolean).join(' | ')}`}`)
}

const registered: string[] = []
const roster = {
  has: (short: string) => ({ present: registered.includes(short), alive: registered.includes(short), ready: registered.includes(short) }),
  list: () => registered.map(short => ({ short })),
  registerLongLived: (short: string) => {
    registered.push(short)
    return { ok: true, pid: process.pid }
  },
  door: () => undefined,
  kill: () => true,
  patchSeatClaim: () => null,
}
const blocking = (): string[] => calls.filter(call => call.how === 'blocking').map(call => call.way)
const opened = (): number => calls.filter(call => call.way === 'unprotect').length
const heldSignIn = (): boolean => getSecureStorage().read()?.claudeAiOauth !== undefined

console.log(`\n── ${scene}: a daemon whose credential store is sealed under the system protector (on Windows each blocking call is a powershell.exe run to its end with the event loop standing) ──`)
try {
  if (scene === 'warm') {
    const ensured = await warm.ensureWarmRunner({ workspaceDir }, { roster: () => roster, dir: recordsDir })
    check('the warm runner is spawned: the sealed store was opened and held a sign-in', ensured.state === 'warmed' && registered.length === 1 && heldSignIn(), `${JSON.stringify(ensured)}; protector calls ${JSON.stringify(calls)}`)
    check('the store’s key was opened once', opened() === 1, JSON.stringify(calls))
    check('no call of the system protector stood the daemon still', blocking().length === 0, `${blocking().length} blocking call(s): ${blocking().join(', ')}`)
  } else if (scene === 'admission') {
    const admit = sup.makeConcourseAdmitHandler({ roster: () => roster, dir: recordsDir })
    const admitted = await admit({ by: 'operator', workspaceDir })
    check('a session is admitted: the sealed store was opened and held a sign-in', admitted.ok === true && registered.length === 1 && heldSignIn(), `${JSON.stringify(admitted).slice(0, 300)}; protector calls ${JSON.stringify(calls)}`)
    check('the store’s key was opened once', opened() === 1, JSON.stringify(calls))
    check('no call of the system protector stood the daemon still', blocking().length === 0, `${blocking().length} blocking call(s): ${blocking().join(', ')}`)
  } else {
    void signIn.signInStoreOpened()
    const ensured = await warm.ensureWarmRunner({ workspaceDir }, { roster: () => roster, dir: recordsDir })
    check('the store’s key is asked for in the background as the daemon starts, before any road needs a sign-in', calls.length >= 1 && calls[0]!.how === 'in the background' && calls[0]!.way === 'unprotect', JSON.stringify(calls))
    check('the warm road that follows waits for that one answer: the key is opened once, by no blocking call', ensured.state === 'warmed' && heldSignIn() && opened() === 1 && blocking().length === 0, `${JSON.stringify(ensured)}; protector calls ${JSON.stringify(calls)}`)
  }
} finally {
  rmSync(SCRATCH, { recursive: true, force: true })
}
process.exit(failures === 0 ? 0 : 1)
