import { randomUUID } from 'node:crypto'
import { clearEphemeralProgress, publishEphemeralProgress } from '../../../screen/app-state/ephemeralProgressStore.js'
import type { HookProgress } from '../../../integrations/event-hooks/hookProgress.js'
import type { ProgressMessage } from '../../message-shapes/message.js'
import type { EvalToolProgress, MCPProgress, ShellProgress } from '../../../tools/kit/toolProgress.js'
import { decodeFoldStatus, type FoldStatusV1 } from '../../compaction/foldStatus.js'
import { compatEndpointIsSelfHosted } from '../../../models/roads/deferralWire.js'
import { decodeRequestWait, streamIdleWarningMsOf, type RequestWaitV1 } from '../../../models/roads/streamIdleBudget.js'
import { interruptLatchRelease } from '../interruptLatch.js'
import { IDLE_LIVE, type LiveTurnFactsV1, type SeatStatusV1, type SessionLiveV1 } from '../seatLive.js'
import { readSessionProgress, type SessionProgressEntryV1, type SessionTailV1 } from '../seatProjections.js'
import type { WorkRowV1 } from '../types.js'
import { workChipLine, workCounts } from '../workCounts.js'
import { connectorTrace, emitAll, type Listeners } from './shared.js'
import { startInterval, stopInterval } from '../../../platform/async/timers.js'

const LIVENESS_TICK_MS = 1000

interface LiveNeeds {
  sessionId(): string
  attached(): boolean
  factsBusy(): boolean
  work(): WorkRowV1[]
  factsTurnStartedAt(): number | undefined
  streamIdleTimeoutMs(): number | undefined
  model(): string
  anySendDelivered(): boolean
  redressQueuedSends(): void
  transcriptLive(): SessionLiveV1
  toolStartedAtMs(inProgress: ReadonlySet<string>): number | null
  tailHeld(): boolean
  clearTail(atMs: number): void
  tailInterrupted(atMs: number): void
  tailInterruptUndone(): void
  foldStillRuns(): boolean
  setLiveFold(next: FoldStatusV1 | null): void
  dropRunningFoldAtIdle(): void
  stepTurnCompletion(inFlight: boolean): boolean
  syncFeedCadence(inFlight: boolean): void
  probeCarrier(): void
}

function reconstructedProgressMessage(parentToolUseID: string, entry: SessionProgressEntryV1): ProgressMessage {
  let data: ShellProgress | MCPProgress | EvalToolProgress | HookProgress
  if (entry.dataType === 'hook_progress') {
    data = {
      type: 'hook_progress',
      event: 'tool.before',
      name: '',
      state: 'waiting',
      count: 1,
      ...(entry.latestLine !== undefined ? { line: entry.latestLine } : {}),
      ...(entry.elapsedTimeSeconds !== undefined ? { elapsedS: entry.elapsedTimeSeconds } : {}),
      ...(entry.budgetMs !== undefined ? { timeoutS: entry.budgetMs / 1000 } : {}),
    }
  } else if (entry.dataType === 'eval_progress') {
    data = {
      type: 'eval_progress',
      kind: 'running',
      elapsedSeconds: entry.elapsedTimeSeconds ?? 0,
      ...(entry.budgetMs !== undefined ? { budgetMs: entry.budgetMs } : {}),
      ...(entry.latestLine !== undefined ? { tail: entry.latestLine } : {}),
    }
  } else if (entry.dataType === 'mcp_progress') {
    const mcp: MCPProgress = { type: 'mcp_progress', status: 'progress', serverName: '', toolName: '' }
    if (entry.mcpProgress !== undefined) mcp.progress = entry.mcpProgress
    if (entry.mcpTotal !== undefined) mcp.total = entry.mcpTotal
    if (entry.latestLine !== undefined) mcp.progressMessage = entry.latestLine
    data = mcp
  } else {
    const body = {
      output: entry.latestLine ?? '',
      fullOutput: entry.latestLine ?? '',
      elapsedTimeSeconds: entry.elapsedTimeSeconds ?? 0,
      totalLines: entry.totalLines ?? 0,
    }
    if (entry.dataType === 'powershell_progress') {
      data = { type: 'powershell_progress', ...body, totalBytes: entry.totalBytes ?? 0 }
    } else {
      const bash: ShellProgress = { type: 'bash_progress', ...body }
      if (entry.totalBytes !== undefined) bash.totalBytes = entry.totalBytes
      data = bash
    }
  }
  return {
    type: 'progress',
    uuid: randomUUID(),
    timestamp: new Date().toISOString(),
    toolUseID: entry.toolUseID,
    parentToolUseID,
    data,
  } as ProgressMessage
}

interface StatusClock {
  now: number
  lastEventAtMs: number | null
  wait: RequestWaitV1 | null
  waitCountsItsOwnAge(wait: Extract<RequestWaitV1, { kind: 'first-byte' }>): boolean
  streamIdleTimeoutMs(): number | undefined
  toolStartedAtMs(inProgress: ReadonlySet<string>): number | null
  toolBudgets: ReadonlyMap<string, { budgetMs: number; elapsedMs: number; atMs: number }>
  blockSinceMs: number | null
  interrupting: boolean
  hardStopping: boolean
}

function seatStatusOf(
  seat: Pick<SeatStatusV1, 'title' | 'projectLabel' | 'isolation' | 'branchLabel' | 'runner'>,
  live: SessionLiveV1,
  clock: StatusClock,
): SeatStatusV1 {
  const now = clock.now
  const quietMs = live.inFlight && clock.lastEventAtMs !== null ? Math.max(0, now - clock.lastEventAtMs) : null
  const wait = clock.wait
  const waitAgeMs = wait !== null && wait.kind === 'first-byte' && clock.waitCountsItsOwnAge(wait) ? Math.max(0, now - wait.sinceMs) : undefined
  const watchdogMs =
    wait?.kind === 'first-byte' ? wait.budgetMs : clock.streamIdleTimeoutMs() ?? null
  let phaseMs: number | null = null
  let toolBudgetMs: number | null = null
  if (live.inFlight) {
    if (live.phase === 'tool') {
      const started = clock.toolStartedAtMs(live.inProgressToolUseIDs)
      if (started !== null) phaseMs = Math.max(0, now - started)
      for (const [id, budget] of clock.toolBudgets) {
        if (!live.inProgressToolUseIDs.has(id)) continue
        toolBudgetMs = Math.max(toolBudgetMs ?? 0, budget.budgetMs)
        phaseMs = Math.max(phaseMs ?? 0, budget.elapsedMs + Math.max(0, now - budget.atMs))
      }
    } else if (clock.blockSinceMs !== null) {
      phaseMs = Math.max(0, now - clock.blockSinceMs)
    } else if (live.turnStartedAtMs !== null) {
      phaseMs = Math.max(0, now - live.turnStartedAtMs)
    }
  }
  const stuck =
    live.inFlight &&
    !clock.interrupting &&
    live.phase !== 'tool' &&
    quietMs !== null &&
    watchdogMs !== null &&
    quietMs >= streamIdleWarningMsOf(watchdogMs)
  return {
    title: seat.title,
    projectLabel: seat.projectLabel,
    interrupting: clock.interrupting,
    hardStopping: clock.hardStopping,
    wait,
    ...(waitAgeMs !== undefined ? { waitAgeMs } : {}),
    quietMs,
    watchdogMs,
    phaseMs,
    toolBudgetMs,
    stuck,
    ...(seat.isolation !== undefined ? { isolation: seat.isolation } : {}),
    ...(seat.branchLabel !== undefined ? { branchLabel: seat.branchLabel } : {}),
    runner: seat.runner,
  }
}

export class LivePart {
  private effectiveLive: SessionLiveV1 = IDLE_LIVE
  private readonly liveListeners: Listeners = new Set()
  private liveTurnChars = 0
  private liveTurnOutputTokens: number | null = null
  private liveTurnThinkingChars = 0
  private liveTurnThinkingBlocks = 0
  private liveFirstByteAtMs: number | null = null
  private liveStateWord: 'compacting' | 'waiting-on-agents' | null = null
  private liveAgentsWaiting = 0
  private liveWait: RequestWaitV1 | null = null
  private liveWaitOwnAge: { wait: RequestWaitV1; own: boolean } | null = null
  private interrupting = false
  private interruptPressedAtMs: number | null = null
  private hardStopping = false
  private lastEventAtMs: number | null = null
  private streamBlock: 'thinking' | 'text' | 'tool_use' | null = null
  private blockSinceMs: number | null = null
  private readonly toolBudgets = new Map<string, { budgetMs: number; elapsedMs: number; atMs: number }>()
  private livenessTicker: ReturnType<typeof setInterval> | null = null
  private progressAtMs = -1
  private readonly publishedProgressSeqs = new Map<string, number>()

  constructor(private readonly needs: LiveNeeds) {}

  wake(): void {
    emitAll(this.liveListeners, 'live')
  }

  stateWord(): 'compacting' | 'waiting-on-agents' | null {
    return this.liveStateWord
  }

  pressed(): { interrupting: boolean; hardStopping: boolean } {
    return { interrupting: this.interrupting, hardStopping: this.hardStopping }
  }

  detached(): void {
    this.liveTurnChars = 0
    this.liveTurnOutputTokens = null
    this.clearLiveStateWord()
    clearEphemeralProgress()
    this.publishedProgressSeqs.clear()
    this.progressAtMs = -1
  }

  readProgress(): void {
    const progress = readSessionProgress(this.needs.sessionId())
    if (progress === null) return
    if (progress.atMs === this.progressAtMs) return
    this.progressAtMs = progress.atMs
    const entries = Object.entries(progress.tools)
    if (entries.length === 0) {
      if (this.publishedProgressSeqs.size > 0) {
        clearEphemeralProgress()
        this.publishedProgressSeqs.clear()
      }
      return
    }
    for (const [parentId, entry] of entries) {
      if (typeof entry.budgetMs === 'number') {
        this.toolBudgets.set(parentId, { budgetMs: entry.budgetMs, elapsedMs: (entry.elapsedTimeSeconds ?? 0) * 1000, atMs: progress.atMs })
      }
      const prior = this.publishedProgressSeqs.get(parentId)
      if (prior !== undefined && entry.seq <= prior) continue
      this.publishedProgressSeqs.set(parentId, entry.seq)
      publishEphemeralProgress(reconstructedProgressMessage(parentId, entry))
    }
  }

  tailGone(): void {
    this.liveTurnChars = 0
    this.liveTurnOutputTokens = null
    this.liveTurnThinkingChars = 0
    this.liveTurnThinkingBlocks = 0
    this.liveFirstByteAtMs = null
    this.setLiveStateWord(null)
    this.needs.setLiveFold(null)
    this.setStreamBlock(null, null)
    this.lastEventAtMs = null
  }

  takeTail(tail: SessionTailV1): void {
    this.liveTurnChars = tail.turnChars ?? 0
    this.liveTurnOutputTokens = typeof tail.turnOutputTokens === 'number' ? tail.turnOutputTokens : null
    this.liveTurnThinkingChars = typeof tail.turnThinkingChars === 'number' && Number.isFinite(tail.turnThinkingChars) ? Math.max(0, tail.turnThinkingChars) : 0
    this.liveTurnThinkingBlocks = typeof tail.turnThinkingBlocks === 'number' && Number.isFinite(tail.turnThinkingBlocks) ? Math.max(0, Math.floor(tail.turnThinkingBlocks)) : 0
    this.liveFirstByteAtMs = typeof tail.firstByteAtMs === 'number' && Number.isFinite(tail.firstByteAtMs) ? tail.firstByteAtMs : null
    this.setLiveStateWord(
      tail.stateWord === 'compacting' ? 'compacting' : tail.stateWord === 'waiting-on-agents' ? 'waiting-on-agents' : null,
      tail.stateWord === 'waiting-on-agents' && typeof tail.waitingOnAgents === 'number' ? Math.max(1, Math.floor(tail.waitingOnAgents)) : 0,
    )
    this.needs.setLiveFold(tail.fold !== undefined ? decodeFoldStatus(tail.fold) : null)
    const wait = decodeRequestWait(tail.wait)
    if (JSON.stringify(wait) !== JSON.stringify(this.liveWait)) {
      this.liveWait = wait
      emitAll(this.liveListeners, 'live')
    }
    this.lastEventAtMs = typeof tail.lastEventAtMs === 'number' ? tail.lastEventAtMs : null
    const block = tail.streamBlock === 'thinking' || tail.streamBlock === 'text' || tail.streamBlock === 'tool_use' ? tail.streamBlock : null
    this.setStreamBlock(block, block !== null && typeof tail.blockSinceMs === 'number' ? tail.blockSinceMs : null)
  }

  turnChars(): number {
    return this.liveTurnChars
  }

  turnOutputTokens(): number | null {
    return this.liveTurnOutputTokens
  }

  turnFacts(): LiveTurnFactsV1 {
    return {
      replyChars: Math.max(0, this.liveTurnChars - this.liveTurnThinkingChars),
      thinkingChars: this.liveTurnThinkingChars,
      thinkingBlocks: this.liveTurnThinkingBlocks,
      wireOutputTokens: this.liveTurnOutputTokens,
      firstByteAtMs: this.liveFirstByteAtMs,
      lastByteAtMs: this.effectiveLive.inFlight ? this.lastEventAtMs : null,
      wait: this.liveWait,
    }
  }

  private clearLiveStateWord(): void {
    if (this.liveStateWord === null) return
    const wasFolding = this.liveStateWord === 'compacting'
    this.liveStateWord = null
    if (wasFolding) {
      this.needs.redressQueuedSends()
    }
  }

  private setLiveStateWord(word: 'compacting' | 'waiting-on-agents' | null, agentsWaiting = 0): void {
    const count = word === 'waiting-on-agents' ? agentsWaiting : 0
    if (this.liveStateWord === word && this.liveAgentsWaiting === count) return
    const wasFolding = this.liveStateWord === 'compacting'
    this.liveStateWord = word
    this.liveAgentsWaiting = count
    if (wasFolding && word !== 'compacting') {
      this.needs.redressQueuedSends()
    }
    this.recomputeLive()
  }

  private setStreamBlock(block: 'thinking' | 'text' | 'tool_use' | null, sinceMs: number | null): void {
    const flipped = this.streamBlock !== block
    this.streamBlock = block
    this.blockSinceMs = sinceMs
    if (flipped) this.recomputeLive()
  }

  syncLivenessTicker(inFlight: boolean): void {
    if (inFlight && this.needs.attached()) {
      if (this.livenessTicker !== null) return
      const t = startInterval(() => {
        emitAll(this.liveListeners, 'liveness')
        this.needs.probeCarrier()
      }, LIVENESS_TICK_MS)
      t.unref?.()
      this.livenessTicker = t
      return
    }
    if (this.livenessTicker !== null) {
      stopInterval(this.livenessTicker)
      this.livenessTicker = null
    }
  }

  recomputeLive(): void {
    const sendInFlight = this.needs.anySendDelivered()
    const inFlight = this.needs.factsBusy() || sendInFlight
    const streaming: SessionLiveV1['phase'] | null =
      this.streamBlock === 'thinking' ? 'thinking' : this.streamBlock !== null ? 'responding' : null
    const phase: SessionLiveV1['phase'] =
      inFlight && this.liveStateWord === 'compacting' && this.needs.foldStillRuns()
        ? 'compacting'
        : inFlight && this.liveStateWord === 'waiting-on-agents' && this.needs.transcriptLive().phase !== 'tool'
          ? 'waiting'
          : inFlight && this.needs.transcriptLive().phase !== 'tool' && streaming !== null
            ? streaming
            : inFlight && this.needs.transcriptLive().phase === 'idle'
              ? 'thinking'
              : this.needs.transcriptLive().phase
    const agentsWaiting = phase === 'waiting' ? this.liveAgentsWaiting : 0
    const waitingOn = phase === 'waiting' ? workCounts(this.needs.work()) : null
    const waitingOnWords = waitingOn !== null ? workChipLine(waitingOn) : null
    const inProgressToolUseIDs = inFlight
      ? this.needs.transcriptLive().inProgressToolUseIDs
      : IDLE_LIVE.inProgressToolUseIDs
    const prev = this.effectiveLive
    const changed =
      inFlight !== prev.inFlight ||
      phase !== prev.phase ||
      agentsWaiting !== prev.agentsWaiting ||
      waitingOnWords !== (prev.waitingOn !== undefined ? workChipLine(prev.waitingOn) : null) ||
      this.needs.transcriptLive().turnStartedAtMs !== prev.turnStartedAtMs ||
      inProgressToolUseIDs.size !== prev.inProgressToolUseIDs.size ||
      [...inProgressToolUseIDs].some(id => !prev.inProgressToolUseIDs.has(id))
    let latchReleased = false
    if (this.interruptPressedAtMs !== null) {
      const release = interruptLatchRelease(
        { pressedAtMs: this.interruptPressedAtMs },
        { inFlight, turnStartedAtMs: this.needs.transcriptLive().turnStartedAtMs },
      )
      if (release !== null) {
        connectorTrace({ ev: 'latch-release', sid: this.needs.sessionId(), road: release })
        this.interruptPressedAtMs = null
        this.interrupting = false
        this.hardStopping = false
        latchReleased = true
      }
    }
    if (!inFlight && this.needs.tailHeld()) this.needs.clearTail(Date.now())
    if (!inFlight) this.liveTurnChars = 0
    if (!inFlight) this.liveTurnOutputTokens = null
    if (!inFlight && (prev.inFlight || this.liveStateWord !== 'waiting-on-agents')) this.clearLiveStateWord()
    if (!inFlight) this.needs.dropRunningFoldAtIdle()
    if (!inFlight && this.publishedProgressSeqs.size > 0) {
      clearEphemeralProgress()
      this.publishedProgressSeqs.clear()
    }
    if (!inFlight && this.toolBudgets.size > 0) this.toolBudgets.clear()
    this.syncLivenessTicker(inFlight)
    this.needs.syncFeedCadence(inFlight)
    const completionAdvanced = this.needs.stepTurnCompletion(inFlight)
    if (!changed && !completionAdvanced) {
      if (latchReleased) emitAll(this.liveListeners, 'live')
      return
    }
    this.effectiveLive = {
      inFlight,
      phase,
      agentsWaiting,
      ...(waitingOn !== null && waitingOnWords !== null ? { waitingOn } : {}),
      inProgressToolUseIDs,
      turnStartedAtMs: this.needs.factsTurnStartedAt() ?? this.needs.transcriptLive().turnStartedAtMs ?? null,
    }
    emitAll(this.liveListeners, 'live')
  }

  pressInterrupt(): { hard: boolean; undo: () => void } | null {
    if (this.interrupting && this.hardStopping) return null
    const hard = this.interrupting
    if (hard) this.hardStopping = true
    else {
      this.interrupting = true
      this.interruptPressedAtMs = Date.now()
      this.needs.tailInterrupted(this.interruptPressedAtMs)
    }
    emitAll(this.liveListeners, 'live')
    connectorTrace({ ev: 'interrupt', sid: this.needs.sessionId(), hard, turnStartedAtMs: this.needs.transcriptLive().turnStartedAtMs })
    const undo = (): void => {
      if (hard) this.hardStopping = false
      else {
        this.interrupting = false
        this.interruptPressedAtMs = null
        this.needs.tailInterruptUndone()
      }
      emitAll(this.liveListeners, 'live')
    }
    return { hard, undo }
  }

  live(): SessionLiveV1 {
    return this.effectiveLive
  }

  subscribeLive(listener: () => void): () => void {
    this.liveListeners.add(listener)
    return () => {
      this.liveListeners.delete(listener)
    }
  }

  status(seat: Pick<SeatStatusV1, 'title' | 'projectLabel' | 'isolation' | 'branchLabel' | 'runner'>): SeatStatusV1 {
    const live = this.effectiveLive
    return seatStatusOf(seat, live, {
      now: Date.now(),
      lastEventAtMs: this.lastEventAtMs,
      wait: live.inFlight ? this.liveWait : null,
      waitCountsItsOwnAge: wait => this.waitCountsItsOwnAge(wait),
      streamIdleTimeoutMs: () => this.needs.streamIdleTimeoutMs(),
      toolStartedAtMs: inProgress => this.needs.toolStartedAtMs(inProgress),
      toolBudgets: this.toolBudgets,
      blockSinceMs: this.blockSinceMs,
      interrupting: this.interrupting,
      hardStopping: this.hardStopping,
    })
  }

  private waitCountsItsOwnAge(wait: Extract<RequestWaitV1, { kind: 'first-byte' }>): boolean {
    if (wait.promise === true) return true
    if (this.liveWaitOwnAge?.wait !== wait) this.liveWaitOwnAge = { wait, own: compatEndpointIsSelfHosted(this.needs.model()) }
    return this.liveWaitOwnAge.own
  }
}
