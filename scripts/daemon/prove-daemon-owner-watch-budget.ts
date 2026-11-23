#!/usr/bin/env bun
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync, lstatSync, mkdirSync, mkdtempSync, openSync, readFileSync, readdirSync, readlinkSync, rmSync, statSync, unlinkSync } from 'node:fs'
import { connect as netConnect, type Socket } from 'node:net'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'

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
const VENDORED_NODE = join(ROOT, 'dist', 'vendor', 'node', ...(process.platform === 'win32' ? ['node.exe'] : ['bin', 'node']))
const NODE = existsSync(VENDORED_NODE) ? VENDORED_NODE : 'node'
const POSIX = process.platform !== 'win32'

const { seedFirstRun } = await import('../lib/firstRunSeed.ts')
seedFirstRun(home, [work])
const ownerWatch = await import('../../src/daemon/control/ownerWatch.ts')
const { controlSockPath } = await import('../../src/daemon/control/controlSocket.ts')
const { getFlagSpec } = await import('../../src/platform/substrate/flagRegistry.ts')

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
check('the daemon booted to its control socket', ready, read(logPath).slice(-800) + ' — the daemon never logged "[daemon] control socket up" (src/daemon/control/main.ts); read the log tail above and rebuild with `bun run build.ts` if dist is stale')
await wait(SETTLE_MS)
const idleFrom = Date.now()
console.log(`  idling ${IDLE_MS / 1000}s (daemon pid ${daemonPid}, owner pid ${ownerPid})…`)
await wait(IDLE_MS)
const idleTo = Date.now()
await until(() => readCensus(daemonPid).some(l => l.t >= idleTo), 10_000)
const win = censusWindow(readCensus(daemonPid), idleFrom, idleTo)
check('the daemon is still alive after the idle window (the owner lives)', ownerWatch.isProcessAlive(daemonPid))
check('the census covered the whole window', win.flushedTo >= idleTo, `flushed to ${win.flushedTo} < ${idleTo} — the census preload scripts/daemon/census-preload.cjs did not flush its last line; check the census-<pid>.jsonl file in the kept scratch census dir`)
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
check(`≤ ${SPAWN_BUDGET} spawns in 120 s of idle`, win.spawns.length <= SPAWN_BUDGET, `${win.spawns.length} spawns — see the spawn list printed above; an idle daemon should only run the identity probe, so find the new child_process spawn in the idle path (startOwnerWatch in src/daemon/control/ownerWatch.ts, or a timer in src/daemon/run/)`)
check(`≤ ${FS_BUDGET} file operations in 120 s of idle`, win.fsOps <= FS_BUDGET, `${win.fsOps} file operations — see the by-function and by-path tables printed above; remove or slow the idle timer that touches the top path (the owner watch in src/daemon/control/ownerWatch.ts and the beats in src/daemon/run/)`)
check(
  'every spawn in the window is the identity probe, none the beat',
  win.spawns.every(s => (POSIX ? s.cmd === 'ps' && s.args[0] === '-o' && s.args[1] === 'lstart=' : true)),
  win.spawns.map(s => `${s.cmd} ${s.args.join(' ')}`).join(' · ') + ' — only the owner identity probe (`ps -o lstart=`) may spawn at idle; the owner beat in startOwnerWatch (src/daemon/control/ownerWatch.ts) must test liveness without spawning',
)
check('no record or delta file was rewritten at idle', !Object.keys(win.fsByPath).some(k => /rename|writeFile|openSync .*\.tmp/.test(k)), top(win.fsByPath, 6) + ' — an idle daemon rewrote its record or a delta file; find the writer named in the paths above and make it skip an unchanged write')

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

section('§2 THE HEAL FOLLOWS THE WATCH — the plane link removed comes back within seconds, once')
if (POSIX) {
  const sock = controlSockPath()
  check('the control socket is where the daemon says it is', existsSync(sock), sock + ' is missing — the daemon did not publish its plane link; see startControlServer and publishSocket in src/daemon/control/controlServer.ts')
  check("…a link to the daemon's own socket, named by its pid", lstatSync(sock).isSymbolicLink() && readlinkSync(sock) === `${basename(sock)}.${daemonPid}` && statSync(join(dirname(sock), readlinkSync(sock))).isSocket(), `${sock} → ${lstatSync(sock).isSymbolicLink() ? readlinkSync(sock) : 'not a link'} — the plane path must be a symlink to control.sock.<daemon pid>; see publishSocket in startControlServer (src/daemon/control/controlServer.ts)`)
  const old = await openLease(sock)
  check('a lease through the plane is open (the witness for the heal)', old.connected && !old.closed)
  unlinkSync(sock)
  const removedAt = Date.now()
  const healed = await until(() => existsSync(sock), 10_000)
  const healMs = Date.now() - removedAt
  console.log(`  plane link back after ${healMs} ms`)
  check('the plane came back', healed, 'the removed plane link was not restored within 10 s — see healCheck in src/daemon/run/heal.ts and rebind in src/daemon/control/controlServer.ts')
  check('…from the watch, well under the 30 s floor (≤ 3000 ms)', healed && healMs <= 3_000, `${healMs} ms — the heal must run off the owner watch beat, not wait for the 30 s floor; see healCheck and its triggers in src/daemon/run/heal.ts`)
  check("…as a link to the same socket node, not a stray file", healed && lstatSync(sock).isSymbolicLink() && statSync(sock).isSocket() && readlinkSync(sock) === `${basename(sock)}.${daemonPid}`, (healed ? readlinkSync(sock) : 'absent') + ' — the heal must republish a symlink to the daemon own socket, see publishSocket in src/daemon/control/controlServer.ts')
  await wait(1_000)
  check("…without a new bind: the lease open across the heal survives it (the daemon's own socket never moved)", healed && old.connected && !old.closed, 'the heal re-bound the daemon socket and dropped the open lease; it must only republish the link (rebind in src/daemon/control/controlServer.ts, healCheck in src/daemon/run/heal.ts)')
  old.sock.destroy()
  const fresh = await openLease(sock)
  check('the healed plane accepts a lease', fresh.connected && !fresh.closed, 'a connect through the healed link failed; check the link target in publishSocket (src/daemon/control/controlServer.ts)')
  await wait(3_000)
  check('…once: the lease through the healed plane holds for the next seconds (no second heal)', fresh.connected && !fresh.closed && existsSync(sock) && statSync(sock).isSocket(), 'the plane was healed a second time or the lease dropped; healCheck in src/daemon/run/heal.ts must heal once')
  fresh.sock.destroy()
  const { daemonControlRpc } = await import('../../src/daemon/control/controlSocket.ts')
  const status = await daemonControlRpc({ op: 'status' } as never, { timeoutMs: 5_000 }).catch(e => ({ error: String(e) }))
  check('the plane answers through the healed link', typeof status === 'object' && status !== null && !('error' in (status as Record<string, unknown>)), JSON.stringify(status).slice(0, 200) + ' — daemonControlRpc (src/daemon/control/controlSocket.ts) got no answer through the healed link; see publishSocket in src/daemon/control/controlServer.ts')
  check('…and it is the daemon we booted (the status pid)', (status as { status?: { pid?: number } }).status?.pid === daemonPid, JSON.stringify(status).slice(0, 200) + ' — the plane link points at another daemon pid; see publishSocket in src/daemon/control/controlServer.ts')
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
check('the daemon exited after its owner died', exitCode !== 'still-running', 'the daemon outlived its killed owner; see armOwnerWatch and onOrphan in src/daemon/run/owner.ts and startOwnerWatch in src/daemon/control/ownerWatch.ts')
check(`the reap landed within the grace (≤ ${reapCeilingMs} ms)`, exitCode !== 'still-running' && reapMs <= reapCeilingMs, `${reapMs} ms — the reap is slower than OWNER_WATCH_INTERVAL_MS * OWNER_WATCH_GRACE_CHECKS plus one beat (src/daemon/control/ownerWatch.ts); check the beat and the shutdown path in src/daemon/run/owner.ts`)
check('the daemon log names the orphaned owner and the road', read(logPath).includes(`owner pid ${ownerPid} gone (owner-gone)`), read(logPath).slice(-600) + ' — onOrphan in armOwnerWatch (src/daemon/run/owner.ts) must log "owner pid N gone (<why>)"')
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
const [node, dist, work, logPath] = process.argv.slice(1)
const logFd = fs.openSync(logPath, 'a')
const child = spawn(node, [dist, 'daemon', 'run', work], {
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
  const helper = spawn(NODE, ['-e', HELPER, NODE, DIST, work, logPath2], {
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
  check('the helper spawned a daemon with the owner pipe', spawned, 'the helper script (HELPER in this file) printed no spawned event within 10 s; see its stderr above')
  const ready2 = await until(() => read(logPath2).includes('[daemon] control socket up'), 60_000)
  check('the piped daemon booted to its control socket', ready2, read(logPath2).slice(-800) + ' — the piped daemon never logged "[daemon] control socket up" (src/daemon/control/main.ts); read the log tail above')
  await wait(1_000)
  check('the owner pipe armed (no unarmed line in the log)', !read(logPath2).includes('owner pipe not armed'), read(logPath2).slice(-400) + ' — armOwnerPipe (src/daemon/control/ownerWatch.ts) refused fd 3; see the reason in the log tail and armOwnerWatch in src/daemon/run/owner.ts')
  const helperPid = Number(eventOf('spawned')?.helper ?? 0)
  check('the helper (the owner pid) is alive before the EOF', helperPid > 0 && ownerWatch.isProcessAlive(helperPid), 'the HELPER script in this file exited or reported no pid; see its output above')
  helper.stdin?.write('eof\n')
  const eofCeilingMs = ownerWatch.OWNER_WATCH_INTERVAL_MS * ownerWatch.OWNER_WATCH_GRACE_CHECKS + 1_000
  const exited2 = await until(() => eventOf('exit') !== undefined, eofCeilingMs + 10_000)
  const eofAt = Number(eventOf('eof')?.at ?? 0)
  const exitAt = Number(eventOf('exit')?.at ?? 0)
  const eofReapMs = exited2 ? exitAt - eofAt : -1
  console.log(`  reaped ${eofReapMs} ms after the EOF (ceiling ${eofCeilingMs} ms); the owner pid was alive the whole time`)
  check('the piped daemon exited after the EOF', exited2, 'the daemon outlived the closed owner pipe; see armOwnerPipe and ownerPipeClosed in src/daemon/control/ownerWatch.ts and armOwnerWatch in src/daemon/run/owner.ts')
  check(`…within an immediate beat plus the grace (≤ ${eofCeilingMs} ms)`, exited2 && eofReapMs >= 0 && eofReapMs <= eofCeilingMs, `${eofReapMs} ms — ownerPipeClosed must beat at once, then the grace (OWNER_WATCH_GRACE_CHECKS in src/daemon/control/ownerWatch.ts)`)
  check('the daemon log names the pipe road', read(logPath2).includes(`owner pid ${helperPid} gone (owner-pipe-eof)`), read(logPath2).slice(-600) + ' — onOrphan in armOwnerWatch (src/daemon/run/owner.ts) must log the pipe road as owner-pipe-eof')
  check('the owner pid was still alive at the reap (the pipe, not the pid, said gone)', helperPid > 0 && ownerWatch.isProcessAlive(helperPid), 'the helper owner pid died before the reap, so the pipe road was not proved; see the HELPER script in this file')
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

section('§5 PID REUSE — the token is read again only when liveness moved: a pid that comes back wearing another token is a stranger')
{
  const r = rig()
  await r.tick(beatsPerFloor * 3)
  check('three minutes of beats with a live owner cost no probe at all', r.tokens === 0 && r.reaped.length === 0, `${r.tokens} probes — startOwnerWatch in src/daemon/control/ownerWatch.ts must read the start token only when liveness moved`)
  r.set({ alive: false })
  await r.tick(1)
  check('one dead beat, no reap yet', r.handle.facts().deadStreak === 1 && r.reaped.length === 0, 'the beat in startOwnerWatch (src/daemon/control/ownerWatch.ts) must count one dead beat and wait for OWNER_WATCH_GRACE_CHECKS')
  r.set({ alive: true, token: 'token-B' })
  await r.tick(1)
  check('the pid came back: one probe reads the stranger, the grace completes, reaped as owner-replaced', r.tokens === 1 && r.handle.facts().identityLost && r.reaped.join() === 'owner-replaced', `${r.tokens} probes; reaped=${r.reaped.join()} — startOwnerWatch in src/daemon/control/ownerWatch.ts must probe once on the liveness move and reap as owner-replaced when the token differs`)
  check('the watch stops after the reap (no further beats act)', r.handle.facts().reaped === 'owner-replaced', 'startOwnerWatch in src/daemon/control/ownerWatch.ts must stop acting once reaped is set')
}
{
  const r = rig()
  r.set({ alive: false })
  await r.tick(1)
  r.set({ alive: true })
  await r.tick(1)
  check('a pid that comes back with the SAME token was a liveness glitch — one probe, no reap, the streak clears', r.tokens === 1 && !r.handle.facts().identityLost && r.handle.facts().deadStreak === 0 && r.reaped.length === 0, 'startOwnerWatch in src/daemon/control/ownerWatch.ts must clear the dead streak and not reap when the token matches the baseline')
  await r.tick(beatsPerFloor)
  check('…and no probe follows on any cadence', r.tokens === 1, `${r.tokens} probes — startOwnerWatch in src/daemon/control/ownerWatch.ts must not probe on a timer, only on a liveness move`)
  r.handle.stop()
}
{
  const r = rig({ baseline: null })
  await r.tick(beatsPerFloor * 3)
  check('no usable baseline ⇒ the probe never runs (pid liveness alone)', r.tokens === 0 && r.reaped.length === 0, `${r.tokens} probes — startOwnerWatch in src/daemon/control/ownerWatch.ts must skip the probe when baselineToken is null`)
  r.set({ alive: false })
  await r.tick(ownerWatch.OWNER_WATCH_GRACE_CHECKS)
  check('…and a gone pid still reaps after the grace', r.reaped.join() === 'owner-gone', `reaped=${r.reaped.join()} — startOwnerWatch in src/daemon/control/ownerWatch.ts must reap as owner-gone after OWNER_WATCH_GRACE_CHECKS dead beats`)
}

section('§6 A PROBE THAT CANNOT RUN — logs once, backs off, liveness keeps watching')
{
  const r = rig()
  r.set({ alive: false })
  await r.tick(1)
  r.set({ alive: true, token: null })
  await r.tick(1)
  check('the transition probe could not run: one line in the log, the owner reads alive (fail safe)', r.tokens === 1 && r.lines.length === 1 && r.lines[0]!.includes('could not run') && r.reaped.length === 0 && r.handle.facts().deadStreak === 0, r.lines.join(' | ') + ' — startOwnerWatch in src/daemon/control/ownerWatch.ts must log "could not run" once and treat the owner as alive when the probe returns null')
  const backoffFloors = ownerWatch.OWNER_PROBE_BACKOFF_FACTOR
  r.set({ alive: false })
  await r.tick(1)
  r.set({ alive: true })
  await r.tick(1)
  check(`no retry inside the back-off (${backoffFloors} units), even on another liveness move — the move is remembered`, r.tokens === 1 && r.lines.length === 1, `${r.tokens} probes, ${r.lines.length} lines — startOwnerWatch in src/daemon/control/ownerWatch.ts must hold the probe until backoffUntil (OWNER_PROBE_BACKOFF_FACTOR) and remember the move`)
  r.set({ token: 'token-A' })
  await r.tick(beatsPerFloor * backoffFloors)
  check('once the back-off ends the remembered move probes once; an answer says so once and resets the back-off', r.tokens === 2 && r.lines.length === 2 && r.lines[1]!.includes('answers again') && r.handle.facts().backoffUntil === 0 && r.reaped.length === 0, r.lines.join(' | ') + ' — startOwnerWatch in src/daemon/control/ownerWatch.ts must probe once after the back-off, log "answers again" and reset backoffUntil')
  await r.tick(beatsPerFloor)
  check('…and nothing probes afterwards', r.tokens === 2, `${r.tokens} probes — startOwnerWatch in src/daemon/control/ownerWatch.ts must not probe again without a liveness move`)
  r.handle.stop()
}
{
  const r = rig()
  r.set({ alive: false })
  await r.tick(1)
  r.set({ alive: true, token: null })
  await r.tick(1)
  r.set({ alive: false })
  await r.tick(ownerWatch.OWNER_WATCH_GRACE_CHECKS)
  check('a gone pid reaps during the back-off — the beat never stopped watching', r.reaped.join() === 'owner-gone' && r.tokens === 1, `reaped=${r.reaped.join()}, ${r.tokens} probes — startOwnerWatch in src/daemon/control/ownerWatch.ts must keep the liveness beat reaping during a probe back-off`)
}

section('§7 NO CADENCE — 120 s of beats cost zero identity probes')
{
  const r = rig()
  await r.tick(Math.floor(120_000 / ownerWatch.OWNER_WATCH_INTERVAL_MS))
  check('0 probes in 120 s of beats', r.tokens === 0, `${r.tokens} probes — startOwnerWatch in src/daemon/control/ownerWatch.ts must not probe on a cadence`)
  check('the owner reads alive throughout', r.reaped.length === 0 && r.handle.facts().deadStreak === 0, 'startOwnerWatch in src/daemon/control/ownerWatch.ts reaped or counted a dead beat for a live owner')
  r.handle.stop()
}

section('§8 THE PIPE EOF — an immediate beat, the grace, then owner-pipe-eof')
{
  const r = rig()
  await r.tick(2)
  r.handle.ownerPipeClosed()
  await wait(10)
  check('the EOF beats at once: one dead beat, no reap yet', r.handle.facts().pipeClosed && r.handle.facts().deadStreak === 1 && r.reaped.length === 0, 'ownerPipeClosed in startOwnerWatch (src/daemon/control/ownerWatch.ts) must run one beat at once that counts a dead beat, and not reap before the grace')
  await r.tick(ownerWatch.OWNER_WATCH_GRACE_CHECKS - 1)
  check('the next beat completes the grace and reaps as owner-pipe-eof (the pid still alive, the token still matching)', r.reaped.join() === 'owner-pipe-eof' && r.tokens === 0, `reaped=${r.reaped.join()}, ${r.tokens} probes — startOwnerWatch in src/daemon/control/ownerWatch.ts must reap as owner-pipe-eof after the grace without a token probe`)
}

section('§9 THE WIRING — source pins')
{
  check('the registry names the owner-fd stamp', getFlagSpec('MERCURY_DAEMON_OWNER_FD') !== undefined, 'register MERCURY_DAEMON_OWNER_FD in the flag registry (FLAG_REGISTRY)')
  check('the back-off unit is the minute, four units long', ownerWatch.OWNER_IDENTITY_FLOOR_MS === 60_000 && ownerWatch.OWNER_PROBE_BACKOFF_FACTOR === 4, 'OWNER_IDENTITY_FLOOR_MS and OWNER_PROBE_BACKOFF_FACTOR in src/daemon/control/ownerWatch.ts must be 60000 and 4')
  check('the beat and the grace stand where they were', ownerWatch.OWNER_WATCH_INTERVAL_MS === 4000 && ownerWatch.OWNER_WATCH_GRACE_CHECKS === 2, 'OWNER_WATCH_INTERVAL_MS and OWNER_WATCH_GRACE_CHECKS in src/daemon/control/ownerWatch.ts must be 4000 and 2')
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
