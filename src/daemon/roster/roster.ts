
import type { InputRow } from '../../engine/rows/vocabulary.js'
import { PendingQueueAck, type QueueAckPolicy, type RunnerDoor } from '../runner-link/runnerConnection.js'
import { logForDebugging } from '../../platform/logs/debugLog.js'
import type { RunnerChildSpec, SeatPermissionMode } from '../runner-link/headlessRun.js'
import { lastStderrLine, deriveWireSpec, type LongLivedRespawnConfig } from './longLivedRespawn.js'
import type { DispatchBody, WireRosterEntry } from '../control/protocol.js'
import type { DispatchOutcome, RosterOptions, SeatPause, WorkerHandle } from './types.js'
import { EndPart } from './end.js'
import { LifePart } from './life.js'
import { SpawnPart } from './spawn.js'
import { RetargetPart } from './retarget.js'
import { DispatchPart } from './dispatch.js'
import { passedOver } from '../../platform/errors/passedOver.js'
import { stopTimeout } from '../../platform/async/timers.js'
export { RUNNER_ASK_BOUND_MS, decideRunnerEnd } from './end.js'

const DELIVERED_ID_CAP = 500

function wireEntry(h: WorkerHandle, retarget: RetargetPart): WireRosterEntry {
  const e: WireRosterEntry = { ...h.entry }
  if (h.longLived) {
    const wire = deriveWireSpec({
      running: h.longLived.running,
      spec: { model: h.longLived.spec.model, effort: h.longLived.spec.effort },
      pendingReconfigure: h.longLived.pendingReconfigure,
      reconfiguring: h.longLived.reconfiguring,
    })
    e.model = wire.model
    e.effort = wire.effort
    if (h.longLived.turnActive && h.longLived.turnStartedAt !== undefined) {
      e.turnOpenedAt = h.longLived.turnStartedAt
      e.turnStartedAt = Math.max(e.turnOpenedAt, h.longLived.lastDeliveredAt ?? e.turnOpenedAt)
    }
    if (wire.pendingModel !== undefined) e.pendingModel = wire.pendingModel
    if (wire.pendingEffort !== undefined) e.pendingEffort = wire.pendingEffort
    e.respawns = h.longLived.respawns
    if (h.longLived.contextPct !== undefined) e.contextPct = h.longLived.contextPct
    if (h.longLived.paused !== undefined && !h.entry.outcome) e.paused = { ...h.longLived.paused }
    e.maxRespawns = h.longLived.cfg.maxRespawns
    e.ready = h.longLived.ready === true
    e.spawnedAt = h.longLived.claimedAt ?? h.longLived.lastSpawnAt
    if (h.longLived.crashedAt !== undefined) e.crashedAt = h.longLived.crashedAt
    const lastError = h.longLived.lastErrorText || lastStderrLine(h.longLived.stderrTail)
    if (lastError !== undefined && lastError !== '') e.lastError = lastError
    if (!h.entry.outcome) {
      e.busy = !retarget.seatIsIdle(h.longLived)
      if (h.longLived.turnActive !== undefined) e.turnActive = h.longLived.turnActive
      if (e.busy && e.turnStartedAt !== undefined) {
        e.turnElapsedMs = Math.max(0, Date.now() - e.turnStartedAt)
      }
    }
  }
  return e
}

export class TaskRoster {
  private readonly handles = new Map<string, WorkerHandle>()
  private readonly degradedSeats = new Map<string, string>()
  private readonly exitListeners = new Map<string, Set<() => void>>()
  private readonly endPart: EndPart
  private readonly lifePart: LifePart
  private readonly spawnPart: SpawnPart
  private readonly retargetPart: RetargetPart
  private readonly dispatchPart: DispatchPart

  constructor(private readonly opts: RosterOptions) {
    this.endPart = new EndPart(this.opts)
    this.lifePart = new LifePart(this.opts, this.degradedSeats, {
      spawnLongLived: short => this.spawnPart.spawnLongLived(short),
      notifyExit: short => this.notifyExit(short),
    })
    this.spawnPart = new SpawnPart(this.opts, this.handles, this.degradedSeats, {
      keepChildStderr: (short, child, ll) => this.lifePart.keepChildStderr(short, child, ll),
      superviseChildLife: (short, h, ll, child) => this.lifePart.superviseChildLife(short, h, ll, child),
      noteWorkerIdle: short => this.retargetPart.noteWorkerIdle(short),
    })
    this.retargetPart = new RetargetPart(this.opts, this.handles, {
      spawnLongLived: short => this.spawnPart.spawnLongLived(short),
      endChild: (short, h, child, signal) => this.endPart.endChild(short, h, child, signal),
    })
    this.dispatchPart = new DispatchPart(this.opts, this.handles, { reapSettled: keepRecent => this.reapSettled(keepRecent) })
  }

  getRespawnState(): { degraded: boolean; reason: string } {
    return { degraded: this.degradedSeats.size > 0, reason: [...this.degradedSeats].map(([seat, why]) => `${seat}: ${why}`).join('; ') }
  }

  liveCount(): number {
    let n = 0
    for (const h of this.handles.values()) {
      if (!h.entry.outcome) n++
    }
    return n
  }

  totalCount(): number {
    return this.handles.size
  }

  liveWorkerFacts(): Array<{
    short: string
    kind: 'long-lived' | 'one-shot'
    purpose: string
    pid?: number
  }> {
    const facts: Array<{ short: string; kind: 'long-lived' | 'one-shot'; purpose: string; pid?: number }> = []
    for (const h of this.handles.values()) {
      if (h.entry.outcome) continue
      if (h.entry.state === 'retiring') continue
      const longLived = h.longLived !== undefined
      const purpose = longLived
        ? `${h.longLived!.spec.role.replace(/^MERCURY_/, '').toLowerCase()} seat`
        : `${h.entry.source} run: ${h.entry.prompt.replace(/\s+/g, ' ').slice(0, 48)}`
      facts.push({
        short: h.entry.short,
        kind: longLived ? 'long-lived' : 'one-shot',
        purpose,
        ...(h.entry.pid !== undefined ? { pid: h.entry.pid } : {}),
      })
    }
    return facts
  }

  list(): WireRosterEntry[] {
    return Array.from(this.handles.values()).map(h => wireEntry(h, this.retargetPart))
  }

  has(short: string): { alive: boolean; present: boolean; ready: boolean } {
    const h = this.handles.get(short)
    if (!h) return { alive: false, present: false, ready: false }
    const alive = !h.entry.outcome
    return { alive, present: true, ready: h.entry.state === 'running' }
  }

  onExit(short: string, listener: () => void): () => void {
    let listeners = this.exitListeners.get(short)
    if (!listeners) {
      listeners = new Set()
      this.exitListeners.set(short, listeners)
    }
    listeners.add(listener)
    return () => {
      const current = this.exitListeners.get(short)
      if (!current) return
      current.delete(listener)
      if (current.size === 0) this.exitListeners.delete(short)
    }
  }

  private notifyExit(short: string): void {
    const listeners = this.exitListeners.get(short)
    if (!listeners) return
    for (const listener of [...listeners]) listener()
  }

  expectExit(short: string, expected: boolean): boolean {
    const h = this.handles.get(short)
    if (!h || !h.longLived || h.entry.outcome) return false
    h.longLived.intentionalStop = expected
    if (expected && h.longLived.respawnTimer) stopTimeout(h.longLived.respawnTimer)
    return true
  }

  async reply(short: string, row: InputRow, policy: QueueAckPolicy = 'bounded'): Promise<boolean> {
    const h = this.handles.get(short)
    if (!h || h.entry.outcome || h.entry.state === 'retiring') return false
    const door = h.longLived?.connection
    if (h.longLived === undefined || door === undefined || door.closed) return false
    const ll = h.longLived
    const edgesBefore = ll.turnEdges
    const opensTurn = !ll.turnActive
    if (opensTurn) {
      ll.turnActive = true
      ll.turnStartedAt = Date.now()
    }
    const worker = short.startsWith('concourse-w')
    if (worker) {
      void import('../concourse-workers/concourseWorkers.js')
        .then(sup => sup.markConcourseWorkerDelivery(short))
        .catch(passedOver)
    }
    const finishDelivery = (accepted: boolean | null): void => {
      if (ll.connection !== door || ll.turnEdges !== edgesBefore) return
      if (accepted && !opensTurn && row.type === 'prompt') ll.lastDeliveredAt = Date.now()
      if (accepted || !opensTurn) return
      ll.turnActive = false
      ll.turnStartedAt = undefined
      if (worker) {
        void import('../concourse-workers/concourseWorkers.js')
          .then(sup => sup.markConcourseWorkerTurnSettled(short))
          .catch(passedOver)
      }
    }
    try {
      const accepted = await door.deliver(row, policy)
      finishDelivery(accepted)
      return accepted
    } catch (error) {
      if (error instanceof PendingQueueAck) void error.confirmed.then(finishDelivery)
      throw error
    }
  }

  door(short: string): RunnerDoor | undefined {
    const h = this.handles.get(short)
    if (!h || h.entry.outcome || h.entry.state === 'retiring') return undefined
    const door = h.longLived?.connection
    return door === undefined || door.closed ? undefined : door
  }

  kill(short: string, signal: NodeJS.Signals = 'SIGTERM'): boolean {
    const h = this.handles.get(short)
    if (!h) return false
    this.degradedSeats.delete(short)
    const respawnPending = h.longLived?.respawnTimer !== undefined && h.entry.state === 'spawning'
    if (h.longLived) {
      h.longLived.intentionalStop = true
      if (h.longLived.respawnTimer) stopTimeout(h.longLived.respawnTimer)
    }
    if (h.entry.outcome) {
      this.handles.delete(short)
      return true
    }
    if (respawnPending) {
      h.entry.state = 'settled'
      h.entry.outcome = 'killed'
      this.notifyExit(short)
      this.lifePart.completeIntentionalStop(short)
      return true
    }
    h.entry.state = 'retiring'
    try {
      if (h.child) this.endPart.endChild(short, h, h.child, signal)
    } catch (e) {
      logForDebugging(`[daemon] kill(${short}) error: ${e}`)
    }
    return true
  }

  askedSettled(): Promise<void> {
    return this.endPart.askedSettled()
  }

  reapSettled(keepRecent = 0): void {
    if (keepRecent > 0) {
      const settled = [...this.handles.entries()].filter(([, h]) => h.entry.outcome)
      if (settled.length <= keepRecent) return
      settled.sort((a, b) => (a[1].entry.startedAt ?? 0) - (b[1].entry.startedAt ?? 0))
      for (const [short] of settled.slice(0, settled.length - keepRecent)) {
        this.handles.delete(short)
      }
      return
    }
    for (const [short, h] of this.handles) {
      if (h.entry.outcome) this.handles.delete(short)
    }
  }

  registerLongLived(
    short: string,
    spec: RunnerChildSpec,
    opts?: Partial<LongLivedRespawnConfig>,
    start?: { cwd: string; worktree?: string },
  ): { ok: boolean; pid?: number; error?: string; startInstant?: Promise<string | null> } {
    return this.spawnPart.registerLongLived(short, spec, opts, start)
  }

  isWorkerBusy(short: string): boolean {
    const h = this.handles.get(short)
    if (!h?.longLived) return false
    return !this.retargetPart.seatIsIdle(h.longLived)
  }

  setSeatPause(short: string, pause: SeatPause | undefined): boolean {
    const ll = this.handles.get(short)?.longLived
    if (!ll) return false
    ll.paused = pause
    return true
  }

  seatPause(short: string): SeatPause | undefined {
    return this.handles.get(short)?.longLived?.paused
  }

  currentLongLivedEffort(short: string): string | undefined {
    return this.handles.get(short)?.longLived?.spec.effort
  }

  currentLongLivedModel(short: string): string | undefined {
    return this.handles.get(short)?.longLived?.spec.model
  }

  currentLongLivedGeneration(short: string): number | undefined {
    return this.handles.get(short)?.longLived?.spawnGeneration
  }

  hasSeenDispatch(short: string, requestId: string): boolean {
    return this.handles.get(short)?.longLived?.seenDispatchIds?.has(requestId) ?? false
  }

  autoClearIfContextFull(short: string): boolean {
    return this.retargetPart.autoClearIfContextFull(short)
  }

  markSeenDispatch(short: string, requestId: string): void {
    const ll = this.handles.get(short)?.longLived
    if (!ll) return
    const set = (ll.seenDispatchIds ??= new Set<string>())
    set.add(requestId)
    if (set.size > DELIVERED_ID_CAP) {
      const overflow = set.size - DELIVERED_ID_CAP
      let i = 0
      for (const v of set) {
        if (i++ >= overflow) break
        set.delete(v)
      }
    }
  }

  reconfigureLongLived(
    short: string,
    patch: { model?: string; effort?: string },
  ): { ok: boolean; respawned: boolean; pending: boolean; error?: string; note?: string } {
    return this.retargetPart.reconfigureLongLived(short, patch)
  }

  patchSeatModel(short: string, model: string): boolean {
    return this.retargetPart.patchSeatModel(short, model)
  }

  patchSeatEffort(short: string, effort: string): boolean {
    return this.retargetPart.patchSeatEffort(short, effort)
  }

  patchSeatClaim(
    short: string,
    patch: { model: string; effort: string; respawnExtraArgv: readonly string[]; permissionMode: SeatPermissionMode; permissionModeTyped?: true },
  ): RunnerChildSpec | null {
    return this.retargetPart.patchSeatClaim(short, patch)
  }

  onDispatchTick(short: string, delivered: number): void {
    const h = this.handles.get(short)
    if (!h?.longLived) return
    const ll = h.longLived
    if (delivered > 0) ll.lastDeliveredAt = Date.now()
    this.retargetPart.applyQueuedRetargetIfIdle(short, ll)
  }

  dispatch(d: DispatchBody): Promise<DispatchOutcome> {
    return this.dispatchPart.dispatch(d)
  }
}
