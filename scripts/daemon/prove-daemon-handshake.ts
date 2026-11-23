#!/usr/bin/env bun
import net from 'node:net'
import { mkdtempSync, mkdirSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

let failures = 0
function check(label: string, cond: boolean, detail = '', hint = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ` — ${detail}` : ''}${!cond && hint ? ` — ${hint}` : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
}
const sleep = (ms: number): Promise<void> => new Promise(res => setTimeout(res, ms))

const home = mkdtempSync(join(tmpdir(), 'mercury-hs-'))
process.env.MERCURY_CONFIG_DIR = join(home, 'config')
mkdirSync(process.env.MERCURY_CONFIG_DIR, { recursive: true })
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '9.9.9' }

const protocol = await import('../../src/daemon/control/protocol.js')
const socketMod = await import('../../src/daemon/control/controlSocket.js')
const hsMod = await import('../../src/daemon/control/handshake.js')
const { MERCURY_DAEMON_PROTO, encodeFrame, readControlFrame } = protocol
const { controlSockPath, daemonControlRpc, forgetDaemonProtoForTesting, daemonStatePath: daemonStatePath } = socketMod

const CONTROL_KEY = 'k'.repeat(64)

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
  shutdownFrame?: () => Record<string, unknown> | null
  close: () => Promise<void>
}

function startOldDaemon(opts: { version: string; jobs: Array<Record<string, unknown>> }): Promise<Fixture> {
  const received: string[] = []
  let killed = false
  let shutdownFrame: Record<string, unknown> | null = null
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
          shutdownFrame = { op, ...('reapWorkers' in req ? { reapWorkers: req.reapWorkers } : {}) }
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
    try {
      unlinkSync(controlSockPath())
    } catch {
    }
    server.listen(controlSockPath(), () =>
      resolve({
        received,
        killed: () => killed,
        shutdownFrame: () => shutdownFrame,
        close: () => new Promise(done => server.close(() => done())),
      }),
    )
  })
}

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
function seedDaemonRecord(dir: string, rec: Record<string, unknown>): void {
  writeFileSync(join(dir, 'daemon.json'), JSON.stringify(rec))
}

console.log('============================================================')
console.log(' Daemon-version handshake — detect at connect · heal idle · honest live')
console.log('============================================================')

section('A · pre-handshake daemon, 1 live session: detected, honest line, never killed, old verbs still work')
{
  const dir = freshPlane()
  seedRecords(dir, {
    'concourse-w1': { workerId: 'concourse-w1', sessionId: 's1', pid: process.pid },
  })
  seedDaemonRecord(dir, { pid: process.pid, version: '1.5.6', origin: 'transient', startedAt: Date.now() - 60_000, dir: '/tmp/p', controlSock: controlSockPath() })
  const old = await startOldDaemon({
    version: '1.5.6',
    jobs: [
      { short: 'concourse-w1', sessionId: 's1', prompt: '', source: 'user', state: 'ready', startedAt: 1, cliVersion: '1.5.6' },
      { short: 'concourse-w2', sessionId: 's2', prompt: '', source: 'user', state: 'ready', startedAt: 1, cliVersion: '1.5.6' },
    ],
  })
  const v = await hsMod.handshakeDaemon({ timeoutMs: 500 })
  check('A1 the first verb on the wire is `hello`', old.received[0] === 'hello', old.received.join(','), 'handshakeDaemon in src/daemon/control/handshake.ts must send hello as its first control verb')
  check('A2 detected: state older, the pre-handshake mark, the daemon version named', v.state === 'older' && v.daemon?.preHandshake === true && v.daemon?.version === '1.5.6', '', 'decideHandshake in src/daemon/control/handshake.ts must give state older, preHandshake true and the daemon version when the daemon answers ping but not hello')
  check('A3 the live count is records ∩ roster (the warm runner set aside)', v.live === 1 && v.liveSessions === 1, `live=${v.live} sessions=${v.liveSessions}`, 'handshakeDaemon in src/daemon/control/handshake.ts must count live as roster records that also appear in the daemon list, so the warm runner is not counted')
  check(
    'A4 THE HONEST LINE, exactly',
    v.line === 'daemon v1.5.6 running with 1 live session — new features wait until it restarts · /daemon restart when ready',
    String(v.line),
    'honestLine in src/daemon/control/handshake.ts builds this line; match its wording exactly',
  )
  check('A5 the heal is the operator (no restart verb on the v1 wire)', v.heal === 'operator' && v.healState === 'operator', '', 'decideHandshake in src/daemon/control/handshake.ts must leave the heal to the operator for a daemon that predates the hello verb')
  check('A6 the daemon was NEVER killed by the handshake', old.killed() === false, '', 'handshakeDaemon and healDaemonVersion in src/daemon/control/handshake.ts must not send shutdown to a daemon with live sessions')
  const list = await daemonControlRpc({ op: 'list' } as never, { timeoutMs: 500 })
  check('A7 old verbs still work — the client speaks the negotiated dialect', list.ok === true && (list as { op?: string }).op === 'list', '', 'daemonControlRpc in src/daemon/control/controlSocket.ts must keep using the protocol the daemon negotiated, so a verb sent to an old daemon is still answered')
  forgetDaemonProtoForTesting()
  const before = old.received.filter(o => o === 'list').length
  const retried = await daemonControlRpc({ op: 'list' } as never, { timeoutMs: 500 })
  const after = old.received.filter(o => o === 'list').length
  check('A8 the EPROTO dialect retry serves the op (one refusal, one send in dialect)', retried.ok === true && after === before + 2, `list frames ${after - before}`, 'daemonControlRpc in src/daemon/control/controlSocket.ts must retry once in the protocol named by an EPROTO answer: one refused send, one send in dialect')
  check('A9 no crash: the process is here and the fixture still serves', (await hsMod.handshakeDaemon({ timeoutMs: 500 })).state === 'older', '', 'handshakeDaemon in src/daemon/control/handshake.ts must still answer older after the dialect retry, without throwing')
  const evidence = hsMod.daemonHandshakeEvidence(hsMod.lastDaemonHandshake())
  check('A10 the certificate grammar: version vs version, waiting on the live session', /daemon v1\.5\.6 · protocol 1 \(pre-handshake\)/.test(evidence) && /waiting on 1 live session — \/daemon restart when ready/.test(evidence), evidence, 'daemonHandshakeEvidence in src/daemon/control/handshake.ts must name the daemon version, its protocol and the live session it waits on')
  await old.close()
}

section('B · pre-handshake daemon, idle: no silent kill; /daemon restart stops it and starts a successor whose posture the receipt names')
{
  const dir = freshPlane()
  seedDaemonRecord(dir, { pid: process.pid, version: '1.5.6', origin: 'transient', startedAt: Date.now() - 60_000, dir: '/tmp/project-b', controlSock: controlSockPath() })
  const old = await startOldDaemon({ version: '1.5.6', jobs: [] })
  const v = await hsMod.handshakeDaemon({ timeoutMs: 500 })
  check('B1 idle detected (live 0), still never killed by the handshake alone', v.live === 0 && old.killed() === false, '', 'handshakeDaemon in src/daemon/control/handshake.ts must report live 0 for an idle old daemon and must not stop it')
  check(
    'B2 the idle honest line names the one door',
    v.line === 'daemon v1.5.6 running with nothing live — new features wait until it restarts · /daemon restart',
    String(v.line),
    'honestLine in src/daemon/control/handshake.ts builds this line; match its wording exactly',
  )
  const spawns: Array<{ dir: string; posture: string }> = []
  const receipt = await hsMod.restartDaemon({
    by: 'pin',
    posture: 'owned',
    pollMs: 25,
    tries: 80,
    spawn: async (spawnDir, posture) => {
      spawns.push({ dir: spawnDir, posture })
      await startVersionedDaemon({ proto: MERCURY_DAEMON_PROTO, version: '9.9.9', pid: 4242, live: 0, liveSessions: 0 })
      return 4242
    },
  })
  check('B3 the old daemon was stopped through its own shutdown verb', old.killed() === true, '', 'restartDaemon in src/daemon/control/handshake.ts must stop the old daemon through its shutdown verb')
  check('B4 the successor was spawned with the RECORD\'s scheduling dir', spawns.length === 1 && spawns[0]!.dir === '/tmp/project-b', JSON.stringify(spawns), 'restartDaemon in src/daemon/control/handshake.ts must pass the dir from the daemon.json record to spawn, exactly once')
  check('B5 the receipt is typed restarted and names the owned posture', receipt.state === 'restarted' && receipt.line.includes("this Mercury's own daemon"), `${receipt.state}: ${receipt.line}`, 'restartDaemon in src/daemon/control/handshake.ts must return a restarted receipt whose line names the owned posture')
  check('B6 the follow-up handshake is matched (the heal completed)', (await hsMod.handshakeDaemon({ timeoutMs: 500 })).state === 'matched', '', 'after restartDaemon (src/daemon/control/handshake.ts) the successor must answer hello with this build version, protocol and tree')
  const bye = old.shutdownFrame?.() ?? null
  check('B7 the heal\'s shutdown frame asks for the reap by name, as the stop verb does: the daemon\'s teardown ends every rostered worker whatever the flag says, so the wire never says keep', bye !== null && bye.reapWorkers === true, JSON.stringify(bye), 'restartDaemon in src/daemon/control/handshake.ts must send reapWorkers: true in its shutdown frame')
}

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
  check('C1 detected: older, NOT pre-handshake, no line owed while the heal can run', v.state === 'older' && v.daemon?.preHandshake === false && v.line === null, '', 'decideHandshake in src/daemon/control/handshake.ts must give state older with no line while the daemon can heal itself by restart-when-idle')
  const heal = await hsMod.healDaemonVersion(v, { by: 'pin' })
  check('C2 the heal answers restarting (idle)', heal.state === 'restarting', '', 'healDaemonVersion in src/daemon/control/handshake.ts must send restart-when-idle to an idle older daemon and return restarting')
  let matched: import('../../src/daemon/control/handshake.js').DaemonHandshakeVerdict | null = null
  for (let i = 0; i < 80; i++) {
    const probe = await hsMod.handshakeDaemon({ timeoutMs: 300, client })
    if (probe.state === 'matched' && probe.daemon?.pid === 222) {
      matched = probe
      break
    }
    await sleep(25)
  }
  check('C3 the successor answers MATCHED — healed with no operator hand', matched !== null, 'never matched', 'the successor never answered hello as matched within the polls: see healDaemonVersion and handshakeDaemon in src/daemon/control/handshake.ts')
  check('C4 transparent: no shutdown verb ever crossed the wire', !oldDaemon.received.includes('shutdown') && oldDaemon.killed() === false, '', 'healDaemonVersion in src/daemon/control/handshake.ts must heal an idle v2-family daemon with restart-when-idle only, never the shutdown verb')
  check('C5 the restart rode restart-when-idle', oldDaemon.received.includes('restart-when-idle'), '', 'healDaemonVersion in src/daemon/control/handshake.ts must send the restart-when-idle verb')
  if (successor !== null) await (successor as Fixture).close()
}

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
    'honestLine in src/daemon/control/handshake.ts builds this line; match its wording exactly',
  )
  const heal = await hsMod.healDaemonVersion(v, { by: 'pin' })
  check('D2 the heal ARMS instead of killing (live runners hold it)', heal.state === 'armed' && heal.live === 2, '', 'healDaemonVersion in src/daemon/control/handshake.ts must return armed with the live count when restart-when-idle answers armed')
  check('D3 nothing was killed and no shutdown crossed', busy.killed() === false && !busy.received.includes('shutdown'), '', 'healDaemonVersion and restartDaemon in src/daemon/control/handshake.ts must not send shutdown to a daemon that holds live sessions')
  const line = hsMod.lastDaemonHandshake()?.line
  check('D4 the line still stands after arming (the operator still owes the restart moment)', line === v.line, String(line), 'healDaemonVersion in src/daemon/control/handshake.ts must leave the verdict line in place after arming')
  const receipt = await hsMod.restartDaemon({ by: 'pin', posture: 'owned', pollMs: 25, tries: 4 })
  check('D5 /daemon restart answers the typed armed receipt', receipt.state === 'armed' && receipt.line.includes('restarts when its 2 live sessions finish'), `${receipt.state}: ${receipt.line}`, 'restartDaemon in src/daemon/control/handshake.ts must return an armed receipt whose line says the daemon restarts when its live sessions finish')
  await busy.close()
}

section('E · the real control server: hello answers while starting and needs no key; restart-when-idle is keyed and reaches the host')
{
  const dir = freshPlane()
  const { startControlServer } = await import('../../src/daemon/control/controlServer.js')
  const { mintControlKey } = socketMod
  const { DaemonBreaker } = await import('../../src/daemon/control/daemonBreaker.js')
  const key = await mintControlKey()
  let ready = false
  const restartAsks: string[] = []
  const fakeRoster = { list: () => [], has: () => ({ present: false }), liveCount: () => 0, totalCount: () => 0, getRespawnState: () => ({ degraded: false }) } as never
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
  check('E1 hello answers BEFORE readiness (ready:false ⇒ verdict starting, no spawn)', starting.state === 'starting' && starting.daemon?.ready === false, '', 'the hello handler in src/daemon/control/controlServer.ts (startControlServer) must answer before readiness with ready false, and decideHandshake in src/daemon/control/handshake.ts must map that to starting')
  ready = true
  const v = await hsMod.handshakeDaemon({ timeoutMs: 500 })
  check('E2 ready ⇒ matched against this build (same version, proto, tree)', v.state === 'matched', v.state, 'decideHandshake in src/daemon/control/handshake.ts must call a ready daemon with this build version, protocol and tree matched')
  const healed = await daemonControlRpc({ op: 'restart-when-idle', proto: MERCURY_DAEMON_PROTO, by: 'pin-e' } as never, { timeoutMs: 500 })
  check('E3 restart-when-idle reaches the host with its attribution', healed.ok === true && restartAsks.join(',') === 'pin-e', '', 'startControlServer in src/daemon/control/controlServer.ts must pass the by attribution of a keyed restart-when-idle request to the restartWhenIdle option')
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
  check('E4 restart-when-idle without the key is EAUTH', bare.code === 'EAUTH', '', 'startControlServer in src/daemon/control/controlServer.ts must refuse restart-when-idle without the control key with code EAUTH')
  await server.close()
}

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
  check('F1 a NEWER daemon of a newer version is the installed build: the reopen line, never a crash', newer.state === 'newer' && newer.heal === 'reopen' && newer.line === 'Mercury v1.7.0 is installed — close this window and open Mercury again', String(newer.line), 'decideHandshake and reopenLine in src/daemon/control/handshake.ts must give state newer, heal reopen and the installed-build line for a daemon of a newer version')
  const newerProto = hsMod.decideHandshake(
    {
      kind: 'hello',
      reply: { ok: true, op: 'hello', proto: 3, minProto: 1, ready: true, version: '1.6.0', buildTree: 'bbbb', pid: 9, startedAt: 1, ownerPid: null, foreground: false, live: 1, liveSessions: 1, warm: 0, restartArmed: false } as never,
    },
    client,
  )
  check('F1b a NEWER-protocol daemon of the same version restarts when idle, with the honest line', newerProto.state === 'newer' && newerProto.heal === 'restart-when-idle' && newerProto.line === "daemon v1.6.0 (protocol 3, newer than this Mercury's 2) running with 1 live session — this Mercury's features wait until it restarts · /daemon restart when ready", String(newerProto.line), 'decideHandshake and honestLine in src/daemon/control/handshake.ts must give state newer, heal restart-when-idle and the protocol wording for a newer-protocol daemon of the same version')
  const idleNewer = hsMod.applyHeal({ ...newerProto, live: 0, liveSessions: 0 }, { state: 'refused', live: 0, detail: 'runs on a terminal: stop it there (ctrl-c) and run `mercury daemon` again' })
  check('F2 a refused heal puts the reason ON the line', idleNewer.line !== null && idleNewer.line.includes('runs on a terminal'), String(idleNewer.line), 'applyHeal in src/daemon/control/handshake.ts must put the refusal detail on the line when a heal is refused')
  const rebuilt = hsMod.decideHandshake(
    {
      kind: 'hello',
      reply: { ok: true, op: 'hello', proto: 2, minProto: 1, ready: true, version: '1.6.0', buildTree: 'cccc', pid: 9, startedAt: 1, ownerPid: null, foreground: false, live: 3, liveSessions: 3, warm: 0, restartArmed: false } as never,
    },
    client,
  )
  check('F3 same version, other build stays visible and does not invent chronology', rebuilt.state === 'rebuilt' && rebuilt.heal === 'operator' && rebuilt.line?.includes('build order unknown') === true, '', 'decideHandshake in src/daemon/control/handshake.ts must give state rebuilt, heal operator and a line saying the build order is unknown for the same version on another tree')
  check('F4 rebuilt evidence names both trees', hsMod.daemonHandshakeEvidence(rebuilt).includes('tree cccc vs aaaa'), hsMod.daemonHandshakeEvidence(rebuilt), 'daemonHandshakeEvidence in src/daemon/control/handshake.ts must name the daemon tree and this Mercury tree for a rebuilt verdict')
  const installedOlderProto = hsMod.decideHandshake(
    {
      kind: 'hello',
      reply: { ok: true, op: 'hello', proto: 1, minProto: 1, ready: true, version: '1.6.0', buildTree: 'dddd', pid: 9, startedAt: 1, ownerPid: null, foreground: false, live: 1, liveSessions: 1, warm: 0, restartArmed: false } as never,
    },
    client,
    Date.now(),
    { buildTree: 'dddd', version: '1.6.0', buildTime: null },
  )
  check(
    'F6 a daemon of an older protocol that IS the installed build, talking to a screen that is not: the line says the chat\'s engine is the installed build and where the way out is — never "/daemon restart when ready" (the Air\'s 7R-04 words)',
    installedOlderProto.state === 'older' && installedOlderProto.heal === 'reopen' && installedOlderProto.line === "chat engine: the installed build dddd, not this Mercury's · /daemon" && !installedOlderProto.line.includes('/daemon restart'),
    String(installedOlderProto.line),
    'decideHandshake, screenIsOlder and reopenLine in src/daemon/control/handshake.ts must give state older, heal reopen and the chat engine line when the daemon is the installed build',
  )
  check(
    'F6b the one line fits the notice row at 80 columns (its budget is the width less two) with a real 12-hex tree, in both reopen shapes; the full way out rides /health and the /daemon restart refusal',
    hsMod.REOPEN_LINE_MAX_COLUMNS === 78 &&
      hsMod.reopenLine({ ...installedOlderProto, daemon: { ...installedOlderProto.daemon!, buildTree: '548142321ff7' } }).length <= hsMod.REOPEN_LINE_MAX_COLUMNS &&
      hsMod.reopenLine({ ...installedOlderProto, daemon: { ...installedOlderProto.daemon!, version: '1.0.0-beta.40', buildTree: '548142321ff7' } }).length <= hsMod.REOPEN_LINE_MAX_COLUMNS &&
      hsMod.reopenWayOut(installedOlderProto).includes("this chat's engine is the installed build (tree dddd), not this Mercury's (tree aaaa) — to run on the installed build, close this window and open Mercury again; to run this build, `mercury daemon stop`") &&
      hsMod.daemonBuildStatusWords(installedOlderProto) === 'engine: installed build dddd',
    JSON.stringify({ line: hsMod.reopenLine({ ...installedOlderProto, daemon: { ...installedOlderProto.daemon!, buildTree: '548142321ff7' } }), wayOut: hsMod.reopenWayOut(installedOlderProto), chip: hsMod.daemonBuildStatusWords(installedOlderProto) }),
    'reopenLine, reopenWayOut, daemonBuildStatusWords and REOPEN_LINE_MAX_COLUMNS in src/daemon/control/handshake.ts must keep the reopen line within 78 columns and carry the full way out',
  )
  const sameVersionNewer = hsMod.decideHandshake(
    {
      kind: 'hello',
      reply: { ok: true, op: 'hello', proto: 3, minProto: 1, ready: true, version: '1.6.0', buildTree: 'eeee', pid: 9, startedAt: 1, ownerPid: null, foreground: false, live: 1, liveSessions: 1, warm: 0, restartArmed: false } as never,
    },
    client,
  )
  check('F7 a newer-protocol daemon of the same version string names the protocols, never "v1.6.0 newer than v1.6.0"', sameVersionNewer.state === 'newer' && sameVersionNewer.line !== null && sameVersionNewer.line.includes("daemon v1.6.0 (protocol 3, newer than this Mercury's 2)") && !sameVersionNewer.line.includes('newer than this Mercury v1.6.0'), String(sameVersionNewer.line), 'honestLine in src/daemon/control/handshake.ts must name the protocols, not the version twice, when a newer-protocol daemon has the same version string')
  const restarting = hsMod.applyHeal({ ...rebuilt, heal: 'restart-when-idle' }, { state: 'restarting', live: 0 })
  check('F5 the heal status words: idle-restarted', hsMod.daemonHandshakeEvidence(restarting).includes('idle-restarted'), '', 'daemonHandshakeEvidence in src/daemon/control/handshake.ts must use the word idle-restarted for a restarting heal')
}

section('G · wiring: ensureDaemon rides the handshake; main wires hello/restart + the successor; the record carries the fact; the Chat paints')
{
  {
    const dir = freshPlane()
    seedRecords(dir, { 'concourse-w1': { workerId: 'concourse-w1', sessionId: 's1', pid: process.pid } })
    seedDaemonRecord(dir, { pid: process.pid, version: '1.5.6', origin: 'transient', startedAt: Date.now() - 60_000, dir: '/tmp/p', controlSock: controlSockPath() })
    const old = await startOldDaemon({ version: '1.5.6', jobs: [{ short: 'concourse-w1', sessionId: 's1', prompt: '', source: 'user', state: 'ready', startedAt: 1, cliVersion: '1.5.6' }] })
    const { crewChecks } = await import('../../src/platform/health/sections/crew.ts')
    const daemonRow = await crewChecks().find(row => row.id === 'daemon')?.run()
    const seen = await hsMod.handshakeDaemon({ timeoutMs: 500 })
    await old.close()
    check('G9 the certificate daemon row runs the handshake and the line IS the fix (the reopen case, which carries the full way out, is driven over a real daemon by E1b of prove-field-e004-daemon-skew.ts)', seen.line === 'daemon v1.5.6 running with 1 live session — new features wait until it restarts · /daemon restart when ready' && daemonRow?.status === 'warn' && daemonRow.fix === seen.line && daemonRow.evidence.startsWith('daemon.json: ') && daemonRow.evidence.endsWith(` · ${hsMod.daemonHandshakeEvidence(seen)}`) && daemonRow.link === '/daemon', JSON.stringify(daemonRow), 'the daemon row of crewChecks in src/platform/health/sections/crew.ts must run the handshake, use its line as the fix and end its evidence with daemonHandshakeEvidence')
  }
}

rmSync(home, { recursive: true, force: true })

console.log('\n' + '═'.repeat(76))
if (failures === 0) console.log('✅ ALL DAEMON-HANDSHAKE PROOFS PASS')
else console.log(`❌ ${failures} DAEMON-HANDSHAKE PROOF(S) FAILED`)
console.log('═'.repeat(76))
process.exit(failures === 0 ? 0 : 1)
