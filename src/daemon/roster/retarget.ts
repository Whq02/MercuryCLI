import type { ChildProcess } from 'node:child_process'
import { logForDebugging } from '../../platform/logs/debugLog.js'
import type { EffortValue } from '../../models/effort/effort.js'
import { validateSeatEffort } from '../../models/facts/seatSlots.js'
import { flagEnv } from '../../platform/substrate/flagRegistry.js'
import type { RunnerChildSpec, SeatPermissionMode } from '../runner-link/headlessRun.js'
import { decideWorkerBusy, getMaxTurnMs } from './longLivedRespawn.js'
import type { LongLivedSeat, RosterOptions, WorkerHandle } from './types.js'

const AUTO_CLEAR_CONTEXT_PCT = 85

interface RetargetNeeds {
  spawnLongLived(short: string): number | undefined
  endChild(short: string, h: WorkerHandle, child: ChildProcess, signal: NodeJS.Signals): void
}

export class RetargetPart {
  constructor(
    private readonly opts: RosterOptions,
    private readonly handles: Map<string, WorkerHandle>,
    private readonly needs: RetargetNeeds,
  ) {}

  private idleWindowMs(): number {
    const n = Number(flagEnv('MERCURY_WORKER_IDLE_MS'))
    return Number.isFinite(n) && n > 0 ? n : 15_000
  }

  seatIsIdle(ll: LongLivedSeat): boolean {
    return !decideWorkerBusy({
      turnActive: ll.turnActive,
      turnStartedAt: ll.turnStartedAt,
      now: Date.now(),
      lastDeliveredAt: ll.lastDeliveredAt,
      idleMs: this.idleWindowMs(),
      maxTurnMs: getMaxTurnMs(flagEnv('MERCURY_WORKER_MAX_TURN_MS')),
    }).busy
  }

  autoClearIfContextFull(short: string): boolean {
    const ll = this.handles.get(short)?.longLived
    if (!ll) return false
    if (ll.clearInFlight) return false
    if (!this.seatIsIdle(ll)) return false
    if ((ll.contextPct ?? 0) < AUTO_CLEAR_CONTEXT_PCT) return false
    ll.clearInFlight = true
    logForDebugging(
      `[daemon] auto-clear: ${short} ctx ${ll.contextPct}% >= ${AUTO_CLEAR_CONTEXT_PCT}% + idle — respawning (fresh transcript)`,
    )
    this.reconfigureLongLived(short, {})
    return true
  }

  private respawnForReconfigure(short: string): void {
    const h = this.handles.get(short)
    if (!h?.longLived) return
    if (h.entry.outcome) {
      this.needs.spawnLongLived(short)
      return
    }
    if (h.longLived.respawnTimer) {
      return
    }
    h.longLived.reconfiguring = true
    try {
      if (h.child) this.needs.endChild(short, h, h.child, 'SIGTERM')
    } catch (e) {
      logForDebugging(`[daemon] reconfigure(${short}) kill failed: ${e}`)
      h.longLived.reconfiguring = false
    }
  }

  reconfigureLongLived(
    short: string,
    patch: { model?: string; effort?: string },
  ): { ok: boolean; respawned: boolean; pending: boolean; error?: string; note?: string } {
    const h = this.handles.get(short)
    if (!h?.longLived) {
      return { ok: false, respawned: false, pending: false, error: 'unknown long-lived worker' }
    }
    const ll = h.longLived
    const notes: string[] = []
    const prevModel = ll.spec.model
    const prevEffort = ll.spec.effort
    const next = { ...ll.spec }
    if (patch.model) {
      next.model = patch.model
    }
    if (patch.effort) {
      const v = validateSeatEffort(patch.effort, prevEffort as EffortValue)
      next.effort = String(v.effort)
      if (v.note) notes.push(v.note)
    }
    ll.spec = next
    const note = notes.length ? notes.join(' · ') : undefined
    if (note && next.model === prevModel && next.effort === prevEffort) {
      logForDebugging(`[daemon] reconfigure(${short}) refused: ${note}`)
      return { ok: true, respawned: false, pending: false, note }
    }
    if (this.seatIsIdle(ll)) {
      this.respawnForReconfigure(short)
      return { ok: true, respawned: true, pending: false, note }
    }
    ll.pendingReconfigure = true
    logForDebugging(`[daemon] reconfigure(${short}) queued — worker busy, will apply when idle`)
    return { ok: true, respawned: false, pending: true, note }
  }

  patchSeatModel(short: string, model: string): boolean {
    const h = this.handles.get(short)
    if (!h?.longLived) return false
    h.longLived.spec = { ...h.longLived.spec, model }
    if (h.longLived.running) h.longLived.running = { ...h.longLived.running, model }
    return true
  }

  patchSeatEffort(short: string, effort: string): boolean {
    const h = this.handles.get(short)
    if (!h?.longLived) return false
    h.longLived.spec = { ...h.longLived.spec, effort }
    if (h.longLived.running) h.longLived.running = { ...h.longLived.running, effort }
    return true
  }

  patchSeatClaim(
    short: string,
    patch: { model: string; effort: string; respawnExtraArgv: readonly string[]; permissionMode: SeatPermissionMode; permissionModeTyped?: true },
  ): RunnerChildSpec | null {
    const h = this.handles.get(short)
    if (!h?.longLived) return null
    const ll = h.longLived
    ll.spec = {
      ...ll.spec,
      model: patch.model,
      effort: patch.effort,
      respawnExtraArgv: [...patch.respawnExtraArgv],
      permissionMode: patch.permissionMode,
      ...(patch.permissionModeTyped === true ? { permissionModeTyped: true as const } : {}),
    }
    if (ll.running) ll.running = { model: patch.model, effort: patch.effort }
    const connection = ll.connection
    if (connection !== undefined && !connection.closed) {
      ll.ready = false
      ll.claimedAt = Date.now()
      const generation = ll.spawnGeneration
      void connection.sessionLoaded().then(loaded => {
        if (!loaded || ll.connection !== connection || ll.spawnGeneration !== generation) return
        ll.ready = true
        logForDebugging(`[daemon] ${short}: the claimed session is loaded after ${Math.round(connection.loadMs / 1000)} s`)
        try {
          this.opts.onChildReady?.(short)
        } catch (e) {
          logForDebugging(`[daemon] onChildReady(${short}) hook threw (ignored): ${e}`)
        }
      })
    }
    return ll.spec
  }

  applyQueuedRetargetIfIdle(short: string, ll: LongLivedSeat): void {
    if (ll.pendingReconfigure && this.seatIsIdle(ll)) {
      ll.pendingReconfigure = false
      logForDebugging(`[daemon] reconfigure(${short}) applying queued retarget — worker now idle`)
      this.respawnForReconfigure(short)
    }
  }

  noteWorkerIdle(short: string): void {
    const ll = this.handles.get(short)?.longLived
    if (ll) this.applyQueuedRetargetIfIdle(short, ll)
    try {
      this.opts.onIdle?.(short)
    } catch (e) {
      logForDebugging(`[daemon] onIdle(${short}) hook threw (ignored): ${e}`)
    }
  }
}
