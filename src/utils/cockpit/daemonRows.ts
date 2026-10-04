import type { MercuryDaemonStatus } from '../../daemon/status.js'
import { getMaxTurnMs } from '../../daemon/longLivedRespawn.js'
import { flagEnv } from '../../substrate/flagRegistry.js'
import { thisMercuryCommand } from '../../services/privateChannel/installPath.js'

export type DaemonBadge = 'off' | 'live' | 'unavailable'

export interface DaemonWorkerRow {
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

export interface DaemonRows {
  badge: DaemonBadge
  badgeLabel: string
  daemonLine: string | null
  dir: string | null
  degraded: string | null
  orphanWarning: string | null
  workers: DaemonWorkerRow[]
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

export function deriveDaemonRows(status: MercuryDaemonStatus | null): DaemonRows {
  if (status === null || status.daemon === null) {
    return {
      badge: 'off',
      badgeLabel: 'no daemon running',
      daemonLine: null,
      dir: null,
      degraded: null,
      orphanWarning: null,
      workers: [],
      breaker: null,
      breakerOpen: false,
      leases: null,
      fireLine: null,
      recentLine: null,
      empty: `run \`${thisMercuryCommand()} daemon\` to start one`,
      version: null,
    }
  }

  const s = status.daemon
  const reachable = status.controlReachable
  const stallMs = Math.round(getMaxTurnMs(flagEnv('MERCURY_WORKER_MAX_TURN_MS')) * 0.5)
  const workers: DaemonWorkerRow[] = (status.workers ?? []).map(w => {
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
    badgeLabel: reachable ? 'daemon live' : 'record present · socket dead',
    daemonLine: `pid ${s.pid} · v${s.version} · up ${s.uptimeSec}s`,
    dir: s.dir,
    degraded: status.degraded
      ? (status.degradedReason ?? 'a long-lived worker exhausted its respawn budget')
      : null,
    orphanWarning: reachable
      ? null
      : `daemon record present but control socket unreachable — run \`${thisMercuryCommand()} daemon stop\` to clear it`,
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
