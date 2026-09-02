import { daemonRosterSnapshot } from '../cockpit/daemonRosterSnapshot.js'
import { scribeModeEnabled } from './scribeGates.js'
import { isScribeModeOn } from '../scribeMode.js'
import { flagEnv } from '../../substrate/flagRegistry.js'

export interface ImplementerTelemetry {
  daemonUp: boolean
  present: boolean
  model?: string
  effort?: string
  pendingModel?: string
  pendingEffort?: string
  busy?: boolean
  contextPct?: number
  turnElapsedMs?: number
  respawns?: number
  settled?: boolean
}

const EMPTY: ImplementerTelemetry = { daemonUp: false, present: false }
let _cache: ImplementerTelemetry = EMPTY

export function publishImplementerTelemetry(t: ImplementerTelemetry): void {
  _cache = t
}

export function getImplementerTelemetry(): ImplementerTelemetry {
  return _cache
}

export function composeDispatchAckHealth(
  t: ImplementerTelemetry,
  opts?: {
    rpcConfirmed?: boolean
  },
): string {
  if (!t.daemonUp) {
    return opts?.rpcConfirmed
      ? 'daemon answered this send (journaled + nudged) — backend telemetry pending its first poll; a reply typically lands in 1–3 min'
      : 'backend UNCONFIRMED (no daemon answer yet) — send≠receipt; treat silence past ~3 min as a fault, not patience'
  }
  if (!t.present) return 'backend MISSING from the daemon roster — the dispatch will sit until an Implementer spawns; escalate if this persists'
  if (t.settled) return 'backend SETTLED (dead/degraded) — the daemon must respawn it before this delivers'
  if (t.busy) {
    const mins = t.turnElapsedMs !== undefined ? ` ~${Math.max(1, Math.round(t.turnElapsedMs / 60_000))} min in` : ''
    return `backend MID-TASK${mins} — held for delivery at the next idle boundary (one task at a time)`
  }
  return 'backend LIVE (idle) — delivery is immediate; first reply typically lands in 1–3 min'
}

const DEFAULT_POLL_MS = 5000
function pollMs(): number {
  const n = Number(flagEnv('MERCURY_SCRIBE_TELEMETRY_MS'))
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_POLL_MS
}

let _refreshing = false
async function refresh(): Promise<void> {
  if (_refreshing) return
  _refreshing = true
  try {
    const snap = await daemonRosterSnapshot('implementer')
    if (!snap.ok) {
      _cache = { daemonUp: false, present: false }
      return
    }
    const e = snap.entry
    _cache = e
      ? {
          daemonUp: true,
          present: true,
          model: e.model,
          effort: e.effort,
          pendingModel: e.pendingModel,
          pendingEffort: e.pendingEffort,
          busy: e.busy,
          contextPct: e.contextPct,
          turnElapsedMs: e.turnElapsedMs,
          respawns: e.respawns,
          settled: e.outcome !== undefined,
        }
      : { daemonUp: true, present: false }
  } catch {
  } finally {
    _refreshing = false
  }
}

let _armed = false

export function armImplementerTelemetryPoll(deps?: { refresh?: () => Promise<void> }): boolean {
  if (_armed) return false
  if (!(scribeModeEnabled() && isScribeModeOn())) return false
  _armed = true
  const tick = deps?.refresh ?? refresh
  void tick()
  const t = setInterval(() => void tick(), pollMs())
  t.unref?.()
  return true
}

export function __resetImplementerTelemetryForTests(): void {
  _cache = EMPTY
  _armed = false
}
