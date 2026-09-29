#!/usr/bin/env bun
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, openSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { FIRST_NOTE, SEAT_MODEL, SEAT_NAME, SEAT_REPLY_PREFIX, SECOND_NOTE, THIRD_NOTE } from './crew-seat-fixture-words.ts'

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
  console.log('prove-crew-seat-resume: the drive holds the daemon on a POSIX owner pipe — nothing to drive on win32')
  process.exit(0)
}

const SCRATCH = mkdtempSync(join(tmpdir(), 'crewseat-resume-'))
const home = join(SCRATCH, 'home')
const daemonDir = join(SCRATCH, 'daemon')
const work = join(SCRATCH, 'work')
for (const d of [home, daemonDir, work]) mkdirSync(d, { recursive: true })
writeFileSync(join(work, 'README.md'), '# crew seat fixture\n')
process.env.MERCURY_CONFIG_DIR = home
process.env.MERCURY_DAEMON_DIR = daemonDir
process.env.MERCURY_CREDENTIAL_STORE = 'file'
process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'
delete process.env.MERCURY_HOME
delete process.env.MERCURY_CREWS_DIR
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
const { sendLiveMessage } = await import('../../src/services/crew/liveComms.ts')
const paths = await import('../../src/utils/sessionStorage/paths.ts')
const crewSpawnModule = (await import('../../src/daemon/crewSpawn.ts')) as Record<string, unknown>

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
  console.log('\n❌ TIMEOUT — prove-crew-seat-resume exceeded 240s')
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
const alive = (pid: number | undefined): boolean => {
  if (pid === undefined) return false
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
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

type Capture = { kind: string; model?: string; asks?: string[]; replies?: string[]; last?: string; status?: number | string; at: number }
const captureFile = join(SCRATCH, 'wire-captures.jsonl')
writeFileSync(captureFile, '')
const wire = (): Capture[] =>
  readFileSync(captureFile, 'utf8')
    .split('\n')
    .filter(l => l.trim() !== '')
    .map(l => JSON.parse(l) as Capture)
const seatHits = (): Capture[] => wire().filter(c => c.kind === 'anthropic' && c.model === SEAT_MODEL)
const hitCarrying = (text: string): Capture | undefined => seatHits().find(c => (c.asks ?? []).some(a => a.includes(text)) && c.last?.includes(text))
const daemonLogPath = join(SCRATCH, 'daemon.log')
const daemonLog = (): string => (existsSync(daemonLogPath) ? readFileSync(daemonLogPath, 'utf8') : '')
const projectDir = (): string => paths.getProjectDir(work)
const transcriptFiles = (): string[] => (existsSync(projectDir()) ? readdirSync(projectDir()).filter(f => f.endsWith('.jsonl')) : [])
const transcriptsCarrying = (text: string): string[] => transcriptFiles().filter(f => readFileSync(join(projectDir(), f), 'utf8').includes(text))

const fixture = spawn('node', [join(REPO, 'scripts', 'crew', 'crew-seat-fixture-server.ts'), captureFile], { stdio: ['ignore', 'pipe', 'pipe'] })
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

type Job = { short: string; pid?: number; outcome?: string; state?: string; model?: string }
const jobs = async (): Promise<Job[]> => {
  const reply = (await daemonControlRpc({ op: 'list' } as never, { timeoutMs: 3_000 })) as { ok?: boolean; jobs?: Job[] }
  return reply.ok === true ? (reply.jobs ?? []) : []
}
const liveSeat = async (): Promise<Job | undefined> => (await jobs()).find(j => j.short === SEAT_NAME && !j.outcome)
const settledSeat = async (): Promise<Job | undefined> => (await jobs()).find(j => j.short === SEAT_NAME && j.outcome !== undefined)
const spawnSeat = async (): Promise<{ ok?: boolean; pid?: number; error?: string }> =>
  (await daemonControlRpc({ op: 'crewSpawn', name: SEAT_NAME, model: SEAT_MODEL } as never, { timeoutMs: 30_000 })) as { ok?: boolean; pid?: number; error?: string }
const killSeat = async (): Promise<{ ok?: boolean; error?: string }> => (await daemonControlRpc({ op: 'kill', short: SEAT_NAME } as never, { timeoutMs: 5_000 })) as { ok?: boolean; error?: string }
const message = (text: string): Promise<boolean> => sendLiveMessage('crew', { to: SEAT_NAME, from: 'team-lead', text, timestamp: new Date().toISOString() })

console.log('crew seat resume — a stopped seat keeps its history; r and a message continue it')
console.log(`  home ${home}\n  fixture ${base}`)

try {
  check('the daemon serves', await untilAsync(async () => (await daemonControlRpc({ op: 'ping' })).ok, 60_000))

  section('§1 a crew seat spawns and answers its first message from the fixture')
  const born = await spawnSeat()
  check('the seat spawned', born.ok === true && typeof born.pid === 'number', JSON.stringify(born))
  const pid1 = born.pid
  check('the roster lists the seat live', await untilAsync(async () => (await liveSeat()) !== undefined, 30_000))
  check('the first message was written', await message(FIRST_NOTE))
  check('the seat carried the first message to the wire and was answered', await untilAsync(() => hitCarrying(FIRST_NOTE)?.status === 200, 90_000), JSON.stringify(seatHits().map(c => [c.last?.slice(-60), c.status])))
  check('the reply landed on the seat transcript', await untilAsync(() => transcriptsCarrying(`${SEAT_REPLY_PREFIX}`).length === 1, 30_000), JSON.stringify(transcriptFiles()))
  const transcript1 = transcriptsCarrying(FIRST_NOTE)[0]
  check('one transcript file carries the first turn', transcript1 !== undefined && transcriptsCarrying(FIRST_NOTE).length === 1, JSON.stringify(transcriptsCarrying(FIRST_NOTE)))
  const sessionIdOf = crewSpawnModule.crewSeatSessionId as ((name: string, dir: string) => string) | undefined
  check('the seat runs on its own pinned session id (the transcript file is named by it)', sessionIdOf !== undefined && transcript1 === `${sessionIdOf(SEAT_NAME, work)}.jsonl`, `${transcript1} vs ${sessionIdOf === undefined ? '(no pin owner on this build)' : sessionIdOf(SEAT_NAME, work)}`)

  section('§2 the stop: the seat ends, its roster record reads stopped, its transcript stays')
  const killed = await killSeat()
  check('the stop was accepted', killed.ok === true, JSON.stringify(killed))
  check('the runner is gone', await untilAsync(() => !alive(pid1), 30_000), `pid ${pid1}`)
  check('the roster record reads killed (stopped), never failed', await untilAsync(async () => (await settledSeat())?.outcome === 'killed', 30_000), JSON.stringify(await jobs()))
  check('the transcript survives the stop', transcript1 !== undefined && existsSync(join(projectDir(), transcript1)))

  section('§3 the r road: the seat spawned again under its name continues its transcript')
  const again = await spawnSeat()
  check('the seat came back under the same name (the stop is not a refusal of the name)', again.ok === true && typeof again.pid === 'number', JSON.stringify(again))
  const liveAgain = again.ok === true && (await untilAsync(async () => (await liveSeat()) !== undefined, 30_000))
  check('the roster lists the seat live again, on the same model', liveAgain && (await liveSeat())?.model === SEAT_MODEL, JSON.stringify(await jobs()))
  check('the second message was written', await message(SECOND_NOTE))
  check('the seat carried the second message to the wire', await untilAsync(() => hitCarrying(SECOND_NOTE) !== undefined, liveAgain ? 90_000 : 10_000), JSON.stringify(seatHits().map(c => [c.last?.slice(-60), c.status])))
  const second = hitCarrying(SECOND_NOTE)
  check('the resumed request carries the first message in its history', second !== undefined && (second.asks ?? []).some(a => a.includes(FIRST_NOTE)), JSON.stringify(second?.asks))
  check("the resumed request carries the seat's earlier reply in its history", second !== undefined && (second.replies ?? []).some(r => r.startsWith(SEAT_REPLY_PREFIX)), JSON.stringify(second?.replies))
  check('the continuation lands on the one transcript file', await untilAsync(() => transcriptsCarrying(SECOND_NOTE).length === 1 && transcriptsCarrying(SECOND_NOTE)[0] === transcript1, 30_000), JSON.stringify(transcriptsCarrying(SECOND_NOTE)))
  const pid2 = (await liveSeat())?.pid

  section('§4 the message road: a message to the stopped seat wakes it with the message as its next turn')
  const killedAgain = liveAgain ? await killSeat() : { ok: true }
  check('the second stop was accepted', killedAgain.ok === true, JSON.stringify(killedAgain))
  check('the runner is gone again', await untilAsync(() => !alive(pid2), 30_000), `pid ${pid2}`)
  check('the roster reads stopped again', await untilAsync(async () => (await liveSeat()) === undefined && (await settledSeat())?.outcome === 'killed', 30_000), JSON.stringify(await jobs()))
  const hitsBefore = seatHits().length
  check('the third message was written to the stopped seat', await message(THIRD_NOTE))
  const woke = await untilAsync(async () => (await liveSeat()) !== undefined, 45_000)
  check('the seat came back by itself on the message', woke, JSON.stringify(await jobs()))
  check('the woken seat carried the message to the wire as its next turn', await untilAsync(() => hitCarrying(THIRD_NOTE) !== undefined, woke ? 90_000 : 5_000), JSON.stringify(seatHits().slice(hitsBefore).map(c => [c.last?.slice(-60), c.status])))
  const third = hitCarrying(THIRD_NOTE)
  check('the woken request carries both earlier messages in its history', third !== undefined && (third.asks ?? []).some(a => a.includes(FIRST_NOTE)) && (third.asks ?? []).some(a => a.includes(SECOND_NOTE)), JSON.stringify(third?.asks))
  check('the woken seat runs on the same model', (await liveSeat())?.model === SEAT_MODEL, JSON.stringify(await liveSeat()))
  check('still one transcript file for the seat', await untilAsync(() => transcriptsCarrying(THIRD_NOTE).length === 1 && transcriptsCarrying(THIRD_NOTE)[0] === transcript1, 30_000), JSON.stringify(transcriptFiles()))
  check('the message was delivered exactly once (one request carried it as the last turn)', seatHits().filter(c => c.last?.includes(THIRD_NOTE)).length === 1, JSON.stringify(seatHits().map(c => c.last)))
  const spawnLines = daemonLog().split('\n').filter(l => l.includes('crew teammate spawned: @mate'))
  check('the daemon spawned the seat three times in all: the birth, the r road, the wake', spawnLines.length === 3, `${spawnLines.length} spawn lines`)
  console.log(`      daemon: ${spawnLines.at(-1) ?? '(no spawn line)'}`)

  section('§5 the crew view: r on an offline named row takes the same road (source pin)')
  {
    const view = readFileSync(join(REPO, 'src/components/mercury-ui/screens/CrewView.tsx'), 'utf8')
    check("the crew view's r resumes an offline named seat through the crew spawn road", /input === 'r'[\s\S]{0,400}kind === 'named'[\s\S]{0,400}resumeCrewmate\(/.test(view), 'no named-row branch on the r key')
    check('the footer offers r resume on an offline named row', /offlineNamed \? \['r resume'\]/.test(view) && /!selectedRow\.member\.online/.test(view), 'no r resume for an offline named row')
  }
} finally {
  await cleanup()
}

console.log(`\n${failures === 0 ? '✅' : '❌'} prove-crew-seat-resume: ${failures} failure(s)`)
process.exit(failures === 0 ? 0 : 1)
