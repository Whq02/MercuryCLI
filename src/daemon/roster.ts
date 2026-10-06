
import type { ChildProcess } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import type { LooseRow } from '../rows/read.js'
import type { InputRow } from '../rows/vocabulary.js'
import type { PermissionRequestParams, SessionAppliedParams } from '../runner/wire/methods.js'
import type { RpcError } from '../runner/wire/errors.js'
import { RunnerConnection, type HeldAsk, type RunnerDoor } from './runnerConnection.js'
import { UNANSWERED_ASK_REJECT_MESSAGE } from '../utils/messages/rejectionText.js'
import { SANDBOX_NETWORK_ACCESS_TOOL_NAME } from './runnerFrames.js'
import { killProcessGroup } from '../utils/processGroup.js'
import { logForDebugging } from '../utils/debug.js'
import { assertSpawnCwd, recordSpawn, recordSpawnExit } from '../utils/spawnLedger.js'
import { DaemonBreaker } from '../utils/daemonBreaker.js'
import type { EffortValue } from '../utils/effort.js'
import { validateSeatEffort } from '../utils/model/seatSlots.js'
import { flagEnv, flagPair } from '../substrate/flagRegistry.js'
import {
  runTaskHeadless,
  buildHeadlessPrompt,
  spawnRunnerChild,
  type RunnerChildSpec,
  type SeatPermissionMode,
} from './headlessRun.js'
import { resolveWorkerReconAllow } from './workerRecon.js'
import {
  decideRespawn,
  occupancyOfRow,
  isOutcomeRow,
  isTurnOpenRow,
  errorTextOfOutcome,
  keepStderrTail,
  lastStderrLine,
  decideWorkerBusy,
  deriveWireSpec,
  getMaxTurnMs,
  DEFAULT_LONG_LIVED_CONFIG,
  DEFAULT_HEALTHY_RESET_MS,
  type LongLivedRespawnConfig,
} from './longLivedRespawn.js'
import { calculateContextPercentages, getContextWindowForModel } from '../utils/context.js'

export const AUTO_CLEAR_CONTEXT_PCT = 85
import { currentVersion } from './controlSocket.js'
import { GLYPH } from '../components/mercury-ui/glyphs.js'
import type { DispatchBody, DispatchSource, WireRosterEntry } from './protocol.js'

export type RosterState =
  | 'spawning'
  | 'running'
  | 'retiring'
  | 'settled'
  | 'crashed'

export interface RosterEntry {
  short: string
  sessionId: string
  prompt: string
  source: DispatchSource
  state: RosterState
  pid?: number
  startedAt: number
  cliVersion: string
  outcome?: string
  via?: string
  cwd?: string
  worktree?: string
}

const DELIVERED_ID_CAP = 500
const EXIT_DRAIN_BACKSTOP_MS = 2_000

interface LongLivedSeat {
  spec: RunnerChildSpec
  cfg: LongLivedRespawnConfig
  respawns: number
  lifetimeCrashes: number
  lastSpawnAt: number
  intentionalStop: boolean
  respawnTimer?: ReturnType<typeof setTimeout>
  reconfiguring?: boolean
  pendingReconfigure?: boolean
  lastDeliveredAt?: number
  contextPct?: number
  turnActive?: boolean
  turnStartedAt?: number
  turnEdges: number
  seenDispatchIds?: Set<string>
  clearInFlight?: boolean
  spawnGeneration: number
  lastErrorText?: string
  stderrTail?: Buffer
  connection?: RunnerConnection
  stormNotified?: boolean
  running?: { model: string; effort: string }
  paused?: SeatPause
}

export type SeatPause = { why: string; words: string; resumesAtMs?: number }

interface WorkerHandle {
  entry: RosterEntry
  child?: ChildProcess
  done: Promise<void>
  longLived?: LongLivedSeat
}

export interface RosterOptions {
  dir: string
  breaker: DaemonBreaker
  maxInflight: number
  onDegraded?: (reason: string, short?: string) => void
  onIdle?: (short: string) => void
  onAsk?: (short: string, params: PermissionRequestParams) => HeldAsk
  onRow?: (short: string, row: LooseRow) => void
  onApplied?: (short: string, params: SessionAppliedParams) => void
  onChildRelaunched?: (short: string, pid: number) => void
}

export interface DispatchOutcome {
  ok: boolean
  short: string
  pid?: number
  via?: string
  code?: 'EALIVE' | 'ENOCONN'
  error?: string
}

export class TaskRoster {
  private readonly handles = new Map<string, WorkerHandle>()
  private inFlight = 0
  private degradedState: { degraded: boolean; reason: string } = {
    degraded: false,
    reason: '',
  }

  constructor(private readonly opts: RosterOptions) {}

  getRespawnState(): { degraded: boolean; reason: string } {
    return { ...this.degradedState }
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
    return Array.from(this.handles.values()).map(h => {
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
        if (h.longLived.turnActive && h.longLived.turnStartedAt !== undefined) e.turnStartedAt = h.longLived.turnStartedAt
        if (wire.pendingModel !== undefined) e.pendingModel = wire.pendingModel
        if (wire.pendingEffort !== undefined) e.pendingEffort = wire.pendingEffort
        e.respawns = h.longLived.respawns
        if (h.longLived.contextPct !== undefined) e.contextPct = h.longLived.contextPct
        if (h.longLived.paused !== undefined && !h.entry.outcome) e.paused = { ...h.longLived.paused }
        if (!h.entry.outcome) {
          e.busy = !this.seatIsIdle(h.longLived)
          if (h.longLived.turnActive !== undefined) e.turnActive = h.longLived.turnActive
          if (e.busy && h.longLived.turnStartedAt !== undefined) {
            e.turnElapsedMs = Math.max(0, Date.now() - h.longLived.turnStartedAt)
          }
        }
      }
      return e
    })
  }

  has(short: string): { alive: boolean; present: boolean; ready: boolean } {
    const h = this.handles.get(short)
    if (!h) return { alive: false, present: false, ready: false }
    const alive = !h.entry.outcome
    return { alive, present: true, ready: h.entry.state === 'running' }
  }

  expectExit(short: string, expected: boolean): boolean {
    const h = this.handles.get(short)
    if (!h || !h.longLived || h.entry.outcome) return false
    h.longLived.intentionalStop = expected
    if (expected && h.longLived.respawnTimer) clearTimeout(h.longLived.respawnTimer)
    return true
  }

  async reply(short: string, row: InputRow): Promise<boolean> {
    const h = this.handles.get(short)
    if (!h || h.entry.outcome || h.entry.state === 'retiring') return false
    const door = h.longLived?.connection
    if (h.longLived === undefined || door === undefined || door.closed) return false
    const ll = h.longLived
    const edgesBefore = ll.turnEdges
    ll.turnActive = true
    ll.turnStartedAt = Date.now()
    const worker = short.startsWith('concourse-w')
    if (worker) {
      void import('./concourseWorkers.js')
        .then(sup => sup.markConcourseWorkerDelivery(short))
        .catch(() => {})
    }
    if (!(await door.deliver(row))) {
      if (ll.turnEdges === edgesBefore) {
        ll.turnActive = false
        ll.turnStartedAt = undefined
        if (worker) {
          void import('./concourseWorkers.js')
            .then(sup => sup.markConcourseWorkerTurnSettled(short))
            .catch(() => {})
        }
      }
      return false
    }
    return true
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
    if (h.longLived) {
      h.longLived.intentionalStop = true
      if (h.longLived.respawnTimer) clearTimeout(h.longLived.respawnTimer)
    }
    if (h.entry.outcome) {
      this.handles.delete(short)
      return true
    }
    h.entry.state = 'retiring'
    try {
      if (h.child) killProcessGroup(h.child, signal)
    } catch (e) {
      logForDebugging(`[daemon] kill(${short}) error: ${e}`)
    }
    return true
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
  ): { ok: boolean; pid?: number; error?: string } {
    const existing = this.handles.get(short)
    if (existing && !existing.entry.outcome) {
      return { ok: false, error: 'a live worker already holds this id' }
    }
    const ll: LongLivedSeat = {
      spec,
      cfg: { ...DEFAULT_LONG_LIVED_CONFIG, ...opts },
      respawns: 0,
      lifetimeCrashes: 0,
      lastSpawnAt: 0,
      intentionalStop: false,
      spawnGeneration: 0,
      turnEdges: 0,
    }
    const entry: RosterEntry = {
      short,
      sessionId: randomUUID(),
      prompt: `[long-lived ${spec.role}]`,
      source: 'dispatch',
      state: 'spawning',
      startedAt: Date.now(),
      cliVersion: currentVersion(),
      via: 'runner',
      ...(start !== undefined ? { cwd: start.cwd } : spec.cwd !== undefined ? { cwd: spec.cwd } : {}),
      ...(start?.worktree !== undefined ? { worktree: start.worktree } : {}),
    }
    this.handles.set(short, { entry, done: Promise.resolve(), longLived: ll })
    const pid = this.spawnLongLived(short)
    if (pid === undefined) {
      ll.intentionalStop = true
      this.handles.delete(short)
      return { ok: false, error: 'spawn failed (no pid)' }
    }
    return { ok: true, pid }
  }

  private idleWindowMs(): number {
    const n = Number(flagEnv('MERCURY_WORKER_IDLE_MS'))
    return Number.isFinite(n) && n > 0 ? n : 15_000
  }

  private seatIsIdle(ll: LongLivedSeat): boolean {
    return !decideWorkerBusy({
      turnActive: ll.turnActive,
      turnStartedAt: ll.turnStartedAt,
      now: Date.now(),
      lastDeliveredAt: ll.lastDeliveredAt,
      idleMs: this.idleWindowMs(),
      maxTurnMs: getMaxTurnMs(flagEnv('MERCURY_WORKER_MAX_TURN_MS')),
    }).busy
  }

  isWorkerBusy(short: string): boolean {
    const h = this.handles.get(short)
    if (!h?.longLived) return false
    return !this.seatIsIdle(h.longLived)
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

  private respawnForReconfigure(short: string): void {
    const h = this.handles.get(short)
    if (!h?.longLived) return
    if (h.entry.outcome) {
      this.spawnLongLived(short)
      return
    }
    if (h.longLived.respawnTimer) {
      return
    }
    h.longLived.reconfiguring = true
    try {
      h.child?.kill('SIGTERM')
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
    patch: { model: string; effort: string; respawnExtraArgv: readonly string[]; permissionMode: SeatPermissionMode },
  ): RunnerChildSpec | null {
    const h = this.handles.get(short)
    if (!h?.longLived) return null
    h.longLived.spec = {
      ...h.longLived.spec,
      model: patch.model,
      effort: patch.effort,
      respawnExtraArgv: [...patch.respawnExtraArgv],
      permissionMode: patch.permissionMode,
    }
    if (h.longLived.running) h.longLived.running = { model: patch.model, effort: patch.effort }
    return h.longLived.spec
  }

  onDispatchTick(short: string, delivered: number): void {
    const h = this.handles.get(short)
    if (!h?.longLived) return
    const ll = h.longLived
    if (delivered > 0) ll.lastDeliveredAt = Date.now()
    this.applyQueuedRetargetIfIdle(short, ll)
  }

  private applyQueuedRetargetIfIdle(short: string, ll: LongLivedSeat): void {
    if (ll.pendingReconfigure && this.seatIsIdle(ll)) {
      ll.pendingReconfigure = false
      logForDebugging(`[daemon] reconfigure(${short}) applying queued retarget — worker now idle`)
      this.respawnForReconfigure(short)
    }
  }

  private noteWorkerIdle(short: string): void {
    const ll = this.handles.get(short)?.longLived
    if (ll) this.applyQueuedRetargetIfIdle(short, ll)
    try {
      this.opts.onIdle?.(short)
    } catch (e) {
      logForDebugging(`[daemon] onIdle(${short}) hook threw (ignored): ${e}`)
    }
  }

  private spawnLongLived(short: string): number | undefined {
    const h = this.handles.get(short)
    if (!h || !h.longLived) return undefined
    const ll = h.longLived
    if (ll.respawnTimer) {
      clearTimeout(ll.respawnTimer)
      ll.respawnTimer = undefined
    }
    const cwdGate = assertSpawnCwd(ll.spec.cwd)
    if (!cwdGate.ok) {
      logForDebugging(`[daemon] long-lived ${short} REFUSED — ${cwdGate.reason}`)
      h.entry.outcome = 'degraded'
      this.degradedState = { degraded: true, reason: `${short}: ${cwdGate.reason}` }
      recordSpawn({
        kind: 'long-lived-refused',
        id: ll.spec.agentId,
        cwd: ll.spec.cwd ?? '',
        reason: cwdGate.reason,
        role: ll.spec.role,
      })
      return undefined
    }
    let spawned: ReturnType<typeof spawnRunnerChild>
    try {
      spawned = spawnRunnerChild(ll.spec, { respawn: ll.spawnGeneration > 0 })
    } catch (e) {
      logForDebugging(`[daemon] long-lived spawn failed for ${short}: ${e}`)
      return undefined
    }
    const child = spawned.child
    child.stdin?.on('error', error => {
      logForDebugging(`[daemon] ${short}: input stream closed: ${error}`)
    })
    h.child = child
    h.entry.pid = child.pid
    if (short.startsWith('concourse-w') && typeof child.pid === 'number') {
      const livePid = child.pid
      void import('./concourseWorkers.js')
        .then(sup => sup.markConcourseWorkerRespawn(short, livePid))
        .catch(() => {})
    }
    h.entry.state = 'running'
    h.entry.outcome = undefined
    ll.lastSpawnAt = Date.now()
    ll.spawnGeneration += 1
    ll.running = { model: ll.spec.model, effort: ll.spec.effort }
    ll.turnActive = false
    ll.turnStartedAt = undefined
    ll.contextPct = undefined
    ll.lastDeliveredAt = undefined
    ll.clearInFlight = false
    ll.lastErrorText = undefined

    ll.connection?.close('the seat was relaunched')
    ll.connection = undefined
    ll.connection = new RunnerConnection({ input: child.stdout!, output: child.stdin! }, spawned.capabilities, {
      onRow: row => {
        this.classifyRow(short, ll, row)
        this.forwardRow(short, row)
      },
      onAsk: params => this.holdAsk(short, params),
      onApplied: params => this.forwardApplied(short, params),
      onProtocolError: error => this.refuseRunner(short, ll, child, error),
      log: line => logForDebugging(`[daemon] ${short}: ${line}`),
    })
    this.keepChildStderr(short, child, ll)
    this.superviseChildLife(short, h, ll, child)
    if (ll.spawnGeneration > 1 && this.opts.onChildRelaunched && typeof child.pid === 'number') {
      try {
        this.opts.onChildRelaunched(short, child.pid)
      } catch (e) {
        logForDebugging(`[daemon] onChildRelaunched(${short}) hook threw (ignored): ${e}`)
      }
    }
    this.noteWorkerIdle(short)
    return child.pid
  }

  private holdAsk(short: string, params: PermissionRequestParams): HeldAsk {
    if (this.opts.onAsk) {
      try {
        return this.opts.onAsk(short, params)
      } catch (e) {
        logForDebugging(`[daemon] onAsk(${short}) hook threw: ${e}`)
      }
    }
    const toolName = params.kind === 'tool' ? params.tool_name : SANDBOX_NETWORK_ACCESS_TOOL_NAME
    return { answer: Promise.resolve({ outcome: 'deny', message: UNANSWERED_ASK_REJECT_MESSAGE(toolName, 'no ask owner stands behind this roster') }), withdraw: () => {} }
  }

  private refuseRunner(short: string, ll: LongLivedSeat, child: ChildProcess, error: RpcError): void {
    logForDebugging(`[daemon] ${short}: the runner's wire was refused — ${error.message}`)
    ll.lastErrorText = error.message
    if (ll.turnActive) {
      ll.turnActive = false
      ll.turnStartedAt = undefined
      if (short.startsWith('concourse-w')) {
        void import('./concourseWorkers.js')
          .then(sup => sup.markConcourseWorkerTurnSettled(short))
          .catch(() => {})
      }
    }
    try {
      killProcessGroup(child, 'SIGTERM')
    } catch (e) {
      logForDebugging(`[daemon] ${short}: ending the refused runner failed: ${e}`)
    }
  }

  private forwardRow(short: string, row: LooseRow): void {
    if (!this.opts.onRow) return
    try {
      this.opts.onRow(short, row)
    } catch (e) {
      logForDebugging(`[daemon] onRow(${short}) hook threw (ignored): ${e}`)
    }
  }

  private forwardApplied(short: string, params: SessionAppliedParams): void {
    if (!this.opts.onApplied) return
    try {
      this.opts.onApplied(short, params)
    } catch (e) {
      logForDebugging(`[daemon] onApplied(${short}) hook threw (ignored): ${e}`)
    }
  }

  private classifyRow(short: string, ll: LongLivedSeat, frame: LooseRow): void {
    const usage = occupancyOfRow(frame)
    if (usage) {
      const pct = calculateContextPercentages(
        usage,
        getContextWindowForModel(ll.spec.model),
      ).used
      if (pct !== null) ll.contextPct = pct
    }
    if (isTurnOpenRow(frame)) {
      ll.turnEdges += 1
      if (!ll.turnActive) {
        ll.turnActive = true
        ll.turnStartedAt = Date.now()
      }
    }
    if (isOutcomeRow(frame)) {
      ll.turnEdges += 1
      ll.lastErrorText = errorTextOfOutcome(frame)
      ll.turnActive = false
      ll.turnStartedAt = undefined
      if (short.startsWith('concourse-w')) {
        void import('./concourseWorkers.js')
          .then(sup => sup.markConcourseWorkerTurnSettled(short))
          .catch(() => {})
      }
      this.noteWorkerIdle(short)
    }
  }

  private keepChildStderr(short: string, child: ChildProcess, ll: LongLivedSeat): void {
    const generation = ll.spawnGeneration
    ll.stderrTail = undefined
    child.stderr?.on('error', error => {
      logForDebugging(`[daemon] ${short}: error stream closed: ${error}`)
    })
    child.stderr?.on('data', (chunk: Buffer) => {
      try {
        process.stderr.write(chunk)
      } catch {
        logForDebugging(`[daemon] ${short}: stderr write-through failed`)
      }
      if (ll.spawnGeneration === generation) ll.stderrTail = keepStderrTail(ll.stderrTail, chunk)
    })
  }

  private superviseChildLife(
    short: string,
    h: WorkerHandle,
    ll: LongLivedSeat,
    child: ChildProcess,
  ): void {
    let lifeSettled = false
    const generation = ll.spawnGeneration
    const handleCrash = (code: number | null, signal: NodeJS.Signals | null) => {
      if (lifeSettled) return
      lifeSettled = true
      if (ll.spawnGeneration === generation) {
        ll.connection?.close('the runner exited')
        ll.connection = undefined
      }
      if (ll.turnActive && short.startsWith('concourse-w')) {
        void import('./concourseWorkers.js')
          .then(sup => sup.markConcourseWorkerTurnSettled(short))
          .catch(() => {})
      }
      const ledgerExit = (outcome: string, reason?: string): void =>
        recordSpawnExit({
          kind: 'long-lived',
          event: 'exit',
          id: ll.spec.agentId,
          pid: h.entry.pid,
          code,
          signal,
          outcome,
          ...(reason ? { reason } : {}),
        })
      if (ll.intentionalStop) {
        h.entry.state = 'settled'
        h.entry.outcome = 'killed'
        ledgerExit('killed')
        if (short.startsWith('concourse-w')) {
          void import('./concourseWorkers.js')
            .then(async sup => {
              sup.completeRequestedStop(short)
              await sup.completeFencedRetirement(short)
            })
            .catch(() => {})
        }
        return
      }
      if (ll.reconfiguring) {
        ll.reconfiguring = false
        ll.spec = { ...ll.spec, extraEnv: { ...(ll.spec.extraEnv ?? {}), ...flagPair('MERCURY_RUNNER_RESTART_REASON', 'settings') } }
        logForDebugging(
          `[daemon] long-lived ${short} reconfiguring → immediate respawn (${ll.spec.model}@${ll.spec.effort}, no ceiling increment)`,
        )
        ledgerExit('reconfigure-respawn')
        h.entry.state = 'spawning'
        ll.respawnTimer = setTimeout(() => this.spawnLongLived(short), 0)
        ll.respawnTimer.unref?.()
        return
      }
      const keptText = ll.lastErrorText || lastStderrLine(ll.stderrTail)
      if (
        Date.now() - ll.lastSpawnAt >
        (ll.cfg.healthyResetMs ?? DEFAULT_HEALTHY_RESET_MS)
      ) {
        ll.respawns = 0
        ll.stormNotified = false
      }
      ll.respawns++
      ll.lifetimeCrashes++
      const decision = decideRespawn(ll.respawns, ll.cfg, ll.lifetimeCrashes)
      logForDebugging(
        `[daemon] long-lived ${short} crashed (code=${code} sig=${signal}); ${decision.action} (${ll.respawns}/${ll.cfg.maxRespawns})`,
      )
      // eslint-disable-next-line no-console
      console.error(
        `[daemon] long-lived ${short} crashed (code=${code} sig=${signal}); ${decision.action} (${ll.respawns}/${ll.cfg.maxRespawns})${keptText ? ` — ${keptText}` : ''}`,
      )
      const stampCrash = (respawning: boolean, detail?: string): void => {
        if (!short.startsWith('concourse-w')) return
        const exitWords = `exit ${code ?? 'none'}${signal ? ` · signal ${signal}` : ''}`
        const reason =
          detail ??
          `crashed mid-run (${exitWords})${keptText ? ` — ${keptText}` : ''}${respawning ? ' · resumed — the interrupted ask needs a re-send' : ''}`
        void import('./concourseWorkers.js')
          .then(sup => sup.markConcourseWorkerCrash(short, { reason, respawning }))
          .catch(() => {})
      }
      if (decision.action === 'degrade') {
        this.degradedState = { degraded: true, reason: `${short}: ${decision.reason}` }
        h.entry.state = 'crashed'
        h.entry.outcome = 'degraded'
        ledgerExit('degraded', decision.reason)
        stampCrash(false, `crashed — respawns exhausted (${decision.reason})`)
        logForDebugging(`[daemon] ${GLYPH.warn} DEGRADED — ${this.degradedState.reason}`)
        try {
          this.opts.onDegraded?.(this.degradedState.reason, short)
        } catch {
        }
        return
      }
      if (ll.respawns === 2 && !ll.stormNotified) {
        ll.stormNotified = true
      }
      ledgerExit('crash-respawn')
      stampCrash(true)
      ll.spec = { ...ll.spec, extraEnv: { ...(ll.spec.extraEnv ?? {}), ...flagPair('MERCURY_RUNNER_RESTART_REASON', 'crash') } }
      h.entry.state = 'spawning'
      ll.respawnTimer = setTimeout(() => this.spawnLongLived(short), decision.delayMs)
      ll.respawnTimer.unref?.()
    }
    let drainBackstop: ReturnType<typeof setTimeout> | undefined
    child.on('exit', (code, signal) => {
      if (ll.intentionalStop || ll.reconfiguring) {
        handleCrash(code, signal)
        return
      }
      drainBackstop = setTimeout(() => handleCrash(code, signal), EXIT_DRAIN_BACKSTOP_MS)
      drainBackstop.unref?.()
    })
    child.on('close', (code, signal) => {
      if (drainBackstop !== undefined) clearTimeout(drainBackstop)
      handleCrash(code, signal)
    })
    child.on('error', e => {
      logForDebugging(`[daemon] long-lived ${short} spawn/runtime error: ${e}`)
      handleCrash(null, null)
    })
  }

  async dispatch(d: DispatchBody): Promise<DispatchOutcome> {
    const short = d.short || `w-${randomUUID().slice(0, 8)}`

    const existing = this.handles.get(short)
    if (existing && !existing.entry.outcome) {
      return { ok: false, short, code: 'EALIVE', error: 'a live worker already holds this id' }
    }

    if (this.opts.breaker.shouldSuppressFire()) {
      return {
        ok: false,
        short,
        code: 'ENOCONN',
        error: 'circuit-breaker OPEN — dispatch suppressed (cooling down)',
      }
    }
    if (this.inFlight >= this.opts.maxInflight) {
      return {
        ok: false,
        short,
        code: 'ENOCONN',
        error: `at max in-flight (${this.opts.maxInflight}) — retry shortly`,
      }
    }

    const cwd = d.cwd || this.opts.dir
    const source: DispatchSource = d.source ?? 'dispatch'
    const entry: RosterEntry = {
      short,
      sessionId: randomUUID(),
      prompt: d.prompt,
      source,
      state: 'spawning',
      startedAt: Date.now(),
      cliVersion: currentVersion(),
    }

    const via = await this.resolveVia()
    entry.via = via

    this.inFlight++
    let settleChild: ChildProcess | undefined
    const headlessPrompt = buildHeadlessPrompt({
      prompt: d.prompt,
      workflow: d.workflow,
    })
    const run = runTaskHeadless(
      { id: short, prompt: headlessPrompt, allowedTools: resolveWorkerReconAllow() },
      cwd,
      child => {
        settleChild = child
        entry.pid = child.pid
        entry.state = 'running'
      },
    )
      .then(res => {
        const failed = DaemonBreaker.isFailureExit(res.code)
        entry.outcome = res.code === null ? 'killed' : failed ? 'failed' : 'ok'
        entry.state = failed ? (res.code === null ? 'retiring' : 'crashed') : 'settled'
        if (res.timedOut === true && !DaemonBreaker.timeoutIsFleetFailure()) {
          this.opts.breaker.recordTimeout()
        } else {
          this.opts.breaker.recordResult(!failed)
        }
      })
      .catch(e => {
        logForDebugging(`[daemon] dispatch ${short} run error: ${e}`)
        entry.outcome = 'crashed'
        entry.state = 'crashed'
        this.opts.breaker.recordResult(false)
      })
      .finally(() => {
        this.inFlight = Math.max(0, this.inFlight - 1)
        this.reapSettled(32)
      })

    this.handles.set(short, { entry, child: settleChild, done: run })

    logForDebugging(`[daemon] dispatched ${short} via ${via} (source=${source})`)
    return { ok: true, short, pid: entry.pid, via }
  }

  private async resolveVia(): Promise<string> {
    return 'headless'
  }
}
