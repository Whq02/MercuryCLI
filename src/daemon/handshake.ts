
import { describeArtifactIdentity } from '../utils/artifactIdentity.js'
import { logForDebugging } from '../utils/debug.js'
import { comparePrivateVersions, parsePrivateVersion } from '../services/privateChannel/channelCore.js'
import {
  currentVersion,
  daemonControlRpc,
  negotiatedDaemonProto,
  noteDaemonProto,
  readDaemonState,
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
  predecessorPids?: number[]
  preHandshake: boolean
}

export type HandshakeState = 'absent' | 'starting' | 'matched' | 'rebuilt' | 'older' | 'newer'
export type HandshakeHeal = 'none' | 'wait' | 'spawn' | 'restart-when-idle' | 'operator' | 'reopen'
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

export interface InstalledBuildFacts {
  buildTree: string | null
  version: string | null
}

export function installedBuildFacts(runtime: { buildTree: string | null; version: string | null } | null): InstalledBuildFacts | null {
  return runtime === null ? null : { buildTree: runtime.buildTree, version: runtime.version }
}

export function versionIsNewer(candidate: string, than: string): boolean {
  const a = parsePrivateVersion(candidate)
  const b = parsePrivateVersion(than)
  return a !== null && b !== null && comparePrivateVersions(a, b) > 0
}

function isInstalledBuild(tree: string | null, installed: InstalledBuildFacts | null): boolean {
  return installed !== null && installed.buildTree !== null && tree === installed.buildTree
}

export function screenIsOlder(daemon: { buildTree: string | null; version: string }, client: ClientVersionFacts, installed: InstalledBuildFacts | null): boolean {
  if (versionIsNewer(daemon.version, client.version)) return true
  return isInstalledBuild(daemon.buildTree, installed) && !isInstalledBuild(client.buildTree, installed)
}

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


export function decideHandshake(outcome: HelloOutcome, client: ClientVersionFacts, now = Date.now(), installed: InstalledBuildFacts | null = null): DaemonHandshakeVerdict {
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
    predecessorPids: r.predecessorPids ?? (r.predecessorPid ? [r.predecessorPid] : []),
    preHandshake: false,
  }
  const counts = { live: r.live, liveSessions: r.liveSessions }
  if (!r.ready) return { ...base, state: 'starting', daemon, ...counts, heal: 'wait', line: null }
  const healState: HealState = r.restartArmed === true ? 'armed' : 'none'
  if (r.proto === client.proto) {
    const rebuilt = r.buildTree !== null && client.buildTree !== null && r.buildTree !== client.buildTree
    if (!rebuilt) return { ...base, state: 'matched', daemon, ...counts, heal: 'none', line: null }
    if (screenIsOlder(daemon, client, installed)) {
      const v: DaemonHandshakeVerdict = { ...base, state: 'rebuilt', daemon, ...counts, heal: 'reopen', healState: 'none', line: null }
      return { ...v, line: honestLine(v) }
    }
    const ordered = versionIsNewer(client.version, daemon.version) || (isInstalledBuild(client.buildTree, installed) && !isInstalledBuild(daemon.buildTree, installed))
    const v: DaemonHandshakeVerdict = { ...base, state: 'rebuilt', daemon, ...counts, heal: ordered ? 'restart-when-idle' : 'operator', healState: ordered ? healState : 'operator', line: null }
    return { ...v, line: honestLine(v) }
  }
  const v: DaemonHandshakeVerdict = {
    ...base,
    state: r.proto < client.proto ? 'older' : 'newer',
    daemon,
    ...counts,
    heal: 'restart-when-idle',
    healState,
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

export function finishVerb(live: number): string {
  return live === 1 ? 'finishes' : 'finish'
}

export function untilFinished(live: number): string {
  return live === 1 ? 'until it finishes' : 'until they finish'
}

export function honestLine(v: DaemonHandshakeVerdict): string | null {
  const d = v.daemon
  if (d === null) return null
  if (v.state === 'rebuilt') {
    if (v.heal === 'reopen') return reopenLine(v)
    if (v.heal === 'operator') return `${rebuiltWho(v)} — build order unknown; ${REBUILT_UNTIL} · /daemon shows the builds`
    if (v.healState === 'refused') return `${rebuiltWho(v)} — ${REBUILT_UNTIL} · ${v.healDetail ?? 'it cannot restart itself'}`
    if (v.healState === 'armed' && v.live > 0) return `${rebuiltWho(v)} running with ${liveNoun(v)} — ${REBUILT_UNTIL} · /daemon restart when ready`
    return null
  }
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
      return `daemon v${d!.version} is another build of protocol ${d!.proto} (tree ${d!.buildTree} vs ${v.client.buildTree} of this Mercury v${v.client.version}) — ${healWords(v)}`
    case 'older':
      return `daemon v${d!.version} · protocol ${d!.proto}${d!.preHandshake ? ' (pre-handshake)' : ''} vs ${c} — ${healWords(v)}`
    case 'newer':
      return `daemon v${d!.version} · protocol ${d!.proto} is newer than ${c} — ${healWords(v)}`
  }
}

const REBUILT_UNTIL = 'new sessions run on its build until it restarts'
export const REOPEN_WORDS = 'close this window and open Mercury again'

function rebuiltWho(v: DaemonHandshakeVerdict): string {
  const d = v.daemon
  if (d !== null && d.version === v.client.version) {
    return `daemon (tree ${d.buildTree ?? '?'}) is another build of this Mercury v${v.client.version} (tree ${v.client.buildTree ?? '?'})`
  }
  return `daemon v${d?.version ?? '?'} is another build of this Mercury v${v.client.version}`
}

export function reopenLine(v: DaemonHandshakeVerdict): string {
  const d = v.daemon
  if (d !== null && d.version === v.client.version) {
    return `${REOPEN_WORDS} — the daemon runs the installed build (tree ${d.buildTree ?? '?'}); this Mercury (tree ${v.client.buildTree ?? '?'}) is another build`
  }
  return `${REOPEN_WORDS} — a newer Mercury (v${d?.version ?? '?'}) is installed and the daemon runs it; this Mercury (v${v.client.version}) is the older build`
}

export function daemonSkewLine(v: DaemonHandshakeVerdict | null): string | null {
  if (v === null || v.daemon === null || v.state !== 'rebuilt') return null
  if (v.line !== null) return v.line
  if (v.healState === 'restarting') return null
  return `${rebuiltWho(v)} — ${REBUILT_UNTIL} · /daemon restart moves it`
}

export function daemonBuildBesideScreen(v: DaemonHandshakeVerdict | null): string | null {
  const d = v?.daemon ?? null
  if (v === null || d === null) return null
  if (v.state !== 'rebuilt' && v.state !== 'older' && v.state !== 'newer') return null
  if (v.heal === 'reopen') return `daemon v${d.version}${d.buildTree ? ` · tree ${d.buildTree}` : ''} (the installed build — ${REOPEN_WORDS})`
  return `daemon v${d.version}${d.buildTree ? ` · tree ${d.buildTree}` : ''} (another build — new sessions run on it until it restarts)`
}

export function daemonBuildStatusWords(v: DaemonHandshakeVerdict | null): string {
  if (v?.daemon == null || !['rebuilt', 'older', 'newer'].includes(v.state)) return ''
  return `daemon build ${v.daemon.buildTree ?? v.daemon.version} differs`
}

function healWords(v: DaemonHandshakeVerdict): string {
  if (v.heal === 'reopen') return `this Mercury is not the installed build — ${REOPEN_WORDS}`
  if (v.state === 'rebuilt' && v.heal === 'operator') return `build order unknown; ${REBUILT_UNTIL} · /daemon shows the builds`
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
  if (handoverInFlight !== null && v.daemon !== null && v.daemon.pid !== null && v.daemon.pid !== handoverInFlight) handoverInFlight = null
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
  healAskInFlight = null
}


export async function handshakeDaemon(
  opts: { timeoutMs?: number; client?: Partial<ClientVersionFacts> } = {},
): Promise<DaemonHandshakeVerdict> {
  const client = clientVersionFacts(opts.client)
  const reply = await daemonControlRpc(
    { op: 'hello', proto: client.proto, clientVersion: client.version, clientBuildTree: client.buildTree },
    { timeoutMs: opts.timeoutMs ?? 1500, protoRetry: false },
  )
  const verdict = decideHandshake(await classifyHello(reply), client, Date.now(), await installedBuild())
  publish(verdict)
  return verdict
}

async function installedBuild(): Promise<InstalledBuildFacts | null> {
  try {
    const { deployedRuntime } = await import('./handover.js')
    return installedBuildFacts(deployedRuntime())
  } catch {
    return null
  }
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
  const rec = await readDaemonState().catch(() => null)
  const liveRecords = new Set<string>()
  try {
    const sup = await import('./concourseWorkers.js')
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
  if (healAskInFlight !== null && healAskInFlight.pid === pid) return healAskInFlight.answer
  if (lastHealAsk !== null && lastHealAsk.pid === pid && Date.now() - lastHealAsk.at < HEAL_ASK_GAP_MS) {
    const remembered = last !== null && (last.daemon?.pid ?? null) === pid ? last.healState : 'none'
    return { state: remembered, live: v.live }
  }
  lastHealAsk = { pid, at: Date.now() }
  const answer = (async (): Promise<{ state: HealState; live: number; detail?: string }> => {
    const reply = await daemonControlRpc(
      { op: 'restart-when-idle', proto: MERCURY_DAEMON_PROTO, by: opts.by ?? `screen ${process.pid}` },
      { timeoutMs: 3000 },
    )
    let out: { state: HealState; live: number; detail?: string } =
      reply.ok && reply.op === 'restart-when-idle'
        ? { state: reply.state, live: reply.live, ...(reply.detail !== undefined ? { detail: reply.detail } : {}) }
        : { state: 'refused' as const, live: v.live, detail: reply.ok ? 'unexpected reply' : reply.error }
    const handover = await handoverDaemonVersion(v, out)
    if (handover !== null) out = { state: 'restarting', live: out.live, detail: handover }
    publish(applyHeal(v, out))
    return out
  })()
  healAskInFlight = { pid, answer }
  try {
    return await answer
  } finally {
    if (healAskInFlight?.answer === answer) healAskInFlight = null
  }
}

let healAskInFlight: { pid: number | null; answer: Promise<{ state: HealState; live: number; detail?: string }> } | null = null
const handoverAsked = new Set<number>()
let handoverInFlight: number | null = null

export function resetHandoverAsksForTesting(): void {
  handoverAsked.clear()
  handoverInFlight = null
  healAskInFlight = null
}

export function handoverInFlightFor(pid: number | null): boolean {
  return pid !== null && handoverInFlight === pid
}

export async function handoverDaemonVersion(
  v: DaemonHandshakeVerdict,
  heal: { state: HealState; live: number },
  opts: { runtime?: () => import('./handover.js').DeployedRuntimeV1 | null; spawn?: (script: string, dir: string, env: Record<string, string | undefined>, ownerPipe: boolean, persist: boolean, node?: string | null) => number | undefined } = {},
): Promise<string | null> {
  const d = v.daemon
  if (d === null || d.pid === null) return null
  const { decideHandover, deployedRuntime, HANDOVER_FROM_ENV } = await import('./handover.js')
  const runtime = (opts.runtime ?? deployedRuntime)()
  const decision = decideHandover({ daemonBuildTree: d.buildTree, deployedBuildTree: runtime?.buildTree ?? null, healState: heal.state, live: heal.live })
  if (!decision.handover || runtime === null) return null
  const record = await readDaemonState().catch(() => null)
  if (record !== null && record.pid !== d.pid && isProcessAlive(record.pid)) {
    handoverInFlight = d.pid
    return `a successor (pid ${record.pid}) is taking the plane from daemon v${d.version} (pid ${d.pid}), which keeps its ${liveNoun({ live: heal.live, liveSessions: Math.min(v.liveSessions, heal.live) })} ${untilFinished(heal.live)}`
  }
  if (handoverAsked.has(d.pid)) return null
  handoverAsked.add(d.pid)
  handoverInFlight = d.pid
  const dir = record?.dir ?? process.cwd()
  const ownsIt = d.ownerPid === process.pid
  const env: Record<string, string | undefined> = {
    [HANDOVER_FROM_ENV]: String(d.pid),
    MERCURY_DAEMON_SUCCESSOR_OF: undefined,
    ...(d.ownerPid === null ? { [OWNER_PID_ENV]: undefined, MERCURY_DAEMON_PERSIST: '1' } : { [OWNER_PID_ENV]: String(d.ownerPid) }),
  }
  const spawn =
    opts.spawn ??
    (async (script: string, projectDir: string, extraEnv: Record<string, string | undefined>, ownerPipe: boolean, persist: boolean, node?: string | null) => {
      const { spawnOwnedDaemon } = await import('./ownedDaemon.js')
      return spawnOwnedDaemon(projectDir, { label: 'daemon-handover', script, extraEnv, ownerPipe, persist, ...(node ? { node } : {}) })
    })
  const pid = await spawn(runtime.script, dir, env, ownsIt, !ownsIt, runtime.node)
  if (pid === undefined) return null
  logForDebugging(`[daemon] handover: ${decision.why} — successor pid ${pid} from ${runtime.script}`)
  return `handing over to the deployed build (tree ${runtime.buildTree ?? '?'}, pid ${pid}) — daemon v${d.version} keeps its ${liveNoun({ live: heal.live, liveSessions: Math.min(v.liveSessions, heal.live) })} ${untilFinished(heal.live)}`
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
  if (first.heal === 'reopen') return { state: 'refused', line: first.line ?? reopenLine(first) }
  if (first.heal === 'operator') {
    if (first.live > 0) {
      return { state: 'refused', line: `daemon v${d.version} has ${liveNoun(first)} — finish or stop them, then /daemon restart` }
    }
    const rec = await readDaemonState().catch(() => null)
    const dir = rec?.dir ?? opts.dir ?? process.cwd()
    const bye = await daemonControlRpc({ op: 'shutdown', reapWorkers: true }, { timeoutMs: 3000 })
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
  if (reply.state === 'armed' || reply.state === 'refused') {
    const handedOver = await handoverDaemonVersion(first, reply)
    if (handedOver !== null) {
      const successor = await waitForHandshake(v => v.daemon !== null && v.daemon.pid !== d.pid && v.state !== 'starting', opts)
      return successor
        ? { state: 'restarted', line: `daemon handed over — v${successor.daemon!.version} · protocol ${successor.daemon!.proto} (pid ${successor.daemon!.pid}) takes new sessions; daemon v${d.version} (pid ${d.pid}) keeps its ${liveNoun({ live: reply.live, liveSessions: Math.min(first.liveSessions, reply.live) })} ${untilFinished(reply.live)}` }
        : { state: 'restarting', line: `${handedOver} — the successor is not answering yet` }
    }
  }
  if (reply.state === 'armed') {
    if (reply.detail !== undefined) return { state: 'armed', line: `restart armed — ${reply.detail}` }
    return { state: 'armed', line: `restart armed — daemon v${d.version} restarts when its ${liveNoun({ live: reply.live, liveSessions: Math.min(first.liveSessions, reply.live) })} ${finishVerb(reply.live)}` }
  }
  if (reply.state === 'refused') return { state: 'refused', line: `daemon v${d.version} — ${reply.detail ?? 'restart refused'}` }
  const oldPid = d.pid
  const back = await waitForHandshake(v => v.daemon !== null && v.daemon.pid !== oldPid && v.state !== 'starting', opts)
  return back
    ? { state: 'restarted', line: `daemon restarted — v${back.daemon!.version} · protocol ${back.daemon!.proto} (pid ${back.daemon!.pid})` }
    : { state: 'restarting', line: `daemon v${d.version} is restarting — not back yet` }
}

export type DaemonMoveState = 'absent' | 'current' | 'moved' | 'moving' | 'when-idle' | 'stop' | 'unknown'

export interface DaemonMoveReceipt {
  state: DaemonMoveState
  line: string
}

export async function moveDaemonToDeployedBuild(opts: {
  by: string
  runtime?: import('./handover.js').DeployedRuntimeV1 | null
  hosted?: boolean
  spawn?: (script: string, dir: string, env: Record<string, string | undefined>, ownerPipe: boolean, persist: boolean, node?: string | null) => number | undefined
  pollMs?: number
  tries?: number
}): Promise<DaemonMoveReceipt> {
  const { deployedRuntime } = await import('./handover.js')
  const { sameBuildTree } = await import('./planeBoot.js')
  const runtime = opts.runtime === undefined ? deployedRuntime() : opts.runtime
  if (runtime === null) return { state: 'unknown', line: 'background daemon: no installed build to move it onto' }
  const to = runtime.version !== null ? `v${runtime.version}` : `tree ${runtime.buildTree ?? '?'}`
  const first = await handshakeDaemon()
  if (first.state === 'absent') return { state: 'absent', line: `background daemon: none running — the next session starts one on ${to}` }
  const d = first.daemon
  if (first.state === 'starting' || d === null) {
    return { state: 'unknown', line: `background daemon: still starting — \`mercury daemon restart\` moves it to ${to} once it answers` }
  }
  const old = `v${d.version}${d.pid !== null ? ` (pid ${d.pid})` : ''}`
  if (d.buildTree === null) return { state: 'unknown', line: `background daemon: ${old} carries no build tree (a source run) — \`mercury daemon restart\` moves it by hand` }
  if (sameBuildTree(d.buildTree, runtime.buildTree)) return { state: 'current', line: `background daemon: already on ${to} (${old})` }
  const stopLine = (why: string): DaemonMoveReceipt => ({
    state: 'stop',
    line: `background daemon: ${old} could not be moved — ${why}; \`mercury daemon stop\` ends it and the next session starts one on ${to}`,
  })
  const { hostedCallerOf, restartEndsHostedCaller } = await import('./hostedCaller.js')
  const hosted = opts.hosted !== undefined ? opts.hosted : (await hostedCallerOf(await (await import('./status.js')).helperPidsOfHome())).hosted
  if (hosted && restartEndsHostedCaller(first)) {
    return stopLine('this command runs inside a session it hosts, so its restart would end your own turn — run `mercury update` or `mercury daemon restart` from a plain shell')
  }
  if (first.heal === 'operator') return stopLine('it predates the version handshake and cannot restart itself')
  const liveWords = (live: number): string => liveNoun({ live, liveSessions: Math.min(first.liveSessions, live) })
  const settled = async (verdict: DaemonHandshakeVerdict, reply: { state: HealState; live: number }): Promise<DaemonMoveReceipt | null> => {
    const handedOver = await handoverDaemonVersion(verdict, reply, { runtime: () => runtime, ...(opts.spawn !== undefined ? { spawn: opts.spawn } : {}) })
    if (handedOver === null) return null
    const successor = await waitForHandshake(v => v.daemon !== null && v.daemon.pid !== verdict.daemon?.pid && v.state !== 'starting', opts)
    if (successor === null || successor.daemon === null) return { state: 'moving', line: `background daemon: ${handedOver} — the successor is not answering yet` }
    const next = `v${successor.daemon.version} (pid ${successor.daemon.pid})`
    return {
      state: 'moved',
      line: reply.live > 0
        ? `background daemon: ${next} takes new sessions; daemon ${old} keeps its ${liveWords(reply.live)} ${untilFinished(reply.live)}`
        : `background daemon: moved to ${next} — new sessions run on it`,
    }
  }
  const ask = async (verdict: DaemonHandshakeVerdict): Promise<DaemonMoveReceipt | null> => {
    const reply = await daemonControlRpc({ op: 'restart-when-idle', proto: MERCURY_DAEMON_PROTO, by: opts.by }, { timeoutMs: 3000 })
    if (!reply.ok || reply.op !== 'restart-when-idle') return stopLine(`it refused the restart (${reply.ok ? 'unexpected reply' : reply.error})`)
    publish(applyHeal(verdict, reply))
    if (reply.state === 'armed') {
      return (await settled(verdict, reply)) ?? {
        state: 'when-idle',
        line: reply.detail !== undefined ? `background daemon: ${old} moves to ${to} when idle — ${reply.detail}` : `background daemon: ${old} moves to ${to} when its ${liveWords(reply.live)} ${finishVerb(reply.live)}`,
      }
    }
    if (reply.state === 'refused') return (await settled(verdict, reply)) ?? stopLine(reply.detail ?? 'the restart was refused')
    const back = await waitForHandshake(v => v.daemon !== null && v.daemon.pid !== verdict.daemon?.pid && v.state !== 'starting', opts)
    if (back === null || back.daemon === null) return { state: 'moving', line: `background daemon: ${old} is restarting as ${to} — not back yet; the next session finds it` }
    if (sameBuildTree(back.daemon.buildTree, runtime.buildTree)) {
      return { state: 'moved', line: `background daemon: moved to v${back.daemon.version} (pid ${back.daemon.pid}) — new sessions run on it` }
    }
    return null
  }
  const firstTry = await ask(first)
  if (firstTry !== null) return firstTry
  const back = await handshakeDaemon()
  if (back.daemon === null || back.state === 'absent' || back.state === 'starting') {
    return { state: 'moving', line: `background daemon: ${old} restarted on its old build and is not answering yet — \`mercury daemon restart\` moves it to ${to}` }
  }
  const second = await ask(back)
  return second ?? stopLine(`it restarted on its old build (v${back.daemon.version}) and would not hand over`)
}

export const SUCCESSOR_WAIT_TRIES = 80
export const SUCCESSOR_WAIT_POLL_MS = 250

async function waitForHandshake(
  done: (v: DaemonHandshakeVerdict) => boolean,
  opts: { pollMs?: number; tries?: number },
): Promise<DaemonHandshakeVerdict | null> {
  const tries = opts.tries ?? SUCCESSOR_WAIT_TRIES
  const pollMs = opts.pollMs ?? SUCCESSOR_WAIT_POLL_MS
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
