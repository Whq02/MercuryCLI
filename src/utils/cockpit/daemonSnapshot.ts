// daemonSnapshot — the `mercury daemon` scheduler/supervisor. It runs as a
// SEPARATE process, but it persists a supervisor record (supervisor.json) at
// startup and clears it on clean shutdown, so a normal REPL session CAN tell
// whether a supervisor is live: read the record synchronously (this snapshot is
// consumed on the per-render Deck/Home/doctor path) and probe the recorded pid.
//   live        — record present, pid alive, AND (rpc-verified or still verifying)
//   unavailable — record present but the pid is dead (orphaned record), OR the
//                 pid is alive while the control socket answers nothing (wedged)
//   off         — no record: the opt-in start path (byte-identical to before)
// The deeper control-socket RPC (getMercuryDaemonStatus) stays the job of the
// /substrate · /trace surfaces; this per-render snapshot stays sync so it never
// blocks a render — the RPC verdict arrives via the TTL cache below.
import { readFileSync } from 'node:fs'
import { daemonControlRpc, supervisorStatePath } from '../../daemon/controlSocket.js'
import { MERCURY_DAEMON_PROTO } from '../../daemon/protocol.js'
import { isSaturnSchedulingEnabled } from '../../tools/ScheduleCronTool/prompt.js'
import { type Snapshot } from './types.js'

/** The record's version fact against this build, for the per-render badge:
 *  '' when matched; a pre-handshake record (no proto) or another proto names
 *  the gap and the one door out. The handshake proper — and its heal — runs
 *  on the session door (daemon/handshake.ts); this only reads what the
 *  daemon wrote. */
function versionNoteFor(rec: { proto?: unknown }): string {
  if (typeof rec.proto !== 'number') return ' · pre-handshake build — /daemon restart when ready'
  if (rec.proto === MERCURY_DAEMON_PROTO) return ''
  return ` · protocol v${rec.proto} (this Mercury speaks v${MERCURY_DAEMON_PROTO}) — /daemon restart when ready`
}

/**
 * Signal-0 liveness probe — a local mirror of
 * genericProcessUtils.isProcessRunning, inlined to keep this sync snapshot's
 * import graph minimal (no execFile transitive deps). pid ≤ 1 and an EPERM/ESRCH
 * from process.kill both read as "not running" (conservative).
 */
function pidAlive(pid: number): boolean {
  if (pid <= 1) return false
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

/* HONESTY hardening: pid signal-0 is a WEAK proxy —
 * a wedged-but-alive supervisor (blocked event loop) or a recycled pid reads
 * 'live' while the control socket answers nothing. The authoritative probe is
 * the pre-auth `ping` RPC, but this snapshot must stay sync + cheap. Bridge:
 * a module-level TTL cache holding the last ping verdict; when stale, ONE
 * fire-and-forget background ping refreshes it for the NEXT render (renders
 * tick constantly, so the verified-upgrade / wedged-downgrade lands within a
 * second). daemonControlRpc is node:net-only — the minimal-import-graph note
 * above still holds. Never throws; a refused/absent socket is a fail verdict. */
const PING_TTL_MS = 15_000
let pingVerdict: { ok: boolean; at: number } | null = null
let pingInFlight = false
function kickPing(): void {
  if (pingInFlight) return
  pingInFlight = true
  void daemonControlRpc({ op: 'ping' }, { timeoutMs: 1500 })
    .then(r => {
      pingVerdict = { ok: r.ok === true, at: Date.now() }
    })
    .catch(() => {
      pingVerdict = { ok: false, at: Date.now() }
    })
    .finally(() => {
      pingInFlight = false
    })
}

export function daemonSnapshot(): Snapshot {
  try {
    let rec: { pid?: unknown; version?: unknown; startedAt?: unknown; proto?: unknown } | null = null
    try {
      const parsed = JSON.parse(readFileSync(supervisorStatePath(), 'utf8'))
      if (parsed && typeof parsed === 'object') rec = parsed
    } catch {
      rec = null
    }

    if (rec && typeof rec.pid === 'number') {
      if (pidAlive(rec.pid)) {
        const ver = typeof rec.version === 'string' ? rec.version : '?'
        const upSec =
          typeof rec.startedAt === 'number' && rec.startedAt > 0
            ? Math.max(0, Math.round((Date.now() - rec.startedAt) / 1000))
            : null
        const base =
          upSec != null
            ? `running · pid ${rec.pid} · v${ver} (up ${upSec}s)`
            : `running · pid ${rec.pid} · v${ver}`
        // Authoritative-probe fold: consume the cached ping verdict, refresh
        // it in the background when stale.
        const fresh = pingVerdict && Date.now() - pingVerdict.at <= PING_TTL_MS
        if (!fresh) kickPing()
        if (fresh && !pingVerdict!.ok) {
          // The pid is alive but the control socket answers nothing — a wedged
          // supervisor or a recycled pid. 'live' would be the exact weak-proxy
          // lie the audit flagged; report it as the fault it is.
          return {
            state: 'unavailable',
            reason: `pid ${rec.pid} alive but control socket unresponsive — wedged? (restart: \`mercury daemon\`)`,
            source: 'daemon',
          }
        }
        return {
          state: 'live',
          reason: `${fresh ? `${base} · rpc ✓` : `${base} · verifying rpc…`}${versionNoteFor(rec)}`,
          source: 'daemon',
        }
      }
      // Record present but the pid is dead — an orphaned supervisor record. Mirrors
      // the status.ts orphan warning; honest `unavailable`, not a fake `off`.
      return {
        state: 'unavailable',
        reason: `stale record · pid ${rec.pid} not running (run \`mercury daemon\` to restart)`,
        source: 'daemon',
      }
    }

    // No supervisor record — the opt-in start path (byte-identical to before).
    const cronReady = isSaturnSchedulingEnabled()
    return {
      state: 'off',
      reason: cronReady
        ? 'opt-in: run `mercury daemon` (cron substrate ready)'
        : 'opt-in: run `mercury daemon`',
      source: 'daemon',
    }
  } catch {
    return { state: 'off', reason: 'opt-in: run `mercury daemon`', source: 'daemon' }
  }
}
