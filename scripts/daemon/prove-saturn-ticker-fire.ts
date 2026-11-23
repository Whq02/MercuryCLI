#!/usr/bin/env bun
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { startFixtureApi } from '../lib/fixtureApi.ts'
import { FIXTURE_API_KEY, seedFirstRun } from '../lib/firstRunSeed.ts'
import { nodeBinPath } from '../lib/nodeBin.ts'
import { removeScratch } from '../lib/removeScratch.ts'

const REPO = resolve(import.meta.dir, '..', '..')
const DIST = process.env.MERCURY_PROOF_DIST ?? (process.argv[2] ? resolve(process.argv[2]) : join(REPO, 'dist', 'mercury.mjs'))
if (!existsSync(DIST)) {
  console.error(`${DIST} missing — run \`bun run build.ts\` first`)
  process.exit(1)
}

const SCRATCH = realpathSync(mkdtempSync(join(tmpdir(), 'saturn-ticker-fire-')))
const home = join(SCRATCH, 'home')
const daemonDir = join(SCRATCH, 'daemon')
const work = join(SCRATCH, 'work')
for (const d of [home, daemonDir, work]) mkdirSync(d, { recursive: true })

process.env.MERCURY_CONFIG_DIR = home
process.env.MERCURY_DAEMON_DIR = daemonDir
process.env.MERCURY_CREDENTIAL_STORE = 'file'
process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'
process.env.ANTHROPIC_API_KEY = FIXTURE_API_KEY
for (const k of [
  'MERCURY_HOME',
  'CI',
  'NODE_ENV',
  'ANTHROPIC_AUTH_TOKEN',
  'ANTHROPIC_BASE_URL',
  'MERCURY_OAUTH_TOKEN',
  'MERCURY_CONCOURSE_WORKER',
  'MERCURY_WARM_RUNNER',
  'MERCURY_MODEL',
  'MERCURY_SATURN_DISABLE',
  'MERCURY_DAEMON_CATCHUP',
  'MERCURY_DAEMON_CATCHUP_MINUTES',
]) {
  delete process.env[k]
}

seedFirstRun(home, [work])

const { daemonControlRpc } = await import('../../src/daemon/control/controlSocket.ts')
const { enableConfigs } = await import('../../src/platform/config/globalConfig.ts')
enableConfigs()
const { getProjectDir } = await import('../../src/sessions/transcripts/paths.ts')

const SCHEDULED_PROMPT = 'SATURN-TICKER-PROMPT-7319: confirm the scheduled fire landed.'
const SCHEDULED_REPLY = 'SATURN-TICKER-REPLY-7319: scheduled fire received.'
const MODEL = 'claude-opus-4-8'

const api = await startFixtureApi([
  { kind: 'text', text: SCHEDULED_REPLY, whenModel: 'opus' },
  { kind: 'text', text: 'Spare.', whenModel: 'opus' },
])
process.env.ANTHROPIC_BASE_URL = api.url

const guard = setTimeout(() => {
  console.log('\nTIMEOUT — prove-saturn-ticker-fire exceeded 120s')
  process.exit(1)
}, 120_000)
guard.unref?.()

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}

const wait = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms))
async function untilAsync(cond: () => Promise<boolean> | boolean, ms = 65_000): Promise<boolean> {
  const deadline = Date.now() + ms
  for (;;) {
    try {
      if (await cond()) return true
    } catch {}
    if (Date.now() > deadline) return false
    await wait(200)
  }
}

type ScheduleRec = {
  id: string
  when?: { kind?: string; atMs?: number }
  action?: { kind?: string; prompt?: string }
  title?: string
}
type WorkerRec = {
  runnerId: string
  sessionId: string
  endedAt?: number
  lastDeliveryAt?: number
  lastTurnSettledAt?: number
  schedules?: ScheduleRec[]
  heldFires?: unknown[]
}

const readWorker = (sid: string): WorkerRec | undefined => {
  try {
    const raw = JSON.parse(readFileSync(join(daemonDir, 'concourse-workers.json'), 'utf8')) as { workers: Record<string, WorkerRec> }
    return Object.values(raw.workers).find(w => w.sessionId === sid && w.endedAt === undefined)
  } catch {
    return undefined
  }
}

const readFacts = (sid: string): { busy?: boolean } | undefined => {
  try {
    return JSON.parse(readFileSync(join(daemonDir, 'session-facts', `${sid}.json`), 'utf8')) as { busy?: boolean }
  } catch {
    return undefined
  }
}

const transcriptText = (sid: string): string => {
  const file = join(getProjectDir(work), `${sid}.jsonl`)
  return existsSync(file) ? readFileSync(file, 'utf8') : ''
}

const logPath = join(SCRATCH, 'daemon.log')
let daemon: ChildProcess | null = null
let daemonExit: Promise<void> = Promise.resolve()

function bootDaemon(): void {
  const logFd = openSync(logPath, 'a')
  daemon = spawn(nodeBinPath(), [DIST, 'daemon', 'run', work], {
    cwd: work,
    env: {
      ...process.env,
      MERCURY_CONFIG_DIR: home,
      MERCURY_DAEMON_DIR: daemonDir,
      MERCURY_CREDENTIAL_STORE: 'file',
      MERCURY_LOCAL_PROBE_TARGETS: 'none',
      MERCURY_WARM_RUNNER: '0',
      MERCURY_CACHE_CLOCK: '0',
      MERCURY_PARTY: '0',
      MERCURY_TERMINAL_TITLE: '0',
      MERCURY_TURN_RECEIPT: '0',
      MERCURY_VERIFY_EVIDENCE: '0',
      ANTHROPIC_API_KEY: FIXTURE_API_KEY,
      ANTHROPIC_BASE_URL: api.url,
    },
    stdio: ['ignore', logFd, logFd],
  })
  const child = daemon
  daemonExit = new Promise<void>(r => child.once('exit', () => r()))
}

async function stopDaemon(): Promise<void> {
  if (daemon === null) return
  await daemonControlRpc({ op: 'shutdown', reapWorkers: true } as never, { timeoutMs: 5_000 }).catch(() => undefined)
  const gone = await Promise.race([daemonExit.then(() => true), wait(10_000).then(() => false)])
  if (!gone) {
    try {
      daemon.kill('SIGKILL')
    } catch {}
  }
  daemon = null
}

try {
  bootDaemon()
  const pingOk = await untilAsync(async () => (await daemonControlRpc({ op: 'ping' })).ok, 30_000)
  check('real daemon boots and answers ping', pingOk)

  const admit = (await daemonControlRpc(
    {
      op: 'sessionAdmit',
      workspaceDir: work,
      isolation: 'shared',
      by: 'operator',
      bornBlank: true,
      model: MODEL,
    } as never,
    { timeoutMs: 30_000 },
  )) as { ok: boolean; sessionId?: string; runnerId?: string; error?: string }
  check('hosted session is admitted on the real daemon', admit.ok === true && typeof admit.sessionId === 'string', JSON.stringify(admit))

  if (admit.ok && admit.sessionId) {
    const sid = admit.sessionId
    const dueAt = Date.now() + 2_000
    const addReply = (await daemonControlRpc(
      {
        op: 'sessionControl',
        action: 'set-schedule',
        sessionId: sid,
        by: 'operator',
        scheduleEdit: {
          op: 'add',
          schedule: {
            when: { kind: 'at', atMs: dueAt, spelling: 'in 2s' },
            action: { kind: 'fire', prompt: SCHEDULED_PROMPT },
            title: 'ticker-fire-proof',
          },
        },
      } as never,
      { timeoutMs: 10_000 },
    )) as { ok?: boolean; outcome?: string; detail?: string }

    const storedSchedule = readWorker(sid)?.schedules?.find(s => s.title === 'ticker-fire-proof')
    const scheduleId = storedSchedule?.id ?? ''
    check(
      'one-shot at schedule two seconds ahead is stored through the control door',
      addReply.ok === true &&
        addReply.outcome === 'applied' &&
        /^[0-9a-f]{8}$/.test(scheduleId) &&
        storedSchedule?.when?.kind === 'at' &&
        storedSchedule?.action?.prompt === SCHEDULED_PROMPT,
      JSON.stringify({ addReply, storedSchedule }),
    )

    const firedAndSettled = await untilAsync(() => {
      const rec = readWorker(sid)
      const facts = readFacts(sid)
      return (
        rec !== undefined &&
        (rec.lastDeliveryAt ?? 0) >= dueAt &&
        (rec.lastTurnSettledAt ?? 0) >= (rec.lastDeliveryAt ?? 1) &&
        facts?.busy === false &&
        transcriptText(sid).includes(SCHEDULED_REPLY)
      )
    }, 65_000)

    const daemonLog = existsSync(logPath) ? readFileSync(logPath, 'utf8') : ''
    check(
      'real daemon Saturn ticker fires the schedule automatically without any manual tick',
      firedAndSettled,
      JSON.stringify({ rec: readWorker(sid), facts: readFacts(sid), logTail: daemonLog.slice(-600) }),
    )

    const opusReqs = api.messageRequests().filter(r => {
      const m = (r.body as { model?: string } | null)?.model ?? ''
      return m.includes('opus') && !r.path.includes('count_tokens')
    })
    check(
      'loopback model API received the scheduled prompt from the daemon fire',
      opusReqs.some(r => r.raw.includes(SCHEDULED_PROMPT)),
      `opusReqs=${opusReqs.length}`,
    )

    const transcript = transcriptText(sid)
    check(
      'session transcript on disk contains both the scheduled prompt and the model reply',
      transcript.includes(SCHEDULED_PROMPT) && transcript.includes(SCHEDULED_REPLY),
      `transcriptLen=${transcript.length}`,
    )

    const receiptsFile = join(getProjectDir(work), `${sid}.receipts.jsonl`)
    const receipts = existsSync(receiptsFile)
      ? readFileSync(receiptsFile, 'utf8')
          .split('\n')
          .filter(line => line.trim().length > 0)
          .map(line => JSON.parse(line) as { kind?: string; by?: string; details?: Record<string, unknown> })
      : []
    const fireReceipt = receipts.find(r => r.kind === 'schedule-fire' && r.by === `saturn:${scheduleId}`)
    check(
      'session receipts file records the schedule-fire receipt for the minted schedule id',
      fireReceipt !== undefined && fireReceipt.details?.scheduleId === scheduleId,
      JSON.stringify({ receiptsFile, fireReceipt }),
    )

    const afterFire = readWorker(sid)
    check(
      'one-shot at schedule is spent from the worker record with no held fires',
      (afterFire?.schedules ?? []).every(s => s.id !== scheduleId) && (afterFire?.heldFires ?? []).length === 0,
      JSON.stringify({ schedules: afterFire?.schedules, heldFires: afterFire?.heldFires }),
    )

    check(
      'daemon log reports the real Saturn ticker firing 1 schedule',
      daemonLog.includes('[daemon] saturn tick: 1 fired'),
      daemonLog.slice(-400),
    )
  }
} finally {
  clearTimeout(guard)
  await stopDaemon()
  await api.close()
  removeScratch(SCRATCH)
}

console.log(failures === 0 ? '\nprove-saturn-ticker-fire: ALL CHECKS PASS' : `\nprove-saturn-ticker-fire: ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
