#!/usr/bin/env bun
// ============================================================================
//  scripts/daemon/prove-daemon-handshake.ts
//  PINS: the daemon-version handshake (src/daemon/handshake.ts + protocol v2).
//  A redeploy leaves the OLD daemon serving the NEW client; the law is that
//  the mismatch is DETECTED at connect, HEALED without the operator's hand
//  where safe, and HONEST where not:
//    · a scripted PRE-HANDSHAKE daemon (the v1 wire, no `hello`) is detected
//      by its own EPROTO, never killed, the honest line names /daemon
//      restart, and the old verbs still work (the negotiated dialect);
//    · an idle daemon of the handshake family one proto older is restarted
//      TRANSPARENTLY — restart-when-idle, the successor answers matched, no
//      shutdown sent, no spawn, no operator hand (the poison);
//    · a live old daemon is never killed — the line is painted and /daemon
//      restart arms the restart for its next idle moment;
//    · an idle PRE-handshake daemon heals through /daemon restart's one
//      keystroke (stop when idle + a successor whose posture the receipt
//      names) — the first-migration exception, deliberate: its record does
//      not say whether it is owned or an operator's persistent cron daemon,
//      so no client may re-posture it silently.
//  Plus: the real server's hello (keyless, readiness-exempt), the EPROTO
//  dialect retry, the certificate grammar, and the wiring pins.
//  Run:  ~/.bun/bin/bun run scripts/daemon/prove-daemon-handshake.ts
// ============================================================================
import net from 'node:net'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ` — ${detail}` : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
}
const sleep = (ms: number): Promise<void> => new Promise(res => setTimeout(res, ms))

// Isolation BEFORE any src import: the daemon plane (socket, supervisor.json,
// control.key, concourse-workers.json) all resolve under MERCURY_DAEMON_DIR.
const home = mkdtempSync(join(tmpdir(), 'hermes-hs-'))
process.env.MERCURY_CONFIG_DIR = join(home, 'config')
mkdirSync(process.env.MERCURY_CONFIG_DIR, { recursive: true })
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '9.9.9' }

const protocol = await import('../../src/daemon/protocol.js')
const socketMod = await import('../../src/daemon/controlSocket.js')
const hsMod = await import('../../src/daemon/handshake.js')
const { MERCURY_DAEMON_PROTO, encodeFrame, readControlFrame } = protocol
const { controlSockPath, daemonControlRpc, forgetDaemonProtoForTesting, supervisorStatePath } = socketMod

const CONTROL_KEY = 'k'.repeat(64)

/** A fresh scratch daemon dir per scenario (socket + records + key + state). */
let scenarioN = 0
function freshPlane(): string {
  scenarioN++
  const dir = join(home, `d${scenarioN}`)
  mkdirSync(dir, { recursive: true })
  process.env.MERCURY_DAEMON_DIR = dir
  writeFileSync(join(dir, 'control.key'), CONTROL_KEY)
  hsMod.resetDaemonHandshakeForTesting()
  forgetDaemonProtoForTesting()
  return dir
}

interface Fixture {
  received: string[]
  killed: () => boolean
  close: () => Promise<void>
}

/** The PRE-HANDSHAKE daemon, faithfully the v1 router: ping keyless; then
 *  the version gate (proto must be exactly 1 — anything else EPROTO with
 *  serverProto/serverVersion, the real v1 refusal); then auth; `list`
 *  serves, `hello` and every other unknown verb answers "unknown op". */
function startOldDaemon(opts: { version: string; jobs: Array<Record<string, unknown>> }): Promise<Fixture> {
  const received: string[] = []
  let killed = false
  const server = net.createServer(sock => {
    readControlFrame(
      sock,
      line => {
        const req = JSON.parse(line) as Record<string, unknown>
        const op = String(req.op)
        received.push(op)
        const answer = (payload: unknown): void => void sock.end(encodeFrame(payload))
        if (op === 'ping') return answer({ ok: true, op: 'ping', version: opts.version, proto: 1 })
        if (op === 'shutdown') {
          killed = true
          setTimeout(() => server.close(), 5)
          return answer({ ok: true, op: 'shutdown', reaped: 0 })
        }
        const proto = req.proto
        if (typeof proto !== 'number' || proto < 1 || proto > 1) {
          return answer({
            ok: false,
            code: 'EPROTO',
            error: `proto mismatch (server=1, client=${typeof proto === 'number' ? proto : -1}) — daemon and CLI versions differ; restart Mercury`,
            serverProto: 1,
            serverVersion: opts.version,
          })
        }
        if (req.auth !== CONTROL_KEY) return answer({ ok: false, code: 'EAUTH', error: `${op} rejected: no key` })
        if (op === 'list') return answer({ ok: true, op: 'list', jobs: opts.jobs })
        return answer({ ok: false, code: 'EUNKNOWN', error: `unknown op: ${op}` })
      },
      () => sock.destroy(),
    )
  })
  return new Promise(resolve => {
    // A closed net server leaves its socket FILE — a successor on the same
    // path must unlink first (the real server does the same before listen).
    try {
      unlinkSync(controlSockPath())
    } catch {
      /* no stale socket — fine */
    }
    server.listen(controlSockPath(), () =>
      resolve({
        received,
        killed: () => killed,
        close: () => new Promise(done => server.close(() => done())),
      }),
    )
  })
}

/** A daemon of the HANDSHAKE family at a given proto: hello keyless and
 *  gate-exempt; restart-when-idle keyed — 'restarting' when idle (then the
 *  fixture swaps itself for `successor`), 'armed' while live. */
function startVersionedDaemon(opts: {
  proto: number
  version: string
  pid: number
  live: number
  liveSessions: number
  successor?: () => Promise<Fixture>
}): Promise<Fixture> {
  const received: string[] = []
  let killed = false
  let restartArmed = false
  const server = net.createServer(sock => {
    readControlFrame(
      sock,
      line => {
        const req = JSON.parse(line) as Record<string, unknown>
        const op = String(req.op)
        received.push(op)
        const answer = (payload: unknown): void => void sock.end(encodeFrame(payload))
        if (op === 'hello') {
          return answer({
            ok: true,
            op: 'hello',
            proto: opts.proto,
            minProto: 1,
            ready: true,
            version: opts.version,
            buildTree: null,
            pid: opts.pid,
            startedAt: Date.now() - 5000,
            ownerPid: null,
            foreground: false,
            live: opts.live,
            liveSessions: opts.liveSessions,
            warm: 0,
            restartArmed,
          })
        }
        if (op === 'ping') return answer({ ok: true, op: 'ping', version: opts.version, proto: opts.proto })
        if (op === 'shutdown') {
          killed = true
          setTimeout(() => server.close(), 5)
          return answer({ ok: true, op: 'shutdown', reaped: 0 })
        }
        const proto = req.proto
        if (typeof proto !== 'number' || proto < 1 || proto > opts.proto) {
          return answer({ ok: false, code: 'EPROTO', error: 'proto mismatch', serverProto: opts.proto, serverVersion: opts.version })
        }
        if (req.auth !== CONTROL_KEY) return answer({ ok: false, code: 'EAUTH', error: `${op} rejected: no key` })
        if (op === 'list') return answer({ ok: true, op: 'list', jobs: [] })
        if (op === 'restart-when-idle') {
          if (opts.live > 0) {
            restartArmed = true
            return answer({ ok: true, op: 'restart-when-idle', state: 'armed', live: opts.live })
          }
          setTimeout(() => {
            server.close(() => {
              if (opts.successor) void opts.successor()
            })
          }, 10)
          return answer({ ok: true, op: 'restart-when-idle', state: 'restarting', live: 0 })
        }
        return answer({ ok: false, code: 'EUNKNOWN', error: `unknown op: ${op}` })
      },
      () => sock.destroy(),
    )
  })
  return new Promise(resolve => {
    try {
      unlinkSync(controlSockPath())
    } catch {
      /* no stale socket — fine */
    }
    server.listen(controlSockPath(), () =>
      resolve({
        received,
        killed: () => killed,
        close: () => new Promise(done => server.close(() => done())),
      }),
    )
  })
}

function seedRecords(dir: string, workers: Record<string, unknown>): void {
  writeFileSync(join(dir, 'concourse-workers.json'), JSON.stringify({ version: 1, workers }))
}
function seedSupervisorRecord(dir: string, rec: Record<string, unknown>): void {
  writeFileSync(join(dir, 'supervisor.json'), JSON.stringify(rec))
}

console.log('============================================================')
console.log(' Daemon-version handshake — detect at connect · heal idle · honest live')
console.log('============================================================')

// ── A. the pre-handshake daemon with a LIVE session ─────────────────────────
section('A · pre-handshake daemon, 1 live session: detected, honest line, never killed, old verbs still work')
{
  const dir = freshPlane()
  seedRecords(dir, {
    'concourse-w1': { workerId: 'concourse-w1', sessionId: 's1', pid: process.pid },
  })
  seedSupervisorRecord(dir, { pid: process.pid, version: '1.5.6', origin: 'transient', startedAt: Date.now() - 60_000, dir: '/tmp/p', controlSock: controlSockPath() })
  const old = await startOldDaemon({
    version: '1.5.6',
    jobs: [
      { short: 'concourse-w1', sessionId: 's1', prompt: '', source: 'user', state: 'ready', startedAt: 1, cliVersion: '1.5.6' },
      // A warm runner: a concourse short with NO record — cache, set aside.
      { short: 'concourse-w2', sessionId: 's2', prompt: '', source: 'user', state: 'ready', startedAt: 1, cliVersion: '1.5.6' },
    ],
  })
  const v = await hsMod.handshakeDaemon({ timeoutMs: 500 })
  check('A1 the first verb on the wire is `hello`', old.received[0] === 'hello', old.received.join(','))
  check('A2 detected: state older, the pre-handshake mark, the daemon version named', v.state === 'older' && v.daemon?.preHandshake === true && v.daemon?.version === '1.5.6')
  check('A3 the live count is records ∩ roster (the warm runner set aside)', v.live === 1 && v.liveSessions === 1, `live=${v.live} sessions=${v.liveSessions}`)
  check(
    'A4 THE HONEST LINE, exactly',
    v.line === 'daemon v1.5.6 running with 1 live session — new features wait until it restarts · /daemon restart when ready',
    String(v.line),
  )
  check('A5 the heal is the operator (no restart verb on the v1 wire)', v.heal === 'operator' && v.healState === 'operator')
  check('A6 the daemon was NEVER killed by the handshake', old.killed() === false)
  const list = await daemonControlRpc({ op: 'list' } as never, { timeoutMs: 500 })
  check('A7 old verbs still work — the client speaks the negotiated dialect', list.ok === true && (list as { op?: string }).op === 'list')
  // The dialect retry itself: forget the memo, a keyed op bounces EPROTO
  // once and is re-sent in the daemon's own proto — first execution, once.
  forgetDaemonProtoForTesting()
  const before = old.received.filter(o => o === 'list').length
  const retried = await daemonControlRpc({ op: 'list' } as never, { timeoutMs: 500 })
  const after = old.received.filter(o => o === 'list').length
  check('A8 the EPROTO dialect retry serves the op (one refusal, one send in dialect)', retried.ok === true && after === before + 2, `list frames ${after - before}`)
  check('A9 no crash: the process is here and the fixture still serves', (await hsMod.handshakeDaemon({ timeoutMs: 500 })).state === 'older')
  const evidence = hsMod.daemonHandshakeEvidence(hsMod.lastDaemonHandshake())
  check('A10 the certificate grammar: version vs version, waiting on the live session', /daemon v1\.5\.6 · protocol 1 \(pre-handshake\)/.test(evidence) && /waiting on 1 live session — \/daemon restart when ready/.test(evidence), evidence)
  await old.close()
}

// ── B. the pre-handshake daemon IDLE: /daemon restart heals with one hand ───
section('B · pre-handshake daemon, idle: no silent kill; /daemon restart stops it and starts a successor whose posture the receipt names')
{
  const dir = freshPlane()
  seedSupervisorRecord(dir, { pid: process.pid, version: '1.5.6', origin: 'transient', startedAt: Date.now() - 60_000, dir: '/tmp/project-b', controlSock: controlSockPath() })
  const old = await startOldDaemon({ version: '1.5.6', jobs: [] })
  const v = await hsMod.handshakeDaemon({ timeoutMs: 500 })
  check('B1 idle detected (live 0), still never killed by the handshake alone', v.live === 0 && old.killed() === false)
  check(
    'B2 the idle honest line names the one door',
    v.line === 'daemon v1.5.6 running with nothing live — new features wait until it restarts · /daemon restart',
    String(v.line),
  )
  const spawns: Array<{ dir: string; posture: string }> = []
  const receipt = await hsMod.restartDaemon({
    by: 'pin',
    posture: 'owned',
    pollMs: 25,
    tries: 80,
    spawn: async (spawnDir, posture) => {
      spawns.push({ dir: spawnDir, posture })
      // The successor: this build's own family, matched.
      await startVersionedDaemon({ proto: MERCURY_DAEMON_PROTO, version: '9.9.9', pid: 4242, live: 0, liveSessions: 0 })
      return 4242
    },
  })
  check('B3 the old daemon was stopped through its own shutdown verb', old.killed() === true)
  check('B4 the successor was spawned with the RECORD\'s scheduling dir', spawns.length === 1 && spawns[0]!.dir === '/tmp/project-b', JSON.stringify(spawns))
  check('B5 the receipt is typed restarted and names the owned posture', receipt.state === 'restarted' && receipt.line.includes("this Mercury's own daemon"), `${receipt.state}: ${receipt.line}`)
  check('B6 the follow-up handshake is matched (the heal completed)', (await hsMod.handshakeDaemon({ timeoutMs: 500 })).state === 'matched')
}

// ── C. the handshake family, one proto older, IDLE: transparent restart ─────
section('C · v2-family daemon one proto older, idle: restart-when-idle heals TRANSPARENTLY — no shutdown, no spawn, no operator hand (the poison)')
{
  freshPlane()
  const client = { proto: MERCURY_DAEMON_PROTO + 1, version: '9.9.10' }
  let successor: Fixture | null = null
  const oldDaemon = await startVersionedDaemon({
    proto: MERCURY_DAEMON_PROTO,
    version: '9.9.9',
    pid: 111,
    live: 0,
    liveSessions: 0,
    successor: async () => {
      successor = await startVersionedDaemon({ proto: MERCURY_DAEMON_PROTO + 1, version: '9.9.10', pid: 222, live: 0, liveSessions: 0 })
      return successor
    },
  })
  const v = await hsMod.handshakeDaemon({ timeoutMs: 500, client })
  check('C1 detected: older, NOT pre-handshake, no line owed while the heal can run', v.state === 'older' && v.daemon?.preHandshake === false && v.line === null)
  const heal = await hsMod.healDaemonVersion(v, { by: 'pin' })
  check('C2 the heal answers restarting (idle)', heal.state === 'restarting')
  let matched: import('../../src/daemon/handshake.js').DaemonHandshakeVerdict | null = null
  for (let i = 0; i < 80; i++) {
    const probe = await hsMod.handshakeDaemon({ timeoutMs: 300, client })
    if (probe.state === 'matched' && probe.daemon?.pid === 222) {
      matched = probe
      break
    }
    await sleep(25)
  }
  check('C3 the successor answers MATCHED — healed with no operator hand', matched !== null, 'never matched')
  check('C4 transparent: no shutdown verb ever crossed the wire', !oldDaemon.received.includes('shutdown') && oldDaemon.killed() === false)
  check('C5 the restart rode restart-when-idle', oldDaemon.received.includes('restart-when-idle'))
  if (successor !== null) await (successor as Fixture).close()
}

// ── D. the handshake family, one proto older, LIVE: armed + the line ────────
section('D · v2-family daemon one proto older, 2 live sessions: never killed; the line paints; /daemon restart arms')
{
  freshPlane()
  const client = { proto: MERCURY_DAEMON_PROTO + 1, version: '9.9.10' }
  const busy = await startVersionedDaemon({ proto: MERCURY_DAEMON_PROTO, version: '9.9.9', pid: 333, live: 2, liveSessions: 2 })
  const v = await hsMod.handshakeDaemon({ timeoutMs: 500, client })
  check(
    'D1 THE HONEST LINE, exactly (the brief\'s grammar)',
    v.line === 'daemon v9.9.9 running with 2 live sessions — new features wait until it restarts · /daemon restart when ready',
    String(v.line),
  )
  const heal = await hsMod.healDaemonVersion(v, { by: 'pin' })
  check('D2 the heal ARMS instead of killing (live runners hold it)', heal.state === 'armed' && heal.live === 2)
  check('D3 nothing was killed and no shutdown crossed', busy.killed() === false && !busy.received.includes('shutdown'))
  const line = hsMod.lastDaemonHandshake()?.line
  check('D4 the line still stands after arming (the operator still owes the restart moment)', line === v.line, String(line))
  const receipt = await hsMod.restartDaemon({ by: 'pin', posture: 'owned', pollMs: 25, tries: 4 })
  check('D5 /daemon restart answers the typed armed receipt', receipt.state === 'armed' && receipt.line.includes('restarts when its 2 live sessions finish'), `${receipt.state}: ${receipt.line}`)
  await busy.close()
}

// ── E. the REAL server: hello keyless + readiness-exempt; restart keyed ─────
section('E · the real control server: hello answers while starting and needs no key; restart-when-idle is keyed and reaches the host')
{
  const dir = freshPlane()
  const { startControlServer } = await import('../../src/daemon/controlServer.js')
  const { mintControlKey } = socketMod
  const { DaemonBreaker } = await import('../../src/utils/daemonBreaker.js')
  const key = await mintControlKey()
  let ready = false
  const restartAsks: string[] = []
  const fakeRoster = { list: () => [], has: () => ({ present: false }), liveCount: () => 0, totalCount: () => 0, getSupervisorState: () => ({ degraded: false }) } as never
  const server = await startControlServer({
    roster: fakeRoster,
    breaker: new DaemonBreaker(),
    dir,
    startedAt: Date.now(),
    maxInflight: 1,
    controlKey: key,
    isReady: () => ready,
    onShutdown: () => ({ reaped: 0, workers: [] }),
    hello: () => ({
      version: '9.9.9',
      buildTree: null,
      pid: process.pid,
      startedAt: Date.now() - 1000,
      ownerPid: null,
      foreground: false,
      live: 0,
      liveSessions: 0,
      warm: 0,
      restartArmed: false,
    }),
    restartWhenIdle: by => {
      restartAsks.push(by)
      return { state: 'restarting', live: 0 }
    },
  } as never)
  const starting = await hsMod.handshakeDaemon({ timeoutMs: 500 })
  check('E1 hello answers BEFORE readiness (ready:false ⇒ verdict starting, no spawn)', starting.state === 'starting' && starting.daemon?.ready === false)
  ready = true
  const v = await hsMod.handshakeDaemon({ timeoutMs: 500 })
  check('E2 ready ⇒ matched against this build (same version, proto, tree)', v.state === 'matched', v.state)
  const healed = await daemonControlRpc({ op: 'restart-when-idle', proto: MERCURY_DAEMON_PROTO, by: 'pin-e' } as never, { timeoutMs: 500 })
  check('E3 restart-when-idle reaches the host with its attribution', healed.ok === true && restartAsks.join(',') === 'pin-e')
  // The adversarial caller: no key ⇒ EAUTH (the verb ends a process).
  const bare = await new Promise<Record<string, unknown>>(resolve => {
    const sock = net.connect(controlSockPath())
    let buf = ''
    sock.on('connect', () => sock.write(JSON.stringify({ op: 'restart-when-idle', proto: MERCURY_DAEMON_PROTO }) + '\n'))
    sock.on('data', d => {
      buf += String(d)
      const nl = buf.indexOf('\n')
      if (nl >= 0) {
        sock.destroy()
        resolve(JSON.parse(buf.slice(0, nl)) as Record<string, unknown>)
      }
    })
    sock.on('error', () => resolve({ code: 'ENOCONN' }))
  })
  check('E4 restart-when-idle without the key is EAUTH', bare.code === 'EAUTH')
  await server.close()
}

// ── F. the pure grammar: mirrors, refusals, evidence ────────────────────────
section('F · the pure grammar: the newer mirror, the refused line, the evidence words')
{
  const client = { proto: 2, version: '1.6.0', buildTree: 'aaaa' }
  const newer = hsMod.decideHandshake(
    {
      kind: 'hello',
      reply: { ok: true, op: 'hello', proto: 3, minProto: 1, ready: true, version: '1.7.0', buildTree: 'bbbb', pid: 9, startedAt: 1, ownerPid: null, foreground: false, live: 1, liveSessions: 1, warm: 0, restartArmed: false } as never,
    },
    client,
  )
  check('F1 a NEWER daemon mirrors the line, never a crash', newer.state === 'newer' && newer.line === "daemon v1.7.0 (newer than this Mercury v1.6.0) running with 1 live session — this Mercury's features wait until it restarts · /daemon restart when ready", String(newer.line))
  const idleNewer = hsMod.applyHeal({ ...newer, live: 0, liveSessions: 0 }, { state: 'refused', live: 0, detail: 'runs on a terminal: stop it there (ctrl-c) and run `mercury daemon` again' })
  check('F2 a refused heal puts the reason ON the line', idleNewer.line !== null && idleNewer.line.includes('runs on a terminal'), String(idleNewer.line))
  const rebuilt = hsMod.decideHandshake(
    {
      kind: 'hello',
      reply: { ok: true, op: 'hello', proto: 2, minProto: 1, ready: true, version: '1.6.0', buildTree: 'cccc', pid: 9, startedAt: 1, ownerPid: null, foreground: false, live: 3, liveSessions: 3, warm: 0, restartArmed: false } as never,
    },
    client,
  )
  check('F3 same proto, other build ⇒ rebuilt: heal armed silently, NO line (nothing is dead)', rebuilt.state === 'rebuilt' && rebuilt.heal === 'restart-when-idle' && rebuilt.line === null)
  check('F4 rebuilt evidence names both trees', hsMod.daemonHandshakeEvidence(rebuilt).includes('tree cccc vs aaaa'), hsMod.daemonHandshakeEvidence(rebuilt))
  const restarting = hsMod.applyHeal(rebuilt, { state: 'restarting', live: 0 })
  check('F5 the heal status words: idle-restarted', hsMod.daemonHandshakeEvidence(restarting).includes('idle-restarted'))
}

// ── G. wiring pins (source): the door, the daemon, the screen, the record ───
section('G · wiring: ensureDaemon rides the handshake; main wires hello/restart + the successor; the record carries the fact; the REPL paints')
{
  const read = (p: string): string => readFileSync(join(import.meta.dir, '..', '..', p), 'utf8')
  const ensure = read('src/services/switchboard/ensureDaemon.ts')
  // The CALL spellings, never the header comment (which names spawnOwnedDaemon
  // first and read the order backwards).
  check('G1 the door handshakes BEFORE any spawn (never beside a live daemon)', ensure.indexOf('await hs.handshakeDaemon(') !== -1 && ensure.indexOf('await hs.handshakeDaemon(') < ensure.indexOf('spawnOwnedDaemon(getCwd()'))
  check('G2 the door heals and awaits the successor instead of spawning', ensure.includes('healDaemonVersion') && ensure.includes('awaitSuccessor'))
  const dmain = read('src/daemon/main.ts')
  check('G3 the daemon serves hello facts with the BOOT-captured tree', dmain.includes('buildTree: bootBuildTree') && dmain.includes('describeArtifactIdentity(currentVersion()).buildTree'))
  check('G4 restart-when-idle: armed while live, refused on a terminal, storm-guarded', dmain.includes('restartWhenIdle: by =>') && dmain.includes('restartArmed = true') && dmain.includes('runs on a terminal') && dmain.includes('RESTART_STORM_GUARD_MS'))
  check('G5 the successor is spawned BEFORE the lock release and waits for the lock', dmain.indexOf('spawnSuccessorDaemon()') !== -1 && dmain.indexOf('spawnSuccessorDaemon()') < dmain.indexOf('await supervisorLock?.release()') && dmain.includes('SUCCESSOR_LOCK_WAIT_MS'))
  check('G6 the successor re-executes THIS daemon: own argv, env, cwd', dmain.includes('[...process.execArgv, ...process.argv.slice(1)]') && dmain.includes('cwd: process.cwd()'))
  check('G7 supervisor.json carries the version fact', dmain.includes('proto: MERCURY_DAEMON_PROTO') && dmain.includes('ownerPid: parseOwnerPid()'))
  const repl = read('src/screens/REPL.tsx')
  check('G8 the REPL paints the one line and clears it on match', repl.includes('subscribeDaemonHandshake') && repl.includes("removeNotification(key)"))
  const health = read('src/utils/healthReport.ts')
  check('G9 the certificate daemon row runs the handshake and the line IS the fix', health.includes('daemonHandshakeEvidence') && health.includes('fix: hs.line'))
  const statusSrc = read('src/daemon/status.ts')
  check('G10 the status probe handshakes BEFORE the keyed ops (an old daemon still reports)', statusSrc.indexOf('snapshot.handshake = await handshakeDaemon') !== -1 && statusSrc.indexOf('snapshot.handshake = await handshakeDaemon') < statusSrc.indexOf("daemonControlRpc({ op: 'status'"))
}

// hygiene
rmSync(home, { recursive: true, force: true })

console.log('\n' + '═'.repeat(76))
if (failures === 0) console.log('✅ ALL DAEMON-HANDSHAKE PROOFS PASS')
else console.log(`❌ ${failures} DAEMON-HANDSHAKE PROOF(S) FAILED`)
console.log('═'.repeat(76))
process.exit(failures === 0 ? 0 : 1)
