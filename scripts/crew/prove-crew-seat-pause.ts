#!/usr/bin/env bun
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { FIRST_NOTE, SEAT_MODEL, SEAT_NAME, SEAT_SPEND_ASK } from './crew-seat-fixture-words.ts'

const REPO = join(import.meta.dir, '..', '..')
const argAfter = (flag: string): string | undefined => {
  const at = process.argv.indexOf(flag)
  return at >= 0 ? process.argv[at + 1] : undefined
}
const DIST = argAfter('--dist') ?? join(REPO, 'dist', 'mercury.mjs')
const RECORD = argAfter('--record')
if (!existsSync(DIST)) {
  console.error(`✗ ${DIST} missing — run \`bun run build.ts\` first, or name a bundle with --dist`)
  process.exit(1)
}
if (process.platform === 'win32') {
  console.log('prove-crew-seat-pause: the drive holds the daemon on a POSIX owner pipe — nothing to drive on win32')
  process.exit(0)
}
const RESET_SECONDS = 10
const SPEND_1 = `${SEAT_SPEND_ASK}: the first ask that meets the spent window`
const SPEND_2 = `${SEAT_SPEND_ASK}: the second ask that meets the spent window`
const RESUMED = 'resumed by yourself'

const SCRATCH = mkdtempSync(join(tmpdir(), 'crewseat-pause-'))
const home = join(SCRATCH, 'home')
const daemonDir = join(SCRATCH, 'daemon')
const work = join(SCRATCH, 'work')
for (const d of [home, daemonDir, work]) mkdirSync(d, { recursive: true })
writeFileSync(join(work, 'README.md'), '# crew seat pause fixture\n')
process.env.MERCURY_CONFIG_DIR = home
process.env.MERCURY_DAEMON_DIR = daemonDir
process.env.MERCURY_CREDENTIAL_STORE = 'file'
process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'
delete process.env.MERCURY_HOME
delete process.env.MERCURY_TEAMS_DIR
delete process.env.NODE_ENV
delete process.env.CI
for (const k of [
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'ANTHROPIC_BASE_URL',
  'MERCURY_OAUTH_TOKEN',
  'MERCURY_OAUTH_TOKEN_FILE_DESCRIPTOR',
  'MERCURY_API_KEY_FILE_DESCRIPTOR',
  'OPENAI_API_KEY',
  'ZAI_API_KEY',
  'OPENROUTER_API_KEY',
  'GEMINI_API_KEY',
  'GOOGLE_API_KEY',
  'HF_TOKEN',
  'HUGGINGFACE_API_KEY',
  'MERCURY_CAP_FAILOVER',
  'MERCURY_MOCK_LIMITS',
  'MERCURY_CREW',
  'MERCURY_CREW_AGENT',
  'MERCURY_DAEMON_CREW',
  'MERCURY_DAEMON_PERMISSION_MODE',
  'MERCURY_DAEMON_NO_SELF_WARM',
  'MERCURY_WARM_RUNNER',
]) {
  delete process.env[k]
}

const { seedFirstRun } = await import('../lib/firstRunSeed.ts')
seedFirstRun(home, [work])
const { daemonControlRpc } = await import('../../src/daemon/controlSocket.ts')
const { enableConfigs } = await import('../../src/utils/config/globalConfig.ts')
enableConfigs()
const auth = await import('../../src/utils/auth.ts')
const { recordSignIn } = await import('../../src/utils/accounts/signInLedger.ts')
const { storeOAuthAccountInfo } = await import('../../src/services/oauth/client.ts')
const { writeToMailbox } = await import('../../src/utils/teammateMailbox.ts')

const reapTargets: Array<{ kill: (signal: NodeJS.Signals) => boolean }> = []
const reapNow = (): void => {
  for (const p of reapTargets) {
    try {
      p.kill('SIGKILL')
    } catch {
    }
  }
}
const guard = setTimeout(() => {
  console.log('\n❌ TIMEOUT — prove-crew-seat-pause exceeded 240s')
  reapNow()
  process.exit(1)
}, 240_000)
guard.unref?.()

let failures = 0
const check = (label: string, cond: boolean, detail = ''): void => {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}
const section = (t: string): void => console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
const sleep = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms))
async function untilAsync(cond: () => Promise<boolean> | boolean, ms = 60_000): Promise<boolean> {
  const deadline = Date.now() + ms
  for (;;) {
    try {
      if (await cond()) return true
    } catch {
    }
    if (Date.now() > deadline) return false
    await sleep(150)
  }
}

storeOAuthAccountInfo({ accountUuid: '00000000-0000-4000-8000-00000000cafe', emailAddress: 'sam@example.com' })
const saved = auth.saveOAuthTokensIfNeeded({
  accessToken: 'fixture-access-token',
  refreshToken: 'fixture-refresh-token',
  expiresAt: Date.now() + 3_600_000,
  scopes: ['user:inference', 'user:profile'],
  subscriptionType: 'max',
  rateLimitTier: 'default_claude_max_20x',
})
if (!saved.success) throw new Error(`the credential store refused the sign-in: ${saved.warning ?? '?'}`)
auth.clearOAuthTokenCache()
recordSignIn('anthropic', 'oauth')

type Capture = { kind: string; model?: string; asks?: string[]; replies?: string[]; last?: string; status?: number | string; resetAt?: number; at: number }
const captureFile = join(SCRATCH, 'wire-captures.jsonl')
writeFileSync(captureFile, '')
const wire = (): Capture[] =>
  readFileSync(captureFile, 'utf8')
    .split('\n')
    .filter(l => l.trim() !== '')
    .map(l => JSON.parse(l) as Capture)
const seatHits = (): Capture[] => wire().filter(c => c.kind === 'anthropic' && c.model === SEAT_MODEL)
const hitCarrying = (text: string, from = 0): Capture | undefined => seatHits().slice(from).find(c => c.last?.includes(text))
const daemonLogPath = join(SCRATCH, 'daemon.log')
const daemonLog = (): string => (existsSync(daemonLogPath) ? readFileSync(daemonLogPath, 'utf8') : '')

const fixture = spawn('node', [join(REPO, 'scripts', 'crew', 'crew-seat-fixture-server.ts'), captureFile], {
  stdio: ['ignore', 'pipe', 'pipe'],
  env: { ...process.env, FIXTURE_RESET_SECONDS: String(RESET_SECONDS), FIXTURE_SPEND_TIMES: '2' },
})
reapTargets.push(fixture)
const port = await new Promise<number>((resolve, reject) => {
  const killer = setTimeout(() => reject(new Error('fixture server never printed PORT')), 15_000)
  let buffer = ''
  fixture.stdout.on('data', (chunk: Buffer) => {
    buffer += chunk.toString('utf8')
    const m = /PORT (\d+)/.exec(buffer)
    if (m) {
      clearTimeout(killer)
      resolve(Number(m[1]))
    }
  })
  fixture.stderr.on('data', (chunk: Buffer) => process.stderr.write(`[fixture] ${chunk.toString('utf8')}`))
  fixture.on('exit', code => reject(new Error(`fixture server exited early (${code})`)))
}).catch(err => {
  console.log(`FAIL ${String(err)}`)
  reapNow()
  process.exit(1)
})
const base = `http://127.0.0.1:${port}`

const logFd = openSync(daemonLogPath, 'a')
const daemon: ChildProcess = spawn('node', [DIST, 'daemon', 'run', work], {
  cwd: work,
  env: {
    ...process.env,
    MERCURY_CONFIG_DIR: home,
    MERCURY_DAEMON_DIR: daemonDir,
    MERCURY_CREDENTIAL_STORE: 'file',
    ANTHROPIC_BASE_URL: base,
    MERCURY_CUSTOM_OAUTH_URL: 'http://127.0.0.1:1',
    MERCURY_CACHE_CLOCK: '0',
    MERCURY_PARTY: '0',
    MERCURY_LOCAL_PROBE_TARGETS: 'none',
    MERCURY_TERMINAL_TITLE: '0',
    MERCURY_TURN_RECEIPT: '0',
    MERCURY_VERIFY_EVIDENCE: '0',
    MERCURY_DAEMON_NO_SELF_WARM: '1',
    MERCURY_DAEMON_OWNER_FD: '3',
    MERCURY_DAEMON_OWNER_PID: String(process.pid),
  },
  stdio: ['ignore', logFd, logFd, 'pipe'],
})
reapTargets.push(daemon)
const cleanup = async (): Promise<void> => {
  try {
    await daemonControlRpc({ op: 'shutdown', reapWorkers: true } as never, { timeoutMs: 5_000 })
  } catch {
  }
  await sleep(500)
  for (const p of [daemon, fixture]) {
    try {
      p.kill('SIGTERM')
    } catch {
    }
  }
  if (RECORD !== undefined) {
    mkdirSync(RECORD, { recursive: true })
    writeFileSync(join(RECORD, 'wire-captures.jsonl'), readFileSync(captureFile, 'utf8'))
    writeFileSync(join(RECORD, 'daemon.log'), daemonLog())
  }
  if (failures === 0) rmSync(SCRATCH, { recursive: true, force: true })
  else console.log(`[forensics] world kept: ${SCRATCH}`)
}

type Pause = { why?: string; words?: string; resumesAtMs?: number }
type Job = { short: string; pid?: number; outcome?: string; state?: string; model?: string; paused?: Pause }
const jobs = async (): Promise<Job[]> => {
  const reply = (await daemonControlRpc({ op: 'list' } as never, { timeoutMs: 3_000 })) as { ok?: boolean; jobs?: Job[] }
  return reply.ok === true ? (reply.jobs ?? []) : []
}
const liveSeat = async (): Promise<Job | undefined> => (await jobs()).find(j => j.short === SEAT_NAME && !j.outcome)
const spawnSeat = async (): Promise<{ ok?: boolean; pid?: number; error?: string }> =>
  (await daemonControlRpc({ op: 'crewSpawn', name: SEAT_NAME, model: SEAT_MODEL } as never, { timeoutMs: 30_000 })) as { ok?: boolean; pid?: number; error?: string }
const message = (text: string): Promise<boolean> => writeToMailbox(SEAT_NAME, { from: 'team-lead', text, timestamp: new Date().toISOString() }, 'crew')
const near = (value: number | undefined, target: number, slackMs: number): boolean => typeof value === 'number' && Math.abs(value - target) <= slackMs

console.log('crew seat pause — a usage limit pauses the seat; the reset and a sign-in on another account resume it')
console.log(`  home ${home}\n  fixture ${base}`)

try {
  check('the daemon serves', await untilAsync(async () => (await daemonControlRpc({ op: 'ping' })).ok, 60_000))

  section('§1 a crew seat answers its first message from the fixture')
  const born = await spawnSeat()
  check('the seat spawned', born.ok === true, JSON.stringify(born))
  check('the roster lists the seat live', await untilAsync(async () => (await liveSeat()) !== undefined, 30_000))
  check('the first message was written', await message(FIRST_NOTE))
  check('the seat carried it to the wire and was answered', await untilAsync(() => hitCarrying(FIRST_NOTE)?.status === 200, 90_000), JSON.stringify(seatHits().map(c => [c.last?.slice(-60), c.status])))

  section('§2 THE PIN: the ask that meets the spent window PAUSES the seat — the roster reads paused with the reset, the seat stays alive')
  const pidBefore = (await liveSeat())?.pid
  check('the spend ask was written', await message(SPEND_1))
  const refused = await untilAsync(() => hitCarrying(SPEND_1)?.status === 429, 90_000)
  check('the wire answered 429 with the unified headers and a reset', refused, JSON.stringify(seatHits().map(c => [c.last?.slice(-60), c.status])))
  const resetAt = hitCarrying(SPEND_1)?.resetAt
  const pausedSeen = await untilAsync(async () => (await liveSeat())?.paused !== undefined, 20_000)
  const pausedRow = await liveSeat()
  check('the roster row reads PAUSED on the usage limit (RED on the base: no pause on the row)', pausedSeen && pausedRow?.paused?.why === 'usage limit', JSON.stringify(pausedRow))
  check("the pause carries the provider's reset time", near(pausedRow?.paused?.resumesAtMs, resetAt ?? 0, 2_000), JSON.stringify({ paused: pausedRow?.paused, resetAt }))
  check('the seat is still alive and live on the roster — paused, never failed or killed', pausedRow !== undefined && pausedRow.pid === pidBefore && pausedRow.outcome === undefined, JSON.stringify(pausedRow))

  section('§3 THE PIN: at the reset the seat resumes by itself — the daemon hands it the resume note as its next turn')
  const before3 = seatHits().length
  const resumed = await untilAsync(() => hitCarrying(RESUMED, before3) !== undefined, RESET_SECONDS * 1000 + 30_000)
  const resumedHit = hitCarrying(RESUMED, before3)
  check('a request with the resume note as its next turn landed after the reset (RED on the base: none)', resumed, JSON.stringify(seatHits().slice(before3).map(c => [c.last?.slice(-60), c.status])))
  check('the resume came at the reset, never before it', resumedHit !== undefined && resetAt !== undefined && resumedHit.at >= resetAt - 1_500, JSON.stringify({ at: resumedHit?.at, resetAt }))
  check('its history keeps the first answer and the refused ask', resumedHit !== undefined && (resumedHit.asks ?? []).some(a => a.includes(FIRST_NOTE)) && (resumedHit.asks ?? []).some(a => a.includes(SPEND_1)), JSON.stringify(resumedHit?.asks))
  check('the pause is lifted once the seat runs again', await untilAsync(async () => (await liveSeat())?.paused === undefined, 20_000), JSON.stringify(await liveSeat()))

  section('§4 THE PIN: the operator signs in on another account before the reset — the daemon resumes the paused seat at once')
  check('the second spend ask was written', await message(SPEND_2))
  const refused2 = await untilAsync(() => hitCarrying(SPEND_2)?.status === 429, 90_000)
  check('the wire refused it again', refused2)
  const pausedAgain = await untilAsync(async () => (await liveSeat())?.paused !== undefined, 20_000)
  check('the seat reads paused again', pausedAgain, JSON.stringify(await liveSeat()))
  const before4 = seatHits().length
  const signedIn = (await daemonControlRpc({ op: 'signIns', refresh: true } as never, { timeoutMs: 5_000 })) as { ok?: boolean }
  check('the credential change reached the daemon (the sign-in view refresh)', signedIn.ok === true, JSON.stringify(signedIn))
  const resumedEarly = await untilAsync(() => hitCarrying(RESUMED, before4) !== undefined, 8_000)
  const earlyHit = hitCarrying(RESUMED, before4)
  check('the seat resumed at once on the sign-in, well before the reset (RED on the base: none)', resumedEarly && earlyHit !== undefined && earlyHit.at < (hitCarrying(SPEND_2)?.resetAt ?? 0) - 1_000, JSON.stringify({ at: earlyHit?.at, resetAt: hitCarrying(SPEND_2)?.resetAt }))
  check('the note names the sign-in as the reason', earlyHit !== undefined && (earlyHit.last ?? '').includes('signed in on another account'), earlyHit?.last?.slice(0, 200))
  check('the pause is lifted', await untilAsync(async () => (await liveSeat())?.paused === undefined, 20_000))
  check('the seat kept its model throughout', (await liveSeat())?.model === SEAT_MODEL)
  const pauseLines = daemonLog().split('\n').filter(l => /crew seat @mate paused/.test(l))
  console.log(`      daemon: ${pauseLines.at(-1) ?? '(no pause line)'}`)
} finally {
  await cleanup()
}

console.log(`\n${failures === 0 ? '✅' : '❌'} prove-crew-seat-pause: ${failures} failure(s)`)
process.exit(failures === 0 ? 0 : 1)
