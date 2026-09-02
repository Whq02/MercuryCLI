// utils/cockpit/daemonSupervisorRows — the React-free view-model for the /daemon
// control-plane cockpit (DaemonSupervisorView renders it).
//
// Lives beside daemonSnapshot.ts (the cheap sync badge probe); this turns the
// richer async getMercuryDaemonStatus() snapshot into the exact fields the cockpit
// draws. Kept PURE — status in, plain data out, no React/ink — so the cockpit's
// honesty (never a fabricated row, the loud DEGRADED line, the honest-empty card)
// is provable under `bun run` without mounting Ink. The text phrasing mirrors
// formatMercuryDaemonStatus so the TUI and the `mercury daemon status` text agree.
//
// Imports a TYPE (erased at build) plus getMaxTurnMs from longLivedSupervisor.ts —
// itself import-free / runtime-dep-free — so this stays loadable under `bun run`.
import type { MercuryDaemonStatus } from '../../daemon/status.js'
import { getMaxTurnMs } from '../../daemon/longLivedSupervisor.js'
import { flagEnv } from '../../substrate/flagRegistry.js'

export type SupervisorBadge = 'off' | 'live' | 'unavailable'

export interface SupervisorWorkerRow {
  short: string
  state: string
  model: string
  effort: string
  ctx: string // "42%" or "–" when the worker hasn't emitted a usage frame yet
  respawns: number
  busy: boolean
  /** Formatted current-turn elapsed ("8m" / "45s"); "" when idle / no turn clock. */
  elapsed: string
  /** busy AND on the current turn longer than the stall threshold — the heads-up
   *  BEFORE the maxTurnMs watchdog kills it. */
  stalled: boolean
  /** The wire's settled outcome ('degraded' · 'crashed' · 'killed' · a one-shot
   *  run's fire outcome); absent while the seat is live. A settled seat must
   *  never wear the idle costume — the roster keeps it until reap, so this
   *  row is the operator's only tell that a seat died. */
  outcome?: string
}

export interface SupervisorView {
  badge: SupervisorBadge
  badgeLabel: string
  supervisorLine: string | null // "pid X · vY · up Zs"
  dir: string | null
  degraded: string | null // the loud escalation reason, else null
  orphanWarning: string | null // record present but socket dead
  workers: SupervisorWorkerRow[]
  breaker: string | null
  breakerOpen: boolean
  leases: number | null
  fireLine: string | null // "fires N · useful-rate X% · last Y"
  recentLine: string | null // recent-window trend, only when total > window
  empty: string | null // honest-empty hint when there is no supervisor
  version: string | null // the version gap + heal status; null when matched
}

// A turn busy this long is flagged on the cockpit — an early heads-up well before
// the daemon's maxTurnMs watchdog (~20m default, env MERCURY_IMPLEMENTER_MAX_TURN_MS)
// kills it. Pure display threshold, derived at HALF the live kill cap so it always
// lands at a fraction of the real watchdog (see stallMs in deriveSupervisorRows).

// ms → a compact human duration for the cockpit ("45s" / "8m" / "1h2m").
function fmtDur(ms: number): string {
  const s = Math.floor(ms / 1000)
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m`
  return `${Math.floor(m / 60)}h${m % 60}m`
}

// The fixed display order for fire outcomes (mirrors formatMercuryDaemonStatus).
const OUTCOME_ORDER = [
  'useful',
  'no_op',
  'failed',
  'suppressed_breaker',
  'skipped_inflight',
  'loop_stopped',
]

/**
 * Derive the cockpit view-model from a {@link MercuryDaemonStatus} (or null while
 * still probing). NEVER fabricates: no supervisor ⇒ an honest-empty card; control
 * unreachable ⇒ the orphan warning + the `unavailable` badge (no live rows).
 */
export function deriveSupervisorRows(status: MercuryDaemonStatus | null): SupervisorView {
  // null (still probing) OR resolved-with-no-supervisor ⇒ the honest-empty cockpit.
  if (status === null || status.supervisor === null) {
    return {
      badge: 'off',
      badgeLabel: 'no daemon running',
      supervisorLine: null,
      dir: null,
      degraded: null,
      orphanWarning: null,
      workers: [],
      breaker: null,
      breakerOpen: false,
      leases: null,
      fireLine: null,
      recentLine: null,
      empty: 'run `mercury daemon` to start the supervisor',
      version: null,
    }
  }

  const s = status.supervisor
  const reachable = status.controlReachable
  // Half the live (env-tunable) maxTurnMs kill cap — the amber heads-up before the
  // daemon's watchdog kills the turn. Default 20m ⇒ 10m (matches the prior fixed value).
  const stallMs = Math.round(getMaxTurnMs(flagEnv('MERCURY_IMPLEMENTER_MAX_TURN_MS')) * 0.5)
  const workers: SupervisorWorkerRow[] = (status.workers ?? []).map(w => {
    const busy = w.busy === true
    const turnMs = w.turnElapsedMs
    return {
      short: w.short,
      state: w.state,
      model: w.model ?? '?',
      effort: w.effort ?? '?',
      ctx: w.contextPct != null ? `${w.contextPct}%` : '–',
      respawns: w.respawns ?? 0,
      busy,
      elapsed: busy && turnMs != null && turnMs > 0 ? fmtDur(turnMs) : '',
      stalled: busy && turnMs != null && turnMs > stallMs,
      ...(w.outcome !== undefined ? { outcome: w.outcome } : {}),
    }
  })

  let fireLine: string | null = null
  let recentLine: string | null = null
  const f = status.fireOutcomes
  if (f && f.total > 0) {
    const rate = f.usefulRate !== null ? ` · useful-rate ${Math.round(f.usefulRate * 100)}%` : ''
    fireLine = `fires ${f.total}${rate}${f.last ? ` · last ${f.last.outcome}` : ''}`
    // recent-trend only when the window is a real subset (an away-run sees a tail).
    if (f.total > f.recentWindow && f.recentWindow > 0) {
      const parts = OUTCOME_ORDER.filter(k => f.recentByOutcome[k]).map(
        k => `${k} ${f.recentByOutcome[k]}`,
      )
      recentLine = `recent ${f.recentWindow}: ${parts.join(' / ')}`
    }
  }

  return {
    badge: reachable ? 'live' : 'unavailable',
    badgeLabel: reachable ? 'supervisor live' : 'record present · socket dead',
    supervisorLine: `pid ${s.pid} · v${s.version} · up ${s.uptimeSec}s`,
    dir: s.dir,
    degraded: status.degraded
      ? (status.degradedReason ?? 'a long-lived worker exhausted its respawn budget')
      : null,
    orphanWarning: reachable
      ? null
      : 'supervisor record present but control socket unreachable — run `mercury daemon stop --any` to clear it',
    workers,
    breaker:
      status.breakerOpen === null ? null : status.breakerOpen ? 'OPEN · dispatch suppressed' : 'closed',
    breakerOpen: status.breakerOpen === true,
    leases: status.leaseCount,
    fireLine,
    recentLine,
    empty: null,
    // A matched daemon has nothing to say; any gap paints the sentence the
    // status text and the certificate carry (status.ts formats it).
    version: status.handshake !== null && status.handshake.state !== 'matched' ? status.versionLine : null,
  }
}
