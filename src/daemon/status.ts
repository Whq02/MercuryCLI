// Mercury daemon — status probe + text renderer.
//
// Loads the persisted supervisor record, then interrogates the control
// socket — a ping first, and only after a good ping the status + list ops —
// folding it all into one flat MercuryDaemonStatus. Feeds both the
// `mercury daemon status` text output and every UI surface that paints
// daemon health.
//
// It cannot throw: every probe carries its own .catch, and whatever fails
// merely leaves its fields degraded (null / empty) in the snapshot.

import {
  controlSockPath,
  daemonControlRpc,
  readSupervisorState,
} from './controlSocket.js'
/** The old fire trail's roll-up shape — the ledger died with its engine
 *  (SATURN's receipts are the fire record now); the field stays on the
 *  snapshot as ALWAYS NULL so every standing reader renders its absent
 *  arm without an edit. Nothing constructs this shape any more. */
export interface FireOutcomeSummary {
  total: number
  byOutcome: Record<string, number>
  usefulRate: number | null
  recentWindow: number
  recentByOutcome: Record<string, number>
  last: { outcome: string; atMs?: number } | null
}
import { daemonHandshakeEvidence, handshakeDaemon, type DaemonHandshakeVerdict } from './handshake.js'
import { MERCURY_DAEMON_PROTO, type WireRosterEntry, type WireStatus } from './protocol.js'

/** The flat snapshot handed to consumers; failed probes degrade their fields. */
export interface MercuryDaemonStatus {
  /** Supervisor digest; null when no record is on disk. */
  supervisor: { pid: number; version: string; uptimeSec: number; dir: string } | null
  /** Resolved control-socket path. */
  controlSock: string
  /** Whether the control-socket ping came back ok. */
  controlReachable: boolean
  /** The ping's error text when it failed; undefined while reachable. */
  controlError?: string
  /** Live workers per the roster `list`; null when control is down. */
  workersLive: number | null
  /** All rostered workers; null when control is down. */
  workersTotal: number | null
  /** Whether the breaker is OPEN (holding dispatches); null when control is down. */
  breakerOpen: boolean | null
  /** The supervisor's concurrency ceiling; null when control is down. */
  maxInflight: number | null
  /** Clients holding leases (foreground windows keeping the daemon warm). */
  leaseCount: number | null
  /** Protocol version the daemon answered with; null when control is down. */
  proto: number | null
  /** Whether long-lived supervision gave up on a worker (respawn budget
   *  spent); null when control is down. The signal that the worker stays
   *  down until someone steps in. */
  degraded: boolean | null
  /** Prose reason accompanying `degraded`; undefined otherwise. */
  degradedReason?: string
  /** Warm session runners alive right now (pre-booted, unclaimed, no
   *  record — the warm-runner pool); null when control is down or the
   *  daemon predates the pool. */
  warmRunners: number | null
  /** Aggregated fire-outcome ledger for this scope (null when disabled or empty). */
  fireOutcomes: FireOutcomeSummary | null
  /** THE VERSION FACT: the daemon's version against this build and the
   *  heal's status (daemon/handshake.ts); null when control is down. */
  handshake: DaemonHandshakeVerdict | null
  /** The handshake as one sentence (the certificate's grammar); null when
   *  control is down. */
  versionLine: string | null
  /** Roster rows straight off the control `list` reply — per-worker short,
   *  state, model/effort, fill %, respawn count, busy bit. Empty while
   *  control is down. A read-only echo of jobs already fetched: no extra
   *  RPC, no writes. */
  workers: WireRosterEntry[]
}

/**
 * Probe the daemon and build a {@link MercuryDaemonStatus}.
 *
 * Sequencing is the contract: supervisor record and ping first; the ledger
 * roll-up regardless of reachability (it is a plain disk read); then, only
 * behind a good ping, status + list in parallel under their own short
 * deadlines. Cannot throw.
 */
export async function getMercuryDaemonStatus(): Promise<MercuryDaemonStatus> {
  const supervisor = await readSupervisorState().catch(() => null)
  const ping = await daemonControlRpc({ op: 'ping' }, { timeoutMs: 1000 })

  const snapshot: MercuryDaemonStatus = {
    supervisor: supervisor
      ? {
          pid: supervisor.pid,
          version: supervisor.version,
          uptimeSec: Math.floor((Date.now() - supervisor.startedAt) / 1000),
          dir: supervisor.dir,
        }
      : null,
    controlSock: sockPathOrPlaceholder(),
    controlReachable: ping.ok,
    controlError: ping.ok ? undefined : ping.error,
    workersLive: null,
    workersTotal: null,
    breakerOpen: null,
    maxInflight: null,
    leaseCount: null,
    proto: null,
    degraded: null,
    warmRunners: null,
    fireOutcomes: null,
    handshake: null,
    versionLine: null,
    workers: [],
  }

  // (The old fire trail died with its engine; fireOutcomes stays null —
  // SATURN's per-session receipts are the fire record.)

  if (!ping.ok) return snapshot

  // The handshake BEFORE the keyed ops: it notes the daemon's dialect, so
  // status + list below reach an older daemon in its own proto instead of
  // bouncing off EPROTO — the probe stays honest across a version gap.
  snapshot.handshake = await handshakeDaemon({ timeoutMs: 1000 })
  snapshot.versionLine = daemonHandshakeEvidence(snapshot.handshake)

  // daemonControlRpc stamps proto + key onto keyed ops itself; the proto
  // here only satisfies the request type ahead of that overwrite.
  const [statusReply, listReply] = await Promise.all([
    daemonControlRpc({ op: 'status', proto: MERCURY_DAEMON_PROTO }, { timeoutMs: 1000 }),
    daemonControlRpc({ op: 'list', proto: MERCURY_DAEMON_PROTO }, { timeoutMs: 1000 }),
  ])

  // Whenever `list` answered, keep its rows — even if `status` did not fill
  // the aggregates. This reuses the reply in hand: no second RPC, nothing
  // written.
  if (listReply.ok && listReply.op === 'list') {
    snapshot.workers = listReply.jobs
  }

  if (statusReply.ok && statusReply.op === 'status') {
    const s: WireStatus = statusReply.status
    snapshot.workersLive = s.workersLive
    snapshot.workersTotal = s.workersTotal
    snapshot.breakerOpen = s.breakerOpen
    snapshot.maxInflight = s.maxInflight
    snapshot.leaseCount = s.leaseCount
    snapshot.proto = s.proto
    snapshot.degraded = s.degraded ?? false
    snapshot.degradedReason = s.degradedReason
    snapshot.warmRunners = s.warmRunners ?? null
  } else if (listReply.ok && listReply.op === 'list') {
    // `status` failed while `list` answered — count the rows instead.
    const jobs: WireRosterEntry[] = listReply.jobs
    snapshot.workersLive = jobs.filter(j => !j.outcome).length
    snapshot.workersTotal = jobs.length
  }

  return snapshot
}

/** The socket path, with a placeholder if even resolving it fails. */
function sockPathOrPlaceholder(): string {
  try {
    return controlSockPath()
  } catch {
    return '<unavailable>'
  }
}

/**
 * Render a {@link MercuryDaemonStatus} as the multi-line "mercury daemon:"
 * block printed by `mercury daemon status`. Pure formatting; operators and
 * scripts read these exact line shapes.
 */
export function formatMercuryDaemonStatus(status: MercuryDaemonStatus): string {
  const lines: string[] = ['', 'mercury daemon:']

  if (status.supervisor) {
    const s = status.supervisor
    // "running" is the socket's word, not the record's: a record whose
    // socket answers nothing is a claim, and the headline used to keep
    // ticking its uptime for a supervisor that died hard (TASK-014 w5-f01-01).
    lines.push(
      status.controlReachable
        ? `  supervisor:   running · pid ${s.pid} · v${s.version} · up ${s.uptimeSec}s`
        : `  supervisor:   record present, not answering · pid ${s.pid} · v${s.version} · recorded up ${s.uptimeSec}s`,
    )
    lines.push(`  dir:          ${s.dir}`)
  } else {
    lines.push('  supervisor:   not running')
  }

  // win32 has no unix socket here — the control plane is a named pipe, and
  // the row says so (TASK-014 w5-f03-03).
  lines.push(
    `  ${process.platform === 'win32' ? 'control pipe:' : 'control.sock:'} ${
      status.controlReachable
        ? `reachable (${status.controlSock})`
        : `unreachable (${status.controlError ?? 'unknown'}) at ${status.controlSock}`
    }`,
  )

  if (status.workersLive !== null) {
    lines.push(
      `  workers:      ${status.workersLive} live / ${status.workersTotal ?? '?'} rostered` +
        (status.maxInflight !== null ? ` (max ${status.maxInflight} in-flight)` : ''),
    )
  } else {
    lines.push('  workers:      unavailable (control unreachable)')
  }

  if (status.breakerOpen !== null) {
    lines.push(`  breaker:      ${status.breakerOpen ? 'OPEN (dispatch suppressed)' : 'closed'}`)
  }
  // The warm-runner pool's honest line: a pre-booted runner is a real
  // process on this machine, named here even though it is not a session
  // (no record, no board row — it becomes a session only when claimed).
  // The pool is WORKSPACE-BOUND (warmRunner.ts) and a claim from any other
  // folder is refused — so "here" is earned only when the operator's folder
  // IS the runner's workspace; anywhere else the line names the bound
  // folder instead of promising a start this folder will not get (FC-086).
  if (status.warmRunners !== null && status.warmRunners > 0) {
    const boundDir = status.supervisor?.dir
    const fold = (p: string): string =>
      process.platform === 'win32' ? p.replace(/\\/g, '/').toLowerCase() : p
    const isHere = boundDir !== undefined && fold(boundDir) === fold(process.cwd())
    const plural = status.warmRunners === 1 ? '' : 's'
    lines.push(
      isHere || boundDir === undefined
        ? `  warm:         ${status.warmRunners} warm runner${plural} (pre-booted, unclaimed — the next new session here starts instantly)`
        : `  warm:         ${status.warmRunners} warm runner${plural} (pre-booted, unclaimed — bound to ${boundDir}; a session born there starts instantly, this folder boots cold)`,
    )
  }
  // The loud line: some long-lived worker spent its respawn budget and will
  // not return on its own.
  if (status.degraded) {
    lines.push(`  supervisor:   ⚠️  DEGRADED — ${status.degradedReason ?? 'a long-lived worker exhausted its respawn budget'}`)
  }
  if (status.leaseCount !== null) {
    lines.push(`  leases:       ${status.leaseCount}`)
  }
  if (status.proto !== null) {
    lines.push(`  proto:        v${status.proto}`)
  }
  // The version row: the daemon against this build, and the heal's status
  // (matched · idle-restarted · waiting on N live · needs /daemon restart).
  if (status.versionLine !== null) {
    lines.push(`  version:      ${status.versionLine}`)
  }

  // Orphan case: there is a record, but its socket answers nothing.
  if (status.supervisor && !status.controlReachable) {
    lines.push(
      '  warning:      supervisor record present but control socket unreachable — ' +
        'the process may have crashed; run `mercury daemon stop --any` to clear it',
    )
  }

  return lines.join('\n')
}
