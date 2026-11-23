import { readFileSync } from 'node:fs'
import { daemonControlRpc, daemonStatePath } from '../../daemon/control/controlSocket.js'
import { MERCURY_DAEMON_PROTO } from '../../daemon/control/protocol.js'
import { isSaturnSchedulingEnabled } from '../../tools/cron/prompt.js'
import { thisMercuryCommand } from '../../platform/update-channel/installPath.js'
import { type Snapshot } from '../cockpit/types.js'
import { passedOver } from '../../platform/errors/passedOver.js'

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
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | null)?.code
    if (code === 'EPERM') return true
    if (code === 'ESRCH') return false
    passedOver(error)
    return false
  }
}

const PING_TIMEOUT_MS = 5_000
const PING_TTL_MS = 15_000
let pingVerdict: { key: string; ok: boolean; at: number } | null = null
let pingInFlight: string | null = null
function kickPing(key: string): void {
  if (pingInFlight === key) return
  pingInFlight = key
  void daemonControlRpc({ op: 'ping' }, { timeoutMs: PING_TIMEOUT_MS })
    .then(r => {
      if (pingInFlight === key) pingVerdict = { key, ok: r.ok === true, at: Date.now() }
    })
    .catch(() => {
      if (pingInFlight === key) pingVerdict = { key, ok: false, at: Date.now() }
    })
    .finally(() => {
      if (pingInFlight === key) pingInFlight = null
    })
}

export function daemonSnapshot(): Snapshot {
  try {
    const statePath = daemonStatePath()
    let rec: { pid?: unknown; version?: unknown; startedAt?: unknown; proto?: unknown } | null = null
    try {
      const parsed = JSON.parse(readFileSync(statePath, 'utf8'))
      if (parsed && typeof parsed === 'object') rec = parsed
    } catch (error) {
      const code = (error as NodeJS.ErrnoException | null)?.code
      if (code === 'ENOENT' || code === 'ENOTDIR' || error instanceof SyntaxError) rec = null
      else throw error
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
        const key = `${rec.pid}:${typeof rec.startedAt === 'number' ? rec.startedAt : ''}`
        const fresh = pingVerdict !== null && pingVerdict.key === key && Date.now() - pingVerdict.at <= PING_TTL_MS
        if (!fresh) kickPing(key)
        if (fresh && !pingVerdict!.ok) {
          return {
            state: 'unavailable',
            reason: `pid ${rec.pid} alive but control socket unresponsive — wedged? (restart: \`${thisMercuryCommand()} daemon\`)`,
            source: 'daemon',
          }
        }
        return {
          state: 'live',
          reason: `${fresh ? `${base} · rpc ✓` : `${base} · verifying rpc…`}${versionNoteFor(rec)}`,
          source: 'daemon',
        }
      }
      pingVerdict = null
      return {
        state: 'unavailable',
        reason: `stale record · pid ${rec.pid} not running (run \`${thisMercuryCommand()} daemon\` to restart)`,
        source: 'daemon',
      }
    }

    pingVerdict = null

    const cronReady = isSaturnSchedulingEnabled()
    return {
      state: 'off',
      reason: cronReady
        ? `opt-in: run \`${thisMercuryCommand()} daemon\` (cron substrate ready)`
        : `opt-in: run \`${thisMercuryCommand()} daemon\``,
      source: 'daemon',
    }
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    return { state: 'unavailable', reason: `daemon state unreadable (${detail})`, source: 'daemon' }
  }
}
