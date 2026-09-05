
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

export interface ClientVersionFacts {
  proto: number
  version: string
  buildTree: string | null
}

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
  preHandshake: boolean
}

export type HandshakeState = 'absent' | 'starting' | 'matched' | 'rebuilt' | 'older' | 'newer'
export type HandshakeHeal = 'none' | 'wait' | 'spawn' | 'restart-when-idle' | 'operator'
export type HealState = 'none' | 'restarting' | 'armed' | 'refused' | 'operator'

export interface DaemonHandshakeVerdict {
  state: HandshakeState
  daemon: DaemonVersionFacts | null
  client: ClientVersionFacts
  live: number
  liveSessions: number
  heal: HandshakeHeal
  healState: HealState
  healDetail?: string
  line: string | null
  at: number
}

type HelloReply = Extract<DaemonReply, { ok: true; op: 'hello' }>

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


let clientMemo: ClientVersionFacts | null = null

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


export function decideHandshake(outcome: HelloOutcome, client: ClientVersionFacts, now = Date.now()): DaemonHandshakeVerdict {
  const base = { client, healState: 'none' as const, at: now }
  if (outcome.kind === 'absent') {
    return { ...base, state: 'absent', daemon: null, live: 0, liveSessions: 0, heal: 'spawn', line: null }
  }
  if (outcome.kind === 'starting') {
    return { ...base, state: 'starting', daemon: null, live: 0, liveSessions: 0, heal: 'wait', line: null }
  }
  if (outcome.kind === 'pre-handshake') {
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

export function liveNoun(v: { live: number; liveSessions: number }): string {
  const noun = v.liveSessions === v.live ? 'session' : 'worker'
  return `${v.live} live ${noun}${v.live === 1 ? '' : 's'}`
}

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
  return null
}

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

export function lastDaemonHandshake(): DaemonHandshakeVerdict | null {
  return last
}

export function subscribeDaemonHandshake(cb: () => void): () => void {
  subscribers.add(cb)
  return () => {
    subscribers.delete(cb)
  }
}

export function resetDaemonHandshakeForTesting(): void {
  last = null
  subscribers.clear()
  clientMemo = null
  lastHealAsk = null
}


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
      const proto = typeof reply.serverProto === 'number' ? reply.serverProto : null
      const version = typeof reply.serverVersion === 'string' ? reply.serverVersion : null
      if (proto !== null) noteDaemonProto(proto, version)
      return { kind: 'pre-handshake', proto, version, ...(await preHandshakeFacts()) }
    }
    case 'EUNKNOWN': {
      if (reply.refusal === 'daemon-older' || /unknown op/i.test(reply.error)) {
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


const HEAL_ASK_GAP_MS = 60_000
let lastHealAsk: { pid: number | null; at: number } | null = null

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


export interface RestartReceipt {
  state: 'restarted' | 'restarting' | 'armed' | 'refused' | 'absent'
  line: string
}

export type DaemonPosture = 'owned' | 'persistent'

export async function restartDaemon(opts: {
  by: string
  posture: DaemonPosture
  dir?: string
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

async function spawnSuccessorHere(dir: string, posture: DaemonPosture): Promise<number | undefined> {
  const { spawnOwnedDaemon } = await import('./ownedDaemon.js')
  return spawnOwnedDaemon(dir, {
    label: 'daemon-restart',
    persist: posture === 'persistent',
    ...(posture === 'persistent' ? { extraEnv: { [OWNER_PID_ENV]: undefined } } : {}),
  })
}
