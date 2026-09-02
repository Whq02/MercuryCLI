import type { MercuryDaemonStatus } from '../../daemon/status.js'
import { getMaxTurnMs } from '../../daemon/longLivedSupervisor.js'
import { flagEnv } from '../../substrate/flagRegistry.js'

export type SupervisorBadge = 'off' | 'live' | 'unavailable'

export interface SupervisorWorkerRow {
  short: string
  state: string
  model: string
  effort: string
  ctx: string
  respawns: number
  busy: boolean
  elapsed: string
  stalled: boolean
  outcome?: string
}

export interface SupervisorView {
  badge: SupervisorBadge
  badgeLabel: string
  supervisorLine: string | null
  dir: string | null
  degraded: string | null
  orphanWarning: string | null
  workers: SupervisorWorkerRow[]
  breaker: string | null
  breakerOpen: boolean
  leases: number | null
  fireLine: string | null
  recentLine: string | null
  empty: string | null
  version: string | null
}


function fmtDur(ms: number): string {
  const s = Math.floor(ms / 1000)
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m`
  return `${Math.floor(m / 60)}h${m % 60}m`
}

const OUTCOME_ORDER = [
  'useful',
  'no_op',
  'failed',
  'suppressed_breaker',
  'skipped_inflight',
  'loop_stopped',
]

export function deriveSupervisorRows(status: MercuryDaemonStatus | null): SupervisorView {
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
    version: status.handshake !== null && status.handshake.state !== 'matched' ? status.versionLine : null,
  }
}
