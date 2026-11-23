import type { ChildProcess } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { turnWaiting, type LooseRow } from '../../engine/rows/read.js'
import type { PermissionRequestParams, SessionAppliedParams } from '../runner-wire/methods.js'
import type { RpcError } from '../runner-wire/errors.js'
import { RunnerConnection, type HeldAsk } from '../runner-link/runnerConnection.js'
import { UNANSWERED_ASK_REJECT_MESSAGE } from '../../engine/message-shapes/rejectionText.js'
import { killProcessGroup } from '../../platform/processes/processGroup.js'
import { logForDebugging } from '../../platform/logs/debugLog.js'
import { assertSpawnCwd, recordSpawn } from './spawnLedger.js'
import { spawnRunnerChild, type RunnerChildSpec } from '../runner-link/headlessRun.js'
import {
  occupancyOfRow,
  isOutcomeRow,
  isTurnOpenRow,
  errorTextOfOutcome,
  DEFAULT_LONG_LIVED_CONFIG,
  type LongLivedRespawnConfig,
} from './longLivedRespawn.js'
import { calculateContextPercentages, getContextWindowForModel } from '../../engine/compaction-window/contextFill.js'
import { currentVersion } from '../control/controlSocket.js'
import type { LongLivedSeat, RosterEntry, RosterOptions, WorkerHandle } from './types.js'
import { passedOver } from '../../platform/errors/passedOver.js'
import { stopTimeout } from '../../platform/async/timers.js'

interface SpawnNeeds {
  keepChildStderr(short: string, child: ChildProcess, ll: LongLivedSeat): void
  superviseChildLife(short: string, h: WorkerHandle, ll: LongLivedSeat, child: ChildProcess): void
  noteWorkerIdle(short: string): void
}

export class SpawnPart {
  constructor(
    private readonly opts: RosterOptions,
    private readonly handles: Map<string, WorkerHandle>,
    private readonly degradedSeats: Map<string, string>,
    private readonly needs: SpawnNeeds,
  ) {}

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
    this.degradedSeats.delete(short)
    const pid = this.spawnLongLived(short)
    if (pid === undefined) {
      ll.intentionalStop = true
      this.handles.delete(short)
      return { ok: false, error: 'spawn failed (no pid)' }
    }
    return { ok: true, pid }
  }

  spawnLongLived(short: string): number | undefined {
    const h = this.handles.get(short)
    if (!h || !h.longLived) return undefined
    const ll = h.longLived
    if (ll.respawnTimer) {
      stopTimeout(ll.respawnTimer)
      ll.respawnTimer = undefined
    }
    const cwdGate = assertSpawnCwd(ll.spec.cwd)
    if (!cwdGate.ok) {
      logForDebugging(`[daemon] long-lived ${short} REFUSED — ${cwdGate.reason}`)
      h.entry.outcome = 'degraded'
      this.degradedSeats.set(short, cwdGate.reason)
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
      void import('../concourse-workers/concourseWorkers.js')
        .then(sup => sup.markConcourseWorkerRespawn(short, livePid))
        .catch(passedOver)
    }
    h.entry.state = 'running'
    h.entry.outcome = undefined
    ll.lastSpawnAt = Date.now()
    ll.spawnGeneration += 1
    ll.running = { model: ll.spec.model, effort: ll.spec.effort }
    ll.turnActive = false
    ll.turnStartedAt = undefined
    ll.waitingOnAgents = 0
    ll.contextPct = undefined
    ll.lastDeliveredAt = undefined
    ll.clearInFlight = false
    ll.lastErrorText = undefined
    ll.ready = false
    ll.claimedAt = undefined
    ll.crashedAt = undefined

    ll.connection?.close('the seat was relaunched')
    ll.connection = undefined
    const connection = new RunnerConnection({ input: child.stdout!, output: child.stdin! }, spawned.capabilities, {
      onRow: row => {
        this.classifyRow(short, ll, row)
        this.forwardRow(short, row)
      },
      onAsk: params => this.holdAsk(short, params),
      onApplied: params => this.forwardApplied(short, params),
      ...(this.opts.onScheduleEdit ? { onScheduleEdit: params => this.opts.onScheduleEdit!(short, params) } : {}),
      onProtocolError: error => this.refuseRunner(short, ll, child, error),
      log: line => logForDebugging(`[daemon] ${short}: ${line}`),
    })
    ll.connection = connection
    const bootGeneration = ll.spawnGeneration
    void connection.initialized.then(result => {
      if (result === null || ll.connection !== connection || ll.spawnGeneration !== bootGeneration) return
      ll.ready = true
      logForDebugging(`[daemon] ${short}: the runner answered initialize after ${Math.round(connection.bootMs / 1000)} s`)
      try {
        this.opts.onChildReady?.(short)
      } catch (e) {
        logForDebugging(`[daemon] onChildReady(${short}) hook threw (ignored): ${e}`)
      }
    })
    this.needs.keepChildStderr(short, child, ll)
    this.needs.superviseChildLife(short, h, ll, child)
    if (ll.spawnGeneration > 1 && this.opts.onChildRelaunched && typeof child.pid === 'number') {
      try {
        this.opts.onChildRelaunched(short, child.pid)
      } catch (e) {
        logForDebugging(`[daemon] onChildRelaunched(${short}) hook threw (ignored): ${e}`)
      }
    }
    this.needs.noteWorkerIdle(short)
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
    return { answer: Promise.resolve({ outcome: 'deny', message: UNANSWERED_ASK_REJECT_MESSAGE(params.tool_name, 'no ask owner stands behind this roster') }), withdraw: () => {} }
  }

  private refuseRunner(short: string, ll: LongLivedSeat, child: ChildProcess, error: RpcError): void {
    logForDebugging(`[daemon] ${short}: the runner's wire was refused — ${error.message}`)
    ll.lastErrorText = error.message
    if (ll.turnActive) {
      ll.turnActive = false
      ll.turnStartedAt = undefined
      if (short.startsWith('concourse-w')) {
        void import('../concourse-workers/concourseWorkers.js')
          .then(sup => sup.markConcourseWorkerTurnSettled(short))
          .catch(passedOver)
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
    if (turnWaiting(frame)) ll.waitingOnAgents = typeof frame.agents === 'number' && Number.isFinite(frame.agents) ? Math.max(0, Math.floor(frame.agents)) : 0
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
        void import('../concourse-workers/concourseWorkers.js')
          .then(sup => sup.markConcourseWorkerTurnSettled(short))
          .catch(passedOver)
          .then(() => {
            if (!ll.turnActive) this.needs.noteWorkerIdle(short)
          })
          .catch(e => logForDebugging(`[daemon] ${short}: the idle edge after its settled turn threw (ignored): ${e}`))
      } else {
        this.needs.noteWorkerIdle(short)
      }
    }
  }
}
