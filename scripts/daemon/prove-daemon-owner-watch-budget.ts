#!/usr/bin/env bun
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, readdirSync, rmSync, statSync, unlinkSync } from 'node:fs'
import { connect as netConnect, type Socket } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const SCRATCH = mkdtempSync(join(tmpdir(), 'daemon-owner-watch-'))
const home = join(SCRATCH, 'home')
const daemonDir = join(SCRATCH, 'daemon')
const daemonDir2 = join(SCRATCH, 'daemon2')
const work = join(SCRATCH, 'work')
const censusDir = join(SCRATCH, 'census')
for (const d of [home, daemonDir, daemonDir2, work, censusDir]) mkdirSync(d, { recursive: true })

process.env.MERCURY_CONFIG_DIR = home
process.env.MERCURY_DAEMON_DIR = daemonDir
process.env.MERCURY_CREDENTIAL_STORE = 'file'
for (const k of [
  'MERCURY_HOME',
  'CI',
  'NODE_ENV',
  'NODE_OPTIONS',
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'ANTHROPIC_BASE_URL',
  'MERCURY_OAUTH_TOKEN',
  'MERCURY_DAEMON_OWNER_PID',
  'MERCURY_DAEMON_OWNER_FD',
  'MERCURY_DAEMON_PERSIST',
  'MERCURY_DAEMON_NO_SELF_WARM',
  'MERCURY_CHILD_RSS_LIMIT_MB',
  'DAEMON_CENSUS_DIR',
  'OPENAI_API_KEY',
  'OPENROUTER_API_KEY',
  'GEMINI_API_KEY',
  'GOOGLE_API_KEY',
  'ZAI_API_KEY',
]) {
  delete process.env[k]
}

const ROOT = process.cwd()
const DIST = join(ROOT, 'dist', 'mercury.mjs')
const CENSUS = join(ROOT, 'scripts', 'daemon', 'census-preload.cjs')
if (!existsSync(DIST)) {
  console.error('✗ dist/mercury.mjs missing — run `bun run build.ts` first')
  process.exit(1)
}
const NODE = process.execPath.includes('bun') ? 'node' : process.execPath
const POSIX = process.platform !== 'win32'

const { seedFirstRun } = await import('../lib/firstRunSeed.ts')
seedFirstRun(home, [work])
const ownerWatch = await import('../../src/daemon/ownerWatch.ts')
const { controlSockPath } = await import('../../src/daemon/controlSocket.ts')

const IDLE_MS = 120_000
const SETTLE_MS = 5_000
const SPAWN_BUDGET = 2
const FS_BUDGET = 30

const guard = setTimeout(() => {
  console.log('\n❌ TIMEOUT — daemon-owner-watch-budget exceeded 280s')
  process.exit(1)
}, 280_000)
guard.unref?.()

let failures = 0
const check = (label: string, cond: boolean, detail = ''): void => {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}
const section = (t: string): void => console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
const wait = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms))
async function until(cond: () => boolean, ms: number): Promise<boolean> {
  const deadline = Date.now() + ms
  for (;;) {
    if (cond()) return true
    if (Date.now() > deadline) return false
    await wait(100)
  }
}
const read = (p: string): string => {
  try {
    return readFileSync(p, 'utf8')
  } catch {
    return ''
  }
}

function spawnOwner(): ChildProcess {
  return spawn(NODE, ['-e', 'setInterval(() => {}, 1 << 30)'], { stdio: 'ignore' })
}

const logPath = join(SCRATCH, 'daemon.log')
function bootDaemon(ownerPid: number): { child: ChildProcess; exited: Promise<number | null> } {
  const logFd = openSync(logPath, 'a')
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    MERCURY_CONFIG_DIR: home,
    MERCURY_DAEMON_DIR: daemonDir,
    MERCURY_CREDENTIAL_STORE: 'file',
    MERCURY_DAEMON_OWNER_PID: String(ownerPid),
    NODE_OPTIONS: `--require=${CENSUS}`,
    DAEMON_CENSUS_DIR: censusDir,
  }
  const child = spawn(NODE, [DIST, 'daemon', 'run', work], { cwd: work, env, stdio: ['ignore', logFd, logFd] })
  const exited = new Promise<number | null>(r => child.once('exit', code => r(code)))
  return { child, exited }
}

interface CensusLine {
  t: number
  spawns: Array<{ t: number; kind: string; cmd: string; args: string[] }>
  fs: Record<string, Record<string, number>>
  fd: Record<string, Record<string, number>>
}
function readCensus(pid: number): CensusLine[] {
  return read(join(censusDir, `census-${pid}.jsonl`))
    .split('\n')
    .filter(Boolean)
    .map(l => JSON.parse(l) as CensusLine)
}
interface Window {
  spawns: Array<{ t: number; kind: string; cmd: string; args: string[] }>
  fsOps: number
  fsByFn: Record<string, number>
  fsByPath: Record<string, number>
  fdOps: number
  flushedTo: number
}
function censusWindow(lines: CensusLine[], fromMs: number, toMs: number): Window {
  const fromSec = Math.floor(fromMs / 1000)
  const toSec = Math.floor(toMs / 1000)
  const w: Window = { spawns: [], fsOps: 0, fsByFn: {}, fsByPath: {}, fdOps: 0, flushedTo: 0 }
  for (const line of lines) {
    w.flushedTo = Math.max(w.flushedTo, line.t)
    for (const s of line.spawns) if (s.t >= fromMs && s.t < toMs) w.spawns.push(s)
    for (const [secText, bucket] of Object.entries(line.fs)) {
      const sec = Number(secText)
      if (sec < fromSec || sec >= toSec) continue
      for (const [key, n] of Object.entries(bucket)) {
        w.fsOps += n
        const fn = key.slice(0, key.indexOf(' '))
        w.fsByFn[fn] = (w.fsByFn[fn] ?? 0) + n
        w.fsByPath[key] = (w.fsByPath[key] ?? 0) + n
      }
    }
    for (const [secText, bucket] of Object.entries(line.fd)) {
      const sec = Number(secText)
      if (sec < fromSec || sec >= toSec) continue
      for (const n of Object.values(bucket)) w.fdOps += n
    }
  }
  return w
}
const top = (table: Record<string, number>, n: number): string =>
  Object.entries(table)
    .sort((a, b) => b[1] - a[1])
    .slice(0, n)
    .map(([k, v]) => `${v}× ${k}`)
    .join('\n      ')

section('§1 THE BUDGET — the real daemon idles 120 s under the census')
const owner = spawnOwner()
await wait(300)
check('the owner process is alive', owner.pid !== undefined && ownerWatch.isProcessAlive(owner.pid))
const ownerPid = owner.pid ?? 0
const daemon = bootDaemon(ownerPid)
const daemonPid = daemon.child.pid ?? 0
const ready = await until(() => read(logPath).includes('[daemon] control socket up'), 60_000)
check('the daemon booted to its control socket', ready, read(logPath).slice(-800))
await wait(SETTLE_MS)
const idleFrom = Date.now()
console.log(`  idling ${IDLE_MS / 1000}s (daemon pid ${daemonPid}, owner pid ${ownerPid})…`)
await wait(IDLE_MS)
const idleTo = Date.now()
await until(() => readCensus(daemonPid).some(l => l.t >= idleTo), 10_000)
const win = censusWindow(readCensus(daemonPid), idleFrom, idleTo)
check('the daemon is still alive after the idle window (the owner lives)', ownerWatch.isProcessAlive(daemonPid))
check('the census covered the whole window', win.flushedTo >= idleTo, `flushed to ${win.flushedTo} < ${idleTo}`)
console.log(`  spawns in the window: ${win.spawns.length}`)
if (win.spawns.length > 0) {
  const byCmd: Record<string, number> = {}
  for (const s of win.spawns) {
    const k = `${s.kind} ${s.cmd} ${s.args.slice(0, 3).join(' ')}`
    byCmd[k] = (byCmd[k] ?? 0) + 1
  }
  console.log(`      ${top(byCmd, 8)}`)
}
console.log(`  file operations in the window: ${win.fsOps} (fd reads/writes beside them: ${win.fdOps})`)
if (win.fsOps > 0) {
  console.log(`      by function:\n      ${top(win.fsByFn, 12)}`)
  console.log(`      by path:\n      ${top(win.fsByPath, 12)}`)
}
check(`≤ ${SPAWN_BUDGET} spawns in 120 s of idle`, win.spawns.length <= SPAWN_BUDGET, `${win.spawns.length} spawns`)
check(`≤ ${FS_BUDGET} file operations in 120 s of idle`, win.fsOps <= FS_BUDGET, `${win.fsOps} file operations`)
check(
  'every spawn in the window is the identity probe, none the beat',
  win.spawns.every(s => (POSIX ? s.cmd === 'ps' && s.args[0] === '-o' && s.args[1] === 'lstart=' : true)),
  win.spawns.map(s => `${s.cmd} ${s.args.join(' ')}`).join(' · '),
)
check('no record or delta file was rewritten at idle', !Object.keys(win.fsByPath).some(k => /rename|writeFile|openSync .*\.tmp/.test(k)), top(win.fsByPath, 6))

interface Lease {
  sock: Socket
  connected: boolean
  closed: boolean
}
function openLease(path: string): Promise<Lease> {
  return new Promise(resolve => {
    const lease: Lease = { sock: netConnect(path), connected: false, closed: false }
    lease.sock.on('error', () => {})
    lease.sock.once('connect', () => {
      lease.connected = true
      resolve(lease)
    })
    lease.sock.once('close', () => {
      lease.closed = true
      resolve(lease)
    })
  })
}

section('§2 THE HEAL FOLLOWS THE WATCH — the control socket removed comes back within seconds, once')
if (POSIX) {
  const sock = controlSockPath()
  check('the control socket is where the daemon says it is', existsSync(sock), sock)
  const old = await openLease(sock)
  check('a lease on the current bind is open (the witness for the heal)', old.connected && !old.closed)
  unlinkSync(sock)
  const removedAt = Date.now()
  const healed = await until(() => existsSync(sock), 10_000)
  const healMs = Date.now() - removedAt
  console.log(`  socket back after ${healMs} ms`)
  check('the socket came back', healed)
  check('…from the watch, well under the 30 s floor (≤ 3000 ms)', healed && healMs <= 3_000, `${healMs} ms`)
  check('…as a socket node, not a stray file', healed && statSync(sock).isSocket())
  const oldDied = await until(() => old.closed, 3_000)
  check('…as a new bind: the lease on the removed bind died (rebind destroys every open connection before it binds again)', healed && old.connected && oldDied)
  old.sock.destroy()
  const fresh = await openLease(sock)
  check('the re-bound socket accepts a lease', fresh.connected && !fresh.closed)
  await wait(3_000)
  check('…once: the lease on the new bind holds for the next seconds (no second rebind)', fresh.connected && !fresh.closed && existsSync(sock) && statSync(sock).isSocket())
  fresh.sock.destroy()
  const { daemonControlRpc } = await import('../../src/daemon/controlSocket.ts')
  const status = await daemonControlRpc({ op: 'status' } as never, { timeoutMs: 5_000 }).catch(e => ({ error: String(e) }))
  check('the plane answers on the re-bound socket', typeof status === 'object' && status !== null && !('error' in (status as Record<string, unknown>)), JSON.stringify(status).slice(0, 200))
  check('…and it is the daemon we booted (the status pid)', (status as { status?: { pid?: number } }).status?.pid === daemonPid, JSON.stringify(status).slice(0, 200))
} else {
  console.log('  (win32: a named pipe cannot be unlinked from under its listener — the key/state halves keep the heal; not staged here)')
}

section('§3 THE REAP LATENCY — the owner killed ⇒ the daemon exits within the grace (the pid road)')
const graceMs = ownerWatch.OWNER_WATCH_INTERVAL_MS * ownerWatch.OWNER_WATCH_GRACE_CHECKS
const reapCeilingMs = graceMs + ownerWatch.OWNER_WATCH_INTERVAL_MS + 1_000
const killedAt = Date.now()
owner.kill('SIGKILL')
const exitCode = await Promise.race([daemon.exited, wait(reapCeilingMs + 10_000).then(() => 'still-running' as const)])
const reapMs = Date.now() - killedAt
console.log(`  reaped in ${reapMs} ms (exit ${String(exitCode)}); grace ${graceMs} ms + one beat of phase + 1 s = ${reapCeilingMs} ms`)
check('the daemon exited after its owner died', exitCode !== 'still-running')
check(`the reap landed within the grace (≤ ${reapCeilingMs} ms)`, exitCode !== 'still-running' && reapMs <= reapCeilingMs, `${reapMs} ms`)
check('the daemon log names the orphaned owner and the road', read(logPath).includes(`owner pid ${ownerPid} gone (owner-gone)`), read(logPath).slice(-600))
if (exitCode === 'still-running') {
  try {
    daemon.child.kill('SIGKILL')
  } catch {
  }
}

section('§4 THE OWNER PIPE — EOF reaps the daemon while the owner pid still lives')
if (POSIX) {
  const HELPER = `
const { spawn } = require('node:child_process')
const fs = require('node:fs')
const [dist, work, logPath] = process.argv.slice(1)
const logFd = fs.openSync(logPath, 'a')
const child = spawn(process.execPath, [dist, 'daemon', 'run', work], {
  cwd: work,
  env: { ...process.env, MERCURY_DAEMON_OWNER_PID: String(process.pid), MERCURY_DAEMON_OWNER_FD: '3' },
  stdio: ['ignore', logFd, logFd, 'pipe'],
})
const pipe = child.stdio[3]
pipe.on('error', () => {})
// The helper outlives the daemon on purpose: it IS the owner pid, and the
// pin is that the daemon reaped while this pid still answered.
child.on('exit', code => {
  console.log(JSON.stringify({ event: 'exit', code, at: Date.now() }))
})
console.log(JSON.stringify({ event: 'spawned', pid: child.pid, helper: process.pid }))
process.stdin.on('data', d => {
  if (String(d).includes('eof')) {
    console.log(JSON.stringify({ event: 'eof', at: Date.now() }))
    pipe.destroy()
  }
})
process.stdin.resume()
`
  const logPath2 = join(SCRATCH, 'daemon2.log')
  const helper = spawn(NODE, ['-e', HELPER, DIST, work, logPath2], {
    cwd: work,
    env: { ...process.env, MERCURY_CONFIG_DIR: home, MERCURY_DAEMON_DIR: daemonDir2, MERCURY_CREDENTIAL_STORE: 'file' },
    stdio: ['pipe', 'pipe', 'inherit'],
  })
  const events: Array<Record<string, unknown>> = []
  let buffer = ''
  helper.stdout?.on('data', d => {
    buffer += String(d)
    const lines = buffer.split('\n')
    buffer = lines.pop() ?? ''
    for (const l of lines) {
      try {
        events.push(JSON.parse(l) as Record<string, unknown>)
      } catch {
      }
    }
  })
  const eventOf = (name: string): Record<string, unknown> | undefined => events.find(e => e.event === name)
  const spawned = await until(() => eventOf('spawned') !== undefined, 10_000)
  check('the helper spawned a daemon with the owner pipe', spawned)
  const ready2 = await until(() => read(logPath2).includes('[daemon] control socket up'), 60_000)
  check('the piped daemon booted to its control socket', ready2, read(logPath2).slice(-800))
  await wait(1_000)
  check('the owner pipe armed (no unarmed line in the log)', !read(logPath2).includes('owner pipe not armed'), read(logPath2).slice(-400))
  const helperPid = Number(eventOf('spawned')?.helper ?? 0)
  check('the helper (the owner pid) is alive before the EOF', helperPid > 0 && ownerWatch.isProcessAlive(helperPid))
  helper.stdin?.write('eof\n')
  const eofCeilingMs = ownerWatch.OWNER_WATCH_INTERVAL_MS * ownerWatch.OWNER_WATCH_GRACE_CHECKS + 1_000
  const exited2 = await until(() => eventOf('exit') !== undefined, eofCeilingMs + 10_000)
  const eofAt = Number(eventOf('eof')?.at ?? 0)
  const exitAt = Number(eventOf('exit')?.at ?? 0)
  const eofReapMs = exited2 ? exitAt - eofAt : -1
  console.log(`  reaped ${eofReapMs} ms after the EOF (ceiling ${eofCeilingMs} ms); the owner pid was alive the whole time`)
  check('the piped daemon exited after the EOF', exited2)
  check(`…within an immediate beat plus the grace (≤ ${eofCeilingMs} ms)`, exited2 && eofReapMs >= 0 && eofReapMs <= eofCeilingMs, `${eofReapMs} ms`)
  check('the daemon log names the pipe road', read(logPath2).includes(`owner pid ${helperPid} gone (owner-pipe-eof)`), read(logPath2).slice(-600))
  check('the owner pid was still alive at the reap (the pipe, not the pid, said gone)', helperPid > 0 && ownerWatch.isProcessAlive(helperPid))
  helper.kill('SIGKILL')
} else {
  console.log('  (win32: the owner pipe is a POSIX road; the beat and the minute identity probe watch alone)')
}

interface Rig {
  handle: ReturnType<typeof ownerWatch.startOwnerWatch>
  lines: string[]
  reaped: string[]
  tokens: number
  tick(n: number): Promise<void>
  set(patch: Partial<{ alive: boolean; token: string | null }>): void
}
function rig(opts: { baseline?: string | null } = {}): Rig {
  let clock = 1_000_000
  let alive = true
  let token: string | null = 'token-A'
  const lines: string[] = []
  const reaped: string[] = []
  const r: Rig = {
    handle: ownerWatch.startOwnerWatch({
      ownerPid: 4242,
      baselineToken: opts.baseline === undefined ? 'token-A' : opts.baseline,
      alive: () => alive,
      probeToken: async () => {
        r.tokens++
        return token
      },
      now: () => clock,
      schedule: false,
      log: l => lines.push(l),
      onOrphan: why => reaped.push(why),
    }),
    lines,
    reaped,
    tokens: 0,
    tick: async (n: number) => {
      for (let i = 0; i < n; i++) {
        clock += ownerWatch.OWNER_WATCH_INTERVAL_MS
        await r.handle.beat()
      }
    },
    set: patch => {
      if (patch.alive !== undefined) alive = patch.alive
      if (patch.token !== undefined) token = patch.token
    },
  }
  return r
}
const beatsPerFloor = ownerWatch.OWNER_IDENTITY_FLOOR_MS / ownerWatch.OWNER_WATCH_INTERVAL_MS

section('§5 PID REUSE — caught at the identity floor, confirmed on the next beat, then reaped')
{
  const r = rig()
  await r.tick(beatsPerFloor - 1)
  check('no probe before the floor', r.tokens === 0, `${r.tokens} probes`)
  await r.tick(1)
  check('one probe at the floor (the owner still matches)', r.tokens === 1 && r.reaped.length === 0, `${r.tokens} probes`)
  r.set({ token: 'token-B' })
  await r.tick(beatsPerFloor - 1)
  check('the beat spawns nothing between floors even with the pid reused', r.tokens === 1 && r.reaped.length === 0)
  await r.tick(1)
  check('the floor probe reads the new token — one dead beat, no reap yet', r.tokens === 2 && r.handle.facts().identityLost && r.handle.facts().deadStreak === 1 && r.reaped.length === 0)
  await r.tick(1)
  check('the next beat re-probes (the grace confirms it) and reaps as owner-replaced', r.tokens === 3 && r.reaped.join() === 'owner-replaced', `${r.tokens} probes; reaped=${r.reaped.join()}`)
  check('the watch stops after the reap (no further beats act)', r.handle.facts().reaped === 'owner-replaced')
}
{
  const r = rig()
  await r.tick(beatsPerFloor)
  r.set({ token: 'token-B' })
  await r.tick(beatsPerFloor)
  check('a mismatch stands one beat', r.handle.facts().deadStreak === 1 && r.reaped.length === 0)
  r.set({ token: 'token-A' })
  await r.tick(1)
  check('…and a matching confirmation clears it — a glitch never reaps', r.handle.facts().deadStreak === 0 && !r.handle.facts().identityLost && r.reaped.length === 0)
  r.handle.stop()
}
{
  const r = rig({ baseline: null })
  await r.tick(beatsPerFloor * 3)
  check('no usable baseline ⇒ the probe never runs (pid liveness alone)', r.tokens === 0 && r.reaped.length === 0)
  r.set({ alive: false })
  await r.tick(ownerWatch.OWNER_WATCH_GRACE_CHECKS)
  check('…and a gone pid still reaps after the grace', r.reaped.join() === 'owner-gone')
}

section('§6 A PROBE THAT CANNOT RUN — logs once, backs off four floors, liveness keeps watching')
{
  const r = rig()
  r.set({ token: null })
  await r.tick(beatsPerFloor)
  check('the floor probe could not run: one line in the log', r.tokens === 1 && r.lines.length === 1 && r.lines[0]!.includes('could not run'), r.lines.join(' | '))
  const backoffFloors = ownerWatch.OWNER_PROBE_BACKOFF_FACTOR
  await r.tick(beatsPerFloor * backoffFloors - 1)
  check(`no retry inside the back-off (${backoffFloors} floors)`, r.tokens === 1 && r.lines.length === 1, `${r.tokens} probes, ${r.lines.length} lines`)
  check('the daemon still reads the owner as alive (fail safe)', r.reaped.length === 0 && r.handle.facts().deadStreak === 0)
  await r.tick(1)
  check('the probe tries again once the back-off ends', r.tokens === 2)
  check('a second failure adds no second line (logged once per streak)', r.lines.length === 1, r.lines.join(' | '))
  r.set({ token: 'token-A' })
  await r.tick(beatsPerFloor * backoffFloors)
  check('a probe that answers again says so once and resets the back-off', r.tokens === 3 && r.lines.length === 2 && r.lines[1]!.includes('answers again') && r.handle.facts().backoffUntil === 0, r.lines.join(' | '))
  r.handle.stop()
}
{
  const r = rig()
  r.set({ token: null })
  await r.tick(beatsPerFloor)
  r.set({ alive: false })
  await r.tick(ownerWatch.OWNER_WATCH_GRACE_CHECKS)
  check('a gone pid reaps during the back-off — the beat never stopped watching', r.reaped.join() === 'owner-gone' && r.tokens === 1)
}

section('§7 THE FLOOR — 120 s of beats cost at most two identity probes')
{
  const r = rig()
  await r.tick(Math.floor(120_000 / ownerWatch.OWNER_WATCH_INTERVAL_MS))
  check('≤ 2 probes in 120 s of beats', r.tokens <= 2 && r.tokens >= 1, `${r.tokens} probes`)
  check('the owner reads alive throughout', r.reaped.length === 0 && r.handle.facts().deadStreak === 0)
  r.handle.stop()
}

section('§8 THE PIPE EOF — an immediate beat, the grace, then owner-pipe-eof')
{
  const r = rig()
  await r.tick(2)
  r.handle.ownerPipeClosed()
  await wait(10)
  check('the EOF beats at once: one dead beat, no reap yet', r.handle.facts().pipeClosed && r.handle.facts().deadStreak === 1 && r.reaped.length === 0)
  await r.tick(ownerWatch.OWNER_WATCH_GRACE_CHECKS - 1)
  check('the next beat completes the grace and reaps as owner-pipe-eof (the pid still alive, the token still matching)', r.reaped.join() === 'owner-pipe-eof' && r.tokens === 0)
}

section('§9 THE WIRING — source pins')
{
  const main = read(join(ROOT, 'src/daemon/main.ts'))
  const owned = read(join(ROOT, 'src/daemon/ownedDaemon.ts'))
  const registry = read(join(ROOT, 'src/substrate/flagRegistry.ts'))
  const ticker = read(join(ROOT, 'src/daemon/saturnTicker.ts'))
  check('the daemon wires the one owner watch and the owner pipe', main.includes('ownerWatch = startOwnerWatch({') && main.includes('armOwnerPipe(ownerFd'))
  check('no beat-cadence probe survives in the daemon (the beat is the watch\'s own)', !/setInterval\([^)]*OWNER_WATCH_INTERVAL_MS/.test(main) && !main.includes('getProcessStartTokenAsync(ownerPid)'))
  check('the spawner passes the owner pipe at stdio index 3 on POSIX and stamps its fd', owned.includes("['ignore', outFd, outFd, 'pipe']") && owned.includes('flagPair(OWNER_FD_ENV, String(OWNER_PIPE_STDIO_INDEX))') && owned.includes("process.platform !== 'win32'"))
  check('the spawner holds its pipe end unref\'d for its whole life', owned.includes('pipeEnd.unref()') && owned.includes('ownerPipeEnds.add(pipeEnd)'))
  check('the registry names the owner-fd stamp', registry.includes("env: 'MERCURY_DAEMON_OWNER_FD'"))
  check('the plane heal runs on its directory watch with a 30 s floor', main.includes('const PLANE_HEAL_FLOOR_MS = 30_000') && main.includes('watchDir(planeDir, { persistent: false }') && main.includes('}, PLANE_HEAL_FLOOR_MS)'))
  check('the reconcile tick keeps the minute floor behind a change gate', main.includes('const RECONCILE_TICK_MS = 60_000') && main.includes('stamp !== reconcileRecordsStamp || reconcileHadLive'))
  check('the Saturn ticker gates its walk on the stores\' move stamps', ticker.includes('if (pending === 0 && stamp === storeStamp) return') && ticker.includes('export function saturnStoreStamp'))
  check('the identity floor is the minute and the back-off four floors', ownerWatch.OWNER_IDENTITY_FLOOR_MS === 60_000 && ownerWatch.OWNER_PROBE_BACKOFF_FACTOR === 4)
  check('the beat and the grace stand where they were', ownerWatch.OWNER_WATCH_INTERVAL_MS === 4000 && ownerWatch.OWNER_WATCH_GRACE_CHECKS === 2)
}

console.log('\n' + '═'.repeat(76))
if (failures === 0) {
  console.log('✅ prove-daemon-owner-watch-budget: ALL PASS')
  rmSync(SCRATCH, { recursive: true, force: true })
} else {
  console.log(`❌ prove-daemon-owner-watch-budget: ${failures} FAIL — scratch kept at ${SCRATCH}`)
  console.log(`   census files: ${readdirSync(censusDir).join(', ')}`)
}
clearTimeout(guard)
process.exit(failures === 0 ? 0 : 1)
