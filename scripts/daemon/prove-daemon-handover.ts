#!/usr/bin/env bun
import { spawnSync } from 'node:child_process'
import net from 'node:net'
import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'

const ROOT = join(import.meta.dir, '..', '..')
const DIST = join(ROOT, 'dist', 'mercury.mjs')
if (!existsSync(DIST)) {
  console.error('✗ dist/mercury.mjs missing — run `bun run build.ts` first')
  process.exit(1)
}

let failures = 0
const check = (label: string, ok: boolean, detail = ''): void => {
  if (!ok) failures++
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${!ok && detail ? ` — ${detail}` : ''}`)
}
const section = (t: string): void => {
  console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
}
const text = (v: unknown): string => JSON.stringify(v) ?? ''
const sleep = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms))
const until = async (pred: () => boolean | Promise<boolean>, ms: number, step = 100): Promise<boolean> => {
  const t0 = Date.now()
  while (Date.now() - t0 < ms) {
    if (await pred()) return true
    await sleep(step)
  }
  return pred()
}

const scratch = mkdtempSync(join(tmpdir(), 'daemon-handover-'))
const home = join(scratch, 'home')
const work = join(scratch, 'work')
mkdirSync(home, { recursive: true })
mkdirSync(work, { recursive: true })
process.env.MERCURY_CONFIG_DIR = home
delete process.env.MERCURY_HOME
delete process.env.MERCURY_DAEMON_DIR
delete process.env.MERCURY_MODEL
process.env.NODE_ENV = 'test'
process.env.MERCURY_CREDENTIAL_STORE = 'file'
process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'
process.env.ANTHROPIC_BASE_URL = 'http://127.0.0.1:1'
process.env.ANTHROPIC_API_KEY = 'proof-key-ci-gate-not-a-real-key'
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

const OLD_TREE = 'old0000000000'
const UNKNOWN_CLAUDE_ID = 'claude-zephyr-9-1'
const OWNER_WORDS = `model refused (unknown-model) · pick one of: claude-opus-5-5 — '${UNKNOWN_CLAUDE_ID}' is not an exact model id (got "${UNKNOWN_CLAUDE_ID}")`

const sock = await import('../../src/daemon/control/controlSocket.ts')
const protocol = await import('../../src/daemon/control/protocol.ts')
const workers = await import('../../src/daemon/concourse-workers/concourseWorkers.ts')
const { isProcessAlive, getProcessStartTokenAsync } = await import('../../src/daemon/control/ownerWatch.ts')
const { daemonRecordIdentity: daemonRecordIdentity } = await import('../../src/daemon/control/verbs.ts')
const handoverModule = await import('../../src/daemon/control/handover.ts').catch(() => null)
const rawFrame = (sockPath: string, payload: unknown, timeoutMs: number): Promise<{ ok: boolean }> =>
  new Promise(resolve => {
    const conn = net.connect(sockPath)
    const timer = setTimeout(() => {
      conn.destroy()
      resolve({ ok: false })
    }, timeoutMs)
    conn.on('error', () => {
      clearTimeout(timer)
      resolve({ ok: false })
    })
    conn.on('connect', () => {
      protocol.readControlFrame(
        conn,
        line => {
          clearTimeout(timer)
          conn.destroy()
          resolve(JSON.parse(line) as { ok: boolean })
        },
        () => {
          clearTimeout(timer)
          conn.destroy()
          resolve({ ok: false })
        },
      )
      conn.write(protocol.encodeFrame(payload))
    })
  })
const predecessorSockPathOf = (pid: number): string => `${sock.controlSockPath()}.${pid}`

section('§1 the pure decision and the road of a verb')
check('the handover module exists', handoverModule !== null, 'src/daemon/control/handover.ts failed to import: restore it or fix the import error it throws')
if (handoverModule !== null) {
  const handover = handoverModule
  const base = { daemonBuildTree: OLD_TREE, deployedBuildTree: 'new0000000000', live: 3 }
  check('an older daemon whose restart is armed behind live workers hands over', handover.decideHandover({ ...base, healState: 'armed' }).handover, 'decideHandover in src/daemon/control/handover.ts must hand over for an older tree with live workers and an armed restart')
  check('…and one whose restart was refused', handover.decideHandover({ ...base, healState: 'refused' }).handover, 'decideHandover in src/daemon/control/handover.ts must also hand over when healState is refused')
  check('a daemon restarting itself hands nothing over', !handover.decideHandover({ ...base, healState: 'restarting' }).handover, 'decideHandover in src/daemon/control/handover.ts must not hand over when healState is restarting')
  check('the deployed build itself hands nothing over', !handover.decideHandover({ ...base, daemonBuildTree: 'new0000000000', healState: 'armed' }).handover, 'decideHandover in src/daemon/control/handover.ts must not hand over when the daemon tree equals the deployed tree')
  check('no deployed runtime, no handover', !handover.decideHandover({ ...base, deployedBuildTree: null, healState: 'armed' }).handover, 'decideHandover in src/daemon/control/handover.ts must not hand over when deployedBuildTree is null')
  check('a source-run daemon (no tree) is never called older', !handover.decideHandover({ ...base, daemonBuildTree: null, healState: 'armed' }).handover, 'decideHandover in src/daemon/control/handover.ts must not hand over when daemonBuildTree is null')
  check('the predecessor pid parses, junk does not', handover.parseHandoverFrom(' 4242 ') === 4242 && handover.parseHandoverFrom('x') === null && handover.parseHandoverFrom(undefined) === null, 'parseHandoverFrom in src/daemon/control/handover.ts must return the trimmed pid for digits and null for junk or undefined')
  const state = handover.handoverState(process.pid, short => short === 'concourse-w9', () => [
    { runnerId: 'concourse-w1', sessionId: 'sess-1', pid: process.pid },
    { runnerId: 'concourse-w2', sessionId: 'sess-2', pid: process.pid, endedAt: 1 },
    { runnerId: 'concourse-w9', sessionId: 'sess-9', pid: process.pid },
  ])
  check('a live record outside the roster is held by the predecessor; an ended one and a rostered one are not', state.holds('concourse-w1') && !state.holds('concourse-w2') && !state.holds('concourse-w9'), 'handoverState in src/daemon/control/handover.ts: holds() must be true only for a live, un-ended record that is not on the roster')
  check('a verb naming the held session goes to the predecessor', handover.handoverRoadOf('sessionControl', { sessionId: 'sess-1' }, state) === 'predecessor' && handover.handoverRoadOf('sessionDispatch', { targetSessionId: 'sess-1' }, state) === 'predecessor' && handover.handoverRoadOf('kill', { short: 'concourse-w1' }, state) === 'predecessor', 'handoverRoadOf in src/daemon/control/handover.ts must route sessionControl, sessionDispatch and kill naming a held session to the predecessor')
  check('a resume that names the held session goes to the predecessor too', handover.handoverRoadOf('sessionAdmit', { workspaceDir: work, resumeSessionId: 'sess-1' }, state) === 'predecessor', 'handoverRoadOf in src/daemon/control/handover.ts must route a sessionAdmit whose resumeSessionId names a held session to the predecessor: served here it would start a second runner on that session')
  check('a verb naming a session of ours, or none, stays here', handover.handoverRoadOf('sessionControl', { sessionId: 'sess-9' }, state) === 'here' && handover.handoverRoadOf('sessionAdmit', { workspaceDir: work }, state) === 'here', 'handoverRoadOf in src/daemon/control/handover.ts must keep a verb naming a rostered session, or none, on the road here')
  check("the predecessor's socket path is its own, under its pid", handover.predecessorSockPath(4242) === `${sock.controlSockPath()}.4242`, 'predecessorSockPath in src/daemon/control/handover.ts must be controlSockPath() plus a dot and the pid')
}

section("§1b the screen's heal hands over when the restart is armed and the deployed runtime is newer")
{
  const hs = await import('../../src/daemon/control/handshake.ts')
  const trigger = (hs as { handoverDaemonVersion?: unknown }).handoverDaemonVersion
  check('the handshake owns a handover trigger', typeof trigger === 'function', 'src/daemon/control/handshake.ts must export handoverDaemonVersion')
  if (typeof trigger === 'function') {
    const spawned: Array<{ script: string; dir: string; env: Record<string, string | undefined>; ownerPipe: boolean; persist: boolean }> = []
    const verdict = {
      state: 'rebuilt' as const,
      daemon: { proto: protocol.MERCURY_DAEMON_PROTO, version: '1.0.0-beta.23', buildTree: OLD_TREE, pid: 424242, startedAt: 1, ownerPid: null, foreground: false, ready: true, restartArmed: true, preHandshake: false },
      client: { proto: protocol.MERCURY_DAEMON_PROTO, version: '1.0.0', buildTree: 'new0000000000' },
      live: 2,
      liveSessions: 2,
      heal: 'restart-when-idle' as const,
      healState: 'none' as const,
      line: null,
      at: 1,
    }
    const opts = {
      runtime: () => ({ script: '/deployed/runtime/dist/mercury.mjs', buildTree: 'new0000000000' }),
      spawn: (script: string, dir: string, env: Record<string, string | undefined>, ownerPipe: boolean, persist: boolean) => {
        spawned.push({ script, dir, env, ownerPipe, persist })
        return process.pid
      },
    }
    hs.resetHandoverAsksForTesting()
    check('nothing is in flight before a handover', !hs.handoverInFlightFor(424242))
    const receipt = await hs.handoverDaemonVersion(verdict, { state: 'armed', live: 2 }, opts)
    check('an armed restart on an older daemon spawns the successor from the DEPLOYED runtime, never the screen\'s own bundle', typeof receipt === 'string' && spawned.length === 1 && spawned[0]?.script === '/deployed/runtime/dist/mercury.mjs', `handoverDaemonVersion in src/daemon/control/handshake.ts must spawn once from the deployedRuntime script and return a string receipt — ${text({ receipt, spawned })}`)
    check('while the successor comes up the predecessor is marked in flight (no new work goes to it), and only it', hs.handoverInFlightFor(424242) && !hs.handoverInFlightFor(1), 'handoverDaemonVersion in src/daemon/control/handshake.ts must mark the predecessor pid in flight, so handoverInFlightFor is true for it and false for any other pid')
    check("the successor keeps the predecessor's posture (persistent here): the handover stamp, no owner pid, no restart stamp, no owner pipe", spawned[0]?.env.MERCURY_DAEMON_HANDOVER_FROM === '424242' && spawned[0]?.env.MERCURY_DAEMON_PERSIST === '1' && spawned[0]?.env.MERCURY_DAEMON_OWNER_PID === undefined && spawned[0]?.env.MERCURY_DAEMON_SUCCESSOR_OF === undefined && spawned[0]?.ownerPipe === false && spawned[0]?.persist === true, `the env built in handoverDaemonVersion (src/daemon/control/handshake.ts) must set the handover and persist stamps and drop the owner pid and restart stamp — ${text(spawned[0]?.env)}`)
    check('the receipt names the deployed tree and what the old daemon keeps', typeof receipt === 'string' && receipt.includes('new0000000000') && receipt.includes('2 live sessions'), `the receipt text of handoverDaemonVersion in src/daemon/control/handshake.ts must name the deployed tree and the live session count — ${String(receipt)}`)
    const again = await hs.handoverDaemonVersion(verdict, { state: 'armed', live: 2 }, opts)
    check('one handover per predecessor per screen', again === null && spawned.length === 1, 'handoverDaemonVersion in src/daemon/control/handshake.ts must remember a predecessor it already asked about and return null on the second ask')
    const matched = await hs.handoverDaemonVersion({ ...verdict, daemon: { ...verdict.daemon, buildTree: 'new0000000000' } }, { state: 'armed', live: 2 }, opts)
    check('a daemon already on the deployed build is left alone', matched === null && spawned.length === 1, 'handoverDaemonVersion in src/daemon/control/handshake.ts must return null when the daemon buildTree equals the deployed tree')
    const restarting = await hs.handoverDaemonVersion(verdict, { state: 'restarting', live: 0 }, opts)
    check('a daemon restarting itself is left alone', restarting === null && spawned.length === 1, 'handoverDaemonVersion in src/daemon/control/handshake.ts must return null when the restart state is restarting')
    hs.resetHandoverAsksForTesting()
    const gone = spawnSync('true').pid ?? 1
    const spawnedDead: number[] = []
    const deadOpts = { ...opts, spawn: () => { spawnedDead.push(gone); return gone } }
    await hs.handoverDaemonVersion(verdict, { state: 'armed', live: 2 }, deadOpts)
    const afterDead = await hs.handoverDaemonVersion(verdict, { state: 'armed', live: 2 }, deadOpts)
    check('a successor that died is not remembered: the next ask spawns again (a screen is never stuck behind one failed successor)', typeof afterDead === 'string' && spawnedDead.length === 2, 'handoverDaemonVersion in src/daemon/control/handshake.ts must forget a spawned successor whose pid is no longer alive and spawn again on the next ask')
    hs.resetHandoverAsksForTesting()
    await sock.writeDaemonState({ pid: process.pid, version: '1.0.0', origin: 'transient', startedAt: Date.now(), dir: work, controlSock: sock.controlSockPath() })
    const already = await hs.handoverDaemonVersion(verdict, { state: 'armed', live: 2 }, opts)
    check('a screen finding a live successor already on the record spawns nothing, marks the predecessor in flight and waits for the successor', typeof already === 'string' && already.includes(`pid ${process.pid}`) && spawned.length === 1 && hs.handoverInFlightFor(424242), `handoverDaemonVersion in src/daemon/control/handshake.ts must, with a live daemon record already written, spawn nothing, mark the predecessor in flight and return a receipt naming that pid — ${String(already)}`)
    await sock.clearDeadDaemonRecords()
    hs.resetHandoverAsksForTesting()
    const owned = await hs.handoverDaemonVersion({ ...verdict, daemon: { ...verdict.daemon, ownerPid: 9191 } }, { state: 'refused', live: 1 }, opts)
    check("an owned predecessor's successor carries the same owner pid and no persistence", typeof owned === 'string' && spawned[1]?.env.MERCURY_DAEMON_OWNER_PID === '9191' && spawned[1]?.env.MERCURY_DAEMON_PERSIST === undefined, `handoverDaemonVersion in src/daemon/control/handshake.ts must pass an owned predecessor owner pid on and leave persist unset — ${text(spawned[1]?.env)}`)
    hs.resetHandoverAsksForTesting()
  }
}

section('§2 a daemon of an old bundle holds a live session; the deployed build takes new births without touching it')
const received: Array<Record<string, unknown>> = []
const lock = await sock.acquireDaemonLock()
check('the fixture predecessor holds the daemon lock (as the real one does)', lock !== null, 'acquireDaemonLock in src/daemon/control/controlSocket.ts returned null: a daemon lock is already held in the scratch config home')
const oldKey = await sock.mintControlKey()
const startedAt = Date.now()
await sock.writeDaemonState({ pid: process.pid, version: '1.0.0-beta.23', origin: 'transient', startedAt, dir: work, controlSock: sock.controlSockPath(), proto: protocol.MERCURY_DAEMON_PROTO, buildTree: OLD_TREE, ownerPid: null, foreground: false, persist: true })
const child: ChildProcess = spawn('sleep', ['600'], { stdio: 'ignore' })
const heldSession = randomUUID()
workers.updateConcourseWorkers(workers => {
  workers['concourse-w1'] = {
    schema: 1,
    runnerId: 'concourse-w1',
    sessionId: heldSession,
    workspaceId: work,
    isolation: 'exclusive',
    modelKey: 'claude-opus-5-5',
    effort: 'high',
    spawnedAt: startedAt,
    lastLiveAt: startedAt,
    lastDeliveryAt: startedAt,
    pid: child.pid,
    title: 'a long session',
  } as never
})
const helloReply = (): Record<string, unknown> => ({ ok: true, op: 'hello', proto: protocol.MERCURY_DAEMON_PROTO, minProto: 1, ready: true, version: '1.0.0-beta.23', buildTree: OLD_TREE, pid: process.pid, startedAt, ownerPid: null, foreground: false, live: 1, liveSessions: 1, warm: 0, restartArmed: true })
const fixture = net.createServer(conn => {
  protocol.readControlFrame(
    conn,
    line => {
      const req = JSON.parse(line) as Record<string, unknown>
      received.push(req)
      const op = String(req.op)
      const answer = (payload: unknown): void => void conn.end(protocol.encodeFrame(payload))
      if (op === 'ping') return answer({ ok: true, op: 'ping', version: '1.0.0-beta.23', proto: protocol.MERCURY_DAEMON_PROTO })
      if (op === 'hello') return answer(helloReply())
      if (op === 'list') return answer({ ok: true, op: 'list', jobs: [{ short: 'concourse-w1', sessionId: heldSession, pid: child.pid }] })
      if (op === 'restart-when-idle') return answer({ ok: true, op: 'restart-when-idle', state: 'armed', live: 1 })
      if (op === 'sessionAdmit' || op === 'concourseAdmit' || op === 'sessionDispatch' || op === 'concourseDispatch') {
        return answer({ ok: false, code: 'EUNKNOWN', error: OWNER_WORDS })
      }
      if (op === 'sessionControl' || op === 'concourseControl') return answer({ ok: true, op: 'sessionControl', outcome: 'applied', detail: `answered by the predecessor for ${String(req.sessionId)}` })
      if (op === 'shutdown') return answer({ ok: true, op: 'shutdown', reaped: 0, workers: [] })
      return answer({ ok: false, code: 'EUNKNOWN', error: `unknown op: ${op}` })
    },
    () => conn.destroy(),
  )
})
await new Promise<void>(resolve => fixture.listen(sock.controlSockPath(), () => resolve()))
const oldSockPath = sock.controlSockPath()
check('the predecessor serves the plane (hello answers its old tree)', await (async () => {
  const r = await sock.daemonControlRpc({ op: 'hello', proto: protocol.MERCURY_DAEMON_PROTO, clientVersion: '1.0.0', clientBuildTree: null }, { timeoutMs: 1500, protoRetry: false })
  return r.ok && r.op === 'hello' && r.pid === process.pid && r.buildTree === OLD_TREE
})(), 'the fixture server in this file did not answer hello on controlSockPath() in src/daemon/control/controlSocket.ts; check that the socket path is free')
const refusedBefore = await sock.daemonControlRpc({ op: 'sessionAdmit', workspaceDir: work, birthKey: randomUUID(), isolation: 'shared', model: UNKNOWN_CLAUDE_ID, bornBlank: true } as never, { timeoutMs: 5000 })
check("before the move, a birth on the old daemon is refused with the owner's words", !refusedBefore.ok && (refusedBefore as { error?: string }).error === OWNER_WORDS, `the sessionAdmit sent through daemonControlRpc in src/daemon/control/controlSocket.ts must reach the fixture and return its error text unchanged — ${text(refusedBefore)}`)

const successorEnv: NodeJS.ProcessEnv = {
  ...process.env,
  MERCURY_DAEMON_HANDOVER_FROM: String(process.pid),
  MERCURY_DAEMON_PERSIST: '1',
  MERCURY_DAEMON_NO_SELF_WARM: '1',
  MERCURY_EVOLUTION_LEDGER: '0',
}
delete successorEnv.MERCURY_DAEMON_SUCCESSOR_OF
delete successorEnv.MERCURY_DAEMON_OWNER_PID
const successorLog: string[] = []
const successor = spawn('node', [DIST, 'daemon', 'run', work], { cwd: work, env: successorEnv, stdio: ['ignore', 'pipe', 'pipe'] })
successor.stdout?.on('data', d => successorLog.push(String(d)))
successor.stderr?.on('data', d => successorLog.push(String(d)))
const successorPid = successor.pid ?? -1
const successorExited = new Promise<number | null>(resolve => successor.once('exit', code => resolve(code)))

const helloFrom = async (): Promise<Record<string, unknown> | null> => {
  const r = await sock.daemonControlRpc({ op: 'hello', proto: protocol.MERCURY_DAEMON_PROTO, clientVersion: '1.0.0', clientBuildTree: null }, { timeoutMs: 1500, protoRetry: false })
  return r.ok && r.op === 'hello' ? (r as unknown as Record<string, unknown>) : null
}
const moved = await until(async () => {
  const h = await helloFrom()
  return h !== null && h.pid === successorPid && h.ready === true
}, 30_000, 250)
const afterHello = await helloFrom()
check('the successor answers on the plane path, ready, on its own (new) tree', moved && afterHello !== null && afterHello.buildTree !== OLD_TREE, `the daemon run started with MERCURY_DAEMON_HANDOVER_FROM (src/daemon/control/main.ts) must take the plane within 30s and answer hello ready with a new buildTree; the successor log tail follows — ${text(afterHello)}\n${successorLog.join('').slice(-1500)}`)
check("the successor names its predecessor without counting that helper's chat as its own", afterHello !== null && afterHello.predecessorPid === process.pid && Number(afterHello.live) === 0 && Number(afterHello.liveSessions) === 0, `the successor hello reply (src/daemon/control/controlServer.ts) must carry predecessorPid and count none of the predecessor workers as its own — ${text(afterHello)}`)
const record = await sock.readDaemonState()
check('the daemon record names the successor', record !== null && record.pid === successorPid, `the successor in src/daemon/control/main.ts must rewrite the daemon record with its own pid — ${text(record)}`)
const successorToken = await getProcessStartTokenAsync(successorPid)
check("the successor's record-first write stamps its own identity baseline, and the one identity owner reads the record as the successor's, never a stranger's", record !== null && typeof record.startToken === 'string' && record.startToken !== '' && daemonRecordIdentity(record, successorToken) === 'same-process', `the successor must write a startToken into the daemon record (src/daemon/control/main.ts) that daemonRecordIdentity in src/daemon/control/verbs.ts reads as same-process — ${text({ startToken: record?.startToken, successorToken })}`)
check('the control key is the one the screens already hold (the predecessor accepts the same stamp)', readFileSync(sock.controlKeyPath(), 'utf8').trim() === oldKey, 'the successor must keep the existing control key file (controlKeyPath in src/daemon/control/controlSocket.ts) and not mint a new one')
check("the predecessor's socket serves on under its own pid", existsSync(predecessorSockPathOf(process.pid)) && predecessorSockPathOf(process.pid) !== oldSockPath && (await rawFrame(predecessorSockPathOf(process.pid), { op: 'ping' }, 2000)).ok)
check('nothing live was signalled: the held runner and the predecessor are alive after the move', child.pid !== undefined && isProcessAlive(child.pid) && child.exitCode === null)
check('the predecessor was never asked to stop or restart by the move', !received.some(r => r.op === 'shutdown' || r.op === 'restart-when-idle'))

const born = await sock.daemonControlRpc({ op: 'sessionAdmit', workspaceDir: work, birthKey: randomUUID(), isolation: 'shared', model: UNKNOWN_CLAUDE_ID, bornBlank: true } as never, { timeoutMs: 60_000 })
check(`a new session on '${UNKNOWN_CLAUDE_ID}' (no catalogue of the old bundle knows it) is born on the new build`, born.ok === true && typeof (born as { sessionId?: unknown }).sessionId === 'string', `a sessionAdmit sent after the move must be answered by the successor, not forwarded to the old daemon (handoverRoadOf in src/daemon/control/handover.ts) — ${text(born)}`)
check('…and the birth never reached the old daemon (its one admit is the pre-move refusal)', received.filter(r => r.op === 'sessionAdmit').length === 1, `handoverRoadOf in src/daemon/control/handover.ts must keep sessionAdmit on the road here; ${received.filter(r => r.op === 'sessionAdmit').length} admit(s) at the predecessor`)
const bornRecord = Object.values(workers.readSessionWorkers()).find(r => r.sessionId === (born as { sessionId?: string }).sessionId)
check("the newborn's record carries the id verbatim (the wire decides)", bornRecord?.modelKey === UNKNOWN_CLAUDE_ID, `the successor must store the requested model id verbatim in the new session worker record — ${text(bornRecord?.modelKey)}`)

const forwarded = await sock.daemonControlRpc({ op: 'sessionControl', action: 'session-facts', sessionId: heldSession, by: 'operator' } as never, { timeoutMs: 5000 })
check("a verb for the session the old daemon holds is answered by the old daemon (forwarded, the screens' key accepted)", forwarded.ok === true && String((forwarded as { detail?: string }).detail ?? '').includes(`answered by the predecessor for ${heldSession}`), `handoverRoadOf in src/daemon/control/handover.ts must route a verb naming the held session to the predecessor socket — ${text(forwarded)}`)
check('…and it reached the predecessor with the session id and the auth stamp', received.some(r => r.op === 'sessionControl' && r.sessionId === heldSession && typeof r.auth === 'string'), 'the frame forwarded to the predecessor must keep the sessionId and carry the auth stamp; see the predecessor road in src/daemon/control/handover.ts')
const resumed = await sock.daemonControlRpc({ op: 'sessionAdmit', workspaceDir: work, resumeSessionId: heldSession, isolation: 'shared', by: 'operator' } as never, { timeoutMs: 10_000 })
const heldRecords = Object.values(workers.readSessionWorkers()).filter(r => r.sessionId === heldSession && r.endedAt === undefined)
check('a resume of the session the old daemon holds is answered by the old daemon: the new one starts no second runner on it', !resumed.ok && (resumed as { error?: string }).error === OWNER_WORDS && received.filter(r => r.op === 'sessionAdmit' && r.resumeSessionId === heldSession).length === 1 && heldRecords.length === 1 && heldRecords[0]?.runnerId === 'concourse-w1' && heldRecords[0]?.pid === child.pid, `handoverRoadOf in src/daemon/control/handover.ts must route a sessionAdmit that resumes a held session to the predecessor socket, and the successor must leave that session's record as it stands — ${text(resumed)} · ${text(heldRecords.map(r => [r.runnerId, r.pid]))}`)
const ownVerb = await sock.daemonControlRpc({ op: 'sessionControl', action: 'session-facts', sessionId: String((born as { sessionId?: string }).sessionId), by: 'operator' } as never, { timeoutMs: 10_000 })
check("a verb for the newborn is the successor's own", ownVerb.ok === true && !String((ownVerb as { detail?: string }).detail ?? '').includes('answered by the predecessor'), `handoverRoadOf in src/daemon/control/handover.ts must keep a verb for a session of the successor on the road here — ${text(ownVerb)}`)
const list = await sock.daemonControlRpc({ op: 'sessionList' } as never, { timeoutMs: 5000 })
const listed = list.ok && list.op === 'sessionList' ? list.workers.map(w => String(w.runnerId)) : []
check("the session list carries the predecessor's live session beside the newborn", listed.includes('concourse-w1') && listed.length >= 2, `the sessionList answer (src/daemon/control/controlServer.ts) must list the predecessor live session beside the newborn — ${text(listed)}`)

section('§3 the predecessor leaves: the successor takes the lock; a restart successor finding the plane served stands down')
await lock?.release()
const lockTaken = await until(async () => (await sock.acquireDaemonLock()) === null, 12_000, 500)
check('once the predecessor releases the daemon lock the successor holds it (a fresh acquire is refused)', lockTaken, `the successor (src/daemon/control/main.ts) must take the daemon lock (acquireDaemonLock in src/daemon/control/controlSocket.ts) after the predecessor releases it; successor log tail — ${successorLog.join('').slice(-800)}`)
const standDown = spawn('node', [DIST, 'daemon', 'run', work], { cwd: work, env: { ...successorEnv, MERCURY_DAEMON_HANDOVER_FROM: undefined, MERCURY_DAEMON_SUCCESSOR_OF: String(process.pid) } as NodeJS.ProcessEnv, stdio: ['ignore', 'pipe', 'pipe'] })
const standDownLog: string[] = []
standDown.stderr?.on('data', d => standDownLog.push(String(d)))
const standDownCode = await new Promise<number | null>(resolve => {
  const t = setTimeout(() => {
    standDown.kill('SIGTERM')
    resolve(null)
  }, 20_000)
  standDown.once('exit', code => {
    clearTimeout(t)
    resolve(code)
  })
})
check("a restart's successor that finds the plane served by a daemon of its own build stands down without touching it", standDownCode === 0 && standDownLog.join('').includes('standing down') && (await helloFrom())?.pid === successorPid, `a restart successor (src/daemon/control/main.ts) must exit 0 logging standing down when the plane is already served by its own build; stand-down log tail — ${standDownLog.join('').slice(-600)}`)

section('§4 the way down')
const bye = await sock.daemonControlRpc({ op: 'shutdown', reapWorkers: true }, { timeoutMs: 5000 })
check('the successor stops on request', bye.ok === true, 'the shutdown op sent through daemonControlRpc (src/daemon/control/controlSocket.ts) was not accepted by the successor; see the shutdown case in src/daemon/control/controlServer.ts')
const exitCode = await Promise.race([successorExited, sleep(20_000).then(() => 'late' as const)])
check('…and leaves', exitCode !== 'late', `the successor process must exit within 20s of the shutdown op; exit code ${String(exitCode)}`)
check('the stop word reached the predecessor too (a stop is a stop for both)', received.some(r => r.op === 'shutdown'), 'the shutdown op must also reach the predecessor socket, not only the successor')
child.kill('SIGTERM')
fixture.close()
rmSync(scratch, { recursive: true, force: true })
console.log(failures === 0 ? '\n✅ prove-daemon-handover — all checks pass' : `\n❌ prove-daemon-handover — ${failures} check(s) failed`)
process.exit(failures === 0 ? 0 : 1)
