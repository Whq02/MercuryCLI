#!/usr/bin/env bun
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { execFileSync, spawn, type ChildProcess } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, openSync, readdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { connect } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const SCRATCH_ROOT = process.platform === 'darwin' ? '/private/tmp/mw' : tmpdir()
mkdirSync(SCRATCH_ROOT, { recursive: true })
const SCRATCH = mkdtempSync(join(SCRATCH_ROOT, 'orphan-sweep-world-'))
const home = join(SCRATCH, 'home')
const dirs = { stale: join(home, 'daemon'), race: join(home, 'daemon-race'), live: join(home, 'daemon-live') }
const work = { stale: join(SCRATCH, 'work-stale'), race: join(SCRATCH, 'work-race'), live: join(SCRATCH, 'work-live'), window: join(SCRATCH, 'work-window'), runner1: join(SCRATCH, 'work-runner-1'), runner2: join(SCRATCH, 'work-runner-2'), runner3: join(SCRATCH, 'work-runner-3'), raceRunner: join(SCRATCH, 'work-race-runner') }
for (const dir of [home, ...Object.values(work)]) mkdirSync(dir, { recursive: true })
const REPO = join(import.meta.dir, '..', '..')
const argAfter = (flag: string): string | undefined => {
  const at = process.argv.indexOf(flag)
  return at >= 0 ? process.argv[at + 1] : undefined
}
const DIST = argAfter('--dist') ?? join(REPO, 'dist', 'mercury.mjs')
const VENDORED_NODE = join(REPO, 'dist', 'vendor', 'node', 'bin', 'node')
const NODE = existsSync(VENDORED_NODE) ? VENDORED_NODE : 'node'
if (!existsSync(DIST)) {
  console.error('✗ dist/mercury.mjs missing — run `bun run build.ts` first')
  process.exit(1)
}
if (process.platform === 'win32') {
  console.log('process sweep world: Windows reads the list and ends nothing on this lane — the world proof is POSIX-only')
  process.exit(0)
}

process.env.MERCURY_CONFIG_DIR = home
process.env.MERCURY_DAEMON_DIR = dirs.stale
process.env.MERCURY_SESSION_PARK_DRAIN_MINUTES = '0.01'
process.env.MERCURY_PROCESS_SWEEP_WAIT_MS = '2500'
delete process.env.MERCURY_HOME

const { guardLoginDriverWrite, configHomeIsReal } = await import('../lib/loginDriverGuard.ts')
guardLoginDriverWrite('the process sweep world', process.env)
const { seedFirstRun } = await import('../lib/firstRunSeed.ts')
seedFirstRun(home, Object.values(work))
const { startFixtureApi } = await import('../lib/fixtureApi.ts')
const api = await startFixtureApi([
  { kind: 'text', text: 'the runner answers once' },
  { kind: 'text', text: 'the runner answers again' },
  { kind: 'text', text: 'the runner answers a third time' },
  { kind: 'text', text: 'the runner answers a fourth time' },
])
const { daemonControlRpc, clearControlKeyMemo } = await import('../../src/daemon/controlSocket.ts')
const { readMercuryProcesses, recordProcessCensusAtBoot, endStaleProcesses, COCKPIT_HEARTBEAT_ALLOWANCE_MS, processSweepCensusPath } = await import('../../src/daemon/processSweepRun.ts')
const { PROCESS_SWEEP_WORDS, sameSweepIdentity } = await import('../../src/daemon/processSweep.ts')
const { getProcessStartTokenAsync } = await import('../../src/daemon/ownerWatch.ts')
import type { ProcessSweepEntry } from '../../src/daemon/processSweep.ts'

let passed = 0
let failed = 0
const check = (label: string, ok: boolean, detail = ''): void => {
  if (ok) passed++
  else failed++
  console.log(`${ok ? '[PASS]' : '[FAIL]'} ${label}${detail === '' ? '' : ` — ${detail}`}`)
}
const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms))
const spawned: ChildProcess[] = []
const logFd = openSync(join(SCRATCH, 'orphan-sweep-world.log'), 'a')

function baseEnv(daemonDir: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    MERCURY_CONFIG_DIR: home,
    MERCURY_DAEMON_DIR: daemonDir,
    MERCURY_TEAMS_DIR: join(home, 'teams'),
    MERCURY_TABULA_DIR: join(home, 'tabula'),
    MERCURY_DOCTOR_STATE_DIR: join(home, 'doctor-state'),
    ANTHROPIC_API_KEY: 'fixture-key-000',
    ANTHROPIC_BASE_URL: api.url,
    MERCURY_CUSTOM_OAUTH_URL: 'http://127.0.0.1:1',
    MERCURY_CREDENTIAL_STORE: 'file',
    MERCURY_LOCAL_PROBE_TARGETS: 'none',
    MERCURY_BOOT_PREFLIGHT: '0',
    MERCURY_TURN_RECEIPT: '0',
    MERCURY_VERIFY_EVIDENCE: '0',
    MERCURY_LIVE_GLYPHS: '0',
    MERCURY_LIVE_CLOCK: '0',
    MERCURY_CRITTER_GAZE: '0',
    MERCURY_CRITTER_IDLE: '0',
    MERCURY_CRITTER_SLEEP: '0',
    MERCURY_DECK_COMPANION: '0',
    MERCURY_TERMINAL_TITLE: '0',
    MERCURY_WARM_RUNNER: '0',
    MERCURY_CACHE_CLOCK: '0',
    MERCURY_SESSION_PARK_DRAIN_MINUTES: '0.01',
    MERCURY_PROCESS_SWEEP_WAIT_MS: '2500',
    TERM: 'xterm-256color',
    COLUMNS: '120',
    LINES: '40',
    BROWSER: '/usr/bin/true',
  }
  delete env.MERCURY_HOME
  delete env.NODE_ENV
  delete env.ANTHROPIC_AUTH_TOKEN
  delete env.MERCURY_DAEMON_OWNER_PID
  delete env.MERCURY_DAEMON_OWNER_FD
  delete env.MERCURY_DAEMON_PERSIST
  return env
}

function controlSockOf(dir: string): string {
  try {
    const record = JSON.parse(readFileSync(join(dir, 'supervisor.json'), 'utf8')) as { controlSock?: string }
    if (typeof record.controlSock === 'string' && record.controlSock !== '') return record.controlSock
  } catch {
    return join(dir, 'control.sock')
  }
  return join(dir, 'control.sock')
}

async function rawRpc(dir: string, request: Record<string, unknown>, timeoutMs = 8000): Promise<Record<string, unknown>> {
  const keyPath = join(dir, 'control.key')
  const auth = existsSync(keyPath) ? readFileSync(keyPath, 'utf8').trim() : undefined
  const frame = JSON.stringify({ proto: 10, ...(auth === undefined ? {} : { auth }), ...request })
  return new Promise(resolve => {
    let buffer = ''
    let settled = false
    const done = (value: Record<string, unknown>): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(value)
    }
    const timer = setTimeout(() => {
      socket.destroy()
      done({ ok: false, code: 'ETIMEOUT', error: 'no reply' })
    }, timeoutMs)
    const socket = connect(controlSockOf(dir))
    socket.on('connect', () => socket.write(`${frame}\n`))
    socket.on('data', chunk => {
      buffer += chunk.toString('utf8')
      const nl = buffer.indexOf('\n')
      if (nl >= 0) {
        try {
          done(JSON.parse(buffer.slice(0, nl)) as Record<string, unknown>)
        } catch {
          done({ ok: false, code: 'EUNKNOWN', error: 'unparseable reply' })
        }
        socket.end()
      }
    })
    socket.on('error', error => done({ ok: false, code: 'ENOCONN', error: String(error) }))
    socket.on('close', () => done({ ok: false, code: 'ENOCONN', error: 'closed before a reply' }))
  })
}

function psRow(pid: number): { stat: string; tty: string } | null {
  try {
    const out = execFileSync('ps', ['-o', 'stat=,tty=', '-p', String(pid)], { encoding: 'utf8' }).trim()
    if (out === '') return null
    const [stat, tty] = out.split(/\s+/)
    return { stat: stat ?? '', tty: tty ?? '' }
  } catch {
    return null
  }
}

const alive = (pid: number): boolean => psRow(pid) !== null && !psRow(pid)!.stat.startsWith('Z')

async function waitFor(label: string, predicate: () => boolean | Promise<boolean>, timeoutMs: number): Promise<boolean> {
  const until = Date.now() + timeoutMs
  while (Date.now() < until) {
    if (await predicate()) return true
    await sleep(150)
  }
  console.log(`  … timed out waiting for ${label}`)
  return false
}

function spawnDaemon(dir: string, cwd: string, ownerPid: number): ChildProcess {
  mkdirSync(dir, { recursive: true })
  const child = spawn(NODE, [DIST, 'daemon', 'run', cwd], {
    cwd,
    env: { ...baseEnv(dir), MERCURY_DAEMON_OWNER_PID: String(ownerPid) },
    stdio: ['ignore', logFd, logFd],
    detached: true,
  })
  spawned.push(child)
  return child
}

function spawnSleeper(): ChildProcess {
  const child = spawn('sleep', ['600'], { stdio: 'ignore' })
  spawned.push(child)
  return child
}

const PTY_HOLDER = join(SCRATCH, 'orphan-sweep-pty.py')
writeFileSync(PTY_HOLDER, [
  'import fcntl, os, pty, select, struct, subprocess, sys, termios',
  'master, slave = pty.openpty()',
  "fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack('HHHH', 40, 120, 0, 0))",
  'def prepare():',
  '    os.setsid()',
  '    fcntl.ioctl(0, termios.TIOCSCTTY, 0)',
  'child = subprocess.Popen(sys.argv[1:], stdin=slave, stdout=slave, stderr=slave, preexec_fn=prepare, close_fds=True)',
  'os.close(slave)',
  'while child.poll() is None:',
  '    ready, _, _ = select.select([master], [], [], 0.2)',
  '    if ready:',
  '        try:',
  '            os.read(master, 65536)',
  '        except OSError:',
  '            break',
  'sys.exit(child.wait() if child.poll() is not None else 0)',
  '',
].join('\n'))
const PYTHON = process.platform === 'darwin' ? '/usr/bin/python3' : 'python3'

function spawnCockpit(cwd: string): ChildProcess {
  const child = spawn(PYTHON, [PTY_HOLDER, NODE, DIST], {
    cwd,
    env: baseEnv(dirs.live),
    stdio: ['ignore', logFd, logFd],
    detached: true,
  })
  spawned.push(child)
  return child
}

function childOf(parentPid: number): number | null {
  try {
    const out = execFileSync('pgrep', ['-P', String(parentPid)], { encoding: 'utf8' }).trim()
    const first = out.split('\n').map(Number).find(pid => Number.isSafeInteger(pid) && pid > 1)
    return first ?? null
  } catch {
    return null
  }
}

function registrationFor(pid: number): { path: string; record: Record<string, unknown> } | null {
  const dir = join(home, 'processes')
  if (!existsSync(dir)) return null
  for (const name of readdirSync(dir)) {
    if (name.startsWith(`cockpit-${pid}-`)) {
      const path = join(dir, name)
      return { path, record: JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown> }
    }
  }
  return null
}

function rosterRecords(dir: string): Record<string, { pid?: number; endedAt?: number; sessionId?: string; runnerId?: string }> {
  try {
    const raw = JSON.parse(readFileSync(join(dir, 'concourse-workers.json'), 'utf8')) as { workers?: Record<string, { pid?: number; endedAt?: number; sessionId?: string; runnerId?: string }> }
    return raw.workers ?? {}
  } catch {
    return {}
  }
}

async function admitRunner(dir: string, cwd: string, words: string): Promise<{ runnerId: string; sessionId: string; pid: number } | null> {
  const admitted = await rawRpc(dir, { op: 'sessionAdmit', workspaceDir: cwd, isolation: 'read-only', model: 'claude-fable-5-1', prompt: '' })
  if (admitted.ok !== true || typeof admitted.runnerId !== 'string' || typeof admitted.sessionId !== 'string') {
    console.log(`  … admission refused: ${JSON.stringify(admitted).slice(0, 300)}`)
    return null
  }
  const runnerId = admitted.runnerId
  const sessionId = admitted.sessionId
  let pid = typeof admitted.pid === 'number' ? admitted.pid : 0
  await waitFor(`the runner pid of ${runnerId}`, () => {
    const record = Object.values(rosterRecords(dir)).find(entry => entry.runnerId === runnerId || entry.sessionId === sessionId)
    if (record !== undefined && typeof record.pid === 'number') pid = record.pid
    return pid > 0
  }, 20000)
  if (pid === 0) return null
  const sent = await rawRpc(dir, { op: 'sessionDispatch', clientMessageId: `orphan-sweep-${runnerId}`, targetSessionId: sessionId, workspaceDir: cwd, prompt: words })
  if (sent.ok !== true) console.log(`  … dispatch refused: ${JSON.stringify(sent).slice(0, 300)}`)
  return { runnerId, sessionId, pid }
}

function entryOf(entries: readonly ProcessSweepEntry[], pid: number): ProcessSweepEntry | undefined {
  return entries.find(entry => entry.process.pid === pid)
}

function cliProcesses(endStale: boolean): { code: number; report: Record<string, unknown> | null } {
  try {
    const out = execFileSync(NODE, [DIST, 'doctor', 'processes', ...(endStale ? ['--end-stale'] : [])], { cwd: work.stale, env: baseEnv(dirs.stale), encoding: 'utf8', stdio: ['ignore', 'pipe', logFd], timeout: 60000 })
    const at = out.indexOf('{')
    return { code: 0, report: at >= 0 ? (JSON.parse(out.slice(at)) as Record<string, unknown>) : null }
  } catch (error) {
    const failed = error as { status?: number; stdout?: string }
    const out = typeof failed.stdout === 'string' ? failed.stdout : ''
    const at = out.indexOf('{')
    return { code: failed.status ?? 1, report: at >= 0 ? (JSON.parse(out.slice(at)) as Record<string, unknown>) : null }
  }
}

async function cleanup(): Promise<void> {
  for (const dir of Object.values(dirs)) {
    if (existsSync(join(dir, 'control.sock'))) await rawRpc(dir, { op: 'shutdown', reapWorkers: true }, 3000).catch(() => undefined)
  }
  await sleep(500)
  const pids = new Set<number>()
  for (const child of spawned) if (typeof child.pid === 'number') pids.add(child.pid)
  try {
    const out = execFileSync('ps', ['-Aww', '-o', 'pid=,args='], { encoding: 'utf8' })
    for (const line of out.split('\n')) {
      const match = /^\s*(\d+)\s+(.*)$/.exec(line)
      if (match !== null && match[2]!.includes(SCRATCH)) pids.add(Number(match[1]))
    }
  } catch {
    console.log('  … the cleanup census could not be read')
  }
  for (const pid of pids) {
    try {
      process.kill(pid, 'SIGCONT')
    } catch {
      continue
    }
    try {
      process.kill(pid, 'SIGKILL')
    } catch {
      continue
    }
  }
  await sleep(300)
  const left = [...pids].filter(alive)
  console.log(`cleanup: ${pids.size} world pid(s) signalled, ${left.length} still present (${left.join(', ') || 'none'})`)
  await api.close().catch(() => undefined)
  if (!process.argv.includes('--keep')) rmSync(SCRATCH, { recursive: true, force: true })
  else console.log(`world kept at ${SCRATCH}`)
}

try {
  console.log('§0 the real config home is refused before anything is spawned')
  check('the scratch home is not the operator\'s real store', !configHomeIsReal(process.env))
  let refused = ''
  try {
    guardLoginDriverWrite('the process sweep world', { ...process.env, MERCURY_CONFIG_DIR: '' })
  } catch (error) {
    refused = String(error)
  }
  check('naming the real config home is refused with the guard\'s words', refused.includes('refusing the process sweep world') && refused.includes('real store'), refused.slice(0, 120))

  console.log('§1 the five shapes stand together in one scratch home')
  const sleeperStale = spawnSleeper()
  const sleeperRace = spawnSleeper()
  const staleDaemon = spawnDaemon(dirs.stale, work.stale, sleeperStale.pid!)
  const raceDaemon = spawnDaemon(dirs.race, work.race, sleeperRace.pid!)
  check('the owner-gone daemon answers ping on its own plane', await waitFor('the stale daemon', async () => (await rawRpc(dirs.stale, { op: 'ping' }, 1500)).ok === true, 40000))
  check('the race daemon answers ping on its own plane', await waitFor('the race daemon', async () => (await rawRpc(dirs.race, { op: 'ping' }, 1500)).ok === true, 40000))

  const liveScript = spawnCockpit(work.live)
  let livePid = 0
  await waitFor('the live cockpit process', () => {
    livePid = childOf(liveScript.pid!) ?? 0
    return livePid > 0
  }, 20000)
  check('the live cockpit runs on a pty of its own', livePid > 0 && psRow(livePid)?.tty !== '??', JSON.stringify(psRow(livePid)))
  check('the live cockpit registers itself in the config home', await waitFor('the live registration', () => registrationFor(livePid) !== null, 90000))
  check('the live cockpit spawned its owned daemon', await waitFor('the live daemon', async () => (await rawRpc(dirs.live, { op: 'ping' }, 1500)).ok === true, 60000))
  const liveHello = await rawRpc(dirs.live, { op: 'hello' })
  check('the live daemon names the live cockpit as its owner', liveHello.ownerPid === livePid, JSON.stringify({ ownerPid: liveHello.ownerPid, livePid }))

  const runner1 = await admitRunner(dirs.live, work.runner1, 'say the first word')
  check('a live session runner was admitted on the live daemon', runner1 !== null && alive(runner1.pid))
  const runner2 = await admitRunner(dirs.live, work.runner2, 'say the second word')
  check('a second session runner was admitted for the released shape', runner2 !== null && alive(runner2.pid))
  const runner3 = await admitRunner(dirs.live, work.runner3, 'say the third word')
  check('a third session runner was admitted for the unkillable shape', runner3 !== null && alive(runner3.pid))
  await sleep(1500)
  for (const runner of [runner2, runner3]) {
    if (runner === null) continue
    process.kill(runner.pid, 'SIGSTOP')
    const released = await rawRpc(dirs.live, { op: 'sessionRelease', runnerId: runner.runnerId })
    check(`the product released ${runner.runnerId} while its paused process survives`, released.ok === true && alive(runner.pid) && (psRow(runner.pid)?.stat.startsWith('T') ?? false), JSON.stringify({ released, stat: psRow(runner.pid)?.stat }))
  }
  check('the released runner records carry endedAt', [runner2, runner3].every(runner => runner !== null && Object.values(rosterRecords(dirs.live)).some(record => record.pid === runner.pid && typeof record.endedAt === 'number')))

  const windowScript = spawnCockpit(work.window)
  let windowPid = 0
  await waitFor('the second cockpit process', () => {
    windowPid = childOf(windowScript.pid!) ?? 0
    return windowPid > 0
  }, 20000)
  check('the second cockpit registers itself', await waitFor('the window registration', () => registrationFor(windowPid) !== null, 90000))
  process.kill(windowPid, 'SIGSTOP')
  process.kill(windowScript.pid!, 'SIGKILL')
  await sleep(700)
  const windowRegistration = registrationFor(windowPid)
  check('the closed-pty cockpit is paused and still names its terminal in the process table', alive(windowPid) && (psRow(windowPid)?.stat.startsWith('T') ?? false), JSON.stringify(psRow(windowPid)))
  if (windowRegistration !== null) {
    const expired = new Date(Date.now() - (COCKPIT_HEARTBEAT_ALLOWANCE_MS + 60_000))
    windowRegistration.record.heartbeatAt = expired.getTime()
    writeFileSync(windowRegistration.path, JSON.stringify(windowRegistration.record, null, 2))
    utimesSync(windowRegistration.path, expired, expired)
  }
  check('the closed-pty cockpit\'s heartbeat is recorded as expired past the allowance', windowRegistration !== null)
  const standIn = spawn('node', ['-e', 'setInterval(() => {}, 1000000)'], { stdio: 'ignore', detached: true })
  spawned.push(standIn)
  const standInPid = standIn.pid!
  const standInToken = await getProcessStartTokenAsync(standInPid)
  const standInId = randomUUID()
  const standInPath = join(home, 'processes', `cockpit-${standInPid}-${standInId}.json`)
  const standInExpired = new Date(Date.now() - (COCKPIT_HEARTBEAT_ALLOWANCE_MS + 60_000))
  writeFileSync(standInPath, JSON.stringify({ schema: 1, id: standInId, pid: standInPid, startToken: standInToken, exe: process.execPath, bundle: DIST, configHome: home, daemonDir: dirs.live, terminal: null, bornAt: standInExpired.getTime(), heartbeatAt: standInExpired.getTime() }, null, 2))
  utimesSync(standInPath, standInExpired, standInExpired)
  check('a stand-in window whose terminal the table no longer names is registered with an expired heartbeat', typeof standInToken === 'string' && standInToken !== '' && psRow(standInPid)?.tty === '??', JSON.stringify(psRow(standInPid)))

  console.log('§2 the read-only census classifies every shape without ending anything')
  const census = await recordProcessCensusAtBoot()
  check('the census is complete', census.complete, census.error ?? '')
  const stale = census.entries.filter(entry => entry.classification === 'stale')
  const ownedD = entryOf(census.entries, staleDaemon.pid!)
  const staleW = entryOf(census.entries, windowPid)
  const staleR = runner2 === null ? undefined : entryOf(census.entries, runner2.pid)
  const staleR3 = runner3 === null ? undefined : entryOf(census.entries, runner3.pid)
  check('an owned daemon whose owner is alive reads running by its owner', ownedD?.classification === 'running' && ownedD.kind === 'daemon' && ownedD.reason.includes('owner'), JSON.stringify(ownedD && [ownedD.classification, ownedD.reason]))
  check('the closed-pty cockpit that still holds its pty node is never stale: its terminal reads alive while its last output is fresh and unknown once it ages, never gone', staleW !== undefined && staleW.kind === 'window' && staleW.classification !== 'stale' && staleW.reason.includes('terminal'), JSON.stringify(staleW && [staleW.classification, staleW.reason]))
  const staleS = entryOf(census.entries, standInPid)
  check('the registered window whose terminal is gone reads stale by its expired heartbeat', staleS?.classification === 'stale' && staleS.kind === 'window' && staleS.reason.includes('terminal is gone'), JSON.stringify(staleS && [staleS.classification, staleS.reason]))
  check('the released runner reads stale by its ended session', staleR?.classification === 'stale' && staleR.kind === 'runner', JSON.stringify(staleR && [staleR.classification, staleR.reason]))
  check('the unkillable shape reads stale too before its leg', staleR3?.classification === 'stale', JSON.stringify(staleR3 && [staleR3.classification, staleR3.reason]))
  const liveA = entryOf(census.entries, livePid)
  const liveB = entryOf(census.entries, liveHello.pid as number)
  const liveR = runner1 === null ? undefined : entryOf(census.entries, runner1.pid)
  const raceD = entryOf(census.entries, raceDaemon.pid!)
  check('the live cockpit reads running by its fresh heartbeat', liveA?.classification === 'running' && liveA.reason.includes('registration'), JSON.stringify(liveA && [liveA.classification, liveA.reason]))
  check('the live daemon reads running by its live owner', liveB?.classification === 'running' && liveB.reason.includes('owner'), JSON.stringify(liveB && [liveB.classification, liveB.reason]))
  check('the live session runner reads running by its open session', liveR?.classification === 'running' && liveR.reason.includes('session'), JSON.stringify(liveR && [liveR.classification, liveR.reason]))
  check('a daemon on a plane this reader cannot ask stays unended (its work is unknown)', raceD === undefined || raceD.classification !== 'stale', JSON.stringify(raceD && [raceD.classification, raceD.reason]))
  check('the census names exactly the three stale shapes that exist so far', stale.length === 3 && [standInPid, runner2?.pid, runner3?.pid].every(pid => stale.some(entry => entry.process.pid === pid)), stale.map(entry => `${entry.process.pid}:${entry.kind}`).join(' '))
  check('the census was recorded beside the registrations', existsSync(processSweepCensusPath(home)))
  const goneProbe = spawn('true', [], { stdio: 'ignore' })
  await new Promise<void>(resolve => goneProbe.once('exit', () => resolve()))
  const gonePid = goneProbe.pid!
  const goneId = randomUUID()
  const gonePath = join(home, 'processes', `cockpit-${gonePid}-${goneId}.json`)
  writeFileSync(gonePath, JSON.stringify({ schema: 1, id: goneId, pid: gonePid, startToken: null, exe: process.execPath, bundle: DIST, configHome: home, daemonDir: dirs.live, terminal: null, bornAt: Date.now() - 600_000, heartbeatAt: Date.now() - 600_000 }, null, 2))
  const censusStamp = statSync(processSweepCensusPath(home)).mtimeMs
  const registrationsBefore = readdirSync(join(home, 'processes')).filter(name => name.startsWith('cockpit-')).length
  const doctorRead = await readMercuryProcesses()
  check('a doctor-shaped read lists the same shapes and writes nothing under the config home: the census stamp stands and a registration of a gone pid is not pruned', doctorRead.entries.length === census.entries.length && statSync(processSweepCensusPath(home)).mtimeMs === censusStamp && existsSync(gonePath) && readdirSync(join(home, 'processes')).filter(name => name.startsWith('cockpit-')).length === registrationsBefore, JSON.stringify({ entries: [doctorRead.entries.length, census.entries.length], stamp: [statSync(processSweepCensusPath(home)).mtimeMs, censusStamp], gone: existsSync(gonePath) }))
  await recordProcessCensusAtBoot()
  check('the boot road records the census anew and prunes the registration of the gone pid', statSync(processSweepCensusPath(home)).mtimeMs !== censusStamp && !existsSync(gonePath) && alive(gonePid) === false, JSON.stringify({ stamp: [statSync(processSweepCensusPath(home)).mtimeMs, censusStamp], gone: existsSync(gonePath) }))
  check('every shape still stands after two read-only censuses', [staleDaemon.pid!, windowPid, standInPid, livePid, liveHello.pid as number, runner1?.pid, runner2?.pid, runner3?.pid].every(pid => typeof pid === 'number' && alive(pid)))

  console.log('§3 the race: a client that arrives between the scan and the end vetoes it')
  process.env.MERCURY_DAEMON_DIR = dirs.race
  clearControlKeyMemo()
  sleeperRace.kill('SIGKILL')
  await waitFor('the race sleeper to leave', () => !alive(sleeperRace.pid!), 5000)
  const raceFirst = await recordProcessCensusAtBoot({ ownDaemonDir: dirs.race })
  const raceWaiting = entryOf(raceFirst.entries, raceDaemon.pid!)
  check('an owner-gone daemon waits for the drain allowance on its first sighting', raceWaiting?.classification === 'running' && raceWaiting.reason.includes('waiting'), JSON.stringify(raceWaiting && [raceWaiting.classification, raceWaiting.reason]))
  await sleep(800)
  const raceCensus = await recordProcessCensusAtBoot({ ownDaemonDir: dirs.race })
  const raceEntry = entryOf(raceCensus.entries, raceDaemon.pid!)
  check('the race daemon reads stale from its own plane', raceEntry?.classification === 'stale', JSON.stringify(raceEntry && [raceEntry.classification, raceEntry.reason, raceFirst.entries.length]))
  const raceRunner = await admitRunner(dirs.race, work.raceRunner, 'a client arrived')
  check('a client arrived on the race daemon after the scan', raceRunner !== null)
  if (raceEntry !== undefined) {
    const veto = await daemonControlRpc({ op: 'processSweep', proto: 10, action: 'end', expected: raceEntry }, { timeoutMs: 5000 })
    check('the daemon itself refuses the reviewed end with the live client named', veto.ok && veto.op === 'processSweep' && veto.action === 'end' && !veto.ended && veto.road === 'daemon' && /live worker|owner|session/.test(veto.reason), JSON.stringify(veto))
    const after = await endStaleProcesses([raceEntry], { ownDaemonDir: dirs.race })
    check('the sweep\'s own recheck refuses the stale-then-used daemon', after.endings.length === 1 && after.endings[0]!.outcome === 'refused' && after.endings[0]!.reason.includes('no longer stale'), JSON.stringify(after.endings[0]))
    check('the race daemon and its client are untouched', alive(raceDaemon.pid!) && raceRunner !== null && alive(raceRunner.pid))
  }
  process.env.MERCURY_DAEMON_DIR = dirs.stale
  clearControlKeyMemo()

  console.log('§4 the unkillable shape is reported with the approved words, never claimed')
  if (staleR3 !== undefined) {
    const swallowed: string[] = []
    const survived = await endStaleProcesses([staleR3], {
      signal: (pid, name) => {
        swallowed.push(`${pid}:${name}`)
        return true
      },
    })
    const ending = survived.endings[0]
    check('a process that survives the kill signal is reported as one that needs a reboot', ending?.outcome === 'survived' && ending.reason.startsWith(PROCESS_SWEEP_WORDS.unkillable), JSON.stringify(ending))
    check('the ladder sent the termination signal and then the kill signal to that one pid', swallowed.length === 2 && swallowed[0] === `${staleR3.process.pid}:SIGTERM` && swallowed[1] === `${staleR3.process.pid}:SIGKILL`, swallowed.join(' '))
    check('the survivor is still listed, not claimed ended', entryOf(survived.entries, staleR3.process.pid) !== undefined)
    process.kill(staleR3.process.pid, 'SIGKILL')
    await waitFor('the unkillable stand-in to leave', () => !alive(staleR3.process.pid), 5000)
  }

  console.log('§5 the headless verb lists, then ends only the reviewed stale shapes')
  const listing = cliProcesses(false)
  const listed = (listing.report?.entries as ProcessSweepEntry[] | undefined) ?? []
  check('mercury doctor processes answers a JSON listing with the approved row words', listing.code === 0 && listing.report?.row === PROCESS_SWEEP_WORDS.row && typeof listing.report?.summary === 'string', JSON.stringify(listing.report?.summary))
  const listedStale = listed.filter(entry => entry.classification === 'stale')
  check('the listing names the two stale shapes so far with pid, terminal and age lines', listedStale.length === 2 && Array.isArray(listing.report?.lines) && (listing.report!.lines as string[]).length >= 2 && (listing.report!.lines as string[]).every(line => /^pid \d+ · .+ · .+ · .+$/.test(line)), JSON.stringify(listing.report?.lines))
  check('the reviewed identities carry the birth token the ending will demand', listedStale.every(entry => typeof entry.startToken === 'string' && entry.startToken !== '' && sameSweepIdentity(entry, entry)))
  check('the listing ended nothing', alive(windowPid) && alive(standInPid) && runner2 !== null && alive(runner2.pid) && alive(staleDaemon.pid!))
  sleeperStale.kill('SIGKILL')
  await waitFor('the stale sleeper to leave', () => !alive(sleeperStale.pid!), 5000)
  const sighting = await recordProcessCensusAtBoot()
  const sighted = entryOf(sighting.entries, staleDaemon.pid!)
  check('the owner-gone daemon is sighted first and waits for the drain allowance', sighted?.classification === 'running' && sighted.reason.includes('waiting'), JSON.stringify(sighted && [sighted.classification, sighted.reason]))
  await sleep(800)
  const second = await recordProcessCensusAtBoot()
  const staleDaemonEntry = entryOf(second.entries, staleDaemon.pid!)
  check('the owner-gone daemon reads stale once the drain allowance elapsed', staleDaemonEntry?.classification === 'stale' && staleDaemonEntry.kind === 'daemon', JSON.stringify(staleDaemonEntry && [staleDaemonEntry.classification, staleDaemonEntry.reason]))
  const daemonEnding = staleDaemonEntry === undefined ? null : await endStaleProcesses([staleDaemonEntry])
  const daemonRoad = daemonEnding?.endings[0]
  check('the owner-gone daemon went through its own daemon road: it re-checked itself and shut down', daemonRoad?.outcome === 'ended' && daemonRoad.road === 'daemon' && daemonRoad.reason.includes('nothing uses it'), JSON.stringify(daemonRoad && [daemonRoad.outcome, daemonRoad.road, daemonRoad.reason]))
  check('the owner-gone daemon is gone and its plane records with it', await waitFor('the stale daemon to leave', () => !alive(staleDaemon.pid!), 5000))
  const ending = cliProcesses(true)
  const endings = (ending.report?.endings as Array<{ entry: ProcessSweepEntry; outcome: string; road: string; reason: string }> | undefined) ?? []
  check('--end-stale ended exactly the two reviewed paused shapes and reported it with the approved words', ending.code === 0 && endings.length === 2 && endings.every(item => item.outcome === 'ended') && typeof ending.report?.result === 'string' && /^Ended 2 stale processes; 0 could not be ended; \d+ left running$/.test(ending.report!.result as string), JSON.stringify({ code: ending.code, result: ending.report?.result, endings: endings.map(item => [item.entry.process.pid, item.outcome, item.road, item.reason]) }))
  check('the two shapes went through the signal ladder: the paused runner to the kill signal, the stand-in window on the termination signal', endings.length === 2 && endings.every(item => item.road === 'signal') && endings.some(item => item.entry.process.pid === runner2?.pid && item.reason.includes('kill signal')) && endings.some(item => item.entry.process.pid === standInPid && item.reason.includes('termination signal')), JSON.stringify(endings.map(item => [item.entry.process.pid, item.reason])))
  await sleep(500)
  check('the three stale processes are gone', !alive(staleDaemon.pid!) && !alive(standInPid) && (runner2 === null || !alive(runner2.pid)))
  const windowAfter = ((ending.report?.entries as ProcessSweepEntry[] | undefined) ?? []).find(item => item.process.pid === windowPid)
  check('the closed-pty cockpit is untouched and listed as running or cannot end, never ended', alive(windowPid) && windowAfter !== undefined && windowAfter.classification !== 'stale' && !endings.some(item => item.entry.process.pid === windowPid), JSON.stringify(windowAfter && [windowAfter.classification, windowAfter.reason]))
  check('the live cockpit, its daemon and its session runner are untouched', alive(livePid) && alive(liveHello.pid as number) && runner1 !== null && alive(runner1.pid))
  check('the ended window\'s registration was cleared', registrationFor(standInPid) === null)
  const again = cliProcesses(true)
  const againEndings = (again.report?.endings as unknown[] | undefined) ?? []
  check('a second sweep ends nothing', again.code === 0 && againEndings.length === 0 && again.report?.result === PROCESS_SWEEP_WORDS.result(0, 0, (again.report?.counts as Record<string, number>).running))
  check('the live shapes still stand after the second sweep', alive(livePid) && alive(liveHello.pid as number) && runner1 !== null && alive(runner1.pid))
  const recorded = JSON.parse(readFileSync(processSweepCensusPath(home), 'utf8')) as { endings?: unknown[] }
  check('the census record carries the endings of the last sweep', Array.isArray(recorded.endings))
} catch (error) {
  failed++
  console.log(`[FAIL] the world proof threw: ${error instanceof Error ? error.stack ?? error.message : String(error)}`)
} finally {
  await cleanup()
}

console.log(`process sweep world: ${passed} passed, ${failed} failed`)
process.exit(failed === 0 ? 0 : 1)
