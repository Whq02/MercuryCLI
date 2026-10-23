#!/usr/bin/env bun
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const REPO = resolve(import.meta.dir, '..', '..')
const DIST = process.argv[2] ? resolve(process.argv[2]) : join(REPO, 'dist', 'mercury.mjs')
if (!existsSync(DIST)) {
  console.error(`✗ ${DIST} missing — run \`bun run build.ts\` first, or pass a bundle path as argv[2]`)
  process.exit(1)
}
if (process.platform === 'win32') {
  console.log('prove-endpoint-gone-runner-stays: the drive holds the daemon on a POSIX owner pipe — nothing to drive on win32')
  process.exit(0)
}

const PARENT_TMP = process.env.MERCURY_CONFIG_DIR ?? tmpdir()
mkdirSync(PARENT_TMP, { recursive: true })
const SCRATCH = mkdtempSync(join(PARENT_TMP, 'endpoint-gone-'))
const home = join(SCRATCH, 'home')
const daemonDir = join(SCRATCH, 'daemon')
const work = join(SCRATCH, 'work')
for (const d of [home, daemonDir, work]) mkdirSync(d, { recursive: true })

const previousCwd = process.cwd()
process.chdir(work)
process.env.MERCURY_CONFIG_DIR = home
process.env.MERCURY_DAEMON_DIR = '../daemon'
process.env.MERCURY_CREDENTIAL_STORE = 'file'
process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'
process.env.BROWSER = '/usr/bin/true'
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
  'MERCURY_WARM_RUNNER',
  'MERCURY_CONCOURSE_WORKER',
  'MERCURY_MODEL',
  'MERCURY_RUNNER_RESTART_REASON',
  'MERCURY_COMPAT_BASE_URL',
  'MERCURY_COMPAT_API_KEY',
  'MERCURY_COMPAT_MODELS',
  'MERCURY_COMPAT_LABEL',
  'MERCURY_LOCAL_BASE_URL',
]) {
  delete process.env[k]
}
for (const k of Object.keys(process.env)) {
  if (/_API_KEY$|^HF_TOKEN$|^GOOGLE_API_KEY$/.test(k)) delete process.env[k]
}

const { seedFirstRun } = await import('../lib/firstRunSeed.ts')
seedFirstRun(home, [work])
const { daemonControlRpc } = await import('../../src/daemon/controlSocket.ts')
const { enableConfigs, saveGlobalConfig } = await import('../../src/utils/config/globalConfig.ts')
enableConfigs()
saveGlobalConfig(c => ({
  ...c,
  switchboardCapacity: { askedAt: Date.now(), allowed: true, recommendedSeats: 6 },
}))
const { resetSettingsCache } = await import('../../src/utils/settings/settingsCache.ts')
const { getProjectDir } = await import('../../src/utils/sessionStorage/paths.ts')
const { loadConversationForResume } = await import('../../src/utils/conversationRecovery.ts')

const GONE_ENDPOINT = 'nothing'
const GONE_WIRE = 'none'
const GONE_MODEL = `compat/${GONE_ENDPOINT}/${GONE_WIRE}`
const KEPT_ENDPOINT = 'kept'
const KEPT_WIRE = 'alive'
const KEPT_MODEL = `compat/${KEPT_ENDPOINT}/${KEPT_WIRE}`
const FIXTURE_REPLY = 'ENDPOINT-GONE-FIXTURE-ANSWER'

const captures: Array<{ path: string; model?: string }> = []
const sse = (value: unknown): string => `data: ${JSON.stringify(value)}\n\n`
const server = Bun.serve({
  hostname: '127.0.0.1',
  port: 0,
  async fetch(req) {
    const url = new URL(req.url)
    const path = url.pathname
    if (path.endsWith('/v1/models')) {
      const wire = path.startsWith(`/${KEPT_ENDPOINT}/`) ? KEPT_WIRE : GONE_WIRE
      return Response.json({ data: [{ id: wire, owned_by: 'fixture' }] })
    }
    if (path.endsWith('/v1/chat/completions')) {
      const body = (await req.json()) as { model?: string }
      captures.push({ path, model: body.model })
      const chunk = (delta: unknown, finish: string | null = null, usage?: unknown) =>
        sse({ model: body.model, choices: [{ index: 0, delta, finish_reason: finish }], ...(usage ? { usage } : {}) })
      const usage = { prompt_tokens: 12, completion_tokens: 4, prompt_tokens_details: { cached_tokens: 0 } }
      const payload = chunk({ content: FIXTURE_REPLY }) + chunk({}, 'stop', usage) + 'data: [DONE]\n\n'
      return new Response(payload, { headers: { 'content-type': 'text/event-stream' } })
    }
    return new Response('not found', { status: 404 })
  },
})
const baseOf = (name: string): string => `http://127.0.0.1:${server.port}/${name}/v1`

const guard = setTimeout(() => {
  console.log('\n❌ TIMEOUT — prove-endpoint-gone-runner-stays exceeded 240s')
  process.exit(1)
}, 240_000)
guard.unref?.()

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}
function section(title: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + title + '\n' + '─'.repeat(76))
}
const wait = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms))
async function untilAsync(cond: () => Promise<boolean> | boolean, ms = 60_000): Promise<boolean> {
  const deadline = Date.now() + ms
  for (;;) {
    try {
      if (await cond()) return true
    } catch {}
    if (Date.now() > deadline) return false
    await wait(200)
  }
}
const alivePid = (pid: number | undefined): boolean => {
  if (pid === undefined) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

const logPath = join(SCRATCH, 'daemon.log')
let daemon: ChildProcess | null = null
let daemonExit: Promise<void> = Promise.resolve()

function bootDaemon(): void {
  const logFd = openSync(logPath, 'a')
  daemon = spawn(process.execPath.includes('bun') ? 'node' : process.execPath, [DIST, 'daemon', 'run', work], {
    cwd: work,
    env: {
      ...process.env,
      MERCURY_CONFIG_DIR: home,
      MERCURY_DAEMON_DIR: '../daemon',
      MERCURY_CREDENTIAL_STORE: 'file',
      MERCURY_LOCAL_PROBE_TARGETS: 'none',
      MERCURY_CACHE_CLOCK: '0',
      MERCURY_PARTY: '0',
      MERCURY_TERMINAL_TITLE: '0',
      MERCURY_TURN_RECEIPT: '0',
      MERCURY_VERIFY_EVIDENCE: '0',
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

type WorkerRec = {
  runnerId: string
  sessionId: string
  workspaceId: string
  modelKey?: string
  pid?: number
  endedAt?: number
  lastDeliveryAt?: number
  lastTurnSettledAt?: number
  crash?: { reason: string; at: number; respawning: boolean }
}
const readWorkerRec = (sid: string): WorkerRec | undefined => {
  try {
    const raw = JSON.parse(readFileSync(join(daemonDir, 'concourse-workers.json'), 'utf8')) as { workers: Record<string, WorkerRec> }
    return Object.values(raw.workers).find(w => w.sessionId === sid && w.endedAt === undefined)
  } catch {
    return undefined
  }
}
const readFacts = (sid: string): { busy?: boolean; model?: { effective?: string } } | undefined => {
  try {
    return JSON.parse(readFileSync(join(daemonDir, 'session-facts', `${sid}.json`), 'utf8')) as { busy?: boolean; model?: { effective?: string } }
  } catch {
    return undefined
  }
}
const turnSettled = (sid: string): boolean => {
  const rec = readWorkerRec(sid)
  const facts = readFacts(sid)
  return rec !== undefined && (rec.lastTurnSettledAt ?? 0) >= (rec.lastDeliveryAt ?? 1) && facts?.busy === false
}
const transcriptPath = (sid: string): string => join(getProjectDir(work), `${sid}.jsonl`)
const transcriptText = (sid: string): string => (existsSync(transcriptPath(sid)) ? readFileSync(transcriptPath(sid), 'utf8') : '')
const transcriptRows = (sid: string): Array<Record<string, unknown>> =>
  transcriptText(sid)
    .split('\n')
    .filter(line => line.trim() !== '')
    .flatMap(line => {
      try {
        return [JSON.parse(line) as Record<string, unknown>]
      } catch {
        return []
      }
    })
const seatReceiptsOf = (sid: string): string[] =>
  transcriptRows(sid).flatMap(row => {
    const payload = row.payload as { kind?: string; noticeKind?: string; content?: unknown } | undefined
    if (payload?.kind === 'notice' && payload.noticeKind === 'seat_receipt' && typeof payload.content === 'string') return [payload.content]
    if (row.type === 'system' && row.subtype === 'seat_receipt' && typeof row.content === 'string') return [row.content]
    return []
  })
const daemonLog = (): string => (existsSync(logPath) ? readFileSync(logPath, 'utf8') : '')
const crashLinesFor = (short: string): string[] => daemonLog().split('\n').filter(line => line.includes(`long-lived ${short} crashed`) || line.includes(`${short}: crashed`) || (line.includes('DEGRADED') && line.includes(short)))

type RosterRow = { short: string; state?: string; outcome?: string; ready?: boolean; respawns?: number; maxRespawns?: number; pid?: number; crashedAt?: number; lastError?: string; model?: string }
const rosterRow = async (short: string): Promise<RosterRow | undefined> => {
  const reply = (await daemonControlRpc({ op: 'list' } as never, { timeoutMs: 10_000 })) as { ok?: boolean; jobs?: RosterRow[] }
  return reply.jobs?.find(job => job.short === short)
}

type AdmitReply =
  | { ok: true; runnerId: string; sessionId: string; modelId?: string; pid?: number }
  | { ok: false; code?: string; error?: string }
const admitSession = async (model: string): Promise<AdmitReply> =>
  (await daemonControlRpc(
    { op: 'sessionAdmit', workspaceDir: work, isolation: 'shared', by: 'operator', bornBlank: true, model } as never,
    { timeoutMs: 30_000 },
  )) as AdmitReply
const dispatchTurn = async (sessionId: string, prompt: string): Promise<{ ok?: boolean; error?: string }> =>
  (await daemonControlRpc(
    {
      op: 'sessionDispatch',
      clientMessageId: `turn-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
      prompt,
      workspaceDir: work,
      targetSessionId: sessionId,
    } as never,
    { timeoutMs: 30_000 },
  )) as { ok?: boolean; error?: string }
const writeUserSettings = (settings: Record<string, unknown>): void => {
  writeFileSync(join(home, 'settings.json'), JSON.stringify(settings, null, 2) + '\n')
  resetSettingsCache()
}

console.log('============================================================')
console.log(' prove-endpoint-gone-runner-stays — a removed endpoint is a refusal, never a crash loop')
console.log(`  bundle ${DIST}`)
console.log(`  home   ${home}`)
console.log(`  fixture ${baseOf(GONE_ENDPOINT)} · ${baseOf(KEPT_ENDPOINT)}`)
console.log('============================================================')

try {
  bootDaemon()
  check('the daemon boots and answers ping', await untilAsync(async () => (await daemonControlRpc({ op: 'ping' })).ok, 60_000))

  section(`§1 a chat on ${GONE_MODEL} against the configured endpoint answers from the fixture`)
  writeUserSettings({
    compatProvider: {
      [GONE_ENDPOINT]: { baseUrl: baseOf(GONE_ENDPOINT) },
      [KEPT_ENDPOINT]: { baseUrl: baseOf(KEPT_ENDPOINT) },
    },
    engine: { model: GONE_MODEL },
  })
  const born = await admitSession(GONE_MODEL)
  check('the session is admitted on the named compat model', born.ok === true && born.modelId === GONE_MODEL, born.ok ? JSON.stringify(born) : (born.error ?? ''))
  if (!born.ok) throw new Error(`admission refused: ${born.error ?? '?'}`)
  const sid = born.sessionId
  const short = born.runnerId
  const sent = await dispatchTurn(sid, 'Say hello from the fixture.')
  const answered = await untilAsync(() => turnSettled(sid) && transcriptText(sid).includes(FIXTURE_REPLY), 60_000)
  check('the first turn is answered by the endpoint', sent.ok === true && answered && captures.some(c => c.path.startsWith(`/${GONE_ENDPOINT}/`) && c.model === GONE_WIRE), JSON.stringify({ sent, answered, captures }))
  const firstPid = readWorkerRec(sid)?.pid
  check('the runner stands behind the session', alivePid(firstPid), JSON.stringify(readWorkerRec(sid) ?? null))

  section(`§2 the endpoint '${GONE_ENDPOINT}' is removed while the session stands; the daemon relaunches the runner on its model`)
  writeUserSettings({
    compatProvider: { [KEPT_ENDPOINT]: { baseUrl: baseOf(KEPT_ENDPOINT) } },
    engine: { model: GONE_MODEL },
  })
  const bounced = (await daemonControlRpc({ op: 'reconfigure', short, effort: 'high' } as never, { timeoutMs: 15_000 })) as { ok?: boolean; respawned?: boolean; pending?: boolean; error?: string }
  check('the seat is bounced onto a fresh runner on the same model', bounced.ok === true && bounced.respawned === true, JSON.stringify(bounced))
  const settled = await untilAsync(async () => {
    const row = await rosterRow(short)
    if (row === undefined) return false
    if ((row.respawns ?? 0) > 0 || row.crashedAt !== undefined || row.outcome !== undefined) return true
    return row.ready === true && readWorkerRec(sid)?.pid !== undefined && readWorkerRec(sid)?.pid !== firstPid
  }, 90_000)
  const row = await rosterRow(short)
  const rec = readWorkerRec(sid)
  console.log(`      roster: ${JSON.stringify(row ?? null)}`)
  console.log(`      record: pid ${String(rec?.pid)} crash ${JSON.stringify(rec?.crash ?? null)}`)
  check('the relaunch settled one way or the other', settled, JSON.stringify(row ?? null))
  check('the runner is alive and answered initialize (no exit over the model)', row?.ready === true && row.outcome === undefined && alivePid(rec?.pid), JSON.stringify({ row, pid: rec?.pid }))
  check('zero restarts: the respawn count stayed at 0 and no crash was stamped', (row?.respawns ?? -1) === 0 && row?.crashedAt === undefined && rec?.crash === undefined, JSON.stringify({ respawns: row?.respawns, crashedAt: row?.crashedAt, crash: rec?.crash ?? null }))
  check('the daemon log carries no crash line for the seat', crashLinesFor(short).length === 0, crashLinesFor(short).join(' | '))
  const receipts = await (async (): Promise<string[]> => {
    await untilAsync(() => seatReceiptsOf(sid).some(words => words.includes(GONE_MODEL)), 15_000)
    return seatReceiptsOf(sid).filter(words => words.includes(GONE_MODEL))
  })()
  check(`one refusal row names ${GONE_MODEL} and its gone endpoint`, receipts.length === 1 && /has no configured endpoint/.test(receipts[0]!), JSON.stringify(receipts))
  check('the refusal points to /llmhost and /model', receipts.length === 1 && receipts[0]!.includes('/llmhost') && receipts[0]!.includes('/model'), JSON.stringify(receipts))
  console.log(`      receipt: ${receipts[0] ?? '(none)'}`)
  const resumed = await loadConversationForResume(sid, transcriptPath(sid))
  const resumedText = JSON.stringify(resumed?.messages ?? [])
  check('a resume of the transcript carries the first turn and the receipt together', resumed !== null && resumedText.includes(FIXTURE_REPLY) && resumedText.includes('seat_receipt'), `loaded ${resumed?.messages.length ?? 0} message(s): ${(resumed?.messages ?? []).map(m => m.type).join(',')}`)
  check('the session keeps the model it was asked for (never another provider)', rec?.modelKey === GONE_MODEL && (await untilAsync(() => readFacts(sid)?.model?.effective === GONE_MODEL, 30_000)), JSON.stringify({ modelKey: rec?.modelKey, effective: readFacts(sid)?.model?.effective }))

  section(`§3 /model picks ${KEPT_MODEL} and the chat carries on`)
  const switched = (await daemonControlRpc({ op: 'sessionControl', action: 'set-model', sessionId: sid, by: 'operator', model: KEPT_MODEL } as never, { timeoutMs: 30_000 })) as { ok?: boolean; outcome?: string; detail?: string }
  check('the live runner takes the switch', switched.ok === true && switched.outcome === 'applied', JSON.stringify(switched))
  const before = captures.length
  const again = await dispatchTurn(sid, 'And now on the kept endpoint.')
  const carried = await untilAsync(() => turnSettled(sid) && captures.slice(before).some(c => c.path.startsWith(`/${KEPT_ENDPOINT}/`) && c.model === KEPT_WIRE), 60_000)
  check('the next turn is answered by the kept endpoint on the same runner', again.ok === true && carried && alivePid(readWorkerRec(sid)?.pid), JSON.stringify({ again, carried, captures: captures.slice(before), rec: readWorkerRec(sid) }))
  const finalRow = await rosterRow(short)
  check('still zero restarts after the switch and the turn', (finalRow?.respawns ?? -1) === 0 && finalRow?.outcome === undefined && crashLinesFor(short).length === 0, JSON.stringify(finalRow ?? null))
} catch (error) {
  failures++
  console.log(`  [FAIL] the drive threw — ${error instanceof Error ? error.message : String(error)}`)
} finally {
  await stopDaemon()
  server.stop(true)
  process.chdir(previousCwd)
  if (failures === 0) rmSync(SCRATCH, { recursive: true, force: true })
  else console.log(`[forensics] world kept: ${SCRATCH}`)
}

clearTimeout(guard)
console.log('\n' + '═'.repeat(60))
console.log(failures === 0 ? '✅ ALL ENDPOINT-GONE-RUNNER-STAYS PROOFS PASS' : `❌ ${failures} ENDPOINT-GONE-RUNNER-STAYS PROOF(S) FAILED`)
console.log('═'.repeat(60))
process.exit(failures === 0 ? 0 : 1)
