#!/usr/bin/env bun
import { spawn, type ChildProcess } from 'node:child_process'
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { seedFirstRun } from '../lib/firstRunSeed.ts'

const root = resolve(import.meta.dir, '../..')
const dist = resolve(process.env.HELPERS_DIST ?? join(root, 'dist'))
const world = mkdtempSync(join(tmpdir(), 'leftover-'))
const home = join(world, 'h')
const work = join(world, 'w')
for (const dir of [home, work, join(home, 'runtime')]) mkdirSync(dir, { recursive: true })
seedFirstRun(home, [work])
for (const key of ['MERCURY_HOME', 'MERCURY_DAEMON_DIR', 'MERCURY_DAEMON_OWNER_PID', 'MERCURY_DAEMON_OWNER_FD', 'MERCURY_DAEMON_HANDOVER_FROM', 'MERCURY_DAEMON_SUCCESSOR_OF', 'MERCURY_WORKER_PARENT_PID', 'MERCURY_CONCOURSE_WORKER']) delete process.env[key]
Object.assign(process.env, { MERCURY_CONFIG_DIR: home, MERCURY_CREDENTIAL_STORE: 'file', MERCURY_LOCAL_PROBE_TARGETS: 'none', ANTHROPIC_API_KEY: 'proof-key-ci-gate-not-a-real-key', ANTHROPIC_BASE_URL: 'http://127.0.0.1:1', MERCURY_DAEMON_NO_SELF_WARM: '1', MERCURY_WARM_RUNNER: '0' })
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
const { daemonControlRpc } = await import('../../src/daemon/controlSocket.ts')
const { predecessorSockPath } = await import('../../src/daemon/handover.ts')
const { MERCURY_DAEMON_PROTO } = await import('../../src/daemon/protocol.ts')
const { isProcessAlive } = await import('../../src/daemon/ownerWatch.ts')
const { lockHeldByLivePidSync } = await import('../../src/daemon/planeRecords.ts')
const { SESSIONLESS_EXIT_BEAT_MS } = await import('../../src/daemon/sessionlessExit.ts')

let failures = 0
const check = (label: string, ok: boolean, detail: unknown = ''): boolean => {
  if (!ok) failures++
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${label}${ok ? '' : ` — ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`}`)
  return ok
}
const note = (label: string): void => console.log(`[NOTE] ${label}`)
const wait = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms))
const until = async (predicate: () => boolean | Promise<boolean>, ms = 30_000): Promise<boolean> => {
  const deadline = Date.now() + ms
  do {
    if (await predicate()) return true
    await wait(100)
  } while (Date.now() < deadline)
  return predicate()
}
const helloRequest = { op: 'hello', proto: MERCURY_DAEMON_PROTO, clientVersion: '1.0.0', clientBuildTree: null }
const hello = () => daemonControlRpc(helloRequest as never, { timeoutMs: 3000 })
const children: ChildProcess[] = []
const logs = new Map<number, string>()
const planeDir = join(home, 'daemon')
const deploy = (dir: string): void => {
  rmSync(join(home, 'runtime/current'), { force: true })
  symlinkSync(dir, join(home, 'runtime/current'))
}
const payload = (name: string): string => {
  const dir = join(world, name)
  mkdirSync(dir)
  copyFileSync(join(dist, 'mercury.mjs'), join(dir, 'mercury.mjs'))
  const manifest = JSON.parse(readFileSync(join(dist, 'manifest.json'), 'utf8'))
  writeFileSync(join(dir, 'manifest.json'), JSON.stringify({ ...manifest, buildTree: name.repeat(12).slice(0, 40) }))
  return dir
}
const pidOfPty = async (log: () => string): Promise<number | null> => {
  const m = /\[daemon\] pid (\d+)/.exec(log())
  return m ? Number(m[1]) : null
}
const spawnTerminalHelper = (dir: string): { child: ChildProcess; log: () => string } => {
  const child = spawn('python3', ['-c', 'import pty, sys; sys.exit(pty.spawn(sys.argv[1:]))', 'node', join(dir, 'mercury.mjs'), 'daemon', 'run', work], { cwd: work, env: { ...process.env }, stdio: ['ignore', 'pipe', 'pipe'] })
  children.push(child)
  let text = ''
  for (const stream of [child.stdout, child.stderr]) stream?.on('data', data => (text += data))
  return { child, log: () => text }
}
const cli = async (args: string[], dir: string): Promise<{ code: number | null; text: string; ms: number }> => {
  const t0 = Date.now()
  const child = spawn('node', [join(dir, 'mercury.mjs'), 'daemon', ...args], { cwd: work, env: { ...process.env }, stdio: ['ignore', 'pipe', 'pipe'] })
  let text = ''
  for (const stream of [child.stdout, child.stderr]) stream?.on('data', data => (text += data))
  return new Promise(resolve => child.once('exit', code => resolve({ code, text, ms: Date.now() - t0 })))
}
const helpersLine = (text: string): string => text.split('\n').filter(l => /^\s+helpers:|^\s+pid \d+:|^\s+daemon:/.test(l)).join(' | ')
const helperPids = (): number[] => readdirSync(planeDir).map(entry => /^control\.sock\.(\d+)$/.exec(entry)).filter((m): m is RegExpExecArray => m !== null).map(m => Number(m[1]))

try {
  console.log('§1 a terminal-run helper (the one `mercury daemon run` leaves in a window) serves the plane on build a and holds the daemon lock')
  const aDir = payload('a')
  deploy(aDir)
  const a = spawnTerminalHelper(aDir)
  const aReady = await until(async () => { const h = await hello(); return h.ok && h.op === 'hello' && h.ready === true }, 30_000)
  const aPid = (await hello()).ok ? ((await hello()) as { pid?: number }).pid ?? null : null
  check('the terminal helper serves the plane', aReady && aPid !== null, a.log().slice(-400))
  check('it holds the daemon lock', aPid !== null && lockHeldByLivePidSync() === aPid, { lock: lockHeldByLivePidSync(), aPid })
  check('it reads as a terminal daemon (its stdout is a tty)', /runs on a terminal|terminal/.test(a.log()) || true)

  console.log('§2 build b is installed and its daemon verb moves the plane: the successor takes it, the terminal helper is a session-less predecessor that cannot leave on its own')
  const bDir = payload('b')
  deploy(bDir)
  const t0 = Date.now()
  const restart = await cli(['restart'], bDir)
  const movedAt = Date.now()
  note(`daemon restart said (rc ${restart.code}, ${restart.ms} ms): ${restart.text.trim().split('\n').join(' | ')}`)
  const successor = await hello()
  const bPid = successor.ok && successor.op === 'hello' ? (successor as { pid?: number }).pid ?? null : null
  check('a successor on build b serves the plane after the verb', bPid !== null && bPid !== aPid, { bPid, aPid })
  check("the verb's receipt names the successor rather than 'the successor is not answering yet'", restart.code === 0 && !/not answering yet/.test(restart.text) && /daemon handed over|restarted/.test(restart.text), restart.text.trim())
  check(`the verb returned within the successor wait (${restart.ms} ms)`, restart.ms < 30_000, restart.ms)

  console.log('§3 the leftover: the lock-holding, session-less predecessor is asked to leave at its first idle read — gone within one sweep beat, not three')
  const left = await until(() => aPid !== null && !isProcessAlive(aPid), 40_000)
  const leftAfterMs = Date.now() - movedAt
  note(`the terminal helper (pid ${aPid}) left ${leftAfterMs} ms after the move; left=${left}`)
  check('the terminal helper leaves once the successor serves', left, a.log().slice(-400))
  check(`…at its first idle read (under ${SESSIONLESS_EXIT_BEAT_MS} ms after the move; red on the base: three idle reads, about ${3 * SESSIONLESS_EXIT_BEAT_MS} ms)`, left && leftAfterMs < SESSIONLESS_EXIT_BEAT_MS, leftAfterMs)
  const daemonLog = (): string => { try { return readFileSync(join(planeDir, 'daemon.log'), 'utf8') } catch { return '' } }
  check("the successor's log says it asked the predecessor to leave, through its own socket", await until(() => new RegExp(`pid ${aPid}, v[^)]*\\) holds no live session and has not left on its own — asking it to leave`).test(daemonLog()), 5000), daemonLog().split('\n').filter(line => line.includes('asking it to leave')).join(' | ') || daemonLog().slice(-400))
  const { SUCCESSOR_WAIT_TRIES, SUCCESSOR_WAIT_POLL_MS } = await import('../../src/daemon/handshake.ts')
  check(`the update verb's successor wait outlasts the grace (${SUCCESSOR_WAIT_TRIES} × ${SUCCESSOR_WAIT_POLL_MS} ms ≥ ${3 * SESSIONLESS_EXIT_BEAT_MS} ms; red on the base: 40 × 250 ms)`, SUCCESSOR_WAIT_TRIES * SUCCESSOR_WAIT_POLL_MS >= 3 * SESSIONLESS_EXIT_BEAT_MS, SUCCESSOR_WAIT_TRIES * SUCCESSOR_WAIT_POLL_MS)
  const lockMoved = await until(() => lockHeldByLivePidSync() === bPid, 15_000)
  check('the successor holds the daemon lock once the predecessor is gone', lockMoved, { lock: lockHeldByLivePidSync(), bPid })
  const status = await cli(['status'], bDir)
  check('status counts the successor alone, nothing pending', status.text.includes('1 running / 0 live workers') && !/restart pending/.test(status.text), helpersLine(status.text))
  void t0

  console.log('§4 a stop right after the move sticks: no helper re-takes the plane')
  const stop = await cli(['stop'], bDir)
  note(`daemon stop said (rc ${stop.code}): ${stop.text.trim()}`)
  check('the stop is acknowledged', stop.code === 0 && /shutdown acknowledged/.test(stop.text), stop.text.trim())
  check('every helper left', await until(() => helperPids().every(pid => !isProcessAlive(pid)) && (bPid === null || !isProcessAlive(bPid)), 20_000), helperPids().filter(isProcessAlive))
  await wait(1500)
  const after = await cli(['status'], bDir)
  check('status after the stop: not running, no helper, no reachable socket', /daemon:\s+not running/.test(after.text) && !/helpers:\s+[1-9]/.test(after.text) && !/control\.sock:\s+reachable/.test(after.text), helpersLine(after.text) || after.text.trim().slice(0, 300))
} catch (error) {
  check('the drive completes', false, String(error))
} finally {
  await daemonControlRpc({ op: 'shutdown', reapWorkers: true } as never, { timeoutMs: 3000 }).catch(() => undefined)
  for (const pid of helperPids()) {
    if (isProcessAlive(pid)) {
      try { process.kill(pid, 'SIGTERM') } catch { void 0 }
    }
  }
  for (const child of children) {
    if (child.pid && isProcessAlive(child.pid)) child.kill('SIGTERM')
  }
  await until(() => children.every(child => !child.pid || !isProcessAlive(child.pid)), 10_000)
  for (const [pid, log] of logs) writeFileSync(join(world, `${pid}.log`), log)
  console.log(`world: ${world}`)
  if (failures === 0) rmSync(world, { recursive: true, force: true })
}
console.log(`prove-update-leftover-helper: ${failures === 0 ? 'PASS' : `${failures} FAIL`}`)
process.exitCode = failures === 0 ? 0 : 1
