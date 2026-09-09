
import type { ChildProcess } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { killProcessGroup } from '../utils/processGroup.js'
import { logForDebugging } from '../utils/debug.js'
import { assertSpawnCwd, recordSpawn, recordSpawnExit } from '../utils/spawnLedger.js'
import { DaemonBreaker } from '../utils/daemonBreaker.js'
import type { EffortValue } from '../utils/effort.js'
import { validateSeatEffort, validateSeatModel } from '../utils/model/seatSlots.js'
import { flagEnv } from '../substrate/flagRegistry.js'
import {
  getTeammateExecutor,
  isInProcessEnabled,
} from '../utils/swarm/backends/registry.js'
import {
  runTaskHeadless,
  buildHeadlessPrompt,
  spawnStreamJsonChild,
  type StreamJsonChildSpec,
} from './headlessRun.js'
import { resolveWorkerReconAllow } from './workerRecon.js'
import {
  decideRespawn,
  parseStreamJsonFrame,
  usageOfStreamJsonFrame,
  normalizeStreamJsonFrame,
  isTurnResultParsedFrame,
  isTurnStartedParsedFrame,
  errorTextOfParsedResultFrame,
  decideWorkerBusy,
  deriveWireSpec,
  getMaxTurnMs,
  DEFAULT_LONG_LIVED_CONFIG,
  DEFAULT_HEALTHY_RESET_MS,
  type LongLivedSupervisorConfig,
} from './longLivedSupervisor.js'
import { calculateContextPercentages, getContextWindowForModel } from '../utils/context.js'
import {
  buildCarryForwardNote,
  carryForwardEnabled,
  lastSeenDispatchId,
} from './carryForward.js'
import { writeToMailbox } from '../utils/teammateMailbox.js'
import { describeSeatReading, resolveSeatCeiling } from '../services/switchboard/capacityCheck.js'
import { markConcourseWorkerCapacityRefused } from './concourseSupervisor.js'

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
}

const DELIVERED_ID_CAP = 500

interface LongLivedSeat {
  spec: StreamJsonChildSpec
  cfg: LongLivedSupervisorConfig
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
  seenDispatchIds?: Set<string>
  clearInFlight?: boolean
  spawnGeneration: number
  lastErrorText?: string
  stormNotified?: boolean
  running?: { model: string; effort: string }
}

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
  onControlRequest?: (short: string, frame: Record<string, unknown>) => void
  onChildLine?: (short: string, line: string) => void
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

  getSupervisorState(): { degraded: boolean; reason: string } {
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

  async reply(short: string, text: string): Promise<boolean> {
    const h = this.handles.get(short)
    if (!h || h.entry.outcome || h.entry.state === 'retiring') return false
    if (h.longLived && h.child?.stdin?.writable) {
      try {
        h.child.stdin.write(normalizeStreamJsonFrame(text))
        h.longLived.turnActive = true
        h.longLived.turnStartedAt = Date.now()
        if (short.startsWith('concourse-w')) {
          void import('./concourseSupervisor.js')
            .then(sup => sup.markConcourseWorkerDelivery(short))
            .catch(() => {})
        }
        return true
      } catch (e) {
        logForDebugging(`[daemon] reply(${short}) stdin write failed: ${e}`)
        return false
      }
    }
    return false
  }

  control(short: string, frame: string): boolean {
    const h = this.handles.get(short)
    if (!h || h.entry.outcome || h.entry.state === 'retiring') return false
    if (h.longLived && h.child?.stdin?.writable) {
      try {
        h.child.stdin.write(normalizeStreamJsonFrame(frame))
        return true
      } catch (e) {
        logForDebugging(`[daemon] control(${short}) stdin write failed: ${e}`)
        return false
      }
    }
    return false
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
    spec: StreamJsonChildSpec,
    opts?: Partial<LongLivedSupervisorConfig>,
  ): { ok: boolean; pid?: number; error?: string } {
    const existing = this.handles.get(short)
    if (existing && !existing.entry.outcome) {
      return { ok: false, error: 'a live worker already holds this id' }
    }
    const ceiling = resolveSeatCeiling()
    if (this.liveCount() >= ceiling) {
      return { ok: false, error: `cannot start another worker — ${describeSeatReading(ceiling)}` }
    }
    const ll: LongLivedSeat = {
      spec,
      cfg: { ...DEFAULT_LONG_LIVED_CONFIG, ...opts },
      respawns: 0,
      lifetimeCrashes: 0,
      lastSpawnAt: 0,
      intentionalStop: false,
      spawnGeneration: 0,
    }
    const entry: RosterEntry = {
      short,
      sessionId: randomUUID(),
      prompt: `[long-lived ${spec.role}]`,
      source: 'dispatch',
      state: 'spawning',
      startedAt: Date.now(),
      cliVersion: currentVersion(),
      via: 'stream-json',
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
    const team = ll.spec.teamName ?? 'default'
    if (carryForwardEnabled()) {
      const note = buildCarryForwardNote(ll.contextPct, lastSeenDispatchId(ll.seenDispatchIds))
      void writeToMailbox(
        short,
        { from: 'daemon', text: JSON.stringify(note), timestamp: new Date().toISOString() },
        team,
      )
        .catch(() => {})
        .finally(() => this.reconfigureLongLived(short, {}))
      return true
    }
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
      const v = validateSeatModel(patch.model, prevModel)
      next.model = v.model
      if (v.note) notes.push(v.note)
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
    patch: { model: string; effort: string; respawnExtraArgv: readonly string[] },
  ): StreamJsonChildSpec | null {
    const h = this.handles.get(short)
    if (!h?.longLived) return null
    h.longLived.spec = {
      ...h.longLived.spec,
      model: patch.model,
      effort: patch.effort,
      respawnExtraArgv: [...patch.respawnExtraArgv],
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
    const ceiling = resolveSeatCeiling()
    const others = [...this.handles.values()].filter(other => other !== h && !other.entry.outcome).length
    if (others >= ceiling) {
      const reason = `cannot resume yet — ${describeSeatReading(ceiling)}`
      h.entry.state = 'settled'
      h.entry.outcome = 'capacity'
      logForDebugging(`[daemon] ${short}: ${reason}`)
      if (short.startsWith('concourse-w')) {
        try {
          markConcourseWorkerCapacityRefused(short, reason)
        } catch (error) {
          logForDebugging(`[daemon] ${short}: capacity refusal could not be persisted: ${error}`)
        }
      }
      return undefined
    }
    let spawned: { child: ChildProcess }
    try {
      spawned = spawnStreamJsonChild(ll.spec, { respawn: ll.spawnGeneration > 0 })
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
      void import('./concourseSupervisor.js')
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

    this.drainChildStdout(short, child, ll)
    this.superviseChildLife(short, h, ll, child)
    this.noteWorkerIdle(short)
    return child.pid
  }

  private drainChildStdout(short: string, child: ChildProcess, ll: LongLivedSeat): void {
    let firstChunkSeen = false
    let tail = ''
    child.stdout?.on('data', (chunk: Buffer) => {
      if (!firstChunkSeen) {
        firstChunkSeen = true
        logForDebugging(
          `[daemon] long-lived ${short} stdout flowing (first chunk ${chunk.length}b) — pipe drained`,
        )
      }
      tail += chunk.toString('utf8')
      let nl: number
      while ((nl = tail.indexOf('\n')) >= 0) {
        const line = tail.slice(0, nl)
        tail = tail.slice(nl + 1)
        const frame = parseStreamJsonFrame(line)
        const usage = usageOfStreamJsonFrame(frame)
        if (usage) {
          const pct = calculateContextPercentages(
            usage,
            getContextWindowForModel(ll.spec.model),
          ).used
          if (pct !== null) ll.contextPct = pct
        }
        const errText = errorTextOfParsedResultFrame(frame)
        if (errText) ll.lastErrorText = errText
        if (this.opts.onControlRequest && frame !== null && frame.type === 'control_request') {
          try {
            this.opts.onControlRequest(short, frame)
          } catch {
          }
        }
        if (this.opts.onChildLine) {
          try {
            this.opts.onChildLine(short, line)
          } catch (e) {
            logForDebugging(`[daemon] onChildLine(${short}) hook threw (ignored): ${e}`)
          }
        }
        if (isTurnStartedParsedFrame(frame)) {
          if (!ll.turnActive) {
            ll.turnActive = true
            ll.turnStartedAt = Date.now()
          }
        }
        if (isTurnResultParsedFrame(frame)) {
          ll.turnActive = false
          ll.turnStartedAt = undefined
          if (short.startsWith('concourse-w')) {
            void import('./concourseSupervisor.js')
              .then(sup => sup.markConcourseWorkerTurnSettled(short))
              .catch(() => {})
          }
          this.noteWorkerIdle(short)
        }
      }
      if (tail.length > 1_000_000) tail = tail.slice(-100_000)
    })
  }

  private superviseChildLife(
    short: string,
    h: WorkerHandle,
    ll: LongLivedSeat,
    child: ChildProcess,
  ): void {
    let lifeSettled = false
    const handleCrash = (code: number | null, signal: NodeJS.Signals | null) => {
      if (lifeSettled) return
      lifeSettled = true
      if (ll.turnActive && short.startsWith('concourse-w')) {
        void import('./concourseSupervisor.js')
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
          void import('./concourseSupervisor.js')
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
        logForDebugging(
          `[daemon] long-lived ${short} reconfiguring → immediate respawn (${ll.spec.model}@${ll.spec.effort}, no ceiling increment)`,
        )
        ledgerExit('reconfigure-respawn')
        h.entry.state = 'spawning'
        ll.respawnTimer = setTimeout(() => this.spawnLongLived(short), 0)
        ll.respawnTimer.unref?.()
        return
      }
      if (
        Date.now() - ll.lastSpawnAt >
        (ll.cfg.healthyResetMs ?? DEFAULT_HEALTHY_RESET_MS)
      ) {
        ll.respawns = 0
        ll.stormNotified = false
        ll.lastErrorText = undefined
      }
      ll.respawns++
      ll.lifetimeCrashes++
      const decision = decideRespawn(ll.respawns, ll.cfg, ll.lifetimeCrashes)
      logForDebugging(
        `[daemon] long-lived ${short} crashed (code=${code} sig=${signal}); ${decision.action} (${ll.respawns}/${ll.cfg.maxRespawns})`,
      )
      const composeStormNote = (phase: 'forming' | 'degraded'): string =>
        `${GLYPH.warn} ${short} ${phase === 'degraded' ? 'DEGRADED — respawn ceiling hit' : 'respawn loop forming'}: ` +
        `${ll.respawns} fast exit(s) on ${ll.spec.model}@${ll.spec.effort} (exit code ${code ?? 'none'}${signal ? `, signal ${signal}` : ''}). ` +
        (ll.lastErrorText ? `Last error: ${ll.lastErrorText}` : 'No output before exit.') +
        (phase === 'degraded'
          ? ' No further respawns — fix the cause, then re-engage.'
          : ' Still retrying with backoff.')
      const postStormNote = (phase: 'forming' | 'degraded'): void => {
        void writeToMailbox(
          'team-lead',
          { from: 'daemon', text: composeStormNote(phase), timestamp: new Date().toISOString() },
          ll.spec.teamName ?? 'default',
        ).catch(() => {})
      }
      const stampCrash = (respawning: boolean, detail?: string): void => {
        if (!short.startsWith('concourse-w')) return
        const exitWords = `exit ${code ?? 'none'}${signal ? ` · signal ${signal}` : ''}`
        const reason =
          detail ??
          `crashed mid-run (${exitWords})${ll.lastErrorText ? ` — ${ll.lastErrorText}` : ''}${respawning ? ' · resumed — the interrupted ask needs a re-send' : ''}`
        void import('./concourseSupervisor.js')
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
        postStormNote('degraded')
        try {
          this.opts.onDegraded?.(this.degradedState.reason, short)
        } catch {
        }
        return
      }
      if (ll.respawns === 2 && !ll.stormNotified) {
        ll.stormNotified = true
        postStormNote('forming')
      }
      ledgerExit('crash-respawn')
      stampCrash(true)
      h.entry.state = 'spawning'
      ll.respawnTimer = setTimeout(() => this.spawnLongLived(short), decision.delayMs)
      ll.respawnTimer.unref?.()
    }
    child.on('exit', (code, signal) => handleCrash(code, signal))
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
    try {
      if (isInProcessEnabled()) {
        await getTeammateExecutor(true).catch(() => null)
        return 'headless'
      }
      await getTeammateExecutor(false).catch(() => null)
      return 'headless'
    } catch {
      return 'headless'
    }
  }
}
