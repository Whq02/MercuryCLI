
import {
  controlSockPath,
  daemonControlRpc,
  readSupervisorState,
} from './controlSocket.js'
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
import { GLYPH } from '../components/mercury-ui/glyphs.js'

export interface MercuryDaemonStatus {
  supervisor: { pid: number; version: string; uptimeSec: number; dir: string } | null
  controlSock: string
  controlReachable: boolean
  controlError?: string
  workersLive: number | null
  workersTotal: number | null
  breakerOpen: boolean | null
  maxInflight: number | null
  leaseCount: number | null
  proto: number | null
  degraded: boolean | null
  degradedReason?: string
  warmRunners: number | null
  fireOutcomes: FireOutcomeSummary | null
  handshake: DaemonHandshakeVerdict | null
  versionLine: string | null
  workers: WireRosterEntry[]
}

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


  if (!ping.ok) return snapshot

  snapshot.handshake = await handshakeDaemon({ timeoutMs: 1000 })
  snapshot.versionLine = daemonHandshakeEvidence(snapshot.handshake)

  const [statusReply, listReply] = await Promise.all([
    daemonControlRpc({ op: 'status', proto: MERCURY_DAEMON_PROTO }, { timeoutMs: 1000 }),
    daemonControlRpc({ op: 'list', proto: MERCURY_DAEMON_PROTO }, { timeoutMs: 1000 }),
  ])

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
    const jobs: WireRosterEntry[] = listReply.jobs
    snapshot.workersLive = jobs.filter(j => !j.outcome).length
    snapshot.workersTotal = jobs.length
  }

  return snapshot
}

function sockPathOrPlaceholder(): string {
  try {
    return controlSockPath()
  } catch {
    return '<unavailable>'
  }
}

export function formatMercuryDaemonStatus(status: MercuryDaemonStatus): string {
  const lines: string[] = ['', 'mercury daemon:']

  if (status.supervisor) {
    const s = status.supervisor
    lines.push(
      status.controlReachable
        ? `  supervisor:   running · pid ${s.pid} · v${s.version} · up ${s.uptimeSec}s`
        : `  supervisor:   record present, not answering · pid ${s.pid} · v${s.version} · recorded up ${s.uptimeSec}s`,
    )
    lines.push(`  dir:          ${s.dir}`)
  } else {
    lines.push('  supervisor:   not running')
  }

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
  if (status.degraded) {
    lines.push(`  supervisor:   ${GLYPH.warn} DEGRADED — ${status.degradedReason ?? 'a long-lived worker exhausted its respawn budget'}`)
  }
  if (status.leaseCount !== null) {
    lines.push(`  leases:       ${status.leaseCount}`)
  }
  if (status.proto !== null) {
    lines.push(`  proto:        v${status.proto}`)
  }
  if (status.versionLine !== null) {
    lines.push(`  version:      ${status.versionLine}`)
  }

  if (status.supervisor && !status.controlReachable) {
    lines.push(
      '  warning:      supervisor record present but control socket unreachable — ' +
        'the process may have crashed; run `mercury daemon stop --any` to clear it',
    )
  }

  return lines.join('\n')
}
