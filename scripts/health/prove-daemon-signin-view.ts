#!/usr/bin/env bun
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { execFileSync, spawn, type ChildProcess } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const REPO = join(import.meta.dir, '..', '..')
const BIN = join(REPO, 'dist', 'mercury.mjs')
if (!existsSync(BIN)) {
  console.error('✗ dist/mercury.mjs missing — run `bun run build.ts` first')
  process.exit(1)
}

const SCRATCH = mkdtempSync(join(tmpdir(), 'daemon-signin-view-'))
const home = join(SCRATCH, 'home')
const daemonDir = join(SCRATCH, 'daemon')
const work = join(SCRATCH, 'work')
for (const d of [home, daemonDir, work]) mkdirSync(d, { recursive: true })
process.env.MERCURY_CONFIG_DIR = home
process.env.MERCURY_DAEMON_DIR = daemonDir
process.env.MERCURY_CREDENTIAL_STORE = 'file'
for (const k of [
  'MERCURY_HOME',
  'CI',
  'NODE_ENV',
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'ANTHROPIC_BASE_URL',
  'MERCURY_OAUTH_TOKEN',
  'MERCURY_OAUTH_TOKEN_FILE_DESCRIPTOR',
  'MERCURY_API_KEY_FILE_DESCRIPTOR',
  'MERCURY_DISABLE_NONESSENTIAL_TRAFFIC',
  'MERCURY_DAEMON_NO_SELF_WARM',
  'OPENAI_API_KEY',
  'MERCURY_OPENAI_API_BASE',
  'ZAI_API_KEY',
  'OPENROUTER_API_KEY',
  'GEMINI_API_KEY',
  'GOOGLE_API_KEY',
  'HF_TOKEN',
  'HUGGINGFACE_API_KEY',
  'MOONSHOT_API_KEY',
  'DEEPSEEK_API_KEY',
  'MERCURY_COMPAT_BASE_URL',
  'MERCURY_COMPAT_API_KEY',
  'MERCURY_LOCAL_BASE_URL',
]) {
  delete process.env[k]
}

const { seedFirstRun } = await import('../lib/firstRunSeed.ts')
seedFirstRun(home, [work])
const { daemonControlRpc } = await import('../../src/daemon/controlSocket.ts')
const auth = await import('../../src/utils/auth.ts')
const { recordSignIn } = await import('../../src/utils/accounts/signInLedger.ts')

let failures = 0
const check = (name: string, cond: boolean, detail = ''): void => {
  if (!cond) failures++
  console.log(`  ${cond ? '✅' : '❌'} ${name}${!cond && detail ? ` — ${detail}` : ''}`)
}
const section = (t: string): void => console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
const wait = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms))
async function untilAsync(cond: () => Promise<boolean> | boolean, ms = 60_000): Promise<boolean> {
  const deadline = Date.now() + ms
  for (;;) {
    if (await cond()) return true
    if (Date.now() > deadline) return false
    await wait(250)
  }
}
const guard = setTimeout(() => {
  console.log('\n❌ TIMEOUT — daemon-signin-view exceeded 240s')
  process.exit(1)
}, 240_000)
guard.unref?.()

type Check = { id: string; status: string; evidence?: unknown; fix?: unknown; link?: unknown }
type Cert = { verdict?: string; sections?: Array<{ id: string; checks: Check[] }>; checks?: Check[] }
function runDoctor(env: Record<string, string | undefined>, extraArgs: string[] = []): { status: number; cert: Cert | null } {
  let stdout = ''
  let status = 0
  try {
    stdout = execFileSync('node', [BIN, 'doctor', '--json', ...extraArgs], {
      cwd: work,
      env: { ...process.env, ...env },
      encoding: 'utf8',
      timeout: 60_000,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
  } catch (e: unknown) {
    const err = e as { status?: number; stdout?: string }
    status = err.status ?? -1
    stdout = err.stdout ?? ''
  }
  try {
    return { status, cert: JSON.parse(stdout) as Cert }
  } catch {
    return { status, cert: null }
  }
}
const rowOf = (cert: Cert | null): Check | undefined => {
  if (cert === null) return undefined
  const all = [...(cert.checks ?? []), ...(cert.sections ?? []).flatMap(s => s.checks)]
  return all.find(c => c.id === 'daemon-sign-ins')
}
const words = (c: Check | undefined): string => (c === undefined ? '(row absent)' : `${c.status} · ${String(c.evidence)} · fix: ${String(c.fix ?? '')}`)

const DAEMON_ONLY_ENV = { OPENAI_API_KEY: 'fixture-openai-key', MERCURY_OPENAI_API_BASE: 'http://127.0.0.1:9/v1' }
const logPath = join(SCRATCH, 'daemon.log')
let daemon: ChildProcess | null = null
let daemonExit: Promise<void> = Promise.resolve()
function bootDaemon(): void {
  const logFd = openSync(logPath, 'a')
  daemon = spawn(process.execPath.includes('bun') ? 'node' : process.execPath, [BIN, 'daemon', 'run', work], {
    cwd: work,
    env: { ...process.env, ...DAEMON_ONLY_ENV, MERCURY_DAEMON_NO_SELF_WARM: '1' },
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
    }
  }
  daemon = null
}

console.log('doctor: the daemon sign-in view — present · green on agreement · red with both lists on a gap')
try {
  const saved = auth.saveOAuthTokensIfNeeded({
    accessToken: 'fixture-access-token',
    refreshToken: 'fixture-refresh-token',
    expiresAt: Date.now() + 3_600_000,
    scopes: ['user:inference', 'user:profile'],
    subscriptionType: 'max',
    rateLimitTier: 'default_claude_max_20x',
  })
  if (!saved.success) throw new Error(`the credential store refused the sign-in: ${saved.warning ?? '?'}`)
  recordSignIn('anthropic', 'oauth')

  section('§1 the row is in the full record, and reads OFF without a daemon')
  {
    const r = runDoctor({})
    const row = rowOf(r.cert)
    check('the full doctor record carries the daemon-sign-ins row', row !== undefined, `status=${r.status}`)
    check('with no daemon the row reads off (nothing to compare with)', row?.status === 'off', words(row))
    check('the row links the daemon surface', row?.link === '/daemon', words(row))
  }

  bootDaemon()
  check('the supervisor answers ping', await untilAsync(async () => (await daemonControlRpc({ op: 'ping' })).ok, 60_000))

  section('§2 agreement is green: the same estate on both sides')
  {
    const r = runDoctor(DAEMON_ONLY_ENV, ['--only', 'daemon-sign-ins'])
    const row = rowOf(r.cert)
    check('the narrowed record carries the row', row !== undefined, `status=${r.status}`)
    check('the row is ok', row?.status === 'ok', words(row))
    check('the evidence says the two agree and names the shared Anthropic sign-in', /agree/.test(String(row?.evidence)) && /anthropic: usable/.test(String(row?.evidence)), words(row))
    check('the evidence names the home and the store the daemon read', String(row?.evidence).includes(home) && /plaintext/.test(String(row?.evidence)), words(row))
    console.log(`  ${words(row)}`)
  }

  section('§3 a gap is red with both lists, and the restart is the way out')
  {
    const r = runDoctor({ OPENAI_API_KEY: undefined, MERCURY_OPENAI_API_BASE: undefined }, ['--only', 'daemon-sign-ins'])
    const row = rowOf(r.cert)
    check('the row is fail', row?.status === 'fail', words(row))
    check('the evidence names the family that differs, with both readings', /openai: client no credential vs daemon signed in/.test(String(row?.evidence)), words(row))
    check('the evidence carries BOTH lists', /daemon: \[/.test(String(row?.evidence)) && /client: \[/.test(String(row?.evidence)), words(row))
    check('the fix says restart the daemon, through the daemon verb\'s restart form', /restart the daemon/.test(String(row?.fix)) && /daemon restart/.test(String(row?.fix)), words(row))
    check('a fail row faults the narrowed record (exit 3)', r.status === 3, `status=${r.status}`)
    console.log(`  ${words(row)}`)
  }

  section('§4 the source: an older daemon reads warn with the restart words')
  {
    const health = readFileSync(join(REPO, 'src', 'utils', 'healthReport.ts'), 'utf8')
    const row = health.slice(health.indexOf("id: 'daemon-sign-ins'"), health.indexOf("id: 'daemon',"))
    check('the row exists once, ahead of the scheduler-daemon row', row.length > 0 && health.split("id: 'daemon-sign-ins'").length === 2)
    check('an unanswered verb reads warn and names the restart', /status: 'warn'/.test(row) && /did not answer signIns/.test(row) && /const restart = restartDaemonWords\(binaryName\(\)\)/.test(row))
    check('the comparison is the one owner\'s (compareSignInViews), never a hand table', row.includes('compareSignInViews(mine, reply.view)') && row.includes('composeSignInView()'))
    check('the fail arm carries both lists and the restart', /status: 'fail'/.test(row) && /daemon: \[/.test(row) && /client: \[/.test(row) && /fix: `\$\{restart\}/.test(row))
  }
} catch (error) {
  failures++
  console.log(`  ❌ the drive threw — ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`)
} finally {
  await stopDaemon()
}

console.log('\n' + '═'.repeat(76))
if (failures === 0) {
  console.log('✅ ALL DAEMON SIGN-IN-VIEW DOCTOR PROOFS PASS')
  rmSync(SCRATCH, { recursive: true, force: true })
} else {
  console.log(`❌ ${failures} DAEMON SIGN-IN-VIEW DOCTOR PROOF(S) FAILED — scratch kept at ${SCRATCH}`)
  try {
    console.log(readFileSync(logPath, 'utf8').trim().split('\n').slice(-20).join('\n'))
  } catch {
  }
}
console.log('═'.repeat(76))
clearTimeout(guard)
process.exit(failures === 0 ? 0 : 1)
