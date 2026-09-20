#!/usr/bin/env bun
import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import net, { type Socket } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const home = mkdtempSync(join(tmpdir(), 'mercury-dep-'))
const daemonDirPath = join(home, 'daemon')
mkdirSync(daemonDirPath, { recursive: true })
process.env.MERCURY_CONFIG_DIR = home
process.env.MERCURY_DAEMON_DIR = daemonDirPath
process.env.MERCURY_CREDENTIAL_STORE = 'file'
delete process.env.NODE_ENV
delete process.env.MERCURY_DAEMON_PERSIST
delete process.env.MERCURY_DAEMON_OWNER_PID
delete process.env.MERCURY_DAEMON_OWNER_FD
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
}
const sleep = (ms: number): Promise<void> => new Promise(res => setTimeout(res, ms))
const ROOT = join(import.meta.dir, '..', '..')
const read = (rel: string): string => readFileSync(join(ROOT, rel), 'utf8')

const cs = await import('../../src/daemon/controlSocket.ts')
const hs = await import('../../src/daemon/handshake.ts')
const owned = await import('../../src/daemon/ownedDaemon.ts')
const ensure = await import('../../src/services/switchboard/ensureDaemon.ts')
const { MERCURY_DAEMON_PROTO, MIN_PROTO } = await import('../../src/daemon/protocol.ts')

const FIXTURE = join(import.meta.dir, 'departure-fixture-daemon.ts')
const LEDGER = join(daemonDirPath, 'fixture-spawns.log')
const LOCK = join(daemonDirPath, 'supervisor.lock')
process.argv[1] = FIXTURE

const spawned: ChildProcess[] = []
function idler(): ChildProcess {
  const c = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1 << 30)'], { stdio: 'ignore' })
  spawned.push(c)
  return c
}
function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}
function ledgerPids(): number[] {
  if (!existsSync(LEDGER)) return []
  return [...new Set(readFileSync(LEDGER, 'utf8').split('\n').filter(l => l.includes(' booted')).map(l => Number(l.split(' ')[0])))]
}
function spawnsSeen(): number {
  return ledgerPids().length
}
async function fixtureGone(pid: number, ms = 8000): Promise<boolean> {
  const until = Date.now() + ms
  while (Date.now() < until) {
    if (!alive(pid)) return true
    await sleep(100)
  }
  return !alive(pid)
}
async function stopFixtures(): Promise<void> {
  for (const pid of ledgerPids()) {
    if (!alive(pid)) continue
    await cs.daemonControlRpc({ op: 'shutdown', reapWorkers: false } as never, { timeoutMs: 2000 }).catch(() => null)
    if (!(await fixtureGone(pid, 4000))) {
      try {
        process.kill(pid, 'SIGTERM')
      } catch {
        continue
      }
      await fixtureGone(pid, 4000)
    }
  }
}
function planeClear(): void {
  for (const p of [cs.controlSockPath(), cs.supervisorStatePath(), cs.controlKeyPath(), LOCK]) {
    try {
      unlinkSync(p)
    } catch {
      continue
    }
  }
}
function resetClient(): void {
  ensure._resetDaemonUsableMemoForProofs()
  hs.resetDaemonHandshakeForTesting()
  cs.forgetDaemonProtoForTesting()
  owned.resetOwnedDaemonBreakerForTesting()
  ;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
}
const roundsSeam = (ensure as { _setDaemonLadderRoundsForProofs?: (n: number | null) => void })._setDaemonLadderRoundsForProofs
const setRounds = (n: number | null): void => {
  if (roundsSeam) roundsSeam(n)
}

type OldMode = 'silent' | 'answer' | 'slow-then-answer'
interface OldDaemon {
  pid: number
  hellos: number
  leave: (opts?: { mark?: boolean; keepPlaneMs?: number }) => Promise<void>
  close: () => Promise<void>
}
async function startOldDaemon(mode: OldMode, opts: { record?: boolean; lock?: boolean } = {}): Promise<OldDaemon> {
  const holder = idler()
  await sleep(150)
  const pid = holder.pid ?? 0
  const conns = new Set<Socket>()
  const state = { hellos: 0 }
  const server = net.createServer(sock => {
    conns.add(sock)
    sock.on('close', () => conns.delete(sock))
    sock.on('error', () => sock.destroy())
    let pending = ''
    sock.on('data', chunk => {
      pending += chunk.toString('utf8')
      const nl = pending.indexOf('\n')
      if (nl < 0) return
      const req = JSON.parse(pending.slice(0, nl)) as { op?: string; proto?: number; clientVersion?: string; clientBuildTree?: string | null }
      if (req.op !== 'hello') {
        sock.end(`${JSON.stringify({ ok: false, code: 'EUNKNOWN', error: `unknown op ${String(req.op)}` })}\n`)
        return
      }
      state.hellos++
      if (mode === 'silent' || (mode === 'slow-then-answer' && state.hellos === 1)) return
      sock.end(
        `${JSON.stringify({
          ok: true,
          op: 'hello',
          proto: MERCURY_DAEMON_PROTO,
          minProto: MIN_PROTO,
          ready: true,
          version: req.clientVersion ?? '1.0.0',
          buildTree: req.clientBuildTree ?? null,
          pid,
          startedAt: Date.now() - 5000,
          ownerPid: null,
          foreground: false,
          live: 0,
          liveSessions: 0,
          warm: 0,
          restartArmed: false,
        })}\n`,
      )
    })
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(cs.controlSockPath(), () => resolve())
  })
  if (opts.record !== false) {
    await cs.writeSupervisorState({
      pid,
      version: '1.0.0',
      origin: 'transient',
      startedAt: Date.now() - 5000,
      dir: ROOT,
      controlSock: cs.controlSockPath(),
      proto: MERCURY_DAEMON_PROTO,
      buildTree: null,
      ownerPid: null,
      foreground: false,
      startToken: null,
    })
  }
  if (opts.lock !== false) writeFileSync(LOCK, JSON.stringify({ owner: 'hermes-supervisor-old', pid, acquiredAt: Date.now() - 5000 }))
  const close = async (): Promise<void> => {
    for (const c of conns) c.destroy()
    await new Promise<void>(resolve => server.close(() => resolve()))
    try {
      unlinkSync(cs.controlSockPath())
    } catch {
      return
    }
  }
  return {
    pid,
    get hellos() {
      return state.hellos
    },
    close,
    leave: async (o = {}) => {
      if (o.mark !== false) {
        const raw = JSON.parse(readFileSync(cs.supervisorStatePath(), 'utf8')) as Record<string, unknown>
        writeFileSync(cs.supervisorStatePath(), JSON.stringify({ ...raw, state: 'stopping', stoppingAt: Date.now() }))
      }
      await close()
      await sleep(o.keepPlaneMs ?? 120)
      try {
        unlinkSync(cs.supervisorStatePath())
      } catch {
        return
      }
      try {
        unlinkSync(LOCK)
      } catch {
        return
      }
      await sleep(250)
      holder.kill('SIGKILL')
    },
  }
}

const guard = setTimeout(() => {
  console.log('\nTIMEOUT — prove-daemon-departure exceeded 300s')
  process.exit(1)
}, 300_000)
guard.unref?.()

console.log('============================================================')
console.log(' a cockpit beside a daemon on its way down spawns its own once the daemon has left')
console.log(`   rounds seam: ${roundsSeam ? 'present' : 'absent (the base ladder: 40 rounds)'}`)
console.log('============================================================')

section('§1 a departing daemon: the ladder reads starting, the daemon leaves, a spawn follows at once')
{
  resetClient()
  setRounds(12)
  const old = await startOldDaemon('silent')
  const before = spawnsSeen()
  const started = Date.now()
  const pending = ensure.ensureOwnedDaemon()
  await sleep(900)
  const departure = Date.now()
  await old.leave()
  const ok = await pending
  const landed = Date.now() - departure
  check('the first handshake met the slow daemon (a timed-out hello reads starting)', old.hellos >= 1, `hellos=${old.hellos}`)
  check('the door resolves usable once the daemon has left', ok === true, `resolved ${String(ok)} after ${Date.now() - started}ms`)
  check('the spawn came within a few beats of the departure, not after the ladder ran out', landed < 6000, `${landed}ms`)
  check('exactly one daemon was spawned', spawnsSeen() - before === 1, `spawns=${spawnsSeen() - before}`)
  const rec = await cs.readSupervisorState()
  check('the new daemon holds the plane under its own pid, never the departed one', rec !== null && rec.pid !== old.pid && alive(rec.pid), `record=${JSON.stringify(rec)}`)
  const v = await hs.handshakeDaemon({ timeoutMs: 1500 })
  check('the new daemon answers the handshake matched', v.state === 'matched' && v.daemon?.pid === rec?.pid, `state=${v.state} pid=${v.daemon?.pid}`)
  console.log(`  record: the departure at +${departure - started}ms · the door resolved ${landed}ms after it`)
  await stopFixtures()
  planeClear()
}

section('§2 a slow daemon keeps its wait: no spawn, the daemon that answers late is the daemon used')
{
  resetClient()
  setRounds(12)
  const old = await startOldDaemon('slow-then-answer')
  const before = spawnsSeen()
  const ok = await ensure.ensureOwnedDaemon()
  check('the door resolves usable on the late answer', ok === true)
  check('the ladder walked at least two rounds (the first hello timed out)', old.hellos >= 2, `hellos=${old.hellos}`)
  check('nothing was spawned beside the slow daemon', spawnsSeen() === before, `spawns=${spawnsSeen() - before}`)
  const v = hs.lastDaemonHandshake()
  check('the verdict names the slow daemon itself', v?.state === 'matched' && v.daemon?.pid === old.pid, `state=${v?.state} pid=${v?.daemon?.pid}`)
  await old.leave({ mark: false })
  planeClear()
}

section('§3 two boots at once beside a departing daemon: one spawn, both doors usable')
{
  resetClient()
  setRounds(12)
  const old = await startOldDaemon('silent')
  const before = spawnsSeen()
  const both = Promise.all([ensure.ensureOwnedDaemon(), ensure.ensureOwnedDaemon()])
  await sleep(900)
  await old.leave()
  const [a, b] = await both
  check('both doors resolve usable', a === true && b === true, `${String(a)} ${String(b)}`)
  check('the two gestures cost one spawn (the single-flight guard)', spawnsSeen() - before === 1, `spawns=${spawnsSeen() - before}`)
  const rec = await cs.readSupervisorState()
  check('one daemon holds the plane', rec !== null && rec.pid !== old.pid && ledgerPids().filter(alive).length === 1, `alive fixtures=${ledgerPids().filter(alive).length}`)
  await stopFixtures()
  planeClear()
}

section('§3b two boots at once on an empty plane: one spawn')
{
  resetClient()
  setRounds(12)
  const before = spawnsSeen()
  const [a, b] = await Promise.all([ensure.ensureOwnedDaemon(), ensure.ensureOwnedDaemon()])
  check('both doors resolve usable', a === true && b === true, `${String(a)} ${String(b)}`)
  check('one spawn for the two gestures', spawnsSeen() - before === 1, `spawns=${spawnsSeen() - before}`)
  await stopFixtures()
  planeClear()
}

section('§4 the plane still held by the departing daemon: no spawn beside it; the spawn follows the clear')
{
  resetClient()
  setRounds(12)
  const holder = idler()
  await sleep(150)
  const pid = holder.pid ?? 0
  await cs.writeSupervisorState({
    pid,
    version: '1.0.0',
    origin: 'transient',
    startedAt: Date.now() - 5000,
    dir: ROOT,
    controlSock: cs.controlSockPath(),
    proto: MERCURY_DAEMON_PROTO,
    buildTree: null,
    ownerPid: null,
    foreground: false,
    startToken: null,
    state: 'stopping',
    stoppingAt: Date.now(),
  } as never)
  writeFileSync(LOCK, JSON.stringify({ owner: 'hermes-supervisor-old', pid, acquiredAt: Date.now() - 5000 }))
  const before = spawnsSeen()
  const pending = ensure.ensureOwnedDaemon()
  await sleep(800)
  check('no spawn while the departing daemon still holds its record and lock', spawnsSeen() === before, `spawns=${spawnsSeen() - before}`)
  unlinkSync(cs.supervisorStatePath())
  unlinkSync(LOCK)
  const cleared = Date.now()
  const ok = await pending
  check('the door resolves usable once the plane is clear', ok === true, `resolved ${String(ok)} ${Date.now() - cleared}ms after the clear`)
  check('one spawn followed the clear', spawnsSeen() - before === 1, `spawns=${spawnsSeen() - before}`)
  const rec = await cs.readSupervisorState()
  check('the new daemon took the plane over under its own pid', rec !== null && rec.pid !== pid, `record=${JSON.stringify(rec)}`)
  holder.kill('SIGKILL')
  await stopFixtures()
  planeClear()
}

section('§4b a live daemon whose socket vanished and came back: the door waits for it, no spawn')
{
  resetClient()
  setRounds(12)
  const old = await startOldDaemon('answer')
  await old.close()
  const before = spawnsSeen()
  const pending = ensure.ensureOwnedDaemon()
  await sleep(600)
  const back = await startOldDaemon('answer', { record: false, lock: false })
  const ok = await pending
  check('the door resolves usable on the re-bound socket', ok === true)
  check('nothing was spawned beside the daemon whose plane was still held', spawnsSeen() === before, `spawns=${spawnsSeen() - before}`)
  await back.close()
  await old.leave({ mark: false })
  planeClear()
}

section('§5 a wedged daemon that never leaves keeps its wait: the door answers false, nothing is spawned')
{
  resetClient()
  setRounds(6)
  const old = await startOldDaemon('silent')
  const before = spawnsSeen()
  const started = Date.now()
  const ok = await ensure.ensureOwnedDaemon()
  check('the door answers false after its rounds', ok === false, `resolved ${String(ok)} after ${Date.now() - started}ms`)
  check('no spawn beside a daemon that holds its pipe and its plane', spawnsSeen() === before, `spawns=${spawnsSeen() - before}`)
  check('the ladder walked its rounds against the pipe', old.hellos >= (roundsSeam ? 6 : 40), `hellos=${old.hellos}`)
  await old.leave({ mark: false })
  planeClear()
}

section("§6 the daemon's own mark: the record says stopping under its own pid, never under another's")
{
  await cs.writeSupervisorState({
    pid: process.pid,
    version: '1.0.0',
    origin: 'transient',
    startedAt: Date.now(),
    dir: ROOT,
    controlSock: cs.controlSockPath(),
    proto: MERCURY_DAEMON_PROTO,
    buildTree: null,
    ownerPid: null,
    foreground: false,
    startToken: null,
  })
  const mark = (cs as { markSupervisorStoppingSync?: () => boolean }).markSupervisorStoppingSync
  check('the mark exists on the control socket', typeof mark === 'function')
  const marked = mark ? mark() : false
  const rec = await cs.readSupervisorState()
  check('the mark lands on our own record', marked === true && rec?.pid === process.pid && (rec as { state?: string })?.state === 'stopping' && typeof (rec as { stoppingAt?: number })?.stoppingAt === 'number', JSON.stringify(rec))
  await cs.writeSupervisorState({ ...(rec as NonNullable<typeof rec>), pid: process.pid + 100000, state: undefined, stoppingAt: undefined } as never)
  const foreign = mark ? mark() : false
  const after = await cs.readSupervisorState()
  check("a record of another pid is never marked", foreign === false && (after as { state?: string })?.state === undefined, JSON.stringify(after))
  planeClear()
}

section('§7 source pins: the shutdown road marks before it closes; the ladder reads the plane; the halt stand-down precedes the spawn')
{
  const main = read('src/daemon/main.ts')
  const body = main.slice(main.indexOf('const shutdown = (signal: string) => {'), main.indexOf('const bail = setTimeout(() => process.exit(1), 15_000)'))
  const markAt = body.indexOf('markSupervisorStoppingSync()')
  const closeAt = body.indexOf('controlServer?.close()')
  check('the shutdown road marks its record before it closes the socket', markAt >= 0 && closeAt >= 0 && markAt < closeAt, `mark@${markAt} close@${closeAt}`)
  const sock = read('src/daemon/controlSocket.ts')
  check("the record's type carries the stopping state", sock.includes("state?: 'stopping'") && sock.includes('stoppingAt?: number'))
  check('the mark is ownership-checked', /markSupervisorStoppingSync[\s\S]{0,400}current\?\.pid !== process\.pid\) return false/.test(sock))
  const ens = read('src/services/switchboard/ensureDaemon.ts')
  check("the starting ladder reads the daemon's departure", ens.includes("if (v.state === 'absent' && (await planeHold()) === 'clear') return 'gone'"))
  check('a departure re-enters the door, which spawns through the one guard', ens.includes("if (outcome === 'gone') return ensureOwnedDaemon()"))
  check('the spawn waits for a held plane to clear', ens.includes("if ((await awaitDeparture(hs)) === 'usable') return true"))
  const haltAt = ens.indexOf('if (daemonHaltStanddownActive()) return false')
  const spawnAt = ens.indexOf('spawnOwnedDaemon(getCwd(), {')
  check('the halt stand-down still refuses before any spawn', haltAt >= 0 && spawnAt >= 0 && haltAt < spawnAt)
  check("the plane read names the record's stopping state", ens.includes("record.state === 'stopping' ? 'stopping' : 'held'"))
  const docs = read('docs/SESSIONS.md')
  check('the sessions page says a window opened beside a departing daemon waits the beat it takes to leave, then starts its own', docs.includes('waits the\nbeat it takes to leave, then starts its own') || docs.includes('waits the beat it takes to leave, then starts its own'))
}

await stopFixtures()
for (const c of spawned) {
  try {
    c.kill('SIGKILL')
  } catch {
    continue
  }
}
clearTimeout(guard)
try {
  rmSync(home, { recursive: true, force: true })
} catch {
  console.log(`  scratch kept: ${home}`)
}
console.log(`\n${failures === 0 ? 'prove-daemon-departure: ALL LAWS HOLD' : `prove-daemon-departure: ${failures} FAILURE(S)`}`)
process.exit(failures === 0 ? 0 : 1)
