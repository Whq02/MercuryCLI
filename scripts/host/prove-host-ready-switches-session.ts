#!/usr/bin/env bun
// gate-watch: src/services/host/worker.ts src/commands/llmhost/words.ts src/daemon/sessionSeat.ts
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
  console.log('prove-host-ready-switches-session: the drive holds the daemon on a POSIX owner pipe — nothing to drive on win32')
  process.exit(0)
}

const PARENT_TMP = process.env.MERCURY_CONFIG_DIR ?? tmpdir()
mkdirSync(PARENT_TMP, { recursive: true })
const SCRATCH = mkdtempSync(join(PARENT_TMP, 'host-ready-switch-'))
const home = join(SCRATCH, 'home')
const daemonDir = join(SCRATCH, 'daemon')
const work = join(SCRATCH, 'work')
for (const d of [home, daemonDir, work]) mkdirSync(d, { recursive: true })

const previousCwd = process.cwd()
process.chdir(work)
process.env.MERCURY_CONFIG_DIR = home
process.env.MERCURY_DAEMON_DIR = daemonDir
process.env.MERCURY_CREDENTIAL_STORE = 'file'
process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'
process.env.BROWSER = '/usr/bin/true'
for (const k of ['MERCURY_HOME', 'CI', 'NODE_ENV', 'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL', 'MERCURY_OAUTH_TOKEN', 'MERCURY_OAUTH_TOKEN_FILE_DESCRIPTOR', 'MERCURY_API_KEY_FILE_DESCRIPTOR', 'MERCURY_DISABLE_NONESSENTIAL_TRAFFIC', 'MERCURY_DAEMON_NO_SELF_WARM', 'MERCURY_WARM_RUNNER', 'MERCURY_CONCOURSE_WORKER', 'MERCURY_MODEL', 'MERCURY_RUNNER_RESTART_REASON', 'MERCURY_COMPAT_BASE_URL', 'MERCURY_COMPAT_API_KEY', 'MERCURY_COMPAT_MODELS', 'MERCURY_COMPAT_LABEL', 'MERCURY_LOCAL_BASE_URL']) {
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
saveGlobalConfig(c => ({ ...c, switchboardCapacity: { askedAt: Date.now(), allowed: true, recommendedSeats: 6 } }))
const { resetSettingsCache } = await import('../../src/utils/settings/settingsCache.ts')
const { updateConcourseWorkers, readSessionWorkers } = await import('../../src/daemon/concourseWorkers.ts')
const { switchRentingSession, rentingSessionModel, restoreRentingSession } = await import('../../src/services/host/worker.ts')
const { hostReadyWords } = await import('../../src/commands/llmhost/words.ts')

const BEFORE_ENDPOINT = 'before'
const BEFORE_WIRE = 'alive'
const BEFORE_MODEL = `compat/${BEFORE_ENDPOINT}/${BEFORE_WIRE}`
const HOSTED_ENDPOINT = 'pod-fixture'
const HOSTED_WIRE = 'GLM-5.3-Flash'
const HOSTED_MODEL = `compat/${HOSTED_ENDPOINT}/${HOSTED_WIRE}`

const server = Bun.serve({
  hostname: '127.0.0.1',
  port: 0,
  fetch(req) {
    const path = new URL(req.url).pathname
    if (path.endsWith('/v1/models')) {
      const wire = path.startsWith(`/${HOSTED_ENDPOINT}/`) ? HOSTED_WIRE : BEFORE_WIRE
      return Response.json({ data: [{ id: wire, owned_by: 'fixture' }] })
    }
    return new Response('not found', { status: 404 })
  },
})
const baseOf = (name: string): string => `http://127.0.0.1:${server.port}/${name}/v1`

const guard = setTimeout(() => {
  console.log('\n❌ TIMEOUT — prove-host-ready-switches-session exceeded 240s')
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

const logPath = join(SCRATCH, 'daemon.log')
let daemon: ChildProcess | null = null
let daemonExit: Promise<void> = Promise.resolve()

function bootDaemon(): void {
  const logFd = openSync(logPath, 'a')
  daemon = spawn(process.execPath.includes('bun') ? 'node' : process.execPath, [DIST, 'daemon', 'run', work], {
    cwd: work,
    env: { ...process.env, MERCURY_CONFIG_DIR: home, MERCURY_DAEMON_DIR: daemonDir, MERCURY_CREDENTIAL_STORE: 'file', MERCURY_LOCAL_PROBE_TARGETS: 'none', MERCURY_CACHE_CLOCK: '0', MERCURY_PARTY: '0', MERCURY_TERMINAL_TITLE: '0', MERCURY_TURN_RECEIPT: '0', MERCURY_VERIFY_EVIDENCE: '0' },
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

type WorkerRec = { runnerId: string; sessionId: string; modelKey?: string; pid?: number; endedAt?: number; parkedAt?: number }
const readWorkerRec = (sid: string): WorkerRec | undefined => Object.values(readSessionWorkers(daemonDir) as Record<string, WorkerRec>).find(w => w.sessionId === sid && w.endedAt === undefined)
const readFacts = (sid: string): { model?: { effective?: string } } | undefined => {
  try {
    return JSON.parse(readFileSync(join(daemonDir, 'session-facts', `${sid}.json`), 'utf8')) as { model?: { effective?: string } }
  } catch {
    return undefined
  }
}
type AdmitReply = { ok: true; runnerId: string; sessionId: string; modelId?: string } | { ok: false; code?: string; error?: string }
const admitSession = async (model: string): Promise<AdmitReply> =>
  (await daemonControlRpc({ op: 'sessionAdmit', workspaceDir: work, isolation: 'shared', by: 'operator', bornBlank: true, model } as never, { timeoutMs: 30_000 })) as AdmitReply
const daemonLog = (): string => (existsSync(logPath) ? readFileSync(logPath, 'utf8') : '')

console.log('============================================================')
console.log(' prove-host-ready-switches-session — a rented machine that is ready becomes the renting session\'s model')
console.log(`  bundle ${DIST}`)
console.log(`  home   ${home}`)
console.log('============================================================')

try {
  section('§1 the words: the notice reads as a fact once the session switched, and keeps the /model door when it did not')
  const record = { price: 8.99, startedAt: new Date(Date.now() - 1800_000).toISOString() }
  const kept = hostReadyWords('GLM-5.3-Flash', HOSTED_MODEL, record)
  const switched = hostReadyWords('GLM-5.3-Flash', HOSTED_MODEL, record, true)
  check('not switched: the notice names the /model door with the id', kept.startsWith(`GLM-5.3-Flash ready · /model ${HOSTED_MODEL}\n~$4.`) && kept.endsWith(' so far + storage.'), JSON.stringify(kept))
  check('switched: the notice reads "now your model" and names no door', switched.startsWith('GLM-5.3-Flash ready · now your model\n~$4.') && switched.endsWith(' so far + storage.') && !switched.includes('/model'), JSON.stringify(switched))
  const worker = readFileSync(join(REPO, 'src/services/host/worker.ts'), 'utf8')
  check('the ready path switches the renting session before it posts the notice, and the notice reads the outcome', worker.includes("const switched = await switchRentingSession(record, result.model)\n    hostNotice(record, 'ready', hostReadyWords(recipe.label, result.model, record, switched))"))
  check('the ready path reads the session’s model before the switch and remembers both models on the record for Terminate', worker.includes('const modelBefore = await rentingSessionModel(record)\n    const switched = await switchRentingSession(record, result.model)') && worker.includes("if (switched && modelBefore && modelBefore !== result.model && !record.sessionModelBefore) patchHostRecord(id, { sessionModelBefore: modelBefore, sessionModel: result.model })"))
  const index = readFileSync(join(REPO, 'src/services/host/index.ts'), 'utf8')
  const idle = readFileSync(join(REPO, 'src/services/host/idle.ts'), 'utf8')
  check('Terminate (the user’s, and the two-hour idle release) puts the renting session back on the model it had', index.includes('await restoreRentingSession(record) }\n          removeHostRecord(pod.id)') && idle.includes('await restoreRentingSession(record) }'))

  section('§2 no session owns the record, or the session is gone: nothing is asked of the daemon')
  check('a record with no session id switches nothing', (await switchRentingSession({ sessionId: undefined }, HOSTED_MODEL)) === false)
  check('a session id no record owns switches nothing (no daemon is even running yet)', (await switchRentingSession({ sessionId: 'no-such-session' }, HOSTED_MODEL)) === false)

  bootDaemon()
  check('the daemon boots and answers ping', await untilAsync(async () => (await daemonControlRpc({ op: 'ping' })).ok, 60_000))

  section(`§3 a live session on ${BEFORE_MODEL}: when the hosted machine is ready the session switches to ${HOSTED_MODEL}`)
  writeFileSync(join(home, 'settings.json'), JSON.stringify({ compatProvider: { [BEFORE_ENDPOINT]: { baseUrl: baseOf(BEFORE_ENDPOINT) }, [HOSTED_ENDPOINT]: { baseUrl: baseOf(HOSTED_ENDPOINT) } }, engine: { model: BEFORE_MODEL } }, null, 2) + '\n')
  resetSettingsCache()
  const born = await admitSession(BEFORE_MODEL)
  check('the session is admitted on the compat model', born.ok === true && born.modelId === BEFORE_MODEL, born.ok ? JSON.stringify(born) : (born.error ?? ''))
  if (!born.ok) throw new Error(`admission refused: ${born.error ?? '?'}`)
  const sid = born.sessionId
  check('the runner stands behind the session and reports its model', await untilAsync(() => readFacts(sid)?.model?.effective === BEFORE_MODEL, 60_000), JSON.stringify(readFacts(sid) ?? null))

  check('the session’s model is readable before the switch', (await rentingSessionModel({ sessionId: sid })) === BEFORE_MODEL)
  const outcome = await switchRentingSession({ sessionId: sid }, HOSTED_MODEL)
  check('the ready road switches the renting session', outcome === true)
  check('…and the session runs the hosted model from here (its facts and its record agree)', await untilAsync(() => readFacts(sid)?.model?.effective === HOSTED_MODEL && readWorkerRec(sid)?.modelKey === HOSTED_MODEL, 60_000), JSON.stringify({ facts: readFacts(sid)?.model, record: readWorkerRec(sid)?.modelKey }))
  check('asking again is a no-op, not a second switch', (await switchRentingSession({ sessionId: sid }, HOSTED_MODEL)) === false && readWorkerRec(sid)?.modelKey === HOSTED_MODEL)

  section('§3b Terminate: the session that was switched onto the machine goes back to the model it had; one that moved on is left alone')
  check('a record that never switched a session restores nothing', (await restoreRentingSession({ sessionId: sid, sessionModel: undefined, sessionModelBefore: undefined })) === false && readWorkerRec(sid)?.modelKey === HOSTED_MODEL)
  check('a session that is no longer on the machine’s model is left alone', (await restoreRentingSession({ sessionId: sid, sessionModel: 'compat/other/model', sessionModelBefore: BEFORE_MODEL })) === false && readWorkerRec(sid)?.modelKey === HOSTED_MODEL)
  check('Terminate puts the session back on the model it had before the rental', (await restoreRentingSession({ sessionId: sid, sessionModel: HOSTED_MODEL, sessionModelBefore: BEFORE_MODEL })) === true && await untilAsync(() => readFacts(sid)?.model?.effective === BEFORE_MODEL && readWorkerRec(sid)?.modelKey === BEFORE_MODEL, 60_000), JSON.stringify({ facts: readFacts(sid)?.model, record: readWorkerRec(sid)?.modelKey }))
  check('the ready road switches it again for the next rental', (await switchRentingSession({ sessionId: sid }, HOSTED_MODEL)) === true && await untilAsync(() => readWorkerRec(sid)?.modelKey === HOSTED_MODEL, 60_000))
  check('the daemon logged no crash for the runner across the switch', !/crashed|DEGRADED/.test(daemonLog()), daemonLog().split('\n').filter(line => /crashed|DEGRADED/.test(line)).join(' | '))

  section('§4 a parked renting session is left alone: no switch, no revival')
  const parkedSid = '77777777-7777-4777-8777-777777777777'
  updateConcourseWorkers(workers => {
    workers['concourse-parked'] = { schema: 1, runnerId: 'concourse-parked', sessionId: parkedSid, workspaceId: work, isolation: 'shared', modelKey: BEFORE_MODEL, spawnedAt: Date.now() - 60_000, lastLiveAt: Date.now() - 60_000, pid: 2_147_000_000, parkedAt: Date.now() - 30_000 } as never
  }, daemonDir)
  check('a parked session switches nothing', (await switchRentingSession({ sessionId: parkedSid }, HOSTED_MODEL)) === false)
  await wait(500)
  const parked = Object.values(readSessionWorkers(daemonDir) as Record<string, WorkerRec>).find(w => w.sessionId === parkedSid)
  check('…its record keeps its model and stays parked (no respawn was asked)', parked?.modelKey === BEFORE_MODEL && parked.parkedAt !== undefined && parked.pid === 2_147_000_000, JSON.stringify(parked ?? null))
  check('…and the live session kept the hosted model', readFacts(sid)?.model?.effective === HOSTED_MODEL)
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
console.log(failures === 0 ? '✅ HOST READY SWITCHES SESSION — all checks pass' : `❌ ${failures} HOST-READY-SWITCH CHECK(S) FAILED`)
console.log('═'.repeat(60))
process.exit(failures === 0 ? 0 : 1)
