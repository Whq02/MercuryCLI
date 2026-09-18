#!/usr/bin/env bun
import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const argAfter = (flag: string): string | undefined => {
  const at = process.argv.indexOf(flag)
  return at >= 0 ? process.argv[at + 1] : undefined
}
const ROOT = process.cwd()
const DIST = argAfter('--dist') ?? join(ROOT, 'dist', 'mercury.mjs')
const VENDORED_NODE = join(DIST, '..', 'vendor', 'node', 'bin', 'node')
const NODE = existsSync(VENDORED_NODE) ? VENDORED_NODE : process.execPath.includes('bun') ? 'node' : process.execPath

let failures = 0
const check = (label: string, cond: boolean, detail = ''): void => {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}
const section = (t: string): void => console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
const wait = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms))
const read = (p: string): string => {
  try {
    return readFileSync(p, 'utf8')
  } catch {
    return ''
  }
}
async function until(cond: () => boolean, ms: number): Promise<boolean> {
  const deadline = Date.now() + ms
  for (;;) {
    if (cond()) return true
    if (Date.now() > deadline) return false
    await wait(150)
  }
}

if (!existsSync(DIST)) {
  console.error(`✗ dist/mercury.mjs missing at ${DIST} — run \`bun run build.ts\` first`)
  process.exit(1)
}

const guard = setTimeout(() => {
  console.log('\n❌ TIMEOUT — prove-owner-handover exceeded 240s')
  process.exit(1)
}, 240_000)
guard.unref?.()

const spawned: ChildProcess[] = []
const scratches: string[] = []
const idler = (): ChildProcess => {
  const c = spawn(NODE, ['-e', 'setInterval(() => {}, 1 << 30)'], { stdio: 'ignore' })
  spawned.push(c)
  return c
}
function done(): never {
  for (const c of spawned) {
    try {
      c.kill('SIGKILL')
    } catch {}
  }
  for (const d of scratches) {
    try {
      rmSync(d, { recursive: true, force: true })
    } catch {}
  }
  clearTimeout(guard)
  console.log(`\n${failures === 0 ? 'prove-owner-handover: ALL LAWS HOLD' : `prove-owner-handover: ${failures} FAILURE(S)`}`)
  process.exit(failures === 0 ? 0 : 1)
}

const sup = await import('../../src/daemon/concourseSupervisor.ts')
const owned = await import('../../src/daemon/ownedDaemon.ts')
const ownerWatch = await import('../../src/daemon/ownerWatch.ts')
const handshake = await import('../../src/daemon/handshake.ts')
const controlSocket = await import('../../src/daemon/controlSocket.ts')

section('§A the pure decision: the oldest live cockpit wins; dead, parked and ended records are never candidates')
{
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'owner-handover-pure-')))
  scratches.push(dir)
  const self = process.pid
  const b = idler()
  await wait(250)
  const bpid = b.pid ?? 0
  const now = Date.now()
  const workers = {
    version: 1,
    workers: {
      'concourse-w1': { runnerId: 'concourse-w1', sessionId: 's1', pid: self, focusedAt: now, focusedBy: `operator:${self}`, lastDeliveryAt: now },
      'concourse-w2': { runnerId: 'concourse-w2', sessionId: 's2', pid: bpid, focusedAt: now - 5000, focusedBy: `operator:${bpid}`, lastDeliveryAt: now },
      'concourse-w3': { runnerId: 'concourse-w3', sessionId: 's3', pid: 999999, focusedAt: now, focusedBy: 'operator:999999', lastDeliveryAt: now },
      'concourse-w4': { runnerId: 'concourse-w4', sessionId: 's4', pid: self, focusedAt: now, focusedBy: `operator:${self}`, parkedAt: now },
      'concourse-w5': { runnerId: 'concourse-w5', sessionId: 's5', pid: self, focusedAt: now, focusedBy: `operator:${self}`, endedAt: now },
    },
  }
  const wpath = join(dir, 'concourse-workers.json')
  writeFileSync(wpath, JSON.stringify(workers))
  check('the oldest live cockpit wins (b focused earlier than self)', sup.nextLiveCockpitOwner(null, dir) === bpid, String(sup.nextLiveCockpitOwner(null, dir)))
  check('the departing owner is excluded — the other live cockpit is chosen', sup.nextLiveCockpitOwner(self, dir) === bpid && sup.nextLiveCockpitOwner(bpid, dir) === self)
  check('a dead-terminal record is never a candidate', sup.nextLiveCockpitOwner(self, dir) !== 999999)
  const onlyDead = { version: 1, workers: { x: { runnerId: 'x', sessionId: 's', pid: 999999, focusedAt: now, focusedBy: 'operator:999999' } } }
  const deadPath = join(dir, 'dead.json')
  writeFileSync(deadPath, JSON.stringify(onlyDead))
  writeFileSync(wpath, JSON.stringify(onlyDead))
  check('no live cockpit ⇒ undefined (the daemon would shut down)', sup.nextLiveCockpitOwner(null, dir) === undefined)
  writeFileSync(wpath, JSON.stringify(workers))
  check('the parent reaper sees another live cockpit and steps aside', owned.anotherLiveCockpitHoldsDaemon(self, wpath) === true && owned.anotherLiveCockpitHoldsDaemon(999999, wpath) === true)
  check('a world holding only the departing cockpit ⇒ the reaper proceeds', owned.anotherLiveCockpitHoldsDaemon(self, deadPath) === false)
  b.kill('SIGKILL')
}

section('§B the real daemon: the owner cockpit goes, ownership passes, the daemon stays up; it self-reaps only when no cockpit remains')
{
  const SCRATCH = realpathSync(mkdtempSync(join(tmpdir(), 'owner-handover-live-')))
  scratches.push(SCRATCH)
  const home = join(SCRATCH, 'home')
  const ddir = join(SCRATCH, 'daemon')
  const work = join(SCRATCH, 'work')
  for (const d of [home, ddir, work]) mkdirSync(d, { recursive: true })
  const { seedFirstRun } = await import('../lib/firstRunSeed.ts')
  seedFirstRun(home, [work])
  process.env.MERCURY_CONFIG_DIR = home
  process.env.MERCURY_DAEMON_DIR = ddir
  process.env.MERCURY_CREDENTIAL_STORE = 'file'

  const a = idler()
  const b = idler()
  await wait(250)
  const apid = a.pid ?? 0
  const bpid = b.pid ?? 0
  const now = Date.now()
  writeFileSync(
    join(ddir, 'concourse-workers.json'),
    JSON.stringify({
      version: 1,
      workers: {
        'concourse-w1': { runnerId: 'concourse-w1', sessionId: 'sess-b', pid: bpid, focusedAt: now, focusedBy: `operator:${bpid}`, lastDeliveryAt: now, lastTurnSettledAt: now },
      },
    }),
  )

  const logPath = join(SCRATCH, 'daemon.log')
  const logFd = openSync(logPath, 'a')
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    MERCURY_CONFIG_DIR: home,
    MERCURY_DAEMON_DIR: ddir,
    MERCURY_CREDENTIAL_STORE: 'file',
    MERCURY_DAEMON_OWNER_PID: String(apid),
    BROWSER: '/usr/bin/true',
  }
  for (const k of ['MERCURY_DAEMON_OWNER_FD', 'MERCURY_DAEMON_PERSIST', 'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'OPENAI_API_KEY', 'OPENROUTER_API_KEY', 'GEMINI_API_KEY', 'GOOGLE_API_KEY', 'ZAI_API_KEY']) delete env[k]

  const daemon = spawn(NODE, [DIST, 'daemon', 'run', work], { cwd: work, env, stdio: ['ignore', logFd, logFd] })
  spawned.push(daemon)
  const dpid = daemon.pid ?? 0
  const ready = await until(() => read(logPath).includes('[daemon] control socket up'), 60_000)
  check('the daemon booted to its control socket, owned by cockpit A', ready, read(logPath).slice(-600))
  check('the daemon is alive with both cockpits present', ownerWatch.isProcessAlive(dpid) && ownerWatch.isProcessAlive(apid) && ownerWatch.isProcessAlive(bpid))
  await wait(1_500)

  a.kill('SIGKILL')
  const handoverBudget = ownerWatch.OWNER_WATCH_INTERVAL_MS * (ownerWatch.OWNER_WATCH_GRACE_CHECKS + 2) + 8_000
  await until(() => read(logPath).includes('ownership passes to the live cockpit') || read(logPath).includes('no live cockpit remains') || !ownerWatch.isProcessAlive(dpid), handoverBudget)
  await wait(1_500)
  const stillUp = ownerWatch.isProcessAlive(dpid)
  check('the daemon STAYS UP after its owner cockpit goes (a second cockpit is live)', stillUp, read(logPath).slice(-800))
  check('the log names the ownership hand-over to the live cockpit', read(logPath).includes(`ownership passes to the live cockpit pid ${bpid}`), read(logPath).slice(-800))
  const recAfter = await controlSocket.readSupervisorState()
  check('the supervisor record names the new owner (the doctor row reads it)', recAfter?.ownerPid === bpid, `record ownerPid=${recAfter?.ownerPid} want ${bpid}`)
  const hs = await handshake.handshakeDaemon({ timeoutMs: 3000 })
  check('the hello facts name the new owner (the doctor handshake reads it)', hs.daemon?.ownerPid === bpid, `hello ownerPid=${hs.daemon?.ownerPid ?? 'none'} state=${hs.state}`)
  const wafter = read(join(ddir, 'concourse-workers.json'))
  check("the surviving cockpit's session was NOT parked", wafter.includes('sess-b') && !/"parkedAt"/.test(wafter), wafter.slice(0, 200))

  b.kill('SIGKILL')
  const downBudget = ownerWatch.OWNER_WATCH_INTERVAL_MS * (ownerWatch.OWNER_WATCH_GRACE_CHECKS + 2) + 12_000
  const wentDown = await until(() => !ownerWatch.isProcessAlive(dpid), downBudget)
  check('the daemon self-reaps once NO live cockpit remains', wentDown, read(logPath).slice(-800))
  check('the log names the no-cockpit shutdown', read(logPath).includes('no live cockpit remains'), read(logPath).slice(-800))
}

section('§C the wiring (source pins)')
{
  const main = read(join(ROOT, 'src/daemon/main.ts'))
  check('the owner watch is armed through the re-armable closure', main.includes('const armOwnerWatch = (pid: number, withPipe: boolean)'))
  check('the hand-over passes ownership to the next live cockpit before shutting down', main.includes('const next = nextLiveCockpitOwner(pid)') && main.includes('currentOwnerPid = next') && main.includes('armOwnerWatch(next, false)'))
  check('parkAllThenShutdown fires only when no live cockpit remains', main.includes('no live cockpit remains') && main.includes("void parkAllThenShutdown('owner-orphaned')"))
  check('the hello facts and the record read the live owner, not the env stamp', main.includes('ownerPid: currentOwnerPid') && !main.includes('ownerPid: parseOwnerPid()'))
  const od = read(join(ROOT, 'src/daemon/ownedDaemon.ts'))
  check('the parent reaper steps aside while another live cockpit holds the daemon', od.includes('if (anotherLiveCockpitHoldsDaemon(process.pid)) return'))
  const cs = read(join(ROOT, 'src/daemon/concourseSupervisor.ts'))
  check('nextLiveCockpitOwner skips ended and parked records', cs.includes('export function nextLiveCockpitOwner(') && cs.includes('rec.endedAt !== undefined || rec.parkedAt !== undefined'))
}

done()
