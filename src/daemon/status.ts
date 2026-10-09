
import {
  controlSockPath,
  currentVersion,
  daemonControlRpc,
  readDaemonState,
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
import { forwardFrame, predecessorSockPath, predecessorSockPidOf } from './handover.js'
import { isProcessAlive } from './ownerWatch.js'
import { readdirSync } from 'node:fs'
import { dirname } from 'node:path'

export interface MercuryDaemonStatus {
  daemon: { pid: number; version: string; uptimeSec: number; dir: string } | null
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
  helpers?: HelperRow[]
}

export async function getMercuryDaemonStatus(): Promise<MercuryDaemonStatus> {
  const record = await readDaemonState().catch(() => null)
  const ping = await daemonControlRpc({ op: 'ping' }, { timeoutMs: 1000 })

  const snapshot: MercuryDaemonStatus = {
    daemon: record
      ? {
          pid: record.pid,
          version: record.version,
          uptimeSec: Math.floor((Date.now() - record.startedAt) / 1000),
          dir: record.dir,
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


  if (!ping.ok) {
    snapshot.helpers = await helperCensus(record !== null && isProcessAlive(record.pid) ? [{ pid: record.pid, live: null }] : [], [])
    return snapshot
  }

  snapshot.handshake = await handshakeDaemon({ timeoutMs: 1000 })
  snapshot.versionLine = daemonHandshakeEvidence(snapshot.handshake)
  const daemon = snapshot.handshake.daemon
  snapshot.helpers = await helperCensus(
    daemon?.pid ? [{ pid: daemon.pid, live: snapshot.handshake.state === 'starting' ? null : snapshot.handshake.live }] : [],
    daemon?.predecessorPids ?? [],
  )

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

export type HelperRow = { pid: number; live: number | null }

export function helperPidSocketsOnDisk(): number[] {
  if (process.platform === 'win32') return []
  const plane = controlSockPath()
  let names: string[]
  try {
    names = readdirSync(dirname(plane))
  } catch {
    return []
  }
  const pids: number[] = []
  for (const entry of names) {
    const pid = predecessorSockPidOf(entry, plane)
    if (pid !== null) pids.push(pid)
  }
  return pids
}

export async function helperPidsOfHome(): Promise<number[]> {
  const daemon = await readDaemonState().catch(() => null)
  const known: HelperRow[] = daemon !== null && isProcessAlive(daemon.pid) ? [{ pid: daemon.pid, live: null }] : []
  const plane = await daemonControlRpc({ op: 'hello', proto: MERCURY_DAEMON_PROTO, clientVersion: currentVersion(), clientBuildTree: null }, { timeoutMs: 1000, protoRetry: false })
  const planeFacts = plane.ok && plane.op === 'hello' ? plane : null
  if (planeFacts !== null && !known.some(helper => helper.pid === planeFacts.pid)) known.unshift({ pid: planeFacts.pid, live: planeFacts.ready ? planeFacts.live : null })
  const census = await helperCensus(known, planeFacts?.predecessorPids ?? [])
  return census.map(helper => helper.pid)
}

async function helperCensus(known: HelperRow[], predecessors: number[]): Promise<HelperRow[]> {
  const helpers = [...known]
  const seen = new Set(helpers.map(helper => helper.pid))
  const pending: Array<{ pid: number; vouched: boolean }> = [
    ...predecessors.map(pid => ({ pid, vouched: true })),
    ...helperPidSocketsOnDisk().filter(isProcessAlive).map(pid => ({ pid, vouched: false })),
  ]
  while (pending.length > 0) {
    const { pid, vouched } = pending.shift()!
    if (seen.has(pid)) continue
    seen.add(pid)
    const reply = await forwardFrame(predecessorSockPath(pid), JSON.stringify({ op: 'hello' }), 1000)
    if (reply.ok && reply.op === 'hello' && reply.pid === pid) {
      helpers.push({ pid, live: reply.ready ? reply.live : null })
      pending.push(...(reply.predecessorPids ?? (reply.predecessorPid ? [reply.predecessorPid] : [])).map(earlier => ({ pid: earlier, vouched: true })))
    } else if (vouched && isProcessAlive(pid)) {
      helpers.push({ pid, live: null })
    }
  }
  return helpers
}

function sockPathOrPlaceholder(): string {
  try {
    return controlSockPath()
  } catch {
    return '<unavailable>'
  }
}


export function workerRowWords(row: WireRosterEntry): string {
  const pid = row.pid !== undefined ? `pid ${row.pid}` : 'pid not yet recorded'
  const session = row.sessionId.length > 8 ? row.sessionId.slice(0, 8) : row.sessionId
  const model = row.model !== undefined ? ` · ${row.model}${row.effort !== undefined ? `@${row.effort}` : ''}` : ''
  return `${row.short}: ${pid} · session ${session} · ${row.state}${model}`
}

export function formatMercuryDaemonStatus(status: MercuryDaemonStatus): string {
  const lines: string[] = ['', 'mercury daemon:']

  if (status.daemon) {
    const s = status.daemon
    lines.push(
      status.controlReachable
        ? `  daemon:       running · pid ${s.pid} · v${s.version} · up ${s.uptimeSec}s`
        : `  daemon:       record present, not answering · pid ${s.pid} · v${s.version} · recorded up ${s.uptimeSec}s`,
    )
    lines.push(`  dir:          ${s.dir}`)
  } else {
    lines.push('  daemon:       not running')
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
    for (const row of status.workers) {
      if (row.outcome !== undefined) continue
      lines.push(`    ${workerRowWords(row)}`)
    }
  } else {
    lines.push('  workers:      unavailable (control unreachable)')
  }

  if (status.helpers !== undefined) {
    const live = status.helpers.some(helper => helper.live === null) ? 'unknown' : String(status.helpers.reduce((n, helper) => n + (helper.live ?? 0), 0))
    lines.push(`  helpers:      ${status.helpers.length} running / ${live} live workers`)
    for (const helper of status.helpers) lines.push(`    pid ${helper.pid}: ${helper.live ?? 'unknown'} live workers`)
  }

  if (status.breakerOpen !== null) {
    lines.push(`  breaker:      ${status.breakerOpen ? 'OPEN (dispatch suppressed)' : 'closed'}`)
  }
  if (status.warmRunners !== null && status.warmRunners > 0) {
    const boundDir = status.daemon?.dir
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
    lines.push(`  daemon:       ${GLYPH.warn} DEGRADED — ${status.degradedReason ?? 'a long-lived worker exhausted its respawn budget'}`)
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

  if (status.daemon && !status.controlReachable) {
    lines.push(
      '  warning:      daemon record present but control socket unreachable — ' +
        'the process may have crashed; run `mercury daemon stop` to clear it',
    )
  }

  return lines.join('\n')
}
