// Mercury daemon — control-plane filesystem identity + the CLI-side RPC client.
//
// Everything the control plane puts on disk is named here: the socket, the
// supervisor record, the control key, and the supervisor lock. The ownership
// guards that stop a dying daemon from deleting a successor's live files live
// beside them, as does daemonControlRpc — the one client seam every CLI-side
// caller goes through. Because server and clients resolve every path through
// the SAME functions in this module, the two sides cannot drift apart about
// where the plane lives.
//
// The plane binds under the Mercury config home as a loopback unix socket
// (a named pipe on win32). Nothing in it ever listens on a network interface.

import net from 'node:net'
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { readFileSync, unlinkSync } from 'node:fs'
import { flagEnv } from '../substrate/flagRegistry.js'
import {
  mkdir,
  readFile,
  writeFile,
  unlink,
  chmod,
} from 'node:fs/promises'
import { platform, tmpdir } from 'node:os'
import { join } from 'node:path'
import { acquirePidLock, noteLockRelease, releasePidLock } from '../substrate/pidLock.js'
import { getMercuryHome } from '../utils/envUtils.js'
import { logForDebugging } from '../utils/debug.js'
import { recordSpawnExit } from '../utils/spawnLedger.js'
import {
  MERCURY_DAEMON_PROTO,
  MIN_PROTO,
  encodeFrame,
  type DaemonReply,
  type DaemonRequest,
} from './protocol.js'

/** Version stamp the bundler injects at build time. */
declare const MACRO: { VERSION: string }

/** Config home, always via the one shared resolver — deriving it inline here
 *  would let the daemon plane and the store it serves split the moment the
 *  resolver's default ever moves. */
function configHome(): string {
  return getMercuryHome()
}

/** Where the daemon keeps its plane, inside the config home by default.
 *  MERCURY_DAEMON_DIR replaces the whole directory and is consulted live on
 *  every call — server bind and client probes alike come through here, which
 *  is what keeps them symmetric. It doubles as the isolation seam: a test
 *  fixture aims it at scratch space, guaranteeing a deterministic run can
 *  never touch a real daemon's socket. */
export function daemonDir(): string {
  const override = flagEnv('MERCURY_DAEMON_DIR')
  if (override && override.trim() !== '') return override
  return join(configHome(), 'daemon')
}

/**
 * Absolute control-socket path. On POSIX it is a unix socket inside the
 * daemon dir; win32 has no AF_UNIX path here, so it gets a named pipe whose
 * suffix hashes the daemon dir (two homes can therefore never share a pipe).
 *
 * sun_path is tiny — roughly 104 bytes on darwin and 108 on linux, NUL
 * included — so a deeply nested config home can push the preferred
 * `control.sock` location past what bind() accepts (EINVAL on darwin,
 * ENAMETOOLONG elsewhere), a failure boot would otherwise swallow into a
 * daemon with no control plane at all. Past the safe bound we therefore use
 * a short hash-suffixed socket under tmpdir, the same trick as the win32
 * pipe; and because every consumer calls THIS function, both ends of the
 * wire agree on the fallback automatically.
 */
const SUN_PATH_SAFE_MAX = 100
export function controlSockPath(): string {
  if (platform() === 'win32') {
    const h = createHash('sha1').update(daemonDir()).digest('hex').slice(0, 12)
    return `\\\\.\\pipe\\hermes-daemon-${h}`
  }
  const preferred = join(daemonDir(), 'control.sock')
  if (Buffer.byteLength(preferred, 'utf8') <= SUN_PATH_SAFE_MAX) return preferred
  const h = createHash('sha1').update(daemonDir()).digest('hex').slice(0, 12)
  return join(tmpdir(), `hermes-daemon-${h}.sock`)
}

/** Where the supervisor record is persisted. */
export function supervisorStatePath(): string {
  return join(daemonDir(), 'supervisor.json')
}

/** Where the 0600 control key is persisted. */
export function controlKeyPath(): string {
  return join(daemonDir(), 'control.key')
}

// ---------------------------------------------------------------------------
// Supervisor record.
// ---------------------------------------------------------------------------

export interface SupervisorState {
  pid: number
  version: string
  /** How this supervisor came to exist; an explicit `mercury daemon` launch is `transient`. */
  origin: 'transient'
  /** epoch-ms at which it came up. */
  startedAt: number
  /** Scheduling dir it drives. */
  dir: string
  /** The socket path it resolved (kept for diagnostics). */
  controlSock: string
  // THE VERSION FACT (the handshake) — absent on a record a pre-handshake
  // daemon wrote, which is itself the fact: that daemon predates `hello`.
  /** The protocol version the daemon speaks (MERCURY_DAEMON_PROTO at its build). */
  proto?: number
  /** The build tree it booted from; null outside a manifest'd bundle. */
  buildTree?: string | null
  /** The owner-pid stamp of an owned daemon; null for a persistent one. */
  ownerPid?: number | null
  /** Running on a terminal — a restart-when-idle refuses. */
  foreground?: boolean
  /** THE IDENTITY BASELINE (TASK-017 F-1): this daemon's own process start
   *  token (ownerWatch.getProcessStartToken at boot — the ONE start-token
   *  vocabulary), so a reader judging "is the recorded pid still THE
   *  daemon" can tell it from a stranger that inherited a recycled pid.
   *  null = the probe could not answer; absent = a pre-token record —
   *  both read conservatively (pid-liveness alone, the old verdict). */
  startToken?: string | null
}

/** Load the supervisor record; null when missing or unparseable. */
export async function readSupervisorState(): Promise<SupervisorState | null> {
  try {
    const raw = await readFile(supervisorStatePath(), 'utf8')
    const parsed = JSON.parse(raw)
    if (
      parsed &&
      typeof parsed === 'object' &&
      typeof parsed.pid === 'number' &&
      typeof parsed.startedAt === 'number'
    ) {
      return parsed as SupervisorState
    }
    return null
  } catch {
    return null
  }
}

/** Persist the supervisor record. Best-effort — never throws. */
export async function writeSupervisorState(
  state: SupervisorState,
): Promise<void> {
  try {
    await mkdir(daemonDir(), { recursive: true })
    await writeFile(supervisorStatePath(), JSON.stringify(state, null, 2), 'utf8')
  } catch (e) {
    logForDebugging(`[daemon] could not write supervisor state: ${e}`)
  }
}

/** Does supervisor.json still name OUR pid? Every teardown unlink checks
 *  this first: once a successor (or a client clearing a dead daemon) has
 *  taken the plane over, the socket/key/record on disk belong to THEM — a
 *  predecessor deleting those files on its way out would cut a live,
 *  serving daemon's phone line. */
export function ownsControlPlaneSync(): boolean {
  try {
    const raw = JSON.parse(readFileSync(supervisorStatePath(), 'utf8')) as { pid?: number }
    return raw?.pid === process.pid
  } catch {
    return false
  }
}

/** Key half of the self-heal: write the SAME key back to disk (0600). */
export async function reassertControlKey(key: string): Promise<void> {
  try {
    await mkdir(daemonDir(), { recursive: true })
    await writeFile(controlKeyPath(), key, { encoding: 'utf8', mode: 0o600 })
    await chmod(controlKeyPath(), 0o600).catch(() => {})
  } catch (e) {
    logForDebugging(`[daemon] control-key reassert failed: ${e}`)
  }
}

/** Delete the supervisor record on a clean shutdown. Best-effort, and
 *  ownership-checked — a successor's record is never touched. */
export async function clearSupervisorState(): Promise<void> {
  if (!ownsControlPlaneSync()) return
  await unlink(supervisorStatePath()).catch(() => {})
}

/**
 * Sweep the leftovers of a supervisor CONFIRMED dead: its record, its lock,
 * and its key (which protects nothing once the daemon is absent — every new
 * supervisor mints its own), leaving a clean floor for the next one. Only
 * call this after a control-socket ping proved nothing actually SERVES this
 * config home: pid-based liveness can read 'live' off a recycled pid or a
 * wedged daemon, and sweeping under a serving daemon orphans it.
 * Best-effort; never throws.
 */
export async function clearDeadSupervisorRecords(): Promise<void> {
  await unlink(supervisorStatePath()).catch(() => {})
  await unlink(join(daemonDir(), 'supervisor.lock')).catch(() => {})
  await unlink(controlKeyPath()).catch(() => {})
}

/** Delete this supervisor's control key on a clean shutdown (best-effort,
 *  ownership-checked so a successor's fresh key survives). Leaving a dead
 *  key behind helps nobody: clients fail at connect long before auth, and
 *  every new supervisor mints a new secret anyway. */
export async function clearControlKey(): Promise<void> {
  if (!ownsControlPlaneSync()) return
  await unlink(controlKeyPath()).catch(() => {})
}

/**
 * Synchronous last-resort teardown for `process.on('exit')`, where no async
 * work can run and the graceful path's unlinks would never land. Removes
 * the record/lock/key trio (still behind the ownership check — a
 * predecessor must not sweep files a successor just claimed) and writes one
 * supervisor exit row to the spawn ledger, turning the death into a lookup
 * instead of an investigation. On win32 a TerminateProcess produces no exit
 * event at all; the boot-time record reconcile covers that hole. Never
 * throws.
 */
export function supervisorExitTeardownSync(reason: string, exitCode?: number): void {
  // A record that survives the sweep is a lie waiting for the next boot —
  // on win32 an unlink can fail EBUSY/EPERM under a scanner's open handle,
  // and the old silent swallow left "record left behind" with no trace
  // (TASK-017 F-3's banked shape). Name every kept file in the ledger row.
  const keptFiles: string[] = []
  if (ownsControlPlaneSync()) {
    for (const p of [supervisorStatePath(), join(daemonDir(), 'supervisor.lock'), controlKeyPath()]) {
      try {
        unlinkSync(p)
      } catch (e) {
        // Absent is fine; anything else means the file OUTLIVES this death.
        if ((e as NodeJS.ErrnoException).code !== 'ENOENT') {
          keptFiles.push(`${p.split(/[\\/]/).pop() ?? p}:${(e as NodeJS.ErrnoException).code ?? 'EUNKNOWN'}`)
        }
      }
    }
  }
  recordSpawnExit({
    kind: 'supervisor',
    event: 'exit',
    id: 'supervisor',
    pid: process.pid,
    reason: keptFiles.length > 0 ? `${reason} (sweep-failed: ${keptFiles.join(', ')})` : reason,
  })
  // THE DEATH NAMES ITSELF (TASK-017 F-3: the box's daemon died silently at
  // +100s, exit 1, nothing on stderr — every deliberate daemon exit road
  // prints, so a wordless death is by definition an exit that BYPASSED them;
  // this hook is the last place that can say so). One stderr line, sync,
  // best-effort: the exit code, the reason, and the sweep verdict — enough
  // to discriminate a voluntary process.exit (this line appears; a
  // --trace-exit run names the site) from an abrupt kill (no line at all).
  if (reason === 'exit-before-teardown') {
    try {
      process.stderr.write(
        `[daemon] exit (code ${exitCode ?? process.exitCode ?? '?'}) WITHOUT a shutdown road — no signal, no shutdown RPC, no crash handler spoke; records ${keptFiles.length > 0 ? `KEPT (${keptFiles.join(', ')})` : 'swept'}. Re-run under node --trace-exit to name the exit site.\n`,
      )
    } catch {
      /* stderr gone at exit — the ledger row above is the record */
    }
  }
}

// ---------------------------------------------------------------------------
// Control key. A random secret written 0600 when the supervisor boots. The
// keyed ops must present it; daemonControlRpc reads the same file back. Being
// able to read that file proves same-uid access to the config home — that is
// the entire trust model of the keyed tier.
// ---------------------------------------------------------------------------

/**
 * Generate this supervisor's control key, write it to disk at 0600, and
 * return it. Whatever key existed before is overwritten: a new supervisor
 * thereby invalidates old clients, and they recover on their own because
 * they re-read the file on each RPC.
 */
export async function mintControlKey(): Promise<string> {
  const key = randomBytes(32).toString('hex')
  await mkdir(daemonDir(), { recursive: true })
  await writeFile(controlKeyPath(), key, { mode: 0o600 })
  // If the file pre-existed with looser permissions, tighten them now.
  await chmod(controlKeyPath(), 0o600).catch(() => {})
  return key
}

/** Load the persisted control key; null when there is none. */
export async function readControlKey(): Promise<string | null> {
  try {
    return (await readFile(controlKeyPath(), 'utf8')).trim() || null
  } catch {
    return null
  }
}

// FN-020 row 10: the control key is read from disk ONCE per process and
// kept in memory — every auth-stamped op (every Enter's sessionDispatch
// among them) re-read the key file. The daemon rotates the key only when a
// new daemon writes its own, and a stale key comes back EAUTH: that refusal
// clears the memo, the key is re-read, and the op is re-sent once when the
// key on disk actually moved (the auth gate runs before any op, so the
// refused send never executed). A missing key is never memoized.
let controlKeyMemo: string | null = null
/** The clear the daemon's key rotation reaches (an EAUTH reply). */
export function clearControlKeyMemo(): void {
  controlKeyMemo = null
}
async function controlKeyForStamp(): Promise<string | null> {
  if (controlKeyMemo !== null) {
    controlSocketCensus.keyMemoHits++
    return controlKeyMemo
  }
  controlSocketCensus.keyReads++
  const key = await readControlKey()
  if (key !== null) controlKeyMemo = key
  return key
}
// The last moment a control RPC found no daemon (ENOCONN): the switchboard's
// usable-daemon memo (services/switchboard/ensureDaemon.ts) stands only while
// its verdict is newer than this stamp.
let lastUnreachableAt = 0
export function daemonLastUnreachableAt(): number {
  return lastUnreachableAt
}
/** PROOF CENSUS (operation-shaped): key-file reads vs memo hits, and
 *  EAUTH re-sends — read by scripts/daemon/prove-send-hops.ts. */
export const controlSocketCensus = { keyReads: 0, keyMemoHits: 0, eauthRetries: 0 }

/**
 * Key comparison without an early-out: absent presented key, absent server
 * key, and any length or content difference all fail. Folding the XOR across
 * the whole string avoids a naive first-mismatch timing signal — extra
 * caution more than necessity, given the key is 256 random bits of hex.
 */
export function verifyControlAuth(
  presented: string | undefined,
  serverKey: string | null,
): boolean {
  if (!presented || !serverKey) return false
  if (presented.length !== serverKey.length) return false
  let diff = 0
  for (let i = 0; i < serverKey.length; i++) {
    diff |= presented.charCodeAt(i) ^ serverKey.charCodeAt(i)
  }
  return diff === 0
}

// ---------------------------------------------------------------------------
// The CLI-side RPC client.
// ---------------------------------------------------------------------------

/** Ops the server puts behind the key. The client must stamp `proto` plus the
 *  on-disk key onto each of them — leave an op out of this set and it goes
 *  over the wire keyless, coming back EAUTH. Keep it matched to the server's
 *  op router. The keyless ops (ping/nudge/shutdown/leases) get only a
 *  defaulted proto. */
const AUTH_STAMPED_OPS: ReadonlySet<string> = new Set([
  'list',
  'has',
  'status',
  'dispatch',
  'reply',
  'kill',
  'reconfigure',
  'envelope',
  'crewSpawn',
  'sessionAdmit',
  'sessionDispatch',
  'sessionList',
  'sessionControl',
  'sessionRelease',
  'sessionRewind',
  // The retired concourse* spellings of the five session ops stay stamped:
  // an untyped straggler caller still sends one, and the server's alias
  // table routes it — keyless it would bounce EAUTH instead. They leave
  // with the alias table (proto 4).
  'concourseAdmit',
  'concourseDispatch',
  'concourseList',
  'concourseControl',
  'concourseRelease',
  'concourseWithdraw',
  'concourseWarm',
  'restart-when-idle',
])

// ---------------------------------------------------------------------------
// THE SPELLING CHOICE (the two-phase wire rename, phase 2) — the ONE place
// the client picks a session-op spelling. Callers always write the
// session-family names; this seam re-spells the frame for the daemon the
// negotiated handshake actually found, so a new client keeps working against
// a not-yet-restarted proto≤2 daemon until the heal retires it. Applied per
// ATTEMPT: the EPROTO dialect retry in daemonControlRpc re-derives the
// spelling at the lower proto, never re-sending a name the old router lacks.
// ---------------------------------------------------------------------------

/** New spelling → the pre-proto-3 spelling an old daemon routes. */
const SESSION_OP_DOWNGRADES: Record<string, string> = {
  sessionAdmit: 'concourseAdmit',
  sessionDispatch: 'concourseDispatch',
  sessionList: 'concourseList',
  sessionRelease: 'concourseRelease',
  sessionControl: 'concourseControl',
}

/**
 * Re-spell one outbound frame for the proto it is stamped with. Exported for
 * the rename-migration prover; production callers ride it inside
 * {@link daemonControlRpc} and never call it themselves.
 */
export function sessionOpWireFrame<T extends { op: string; proto?: number }>(outbound: T): T {
  const proto = outbound.proto ?? MERCURY_DAEMON_PROTO
  const old = proto < 3 ? SESSION_OP_DOWNGRADES[outbound.op] : undefined
  if (old === undefined) return outbound
  // The wire seam speaks the old dialect on purpose; the reply comes back
  // through normalizeSessionOpReply, so callers only ever see the new names.
  const frame = { ...outbound, op: old } as T & { workerId?: string; runnerId?: string }
  // R2 rides the same dialect: a pre-proto-3 release door reads `workerId`.
  if (old === 'concourseRelease' && typeof frame.runnerId === 'string') {
    frame.workerId = frame.runnerId
    delete frame.runnerId
  }
  return frame
}

/** Fold a reply's echoed old spelling — op name and the R2 field — back
 *  onto the canonical names (an old daemon's admit/dispatch replies carry
 *  only `workerId`). */
export function normalizeSessionOpReply(reply: DaemonReply): DaemonReply {
  if (!('op' in reply) || typeof reply.op !== 'string') return reply
  let out: DaemonReply & { op: string } = reply
  for (const [nu, old] of Object.entries(SESSION_OP_DOWNGRADES)) {
    if (out.op === old) out = { ...out, op: nu } as DaemonReply & { op: string }
  }
  const fielded = out as DaemonReply & { workerId?: string; runnerId?: string }
  if (typeof fielded.workerId === 'string' && fielded.runnerId === undefined) {
    return { ...fielded, runnerId: fielded.workerId } as DaemonReply
  }
  return out
}

// ---------------------------------------------------------------------------
// The negotiated protocol — the daemon's dialect, remembered per process.
// ---------------------------------------------------------------------------

/** What the last handshake (or the last EPROTO refusal) learned about the
 *  daemon on the other end: its protocol version and semver. The RPC client
 *  stamps min(ours, theirs) on every op, so an OLDER daemon keeps serving
 *  the verbs it knows instead of refusing everything with EPROTO, and a
 *  newer one accepts our proto within its floor. Null until a daemon has
 *  answered — then ours is stamped, as before the handshake existed. */
let negotiated: { proto: number; version: string | null } | null = null

/** Record the daemon's protocol version (the handshake and the EPROTO retry
 *  below both call this). */
export function noteDaemonProto(proto: number, version?: string | null): void {
  if (!Number.isInteger(proto) || proto < MIN_PROTO) return
  negotiated = { proto, version: version ?? negotiated?.version ?? null }
}

/** The remembered daemon dialect; null before any daemon answered. */
export function negotiatedDaemonProto(): { proto: number; version: string | null } | null {
  return negotiated === null ? null : { ...negotiated }
}

/** Provers: forget the dialect between scenarios. */
export function forgetDaemonProtoForTesting(): void {
  negotiated = null
}

/** The proto to stamp: ours, lowered to the daemon's when it is older. */
function protoToStamp(): number {
  if (negotiated === null) return MERCURY_DAEMON_PROTO
  return Math.max(MIN_PROTO, Math.min(MERCURY_DAEMON_PROTO, negotiated.proto))
}

/**
 * One round-trip on the control socket: connect to {@link controlSockPath},
 * send one newline-framed request, read one newline-framed reply, resolve
 * it. Transport trouble of any kind — no listener, refused, deadline,
 * unparseable reply — resolves as a synthetic `{ ok:false, code:'ENOCONN' }`
 * (`ETIMEOUT` when the deadline hit); the function NEVER throws. Its
 * synthetic `error` strings are deliberate operator prose (`daemon
 * unreachable (<errno>)` and similar), never a stringified exception: these
 * strings surface on painted receipts, while the raw error — which embeds
 * the socket path — goes only to the debug log.
 *
 * Keyed ops get `proto` + the disk-read control key stamped on
 * automatically, so callers hand over just the op body; keyless ops skip
 * the key. The proto stamped is the NEGOTIATED one (the daemon's dialect
 * when it is older than this build); an EPROTO refusal that names a lower
 * server proto is answered ONCE more in that dialect — the version gate
 * runs before any op, so the retry is the op's first execution. Pass
 * `protoRetry: false` to see the refusal itself (the handshake does).
 */
export async function daemonControlRpc(
  req: DaemonRequest,
  opts: { timeoutMs?: number; protoRetry?: boolean } = {},
): Promise<DaemonReply> {
  const timeoutMs = opts.timeoutMs ?? 2000
  const outbound: DaemonRequest & { proto?: number; auth?: string } = { ...req }
  const stamped = AUTH_STAMPED_OPS.has(req.op)
  if (stamped) {
    outbound.proto = protoToStamp()
    const key = await controlKeyForStamp()
    if (key) outbound.auth = key
  } else if (outbound.proto === undefined) {
    outbound.proto = protoToStamp()
  }

  let reply = await rpcOnce(sessionOpWireFrame(outbound), timeoutMs)
  if (!reply.ok && reply.code === 'ENOCONN') lastUnreachableAt = Date.now()
  if (stamped && !reply.ok && reply.code === 'EAUTH') {
    // The daemon rotated its key (a restart): re-read, and re-send once
    // when the key on disk actually moved.
    const stale = outbound.auth
    clearControlKeyMemo()
    const fresh = await controlKeyForStamp()
    if (fresh !== null && fresh !== stale) {
      controlSocketCensus.eauthRetries++
      outbound.auth = fresh
      reply = await rpcOnce(sessionOpWireFrame(outbound), timeoutMs)
      if (!reply.ok && reply.code === 'ENOCONN') lastUnreachableAt = Date.now()
    }
  }
  if (
    opts.protoRetry !== false &&
    !reply.ok &&
    reply.code === 'EPROTO' &&
    typeof reply.serverProto === 'number' &&
    Number.isInteger(reply.serverProto) &&
    reply.serverProto >= MIN_PROTO &&
    reply.serverProto < (outbound.proto ?? MERCURY_DAEMON_PROTO)
  ) {
    noteDaemonProto(reply.serverProto, reply.serverVersion ?? null)
    logForDebugging(
      `[daemon] ${req.op}: daemon speaks proto ${reply.serverProto} (this build ${MERCURY_DAEMON_PROTO}) — re-sent in its dialect`,
    )
    // The retry frame is re-spelled at the LOWER proto — the whole point of
    // deriving the spelling per attempt.
    return normalizeSessionOpReply(await rpcOnce(sessionOpWireFrame({ ...outbound, proto: reply.serverProto }), timeoutMs))
  }
  return normalizeSessionOpReply(reply)
}

/** One connect → one frame → one reply; the transport contract of
 *  {@link daemonControlRpc} (never throws, synthesizes ENOCONN/ETIMEOUT). */
function rpcOnce(outbound: DaemonRequest & { proto?: number; auth?: string }, timeoutMs: number): Promise<DaemonReply> {
  return new Promise<DaemonReply>(resolve => {
    let settled = false
    const finish = (reply: DaemonReply) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      try {
        sock.destroy()
      } catch {
        /* ignore */
      }
      resolve(reply)
    }

    const sock = net.connect(controlSockPath())
    const collected: Buffer[] = []

    const timer = setTimeout(() => {
      finish({ ok: false, code: 'ETIMEOUT', error: `daemon did not answer within ${timeoutMs}ms (ETIMEOUT)` })
    }, timeoutMs)
    timer.unref?.()

    sock.on('connect', () => {
      sock.write(encodeFrame(outbound))
    })
    sock.on('data', (chunk: Buffer) => {
      collected.push(chunk)
      const joined = Buffer.concat(collected)
      const nl = joined.indexOf(10)
      if (nl < 0) return
      const line = joined.subarray(0, nl).toString('utf8')
      try {
        finish(JSON.parse(line) as DaemonReply)
      } catch {
        finish({ ok: false, code: 'EUNKNOWN', error: 'malformed daemon reply' })
      }
    })
    sock.on('error', err => {
      // Errno stays (diagnostic); path goes (see the doc comment). The whole
      // error still reaches the debug channel.
      logForDebugging(`[daemon] control RPC transport error: ${err}`)
      finish({
        ok: false,
        code: 'ENOCONN',
        error: `daemon unreachable (${(err as NodeJS.ErrnoException).code ?? 'ENOCONN'})`,
      })
    })
    sock.on('close', () => {
      finish({ ok: false, code: 'ENOCONN', error: 'daemon closed without a reply (ENOCONN)' })
    })
  })
}

// ---------------------------------------------------------------------------
// Supervisor lock — one daemon per daemonDir(), never more.
// ---------------------------------------------------------------------------

/**
 * Owner key for the supervisor-level lock. Separate from the cron
 * scheduler's lock (a daemon holds both): this one exists so two daemons
 * aimed at one config home cannot both bind its control socket.
 */
export function mintSupervisorIdentity(): string {
  return `hermes-supervisor-${randomUUID()}`
}

/** Location of the per-config-home supervisor lock. */
function supervisorLockPath(): string {
  return join(daemonDir(), 'supervisor.lock')
}

/** A held supervisor lock; release() deletes it (if still ours). */
export interface SupervisorLock {
  release: () => Promise<void>
}

/**
 * Take the per-config-home supervisor lock. A handle comes back on success;
 * `null` means a LIVE daemon already holds this home, and the caller MUST
 * bail out cleanly — pressing on would unlink the live socket and overwrite
 * control.key, orphaning the serving daemon and breaking every CLI with
 * EAUTH.
 *
 * Built on the substrate's single pid-liveness mutex: O_EXCL atomic create,
 * one reclaim of a stale holder, refuse on anything unexpected. The
 * 'assume-alive' polarity means an ambiguous liveness probe refuses instead
 * of gambling on a clobber, and the process-start token defeats pid reuse.
 * The lock record carries the legacy `id`/`startedAt` fields too, so an
 * older build still running elsewhere honors locks this one writes.
 */
export async function acquireSupervisorLock(): Promise<SupervisorLock | null> {
  await mkdir(daemonDir(), { recursive: true })
  const lockPath = supervisorLockPath()
  const owner = mintSupervisorIdentity()
  const res = await acquirePidLock(lockPath, owner, {
    liveness: 'assume-alive',
    extra: { id: owner, startedAt: Date.now() }, // legacy aliases for older-build readers
  })
  if (!res.held) {
    if (!res.by) logForDebugging('[daemon] supervisor lock unavailable')
    return null // this config home already has a live daemon — walk away
  }
  return {
    release: async () => {
      // releasePidLock deletes only OUR owner record — losing a reclaim race
      // can never turn release into deleting the successor's lock.
      noteLockRelease(`supervisor lock ${lockPath}`, await releasePidLock(lockPath, owner))
    },
  }
}

/** Version string of this build (from the MACRO the bundler injects). */
export function currentVersion(): string {
  try {
    return typeof MACRO !== 'undefined' && typeof MACRO.VERSION === 'string'
      ? MACRO.VERSION
      : 'unknown'
  } catch {
    return 'unknown'
  }
}
