import net from 'node:net'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.10' }
const arg = process.argv.indexOf('--source-root')
const root = arg < 0 ? resolve(dirname(fileURLToPath(import.meta.url)), '../..') : resolve(process.argv[arg + 1]!)

const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'daemon-snap-slow-')))
const home = join(scratch, 'home')
const daemonDir = join(scratch, 'd')
const work = join(scratch, 'work')
for (const dir of [home, daemonDir, work]) mkdirSync(dir, { recursive: true })

const savedEnv = { ...process.env }
Object.assign(process.env, {
  HOME: home,
  MERCURY_CONFIG_DIR: home,
  MERCURY_DAEMON_DIR: daemonDir,
  MERCURY_CREDENTIAL_STORE: 'file',
  MERCURY_LOCAL_PROBE_TARGETS: 'none',
})
for (const key of [
  'MERCURY_HOME',
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'OPENAI_API_KEY',
  'OPENROUTER_API_KEY',
  'GEMINI_API_KEY',
  'GOOGLE_API_KEY',
  'MERCURY_OAUTH_TOKEN',
]) {
  delete process.env[key]
}

const wait = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms))

let checks = 0
let failures = 0
const check = (label: string, pass: boolean, detail = ''): void => {
  checks++
  if (!pass) failures++
  console.log(`[${pass ? 'PASS' : 'FAIL'}] ${label}${!pass && detail ? ` — ${detail}` : ''}`)
}

const { MERCURY_DAEMON_PROTO } = (await import(`${root}/src/daemon/protocol.ts`)) as { MERCURY_DAEMON_PROTO: number }
const { controlKeyPath, daemonStatePath, setBoxReadingForTesting } = (await import(
  `${root}/src/daemon/controlSocket.ts`
)) as {
  controlKeyPath: () => string
  daemonStatePath: () => string
  setBoxReadingForTesting: (r: { load1: number; cores: number } | null) => void
}
const { composeSignInView } = (await import(`${root}/src/daemon/signInView.ts`)) as {
  composeSignInView: (opts?: { refresh?: boolean }) => unknown
}
const { daemonSnapshot } = (await import(`${root}/src/utils/cockpit/daemonSnapshot.ts`)) as {
  daemonSnapshot: () => { state: string; reason?: string }
}
const { runWithCwdOverride } = (await import(`${root}/src/utils/cwd.ts`)) as {
  runWithCwdOverride: <T>(cwd: string, fn: () => Promise<T>) => Promise<T>
}
const { runHealthReport } = (await import(`${root}/src/utils/healthReport.ts`)) as {
  runHealthReport: () => Promise<{ sections: Array<{ checks: Array<{ id: string; status: string; evidence: string }> }> }>
}

const sockPath = join(daemonDir, 'control.sock')
writeFileSync(controlKeyPath(), 'a'.repeat(64), { mode: 0o600 })

function writeRecord(startedAt: number): void {
  writeFileSync(
    daemonStatePath(),
    JSON.stringify({
      pid: process.pid,
      version: '1.0.10',
      proto: MERCURY_DAEMON_PROTO,
      origin: 'transient',
      startedAt,
      dir: daemonDir,
      controlSock: sockPath,
    }),
  )
}

let mode: 'slow-live' | 'silent-wedged' | 'fast-live' = 'slow-live'
let slowHoldUntil = 0
const openSockets = new Set<net.Socket>()

const server = net.createServer(sock => {
  openSockets.add(sock)
  sock.on('close', () => openSockets.delete(sock))
  sock.on('error', () => {})
  let buf = ''
  sock.on('data', chunk => {
    buf += chunk.toString('utf8')
    const nl = buf.indexOf('\n')
    if (nl < 0) return
    const line = buf.slice(0, nl)
    buf = buf.slice(nl + 1)
    if (mode === 'silent-wedged') return
    let req: { op?: string } = {}
    try {
      req = JSON.parse(line) as { op?: string }
    } catch {
      return
    }
    const respond = (): void => {
      if (sock.destroyed) return
      if (req.op === 'ping') {
        sock.write(`${JSON.stringify({ ok: true, op: 'ping', version: '1.0.10', proto: MERCURY_DAEMON_PROTO, working: 0 })}\n`)
      } else if (req.op === 'hello') {
        sock.write(
          `${JSON.stringify({
            ok: true,
            op: 'hello',
            version: '1.0.10',
            proto: MERCURY_DAEMON_PROTO,
            buildTree: null,
            pid: process.pid,
            startedAt: 1718000000000,
            ownerPid: null,
            foreground: false,
            ready: true,
            restartArmed: false,
            live: 0,
            liveSessions: 0,
          })}\n`,
        )
      } else if (req.op === 'signIns') {
        sock.write(`${JSON.stringify({ ok: true, op: 'signIns', view: composeSignInView({ refresh: true }) })}\n`)
      }
    }
    const delay = mode === 'slow-live' ? Math.max(0, slowHoldUntil - Date.now()) : 0
    if (delay > 0) setTimeout(respond, delay)
    else respond()
  })
})

await new Promise<void>((resolveListen, rejectListen) => {
  server.once('error', rejectListen)
  server.listen(sockPath, () => resolveListen())
})

try {
  setBoxReadingForTesting({ load1: 0, cores: 8 })

  writeRecord(1718000000000)
  mode = 'slow-live'
  slowHoldUntil = Date.now() + 3300
  const first = daemonSnapshot()
  check(
    'initial read while ping is in flight stays live (verifying rpc)',
    first.state === 'live' && (first.reason ?? '').includes('verifying rpc'),
    JSON.stringify(first),
  )

  await wait(3600)
  mode = 'fast-live'
  const afterSlow = daemonSnapshot()
  check(
    'a live daemon that pauses 3.3 s under zero loadavg still settles as live rpc ok, not wedged',
    afterSlow.state === 'live' && (afterSlow.reason ?? '').includes('rpc ✓') && !(afterSlow.reason ?? '').includes('wedged'),
    JSON.stringify(afterSlow),
  )

  const cert = await runWithCwdOverride(work, () => runHealthReport())
  const rows = cert.sections.flatMap(s => s.checks)
  const daemonRow = rows.find(r => r.id === 'daemon')
  const signInsRow = rows.find(r => r.id === 'daemon-sign-ins')
  check(
    'mercury health scheduler-daemon row reads ok rather than wedged after the slow ping settles',
    daemonRow?.status === 'ok' && !daemonRow.evidence.includes('wedged'),
    JSON.stringify(daemonRow),
  )
  check(
    'mercury health daemon-sign-ins row compares sign-ins rather than skipping a wedged daemon',
    signInsRow?.status === 'ok' && !signInsRow.evidence.includes('wedged'),
    JSON.stringify(signInsRow),
  )

  writeRecord(1718000001000)
  mode = 'silent-wedged'
  const wedgedKick = daemonSnapshot()
  check(
    'a new daemon record starts fresh while its own ping is in flight',
    wedgedKick.state === 'live' && (wedgedKick.reason ?? '').includes('verifying rpc'),
    JSON.stringify(wedgedKick),
  )
  const deadline = Date.now() + 14_000
  let settledWedged = daemonSnapshot()
  while (settledWedged.state === 'live' && Date.now() < deadline) {
    await wait(100)
    settledWedged = daemonSnapshot()
  }
  check(
    'a genuinely unresponsive control socket still downgrades to unavailable (wedged)',
    settledWedged.state === 'unavailable' && (settledWedged.reason ?? '').includes('control socket unresponsive — wedged?'),
    JSON.stringify(settledWedged),
  )

  mode = 'fast-live'
  writeRecord(1718000002000)
  const restarted = daemonSnapshot()
  check(
    'a restarted daemon with a new startedAt drops the prior wedged verdict immediately within the TTL',
    restarted.state === 'live' && !(restarted.reason ?? '').includes('wedged'),
    JSON.stringify(restarted),
  )
  const settleDeadline = Date.now() + 2000
  let restartedSettled = daemonSnapshot()
  while (!(restartedSettled.reason ?? '').includes('rpc ✓') && Date.now() < settleDeadline) {
    await wait(50)
    restartedSettled = daemonSnapshot()
  }
  check(
    'the restarted daemon confirms rpc ok',
    restartedSettled.state === 'live' && (restartedSettled.reason ?? '').includes('rpc ✓'),
    JSON.stringify(restartedSettled),
  )
} finally {
  setBoxReadingForTesting(null)
  for (const s of openSockets) s.destroy()
  await new Promise<void>(r => server.close(() => r()))
  for (const key of Object.keys(process.env)) {
    if (!(key in savedEnv)) delete process.env[key]
  }
  Object.assign(process.env, savedEnv)
  rmSync(scratch, { recursive: true, force: true })
}

console.log(`${checks - failures}/${checks} checks; ${failures} red`)
process.exit(failures === 0 ? 0 : 1)
