// The daemon-version handshake — the client half.
//
// THE LAW: a client never speaks to a daemon that does not understand it.
// The daemon outlives the screen, so a redeploy leaves the OLD daemon
// serving the NEW client: every verb the old build lacks answers "unknown
// op", and the operator sees New Session silently dead until a lucky
// restart. This module is the one door — `hello` first (protocol.ts), then
//   · matched  → proceed;
//   · a gap    → THE HEAL: the daemon re-executes itself as the deployed
//                build when no live worker would die (restart-when-idle);
//                otherwise it arms the restart and the screen paints ONE
//                honest line while the old daemon keeps serving the verbs
//                it knows (controlSocket.ts stamps its dialect);
//   · absent   → the caller's spawn path.
// A PRE-HANDSHAKE daemon (the v1 wire, no `hello`) is detected by its own
// answer: EPROTO naming its proto, or "unknown op" in its dialect. Nothing
// on disk says whether such a daemon is owned by another live screen or is
// an operator's persistent `mercury daemon` (for cron), so the client never
// kills it: the honest line names /daemon restart, whose receipt names the
// successor's posture. From v2 on the daemon knows its own posture and
// restarts in it, transparently.
//
// The verdict is remembered per process and published to subscribers — the
// REPL paints the line, the health certificate reads the evidence.

import { describeArtifactIdentity } from '../utils/artifactIdentity.js'
import { logForDebugging } from '../utils/debug.js'
import {
  currentVersion,
  daemonControlRpc,
  negotiatedDaemonProto,
  noteDaemonProto,
  readSupervisorState,
} from './controlSocket.js'
import { isProcessAlive, OWNER_PID_ENV } from './ownerWatch.js'
import { MERCURY_DAEMON_PROTO, MIN_PROTO, type DaemonReply } from './protocol.js'

/** This build's version fact. */
export interface ClientVersionFacts {
  proto: number
  version: string
  buildTree: string | null
}

/** The daemon's version fact as the handshake learned it. */
export interface DaemonVersionFacts {
  proto: number
  version: string
  buildTree: string | null
  pid: number | null
  startedAt: number | null
  ownerPid: number | null
  foreground: boolean
  ready: boolean
  restartArmed: boolean
  /** A daemon of the v1 wire — it has no `hello` and no restart verb. */
  preHandshake: boolean
}

export type HandshakeState = 'absent' | 'starting' | 'matched' | 'rebuilt' | 'older' | 'newer'
/** What the verdict calls for: nothing · wait for a starting daemon · the
 *  caller's spawn path · the daemon's own restart · the operator's hand. */
export type HandshakeHeal = 'none' | 'wait' | 'spawn' | 'restart-when-idle' | 'operator'
export type HealState = 'none' | 'restarting' | 'armed' | 'refused' | 'operator'

export interface DaemonHandshakeVerdict {
  state: HandshakeState
  daemon: DaemonVersionFacts | null
  client: ClientVersionFacts
  /** Live workers a restart would kill (warm runners set aside) and the
   *  session subset. */
  live: number
  liveSessions: number
  heal: HandshakeHeal
  /** What the heal answered; 'none' until asked. */
  healState: HealState
  healDetail?: string
  /** The one honest line for the screen; null when nothing is owed. */
  line: string | null
  at: number
}

type HelloReply = Extract<DaemonReply, { ok: true; op: 'hello' }>

/** What `hello` came back as, classified for the pure decision. */
export type HelloOutcome =
  | { kind: 'absent' }
  | { kind: 'starting' }
  | {
      kind: 'pre-handshake'
      proto: number | null
      version: string | null
      live: number
      liveSessions: number
      pid: number | null
      startedAt: number | null
    }
  | { kind: 'hello'; reply: HelloReply }

// ---------------------------------------------------------------------------
// This build's facts (memoised — argv and the manifest beside it never change
// inside one process; a redeploy is a new process).
// ---------------------------------------------------------------------------

let clientMemo: ClientVersionFacts | null = null

/** The client's version fact; `override` lets a prover play another build. */
export function clientVersionFacts(override?: Partial<ClientVersionFacts>): ClientVersionFacts {
  if (clientMemo === null) {
    const version = currentVersion()
    let buildTree: string | null = null
    try {
      buildTree = describeArtifactIdentity(version).buildTree
    } catch {
      buildTree = null
    }
    clientMemo = { proto: MERCURY_DAEMON_PROTO, version, buildTree }
  }
  return override ? { ...clientMemo, ...override } : clientMemo
}

// ---------------------------------------------------------------------------
// The pure decision.
// ---------------------------------------------------------------------------

/** Classify the daemon against this client. Pure; provers drive it. */
export function decideHandshake(outcome: HelloOutcome, client: ClientVersionFacts, now = Date.now()): DaemonHandshakeVerdict {
  const base = { client, healState: 'none' as const, at: now }
  if (outcome.kind === 'absent') {
    return { ...base, state: 'absent', daemon: null, live: 0, liveSessions: 0, heal: 'spawn', line: null }
  }
  if (outcome.kind === 'starting') {
    return { ...base, state: 'starting', daemon: null, live: 0, liveSessions: 0, heal: 'wait', line: null }
  }
  if (outcome.kind === 'pre-handshake') {
    // A daemon that refuses our proto outright: older (the v1 wire) or a
    // newer one whose floor is above us. Either way it has no restart verb
    // we can reach — the operator's hand, named on the line.
    const newer = outcome.proto !== null && outcome.proto > client.proto
    const daemon: DaemonVersionFacts = {
      proto: outcome.proto ?? MIN_PROTO,
      version: outcome.version ?? 'unknown',
      buildTree: null,
      pid: outcome.pid,
      startedAt: outcome.startedAt,
      ownerPid: null,
      foreground: false,
      ready: true,
      restartArmed: false,
      preHandshake: !newer,
    }
    const v: DaemonHandshakeVerdict = {
      ...base,
      state: newer ? 'newer' : 'older',
      daemon,
      live: outcome.live,
      liveSessions: outcome.liveSessions,
      heal: 'operator',
      healState: 'operator',
      line: null,
    }
    return { ...v, line: honestLine(v) }
  }
  const r = outcome.reply
  const daemon: DaemonVersionFacts = {
    proto: r.proto,
    version: r.version,
    buildTree: r.buildTree,
    pid: r.pid,
    startedAt: r.startedAt,
    ownerPid: r.ownerPid,
    foreground: r.foreground,
    ready: r.ready,
    restartArmed: r.restartArmed,
    preHandshake: false,
  }
  const counts = { live: r.live, liveSessions: r.liveSessions }
  if (!r.ready) return { ...base, state: 'starting', daemon, ...counts, heal: 'wait', line: null }
  if (r.proto === client.proto) {
    // Same wire, other bytes: nothing is dead, so no line — the restart is
    // still worth having when idle (the fix the redeploy carried).
    const rebuilt = r.buildTree !== null && client.buildTree !== null && r.buildTree !== client.buildTree
    if (!rebuilt) return { ...base, state: 'matched', daemon, ...counts, heal: 'none', line: null }
    return { ...base, state: 'rebuilt', daemon, ...counts, heal: 'restart-when-idle', line: null }
  }
  const v: DaemonHandshakeVerdict = {
    ...base,
    state: r.proto < client.proto ? 'older' : 'newer',
    daemon,
    ...counts,
    heal: 'restart-when-idle',
    line: null,
  }
  return { ...v, line: honestLine(v) }
}

/** Fold the heal's answer into the verdict (the line follows it). */
export function applyHeal(
  v: DaemonHandshakeVerdict,
  outcome: { state: HealState; live: number; detail?: string },
  now = Date.now(),
): DaemonHandshakeVerdict {
  const next: DaemonHandshakeVerdict = {
    ...v,
    healState: outcome.state,
    ...(outcome.detail !== undefined ? { healDetail: outcome.detail } : {}),
    live: outcome.live,
    liveSessions: Math.min(v.liveSessions, outcome.live),
    at: now,
  }
  return { ...next, line: honestLine(next) }
}

/** "2 live sessions" when every live worker is a session, else "workers". */
export function liveNoun(v: { live: number; liveSessions: number }): string {
  const noun = v.liveSessions === v.live ? 'session' : 'worker'
  return `${v.live} live ${noun}${v.live === 1 ? '' : 's'}`
}

/**
 * THE ONE HONEST LINE. Owed only when the operator's next verb could be
 * refused: a daemon of another version that is not restarting right now.
 */
export function honestLine(v: DaemonHandshakeVerdict): string | null {
  const d = v.daemon
  if (d === null) return null
  if (v.state !== 'older' && v.state !== 'newer') return null
  const who = v.state === 'newer' ? `daemon v${d.version} (newer than this Mercury v${v.client.version})` : `daemon v${d.version}`
  const wait = v.state === 'newer' ? "this Mercury's features wait until it restarts" : 'new features wait until it restarts'
  if (v.healState === 'refused') return `${who} — ${wait} · ${v.healDetail ?? 'it cannot restart itself'}`
  if (v.healState === 'restarting') return null
  if (v.live > 0) return `${who} running with ${liveNoun(v)} — ${wait} · /daemon restart when ready`
  if (v.heal === 'operator') return `${who} running with nothing live — ${wait} · /daemon restart`
  // Idle and the daemon's own restart is on its way (or about to be asked).
  return null
}

/** The health certificate's sentence: version vs client, and the heal status. */
export function daemonHandshakeEvidence(v: DaemonHandshakeVerdict | null): string {
  if (v === null) return 'version handshake not run'
  const c = `this Mercury v${v.client.version} · protocol ${v.client.proto}`
  const d = v.daemon
  switch (v.state) {
    case 'absent':
      return `no daemon answering (${c})`
    case 'starting':
      return d ? `daemon v${d.version} starting (${c})` : `daemon starting (${c})`
    case 'matched':
      return `version matched — daemon v${d!.version} · protocol ${d!.proto}${d!.buildTree ? ` · tree ${d!.buildTree}` : ''}`
    case 'rebuilt':
      return `daemon v${d!.version} is another build of protocol ${d!.proto} (tree ${d!.buildTree} vs ${v.client.buildTree}) — ${healWords(v)}`
    case 'older':
      return `daemon v${d!.version} · protocol ${d!.proto}${d!.preHandshake ? ' (pre-handshake)' : ''} vs ${c} — ${healWords(v)}`
    case 'newer':
      return `daemon v${d!.version} · protocol ${d!.proto} is newer than ${c} — ${healWords(v)}`
  }
}

function healWords(v: DaemonHandshakeVerdict): string {
  switch (v.healState) {
    case 'restarting':
      return 'idle-restarted'
    case 'armed':
      return `waiting on ${liveNoun(v)} — /daemon restart when ready`
    case 'refused':
      return `restart refused: ${v.healDetail ?? 'unknown'}`
    case 'operator':
      return v.live > 0
        ? `waiting on ${liveNoun(v)} — /daemon restart when ready`
        : 'needs /daemon restart (a pre-handshake daemon restarts only by hand)'
    default:
      return v.live > 0 ? `${liveNoun(v)} — restart pending` : 'restart pending'
  }
}

// ---------------------------------------------------------------------------
// The remembered verdict + subscribers.
// ---------------------------------------------------------------------------

let last: DaemonHandshakeVerdict | null = null
const subscribers = new Set<() => void>()

function publish(v: DaemonHandshakeVerdict): void {
  const changed =
    last === null ||
    last.state !== v.state ||
    last.line !== v.line ||
    last.healState !== v.healState ||
    (last.daemon?.pid ?? null) !== (v.daemon?.pid ?? null)
  last = v
  if (!changed) return
  for (const cb of subscribers) {
    try {
      cb()
    } catch (e) {
      logForDebugging(`[daemon] handshake subscriber threw (ignored): ${e}`)
    }
  }
}

/** The last verdict this process reached; null before any handshake. */
export function lastDaemonHandshake(): DaemonHandshakeVerdict | null {
  return last
}

/** Called when the verdict's state, line or heal status changes. */
export function subscribeDaemonHandshake(cb: () => void): () => void {
  subscribers.add(cb)
  return () => {
    subscribers.delete(cb)
  }
}

/** Provers: a clean slate between scenarios. */
export function resetDaemonHandshakeForTesting(): void {
  last = null
  subscribers.clear()
  clientMemo = null
  lastHealAsk = null
}

// ---------------------------------------------------------------------------
// The wire: hello, classify, decide.
// ---------------------------------------------------------------------------

/**
 * One handshake: `hello` in this build's own proto (no dialect retry — the
 * refusal itself is the fact), classified and decided. Never throws.
 */
export async function handshakeDaemon(
  opts: { timeoutMs?: number; client?: Partial<ClientVersionFacts> } = {},
): Promise<DaemonHandshakeVerdict> {
  const client = clientVersionFacts(opts.client)
  const reply = await daemonControlRpc(
    { op: 'hello', proto: client.proto, clientVersion: client.version, clientBuildTree: client.buildTree },
    { timeoutMs: opts.timeoutMs ?? 1500, protoRetry: false },
  )
  const verdict = decideHandshake(await classifyHello(reply), client)
  publish(verdict)
  return verdict
}

async function classifyHello(reply: DaemonReply): Promise<HelloOutcome> {
  if (reply.ok) {
    if (reply.op === 'hello') {
      noteDaemonProto(reply.proto, reply.version)
      return { kind: 'hello', reply }
    }
    return { kind: 'starting' }
  }
  switch (reply.code) {
    case 'ENOCONN':
      return { kind: 'absent' }
    case 'ETIMEOUT':
    case 'ESTARTING':
      return { kind: 'starting' }
    case 'EPROTO': {
      // The pre-handshake daemon's own answer: it refuses our proto and
      // names its own (and its version) in the refusal.
      const proto = typeof reply.serverProto === 'number' ? reply.serverProto : null
      const version = typeof reply.serverVersion === 'string' ? reply.serverVersion : null
      if (proto !== null) noteDaemonProto(proto, version)
      return { kind: 'pre-handshake', proto, version, ...(await preHandshakeFacts()) }
    }
    case 'EUNKNOWN': {
      if (/unknown op/i.test(reply.error)) {
        // Asked in its remembered dialect, the old daemon says it has no
        // `hello` — the same daemon, seen again.
        const known = negotiatedDaemonProto()
        return {
          kind: 'pre-handshake',
          proto: known?.proto ?? null,
          version: known?.version ?? null,
          ...(await preHandshakeFacts()),
        }
      }
      logForDebugging(`[daemon] hello answered EUNKNOWN: ${reply.error}`)
      return { kind: 'starting' }
    }
    default:
      logForDebugging(`[daemon] hello answered ${reply.code}: ${reply.error}`)
      return { kind: 'starting' }
  }
}

/**
 * A pre-handshake daemon reports no idleness, so the client reads it: the
 * session records ∩ the roster (`list`, in its dialect) are the live
 * sessions; roster rows outside concourse-w (crew seats, one-shot runs) are
 * live workers; a concourse-w row WITHOUT a live record is a warm runner —
 * cache, set aside.
 */
async function preHandshakeFacts(): Promise<{ live: number; liveSessions: number; pid: number | null; startedAt: number | null }> {
  const rec = await readSupervisorState().catch(() => null)
  const liveRecords = new Set<string>()
  try {
    const sup = await import('./concourseSupervisor.js')
    for (const r of Object.values(sup.readSessionWorkers())) {
      if (r.endedAt !== undefined || r.attachedAt !== undefined) continue
      if (r.pid !== undefined && isProcessAlive(r.pid)) liveRecords.add(r.runnerId)
    }
  } catch {
    /* no records on disk (hermetic runs) — the roster alone counts */
  }
  let liveSessions = liveRecords.size
  let live = liveSessions
  const list = await daemonControlRpc({ op: 'list', proto: MIN_PROTO }, { timeoutMs: 1000 })
  if (list.ok && list.op === 'list') {
    liveSessions = 0
    let others = 0
    for (const j of list.jobs) {
      if (j.outcome) continue
      if (j.short.startsWith('concourse-w')) {
        if (liveRecords.has(j.short)) liveSessions++
      } else {
        others++
      }
    }
    live = liveSessions + others
  }
  return { live, liveSessions, pid: rec?.pid ?? null, startedAt: rec?.startedAt ?? null }
}

// ---------------------------------------------------------------------------
// The heal.
// ---------------------------------------------------------------------------

/** One ask per daemon life per minute: a successor that came back unchanged
 *  must not be asked again on every send (the restart storm). */
const HEAL_ASK_GAP_MS = 60_000
let lastHealAsk: { pid: number | null; at: number } | null = null

/**
 * Ask the daemon to restart itself as the deployed build. Answers the
 * daemon's typed state ('restarting' — the caller waits for the successor
 * and never spawns beside it; 'armed' / 'refused' — the old daemon keeps
 * serving, the line is on screen) or 'operator' for a pre-handshake daemon.
 */
export async function healDaemonVersion(
  v: DaemonHandshakeVerdict,
  opts: { by?: string } = {},
): Promise<{ state: HealState; live: number; detail?: string }> {
  if (v.heal !== 'restart-when-idle') {
    const out = { state: v.heal === 'operator' ? ('operator' as const) : ('none' as const), live: v.live }
    if (v.heal === 'operator') publish(applyHeal(v, out))
    return out
  }
  const pid = v.daemon?.pid ?? null
  if (lastHealAsk !== null && lastHealAsk.pid === pid && Date.now() - lastHealAsk.at < HEAL_ASK_GAP_MS) {
    const remembered = last !== null && (last.daemon?.pid ?? null) === pid ? last.healState : 'none'
    return { state: remembered, live: v.live }
  }
  lastHealAsk = { pid, at: Date.now() }
  const reply = await daemonControlRpc(
    { op: 'restart-when-idle', proto: MERCURY_DAEMON_PROTO, by: opts.by ?? `screen ${process.pid}` },
    { timeoutMs: 3000 },
  )
  const out =
    reply.ok && reply.op === 'restart-when-idle'
      ? { state: reply.state, live: reply.live, ...(reply.detail !== undefined ? { detail: reply.detail } : {}) }
      : { state: 'refused' as const, live: v.live, detail: reply.ok ? 'unexpected reply' : reply.error }
  publish(applyHeal(v, out))
  return out
}

// ---------------------------------------------------------------------------
// The operator's hand: /daemon restart · mercury daemon restart.
// ---------------------------------------------------------------------------

export interface RestartReceipt {
  state: 'restarted' | 'restarting' | 'armed' | 'refused' | 'absent'
  line: string
}

export type DaemonPosture = 'owned' | 'persistent'

/**
 * Restart the daemon by hand. A daemon that speaks the handshake re-executes
 * itself (now when idle, armed otherwise — matched or not, the operator
 * asked). A pre-handshake daemon has no restart verb: it is stopped when
 * idle and a successor started HERE, whose posture the receipt names —
 * 'owned' from a screen (it stops when this Mercury exits), 'persistent'
 * from the headless verb (a headless caller exits at once, so an owned
 * successor would self-reap behind it).
 */
export async function restartDaemon(opts: {
  by: string
  posture: DaemonPosture
  /** The successor's scheduling dir when the record names none. */
  dir?: string
  /** Provers inject the spawn; the default is the owned-daemon seam. */
  spawn?: (dir: string, posture: DaemonPosture) => Promise<number | undefined>
  pollMs?: number
  tries?: number
}): Promise<RestartReceipt> {
  const first = await handshakeDaemon()
  if (first.state === 'absent') return { state: 'absent', line: 'no daemon is running — the next session starts one' }
  if (first.state === 'starting' || first.daemon === null) {
    return { state: 'refused', line: 'the daemon is still starting — try again in a moment' }
  }
  const d = first.daemon
  if (first.heal === 'operator') {
    if (first.live > 0) {
      return { state: 'refused', line: `daemon v${d.version} has ${liveNoun(first)} — finish or stop them, then /daemon restart` }
    }
    const rec = await readSupervisorState().catch(() => null)
    const dir = rec?.dir ?? opts.dir ?? process.cwd()
    const bye = await daemonControlRpc({ op: 'shutdown', reapWorkers: false }, { timeoutMs: 3000 })
    if (!bye.ok) return { state: 'refused', line: `daemon v${d.version} did not stop — ${bye.error}` }
    await waitForHandshake(v => v.state === 'absent', opts)
    const pid = await (opts.spawn ?? spawnSuccessorHere)(dir, opts.posture)
    if (pid === undefined) {
      return { state: 'refused', line: `daemon v${d.version} stopped, but the new one could not be started — the next session starts it` }
    }
    const posture =
      opts.posture === 'owned'
        ? "this Mercury's own daemon — it stops when this Mercury exits; a `mercury daemon` you had started yourself for cron needs starting again"
        : 'persistent — `mercury daemon stop` ends it'
    const back = await waitForHandshake(v => v.state === 'matched', opts)
    return back
      ? { state: 'restarted', line: `daemon restarted as v${first.client.version} · protocol ${first.client.proto} (${posture})` }
      : { state: 'restarting', line: `daemon v${d.version} stopped; the new one (pid ${pid}) is still starting (${posture})` }
  }
  const reply = await daemonControlRpc(
    { op: 'restart-when-idle', proto: MERCURY_DAEMON_PROTO, by: opts.by },
    { timeoutMs: 3000 },
  )
  if (!reply.ok || reply.op !== 'restart-when-idle') {
    return { state: 'refused', line: `daemon v${d.version} refused the restart — ${reply.ok ? 'unexpected reply' : reply.error}` }
  }
  publish(applyHeal(first, reply))
  if (reply.state === 'armed') {
    return { state: 'armed', line: `restart armed — daemon v${d.version} restarts when its ${liveNoun({ live: reply.live, liveSessions: Math.min(first.liveSessions, reply.live) })} finish` }
  }
  if (reply.state === 'refused') return { state: 'refused', line: `daemon v${d.version} — ${reply.detail ?? 'restart refused'}` }
  const oldPid = d.pid
  const back = await waitForHandshake(v => v.daemon !== null && v.daemon.pid !== oldPid && v.state !== 'starting', opts)
  return back
    ? { state: 'restarted', line: `daemon restarted — v${back.daemon!.version} · protocol ${back.daemon!.proto} (pid ${back.daemon!.pid})` }
    : { state: 'restarting', line: `daemon v${d.version} is restarting — not back yet` }
}

async function waitForHandshake(
  done: (v: DaemonHandshakeVerdict) => boolean,
  opts: { pollMs?: number; tries?: number },
): Promise<DaemonHandshakeVerdict | null> {
  const tries = opts.tries ?? 40
  const pollMs = opts.pollMs ?? 250
  for (let i = 0; i < tries; i++) {
    const v = await handshakeDaemon({ timeoutMs: 500 })
    if (done(v)) return v
    await new Promise(res => setTimeout(res, pollMs))
  }
  return null
}

/** The default successor spawn for a pre-handshake daemon: the owned-daemon
 *  seam, with the owner-pid stamp dropped for a persistent posture. */
async function spawnSuccessorHere(dir: string, posture: DaemonPosture): Promise<number | undefined> {
  const { spawnOwnedDaemon } = await import('./ownedDaemon.js')
  return spawnOwnedDaemon(dir, {
    label: 'daemon-restart',
    persist: posture === 'persistent',
    ...(posture === 'persistent' ? { extraEnv: { [OWNER_PID_ENV]: undefined } } : {}),
  })
}
