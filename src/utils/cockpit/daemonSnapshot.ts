import { readFileSync } from 'node:fs'
import { daemonControlRpc, supervisorStatePath } from '../../daemon/controlSocket.js'
import { MERCURY_DAEMON_PROTO } from '../../daemon/protocol.js'
import { isSaturnSchedulingEnabled } from '../../tools/ScheduleCronTool/prompt.js'
import { type Snapshot } from './types.js'

function versionNoteFor(rec: { proto?: unknown }): string {
  if (typeof rec.proto !== 'number') return ' · pre-handshake build — /daemon restart when ready'
  if (rec.proto === MERCURY_DAEMON_PROTO) return ''
  return ` · protocol v${rec.proto} (this Mercury speaks v${MERCURY_DAEMON_PROTO}) — /daemon restart when ready`
}

function pidAlive(pid: number): boolean {
  if (pid <= 1) return false
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

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
        const fresh = pingVerdict && Date.now() - pingVerdict.at <= PING_TTL_MS
        if (!fresh) kickPing()
        if (fresh && !pingVerdict!.ok) {
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
      return {
        state: 'unavailable',
        reason: `stale record · pid ${rec.pid} not running (run \`mercury daemon\` to restart)`,
        source: 'daemon',
      }
    }

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
