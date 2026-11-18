import { existsSync, statSync, watch, mkdirSync, type FSWatcher } from 'node:fs'
import { flagEnabled } from '../../substrate/flagRegistry.js'
import { armInactivityDeadline } from '../../utils/deadline.js'
import { resolveWatchRoot } from '../../utils/watchRoot.js'
import { basename, dirname, join } from 'node:path'
import type { Message } from '../../types/message.js'
import { readClearModelReceipt } from '../switchboard/sessionReceipts.js'
import type { ContentBlockParam } from '../../types/wire.js'
import type { PermissionMode } from '../../types/permissions.js'
import type { PastedContent } from '../../utils/config/schema.js'
import { storedImageRefBlock } from '../../utils/imageStore.js'
import { submitTrace } from '../../utils/submitTrace.js'
import { logForDebugging } from '../../utils/debug.js'
import { randomUUID } from 'node:crypto'
import type { SessionKitEditV1 } from '../../daemon/sessionKit.js'
import type { SpawnSwitchFacts, SpawnSwitchKind } from '../switchboard/spawnSwitches.js'

const BOTH_SWITCHES_ON: SpawnSwitchFacts = Object.freeze({
  subagents: Object.freeze({ on: true, source: 'default' as const }),
  workflows: Object.freeze({ on: true, source: 'default' as const }),
})
import { createUserMessage } from '../../utils/messages/factories.js'
import { createModelTransitionMessage, createSeatReceiptMessage } from '../../utils/messages/systemMessages.js'
import { providerFamilyOfSetting } from '../../utils/model/modelTransition.js'
import { createLiveTurnFold, deserializeLiveMessages, type LiveTurnFold } from '../../utils/conversationRecovery.js'
import type { TranscriptChainCursor } from '../../utils/sessionStorage/transcriptReader.js'
import { getEngineModel } from '../../utils/model/model.js'
import type { StreamingTailStore } from '../../utils/messages/streamingTailStore.js'
import { adoptOpenaiObservedUsage, adoptOpenaiWindowFact } from '../providers/openai/openaiLimitState.js'
import { adoptOpenaiCatalogueFact } from '../providers/openai/openaiCatalogue.js'
import { adoptAnthropicObservedUsage, adoptAnthropicWindowFact } from '../anthropicLimits.js'
import { mergeRecordsContentKeyed } from './recordIdentity.js'
import { placeLocalCommandRows } from './localCommandRows.js'
import { endedRunResults } from './endedRunCalls.js'
import {
  readSessionFacts,
  readSessionTail,
  sessionAsksDir,
  sessionAsksPath,
  sessionFactsDir,
  sessionFactsPath,
  sessionProgressDir,
  sessionProgressPath,
  sessionTailDir,
  sessionTailPath,
  type SessionFactsV1,
} from './seatProjections.js'
import { IDLE_LIVE, type LiveTurnFactsV1, type LostLineV1, type SeatLiveExtensionV1, type SeatStatusV1, type SessionLiveV1 } from './seatLive.js'
import { createNoticeRow, deliveredNoticeRow, foldClockOf, isNoticeFact, isNoticeKey, noticeKeyOf, noticeRowLanded, placeDeliveredNotices, queueOrderedSends } from './queuedNotices.js'
import { BASH_INPUT_TAG } from '../../constants/xml.js'
import { withoutRetractedReplies, type CommittedTextRow } from './midTurnText.js'
import type { FoldStatusV1 } from '../compact/foldStatus.js'
import { mcpToolsOfReply } from '../mcp/toolsAnswer.js'
import { getFocusedSessionConnector, setFocusedSessionConnector, subscribeFocusedSessionConnector, claimHopEpoch, hopEpochIsCurrent } from './focusedConnector.js'
import type {
  AdvisorFactsV1,
  AgentControlReceiptV1,
  AskAnswerV1,
  AskReceiptV1,
  BoardPostReceiptV1,
  BoardPostRequestV1,
  CheckpointFactsV1,
  EditOutcomeRowV1,
  EngineConnectorV1,
  KitDialReceiptV1,
  LeaveReceiptV1,
  SpawnSwitchReceiptV1,
  McpRosterV1,
  McpToolsV1,
  ModelFactsV1,
  ModelSwitchReceiptV1,
  PermissionModeReceiptV1,
  RewindReceiptV1,
  RewindRequestV1,
  SeatIdentityV1,
  RecallableSendV1,
  SendReceiptV1,
  SendWordsOptions,
  WithdrawReceiptV1,
  SessionAskV1,
  SkillsRosterV1,
  UsageFactsV1,
  WorkRosterV1,
  WorkspaceFactsV1,
} from './types.js'
import { bootBirthFacts, type BootBirthFacts } from '../switchboard/bootBirthFacts.js'
import { seatInitialPermissionMode } from '../../daemon/concourseWorkers.js'
import { AdmissionPart } from './daemon/admission.js'
import { AsksPart } from './daemon/asks.js'
import { CompletionPart } from './daemon/completion.js'
import { FoldPart } from './daemon/fold.js'
import { connectorTrace, ECHO_RETIRE_MS, emitAll, type Listeners } from './daemon/shared.js'
import { TailPart } from './daemon/tail.js'
import { LivePart } from './daemon/live.js'
import { WorkPart } from './daemon/work.js'
import { projectOperatorRewinds } from '../compact/checkpointRewind.js'

export interface DaemonSessionRecordV1 {
  sessionId: string
  runnerId: string
  title: string
  projectLabel: string
  workspaceId: string
  home: string
  isolation?: 'exclusive' | 'shared' | 'worktree-isolated' | 'read-only'
  branchLabel?: string
  modelKey?: string
  effort?: string
  worktreePath?: string
}

export function permissionModeOf(facts: Pick<SessionFactsV1, 'permissionMode'> | null, birth: Pick<BootBirthFacts, 'permissionMode'>): PermissionMode | null {
  const spoken = facts?.permissionMode
  if (spoken !== undefined) return spoken
  const born = birth.permissionMode
  return born === null ? null : (seatInitialPermissionMode(born) as PermissionMode)
}

interface SeatSend {
  clientMessageId: string
  text: string
  sentAtMs: number
  state: 'pending' | 'delivered' | 'queued' | 'taken'
  heldFor?: 'compaction'
  crossedRunner?: true
  mode: 'prompt' | 'bash'
  source?: { text: string; mode: 'prompt' | 'bash'; pastedContents: Record<number, PastedContent> }
  withdrawing?: true
}

const REFUSED_EMPTY: SendReceiptV1 = { state: 'refused', detail: 'nothing to send' }
export const RECALL_TAKEN_LINE = 'already taken — esc interrupts the turn'
export const RECALL_UNKNOWN_LINE = 'nothing queued to take back — esc interrupts the turn'
const QUOTED_WORDS_MAX = 32
function quoteWords(words: string): string {
  const folded = words.replace(/\s+/g, ' ').trim()
  return `"${folded.length > QUOTED_WORDS_MAX ? `${folded.slice(0, QUOTED_WORDS_MAX - 1).trimEnd()}…` : folded}"`
}
export function lostLine(words: string): string {
  return `the session did not take ${quoteWords(words)}; type it again`
}
export function lostWithRunnerLine(lines: readonly string[]): string {
  const named = lines.map(quoteWords).join(' · ')
  return lines.length === 1 ? `the runner restarted (${named} not taken); type it again` : `the runner restarted (${named} not taken); type them again`
}
const PENDING_WITHDRAW_WAIT_MS = 10_000

export function imageBlocksOf(pastes: Record<number, PastedContent>): ContentBlockParam[] {
  return Object.entries(pastes)
    .map(([id, content]) => ({ id: Number(id), content }))
    .filter(entry => entry.content.type === 'image' && Boolean(entry.content.content))
    .sort((a, b) => a.id - b.id)
    .map(
      entry =>
        (storedImageRefBlock(entry.content) ?? {
          type: 'image',
          source: { type: 'base64', media_type: entry.content.mediaType ?? 'image/png', data: entry.content.content },
        }) as unknown as ContentBlockParam,
    )
}
const RPC_TIMEOUT_MS = 15_000
const LEAVE_RPC_TIMEOUT_MS = 135_000
export const HEARTBEAT_MS = 400
const IDLE_TRANSCRIPT_FLOOR_MS = 2000
export const IDLE_PROJECTION_FLOOR_MS = 10_000
export const SEAT_VERB_SETTLE_MS = 4000
export const CARRIER_GONE_WORDS = 'the background daemon ended — the next prompt starts a new one'
const UUID_SHAPE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

const SEAT_BY = `operator:${process.pid}`

let seatChain: Promise<unknown> = Promise.resolve()
function seatVerb(action: 'focus' | 'blur', sessionId: string): void {
  seatChain = seatChain
    .then(async () => {
      const { daemonControlRpc } = await import('../../daemon/controlSocket.js')
      let terminalApplication: { identity: string; name: string; windowId?: string | null; tty?: string | null } | null | undefined
      if (action === 'focus' && flagEnabled('MERCURY_COMPUTER_USE')) {
        const { resolveDesktopDriver } = await import('../desktop/resolveDriver.js')
        const driver = resolveDesktopDriver()
        const terminal = driver.state === 'ok' ? await driver.driver.ownTerminalApplication() : null
        terminalApplication = terminal?.ok && terminal.value !== null ? { identity: terminal.value.identity, name: terminal.value.name, windowId: terminal.value.windowId ?? null, tty: terminal.value.tty ?? null } : null
      }
      const reply = (await daemonControlRpc({ op: 'sessionControl', action, sessionId, by: SEAT_BY, ...(terminalApplication !== undefined ? { terminalApplication } : {}) } as never, { timeoutMs: RPC_TIMEOUT_MS })) as { ok?: boolean; error?: string }
      if (reply.ok !== true) logForDebugging(`[engine-connector] ${action} ${sessionId} not applied: ${reply.error ?? 'no reply'}`)
    })
    .catch(e => logForDebugging(`[engine-connector] ${action} ${sessionId} threw: ${e}`))
}

function textOfUserRow(m: Message): string {
  if (m.type !== 'user') return ''
  if ((m as { isMeta?: boolean }).isMeta) return ''
  const content = (m as { message?: { content?: unknown } }).message?.content
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .map(b => ((b as { type?: string; text?: string }).type === 'text' ? ((b as { text?: string }).text ?? '') : ''))
      .join('')
  }
  return ''
}

export function projectionChangeKey(stat: { mtimeMs: number; size: number; ino: number }): string {
  return `${stat.mtimeMs}:${stat.size}:${stat.ino}`
}
export const PROJECTION_ABSENT = 'absent'

export class ProjectionFeed {
  private watcher: FSWatcher | null = null
  private timer: ReturnType<typeof setInterval> | null = null
  private timerMs = 0
  private lastKey = PROJECTION_ABSENT
  private settleUntilMs = 0
  private recheck: ReturnType<typeof setTimeout> | null = null
  constructor(
    private readonly dir: string,
    private readonly path: string,
    private readonly onChange: () => void,
    private readonly idleFloorMs: () => number = () => HEARTBEAT_MS,
  ) {}
  private readonly tick = (): boolean => {
    let key = PROJECTION_ABSENT
    try {
      key = projectionChangeKey(statSync(this.path))
    } catch {
      key = PROJECTION_ABSENT
    }
    if (key === this.lastKey) return false
    this.lastKey = key
    this.onChange()
    return true
  }
  private readonly report = (): void => {
    if (this.tick() || this.recheck !== null) return
    const recheck = setTimeout(() => {
      this.recheck = null
      this.tick()
    }, HEARTBEAT_MS)
    recheck.unref?.()
    this.recheck = recheck
  }
  private cadenceMs(): number {
    if (this.watcher === null) return HEARTBEAT_MS
    if (this.settleUntilMs > Date.now()) return HEARTBEAT_MS
    return this.idleFloorMs()
  }
  rearm(): void {
    if (this.timer === null) return
    const ms = this.cadenceMs()
    if (ms === this.timerMs) return
    clearInterval(this.timer)
    this.timer = setInterval(this.tick, ms)
    this.timer.unref?.()
    this.timerMs = ms
  }
  settle(windowMs: number): void {
    if (windowMs <= 0) return
    this.settleUntilMs = Math.max(this.settleUntilMs, Date.now() + windowMs)
    this.rearm()
    const revert = setTimeout(() => this.rearm(), windowMs)
    revert.unref?.()
  }
  heartbeatMs(): number {
    return this.timer === null ? 0 : this.timerMs
  }
  start(): void {
    if (this.timer !== null) return
    try {
      mkdirSync(this.dir, { recursive: true })
      const watcher = watch(resolveWatchRoot(this.dir), this.report)
      watcher.on('error', () => {
        try {
          watcher.close()
        } catch {
        }
        if (this.watcher === watcher) this.watcher = null
        this.rearm()
      })
      this.watcher = watcher
    } catch {
    }
    this.timerMs = this.cadenceMs()
    this.timer = setInterval(this.tick, this.timerMs)
    this.timer.unref?.()
    this.tick()
  }
  stop(): void {
    if (this.timer !== null) {
      clearInterval(this.timer)
      this.timer = null
      this.timerMs = 0
    }
    if (this.recheck !== null) {
      clearTimeout(this.recheck)
      this.recheck = null
    }
    try {
      this.watcher?.close()
    } catch {
    }
    this.watcher = null
    this.lastKey = PROJECTION_ABSENT
    this.settleUntilMs = 0
  }
}

export class DaemonSessionConnector implements EngineConnectorV1, SeatLiveExtensionV1 {
  readonly carrier = 'daemon' as const

  private rawRecords: Message[] = []
  private recordSigs: string[] = []
  private painted: readonly Message[] = []
  private keptRecords: readonly Message[] = []
  private answeredRows: readonly Message[] = []
  private liveState: SessionLiveV1 = IDLE_LIVE
  private factsBusy = false
  private busyStallDeadline: ReturnType<typeof armInactivityDeadline> | null = null
  private static readonly BUSY_STALL_MS = 45_000
  private carrierGoneTicks = 0
  private carrierGoneAtFactsMs: number | null = null
  private carrierProbeInFlight = false
  private carrierSeen = false
  private static readonly CARRIER_GONE_TICKS = 3

  private armBusyStall(): void {
    if (this.busyStallDeadline !== null) {
      this.busyStallDeadline.touch()
      return
    }
    const deadline = armInactivityDeadline({
      seam: 'engine-connector.factsBusy',
      limitMs: DaemonSessionConnector.BUSY_STALL_MS,
      advice: 'the chat turn indicator was busy with no facts movement — probing the session host',
    })
    this.busyStallDeadline = deadline
    void deadline.expiry.catch(() => {
      if (this.busyStallDeadline !== deadline) return
      this.busyStallDeadline = null
      this.probeStalledTurn()
    })
  }

  private disarmBusyStall(): void {
    this.busyStallDeadline?.cancel()
    this.busyStallDeadline = null
  }

  private probeStalledTurn(): void {
    void this.rpc({ op: 'sessionControl', action: 'session-facts', sessionId: this.record.sessionId, by: 'operator' })
      .then(reply => {
        const r = reply as { ok?: boolean; outcome?: string; detail?: string }
        if (r.ok === true && r.outcome !== 'refused') {
          if (this.factsBusy) this.armBusyStall()
          return
        }
        this.settleStalledTurn(`daemon: ${r.detail ?? r.outcome ?? 'refused'}`)
      })
      .catch(e => this.settleStalledTurn(`daemon unreachable: ${e}`))
  }

  private settleStalledTurn(why: string): void {
    if (!this.factsBusy) return
    logForDebugging(`[engine-connector] busy turn stalled ${DaemonSessionConnector.BUSY_STALL_MS}ms with no facts and no live runner — settling idle (${why})`)
    this.factsBusy = false
    this.recomputeLive()
  }

  private probeCarrier(): void {
    if (this.carrierProbeInFlight || this.carrierGoneAtFactsMs !== null) return
    this.carrierProbeInFlight = true
    void (async () => {
      const { readDaemonState } = await import('../../daemon/controlSocket.js')
      const { isProcessAlive } = await import('../../daemon/ownerWatch.js')
      const state = await readDaemonState()
      if (state === null) return this.carrierSeen ? 'gone' : 'unknown'
      if (state.state === 'stopping' || !isProcessAlive(state.pid)) return 'gone'
      this.carrierSeen = true
      return 'alive'
    })()
      .then(verdict => {
        if (verdict !== 'gone') {
          this.carrierGoneTicks = 0
          return
        }
        this.carrierGoneTicks += 1
        if (this.carrierGoneTicks >= DaemonSessionConnector.CARRIER_GONE_TICKS) this.settleCarrierGone()
      })
      .catch(() => {})
      .finally(() => {
        this.carrierProbeInFlight = false
      })
  }

  private settleCarrierGone(): void {
    if (this.carrierGoneAtFactsMs !== null) return
    this.carrierGoneAtFactsMs = this.facts?.atMs ?? 0
    logForDebugging(`[engine-connector] the daemon carrying ${this.record.sessionId} is gone (${DaemonSessionConnector.CARRIER_GONE_TICKS} reads) — settling idle, dropping its work rows, saying so`)
    this.factsBusy = false
    this.disarmBusyStall()
    if (this.facts !== null) this.facts = { ...this.facts, busy: false, work: [], mission: [], samples: [] }
    this.workPart.refreshWork()
    this.recomputeLive()
    this.addDisplayRow(createSeatReceiptMessage(CARRIER_GONE_WORDS, 'warning') as unknown as Message)
  }

  private factsFromCarrier(next: SessionFactsV1): SessionFactsV1 {
    if (this.carrierGoneAtFactsMs === null) return next
    if (next.atMs !== this.carrierGoneAtFactsMs) {
      this.carrierGoneAtFactsMs = null
      this.carrierGoneTicks = 0
      return next
    }
    return { ...next, busy: false, work: [], mission: [], samples: [] }
  }
  private displayRows: Array<{ row: Message; anchor: number }> = []
  private clearModelReceipt: Message | null | undefined
  private echoRows = new Map<string, Message>()
  private deliveredNotices = new Map<string, { row: Message; text: string; sentAtMs: number; seq: number }>()
  private sends: SeatSend[] = []
  private sendSeq = new Map<string, number>()
  private rowsAfterTail = 0
  private textRetiredRowUuids = new Set<string>()
  private retainedSend: { text: string; id: string } | null = null
  private lastSize = -1
  private lastLen = -1
  private transcriptUnreadableFp: string | null = null
  private chainCursor: TranscriptChainCursor | null = null
  private readonly liveFold: LiveTurnFold = createLiveTurnFold()
  private releaseTranscript: (() => void) | null = null
  private transcriptWatcher: FSWatcher | null = null
  private transcriptTimer: ReturnType<typeof setInterval> | null = null
  private transcriptTimerMs = 0
  private turnInFlight = false
  private tickInFlight: Promise<void> | null = null
  private tickDirty = false
  private readonly transcriptPath: string
  private readonly recordListeners: Listeners = new Set()

  private facts: SessionFactsV1 | null
  private readonly completionPart: CompletionPart
  private readonly admissionPart = new AdmissionPart({ wakeLive: () => this.livePart.wake() })
  private readonly factsFeed: ProjectionFeed
  private readonly modelListeners: Listeners = new Set()
  private readonly permissionListeners: Listeners = new Set()
  private readonly workPart = new WorkPart({ facts: () => this.facts, carrierGone: () => this.carrierGoneAtFactsMs !== null })

  private readonly asksPart = new AsksPart({
    record: () => this.record,
    rows: () => this.rawRecords,
    facts: () => this.facts,
    permissionMode: () => this.permissionMode(),
    chainRpc: req => this.chainRpc(req),
    deliver: (text, opts) => this.deliver(text, opts),
  })
  private readonly asksFeed: ProjectionFeed

  private readonly tailFeed: ProjectionFeed
  private readonly tailPart = new TailPart({
    sessionId: () => this.record.sessionId,
    rows: () => this.rawRecords,
    model: () => this.modelFacts().effective,
    paint: () => this.paint(),
  })
  private runnerGeneration: number | null = null
  private lostLineNotice: LostLineV1 | null = null
  private readonly foldPart = new FoldPart({ recomputeLive: () => this.recomputeLive() })
  private readonly livePart: LivePart = new LivePart({
    sessionId: () => this.record.sessionId,
    attached: () => this.attached,
    factsBusy: () => this.factsBusy,
    work: () => this.facts?.work ?? [],
    factsTurnStartedAt: () => this.facts?.turnStartedAt,
    streamIdleTimeoutMs: () => (typeof this.facts?.streamIdleTimeoutMs === 'number' ? this.facts.streamIdleTimeoutMs : undefined),
    model: () => this.modelFacts().effective,
    anySendDelivered: () => this.sends.some(s => s.state === 'delivered'),
    redressQueuedSends: () => {
      for (const s of this.sends) if (s.state === 'queued') this.dressSend(s.clientMessageId, 'queued')
    },
    transcriptLive: () => this.liveState,
    toolStartedAtMs: inProgress => this.toolStartedAtMs(inProgress),
    tailHeld: () => this.tailPart.store().read() !== null,
    clearTail: atMs => this.tailPart.clearTail(atMs),
    tailInterrupted: atMs => this.tailPart.interrupted(atMs),
    tailInterruptUndone: () => this.tailPart.interruptUndone(),
    foldStillRuns: () => this.foldPart.stillRuns(),
    setLiveFold: next => this.foldPart.setLiveFold(next),
    dropRunningFoldAtIdle: () => this.foldPart.dropRunningAtIdle(),
    stepTurnCompletion: inFlight => this.completionPart.stepTurnCompletion(inFlight),
    syncFeedCadence: inFlight => this.syncFeedCadence(inFlight),
    probeCarrier: () => this.probeCarrier(),
  })

  private readonly progressFeed: ProjectionFeed

  private attached = false

  constructor(readonly record: DaemonSessionRecordV1) {
    this.transcriptPath = join(record.home, `${record.sessionId}.jsonl`)
    this.facts = readSessionFacts(record.sessionId)
    this.factsBusy = this.facts?.busy ?? false
    this.completionPart = new CompletionPart({
      sessionId: () => this.record.sessionId,
      factsBusy: () => this.factsBusy,
      hasUnreadTranscript: () => this.hasUnreadTranscript(),
      tick: () => this.tick(),
    })
    this.admissionPart.seed(this.facts?.atMs ?? null, record.runnerId === '')
    this.workPart.refreshWork()
    const idleFloor = (): number => (this.turnInFlight ? HEARTBEAT_MS : IDLE_PROJECTION_FLOOR_MS)
    this.factsFeed = new ProjectionFeed(sessionFactsDir(), sessionFactsPath(record.sessionId), () => this.readFacts(), idleFloor)
    this.asksFeed = new ProjectionFeed(sessionAsksDir(), sessionAsksPath(record.sessionId), () => this.readAsks(), idleFloor)
    this.tailFeed = new ProjectionFeed(sessionTailDir(), sessionTailPath(record.sessionId), () => this.readTail(), idleFloor)
    this.progressFeed = new ProjectionFeed(sessionProgressDir(), sessionProgressPath(record.sessionId), () => this.livePart.readProgress(), idleFloor)
    this.readAsks()
    this.workPart.refreshWork()
    this.workPart.refreshCheckpoints()
  }


  attach(): Promise<void> {
    if (this.attached) return Promise.resolve()
    this.attached = true
    connectorTrace({ ev: 'attach', sid: this.record.sessionId, raw: this.rawRecords.length, display: this.displayRows.length })
    this.armTranscriptWatcher()
    this.armTranscriptTimer()
    this.factsFeed.start()
    this.asksFeed.start()
    this.tailFeed.start()
    this.progressFeed.start()
    void this.rpc({ op: 'sessionControl', action: 'session-facts', sessionId: this.record.sessionId, by: 'operator' }).catch(() => {})
    seatVerb('focus', this.record.sessionId)
    return this.tick()
  }

  detach(): void {
    this.disarmBusyStall()
    if (!this.attached) return
    this.attached = false
    this.livePart.syncLivenessTicker(false)
    connectorTrace({ ev: 'detach', sid: this.record.sessionId, raw: this.rawRecords.length, display: this.displayRows.length })
    if (this.transcriptTimer !== null) {
      clearInterval(this.transcriptTimer)
      this.transcriptTimer = null
      this.transcriptTimerMs = 0
    }
    try {
      this.transcriptWatcher?.close()
    } catch {
    }
    this.transcriptWatcher = null
    this.releaseTranscript?.()
    this.releaseTranscript = null
    this.factsFeed.stop()
    this.asksFeed.stop()
    this.tailFeed.stop()
    this.progressFeed.stop()
    seatVerb('blur', this.record.sessionId)
    this.tailPart.detached()
    this.livePart.detached()
  }

  private readTail(): void {
    const tail = readSessionTail(this.record.sessionId)
    if (tail === null) {
      this.livePart.tailGone()
      this.tailPart.clearTail(Date.now())
      return
    }
    this.livePart.takeTail(tail)
    this.tailPart.takeTail(tail)
  }

  turnChars(): number {
    return this.livePart.turnChars()
  }

  turnOutputTokens(): number | null {
    return this.livePart.turnOutputTokens()
  }

  turnFacts(): LiveTurnFactsV1 {
    return this.livePart.turnFacts()
  }

  fold(): FoldStatusV1 | null {
    return this.foldPart.fold()
  }

  subscribeFold(listener: () => void): () => void {
    return this.foldPart.subscribeFold(listener)
  }

  private get liveStateWord(): 'compacting' | 'waiting-on-agents' | null {
    return this.livePart.stateWord()
  }

  private syncFeedCadence(inFlight: boolean): void {
    if (this.turnInFlight === inFlight) return
    this.turnInFlight = inFlight
    this.armTranscriptTimer()
    this.factsFeed.rearm()
    this.asksFeed.rearm()
    this.tailFeed.rearm()
    this.progressFeed.rearm()
  }

  private armTranscriptWatcher(): void {
    if (this.transcriptWatcher !== null) return
    try {
      const dir = dirname(this.transcriptPath)
      const name = basename(this.transcriptPath)
      const watcher = watch(resolveWatchRoot(dir), (_event, filename) => {
        if (filename === undefined || filename === null || String(filename) === name) void this.tick()
      })
      watcher.on('error', () => {
        try {
          watcher.close()
        } catch {
        }
        if (this.transcriptWatcher === watcher) this.transcriptWatcher = null
        this.armTranscriptTimer()
      })
      this.transcriptWatcher = watcher
    } catch {
    }
  }

  private armTranscriptTimer(): void {
    if (!this.attached) return
    const ms = this.transcriptWatcher === null || this.turnInFlight ? HEARTBEAT_MS : IDLE_TRANSCRIPT_FLOOR_MS
    if (this.transcriptTimer !== null && this.transcriptTimerMs === ms) return
    if (this.transcriptTimer !== null) clearInterval(this.transcriptTimer)
    const timer = setInterval(() => void this.tick(), ms)
    timer.unref?.()
    this.transcriptTimer = timer
    this.transcriptTimerMs = ms
  }

  feedCadencesForProofs(): { transcript: number; facts: number; asks: number; tail: number; progress: number } {
    return {
      transcript: this.transcriptTimer === null ? 0 : this.transcriptTimerMs,
      facts: this.factsFeed.heartbeatMs(),
      asks: this.asksFeed.heartbeatMs(),
      tail: this.tailFeed.heartbeatMs(),
      progress: this.progressFeed.heartbeatMs(),
    }
  }

  private toolStartedAtMs(inProgress: ReadonlySet<string>): number | null {
    let earliest: number | null = null
    for (let i = this.rawRecords.length - 1; i >= 0; i--) {
      const row = this.rawRecords[i] as { type?: string; timestamp?: string; message?: { content?: unknown } } | undefined
      if (row?.type !== 'assistant' || !Array.isArray(row.message?.content)) continue
      const carries = (row.message.content as Array<{ type?: string; id?: string }>).some(b => b.type === 'tool_use' && typeof b.id === 'string' && inProgress.has(b.id))
      if (!carries) continue
      const at = typeof row.timestamp === 'string' ? Date.parse(row.timestamp) : Number.NaN
      if (Number.isNaN(at)) continue
      earliest = earliest === null ? at : Math.min(earliest, at)
    }
    return earliest
  }

  isAttached(): boolean {
    return this.attached
  }

  assertSeat(): void {
    if (this.attached) seatVerb('focus', this.record.sessionId)
  }

  addDisplayRow(row: Message): void {
    const subtype = (row as { subtype?: string }).subtype
    const kept =
      row.type === 'system' && subtype === 'away_summary'
        ? this.displayRows.filter(d => !(d.row.type === 'system' && (d.row as { subtype?: string }).subtype === 'away_summary'))
        : this.displayRows
    connectorTrace({ ev: 'display-row', sid: this.record.sessionId, anchor: this.rawRecords.length, subtype: subtype ?? row.type, display: kept.length + 1 })
    this.displayRows = [...kept, { row, anchor: this.rawRecords.length }]
    this.paint()
  }

  private releaseDisplayRowsPast(since: number): void {
    const kept = this.displayRows.filter(d => d.anchor <= since)
    if (kept.length === this.displayRows.length) return
    connectorTrace({ ev: 'display-release', sid: this.record.sessionId, since, released: this.displayRows.length - kept.length, display: kept.length })
    this.displayRows = kept
  }

  transcriptFile(): string {
    return this.transcriptPath
  }

  adoptRecord(next: DaemonSessionRecordV1, runnerLive = false): void {
    if (next.sessionId !== this.record.sessionId) return
    if (this.admissionPart.parksAgain(next.runnerId)) {
      this.facts = readSessionFacts(next.sessionId) ?? this.facts
      this.admissionPart.parked(this.facts?.atMs ?? null)
    }
    Object.assign(this.record, next)
    if (runnerLive) this.admissionPart.runnerLive()
    emitAll(this.modelListeners, 'model')
    this.livePart.wake()
  }

  awaitAdmission(admission: Promise<string | null>): void {
    this.admissionPart.awaitAdmission(admission)
  }

  admissionRefusal(): string | null {
    return this.admissionPart.admissionRefusal()
  }


  private tick(): Promise<void> {
    if (this.tickInFlight !== null) {
      this.tickDirty = true
      return this.tickInFlight
    }
    const flight = (async () => {
      try {
        do {
          this.tickDirty = false
          await this.tickOnce()
        } while (this.tickDirty && this.attached)
      } finally {
        this.tickInFlight = null
      }
    })()
    this.tickInFlight = flight
    return flight
  }

  private async tickOnce(): Promise<void> {
    if (!this.attached) return
    let fpNow: string | null = null
    try {
      let sizeNow = -1
      try {
        const st = statSync(this.transcriptPath, { bigint: true })
        sizeNow = Number(st.size)
        fpNow = `${st.dev}:${st.ino}:${st.size}:${st.mtimeNs}:${st.ctimeNs}`
      } catch {
        sizeNow = -1
      }
      connectorTrace({ ev: 'tick', sid: this.record.sessionId, sizeNow, lastSize: this.lastSize, lastLen: this.lastLen })
      if (sizeNow === this.lastSize && this.lastLen >= 0) return
      if (sizeNow !== -1 && this.transcriptWatcher === null) {
        this.armTranscriptWatcher()
        this.armTranscriptTimer()
      }
      const reader = await import('../../utils/sessionStorage/transcriptReader.js')
      if (this.releaseTranscript === null) this.releaseTranscript = reader.retainTranscript(this.transcriptPath)
      const chain = await reader.readTranscriptChainSince(this.transcriptPath, this.chainCursor)
      if (!this.attached) return
      this.transcriptUnreadableFp = null
      this.chainCursor = chain.cursor
      const raw = chain.rows as unknown as Message[]
      this.lastSize = sizeNow
      this.lastLen = raw.length
      const since = chain.since <= this.rawRecords.length && chain.since <= this.recordSigs.length ? chain.since : 0
      const tail = (since === 0 ? raw : (chain.appended as unknown as Message[]))
      const merge = mergeRecordsContentKeyed(
        this.rawRecords,
        this.recordSigs,
        raw,
        deserializeLiveMessages(tail),
        reader.chainRowSigner(),
        since,
      )
      this.recordSigs = merge.sigs
      connectorTrace({ ev: 'load', sid: this.record.sessionId, rawLen: raw.length, reusedAll: merge.reusedAll, prevLen: this.rawRecords.length, since: chain.since, rewound: chain.rewound })
      if (merge.reusedAll) {
        this.recomputeLive()
        return
      }
      this.rawRecords = merge.records
      if (chain.rewound) {
        this.releaseDisplayRowsPast(chain.since)
        this.tailPart.dropCommittedRows()
      }
      this.liveState = this.liveFold.fold(this.rawRecords, chain.since)
      this.tailPart.releaseTail()
      this.reconcileSends()
      this.tailPart.retireTextRows()
      this.paint()
      if (this.admissionPart.awaiting() || this.facts?.runner?.state === 'starting') this.readFacts()
      this.recomputeLive()
    } catch (error) {
      if (fpNow !== null) this.transcriptUnreadableFp = fpNow
      connectorTrace({ ev: 'tick-error', sid: this.record.sessionId, message: error instanceof Error ? error.message : String(error) })
      if (this.attached) this.recomputeLive()
    }
  }

  private recomputeLive(): void {
    this.livePart.recomputeLive()
  }

  lastTurnCompletedAtMs(): number | null {
    return this.completionPart.lastTurnCompletedAtMs()
  }

  private hasUnreadTranscript(): boolean {
    if (!this.attached) return false
    try {
      const st = statSync(this.transcriptPath, { bigint: true })
      const sizeNow = Number(st.size)
      if (sizeNow <= 0 || sizeNow === this.lastSize) return false
      const fp = `${st.dev}:${st.ino}:${st.size}:${st.mtimeNs}:${st.ctimeNs}`
      return fp !== this.transcriptUnreadableFp
    } catch {
      return false
    }
  }

  private reconcileQueuedSends(facts: SessionFactsV1): void {
    if (facts.queueReady === false) return
    const queue = facts.queue ?? []
    if (typeof facts.runnerGeneration === 'number') {
      const moved = this.runnerGeneration !== null && facts.runnerGeneration !== this.runnerGeneration
      this.runnerGeneration = facts.runnerGeneration
      if (moved) {
        if (this.reconcileSends()) this.paint()
        this.retireSendsLostWithRunner(queue, facts.recoveredCommandIds)
        this.tailPart.retireTextRowsWithRunner()
      }
    }
    let born = false
    for (const entry of queue) {
      if (!isNoticeFact(entry)) continue
      const key = noticeKeyOf(entry.value)
      if (this.sends.some(s => s.clientMessageId === key)) continue
      const atMs = Date.now()
      this.sends = [...this.sends, { clientMessageId: key, text: entry.value, sentAtMs: atMs, state: 'queued', mode: 'prompt' }]
      this.stampArrival(key, atMs)
      this.echoRows.set(key, createNoticeRow(entry.value, atMs, entry.origin))
      connectorTrace({ ev: 'notice', sid: this.record.sessionId, state: 'queued' })
      born = true
    }
    if (this.sends.length === 0) return
    const queuedIds = new Set<string>()
    for (const entry of queue) {
      if (typeof entry.uuid === 'string') queuedIds.add(entry.uuid)
      if (isNoticeFact(entry)) queuedIds.add(noticeKeyOf(entry.value))
    }
    for (const s of this.sends) {
      if (s.state === 'pending' || s.withdrawing === true) continue
      if (queuedIds.has(s.clientMessageId)) {
        if (s.state !== 'queued') this.dressSend(s.clientMessageId, 'queued')
      } else if (s.state === 'queued' || (s.state === 'delivered' && facts.atMs >= s.sentAtMs)) {
        this.dressSend(s.clientMessageId, 'taken', facts.atMs)
      }
    }
    const ordered = queueOrderedSends(this.sends, queue)
    const moved = ordered.some((entry, i) => entry !== this.sends[i])
    if (moved) this.sends = ordered
    if (born || moved) this.paint()
  }

  private dressSend(clientMessageId: string, state: SeatSend['state'], takenAtMs = Date.now()): void {
    const current = this.sends.find(s => s.clientMessageId === clientMessageId)
    if (state === 'taken' && isNoticeKey(clientMessageId) && current !== undefined) {
      const row = this.echoRows.get(clientMessageId)
      if (row !== undefined) {
        const atMs = Number.isFinite(takenAtMs) ? Math.max(current.sentAtMs, takenAtMs) : Date.now()
        const seq = this.tailPart.noticeSeqAt(atMs)
        this.deliveredNotices.set(row.uuid, { row: deliveredNoticeRow(row, atMs), text: current.text, sentAtMs: current.sentAtMs, seq })
      }
      this.sends = this.sends.filter(s => s.clientMessageId !== clientMessageId)
      this.echoRows.delete(clientMessageId)
      this.sendSeq.delete(clientMessageId)
      this.paint()
      return
    }
    if (current?.state === 'delivered' && state === 'queued') {
      this.completionPart.noteSendDemoted()
    } else if (current?.state === 'delivered' && state === 'taken') {
      this.completionPart.noteSendTaken()
    }
    const enqueuedUnderTheFold = current !== undefined && (current.state !== 'queued' || current.heldFor === 'compaction')
    const heldFor = state === 'queued' && this.liveStateWord === 'compacting' && enqueuedUnderTheFold ? ('compaction' as const) : undefined
    this.sends = this.sends.map(s => {
      if (s.clientMessageId !== clientMessageId) return s
      const next: SeatSend = { ...s, state }
      if (heldFor !== undefined) next.heldFor = heldFor
      else delete next.heldFor
      return next
    })
    const row = this.echoRows.get(clientMessageId) as (Message & { queued?: true; heldFor?: 'compaction' }) | undefined
    if (row === undefined) return
    const queued = state === 'queued'
    if (queued === (row.queued === true) && heldFor === row.heldFor) return
    const next: Message & { queued?: true; heldFor?: 'compaction' } = queued
      ? { ...row, queued: true }
      : isNoticeKey(clientMessageId)
        ? deliveredNoticeRow(row, Date.now())
        : { ...row, timestamp: new Date().toISOString() }
    if (!queued) delete next.queued
    if (heldFor !== undefined) next.heldFor = heldFor
    else delete next.heldFor
    this.echoRows.set(clientMessageId, next)
    this.paint()
  }

  heldForCompaction(): string[] {
    return this.sends.filter(s => s.heldFor === 'compaction').map(s => s.clientMessageId)
  }

  private retireSendsLostWithRunner(queue: SessionFactsV1['queue'], recoveredCommandIds: readonly string[] = []): void {
    const listed = new Set<string>(recoveredCommandIds.filter(id => typeof id === 'string'))
    for (const entry of queue) if (typeof entry.uuid === 'string') listed.add(entry.uuid)
    this.sends = this.sends.map(s => s.state === 'queued' && listed.has(s.clientMessageId) ? { ...s, crossedRunner: true as const } : s)
    const lost = this.sends.filter(
      s => s.state === 'queued' && s.withdrawing !== true && !isNoticeKey(s.clientMessageId) && !listed.has(s.clientMessageId),
    )
    if (lost.length === 0) return
    const gone = new Set(lost.map(s => s.clientMessageId))
    for (const id of gone) this.echoRows.delete(id)
    this.sends = this.sends.filter(s => !gone.has(s.clientMessageId))
    if (this.sends.length === 0) this.textRetiredRowUuids.clear()
    this.lostLineNotice = { text: lostWithRunnerLine(lost.map(s => s.source?.text ?? s.text)), atMs: Date.now() }
    connectorTrace({ ev: 'lost', sid: this.record.sessionId, reason: 'runner-relaunched', count: lost.length })
    this.paint()
    this.livePart.wake()
  }

  private retireSendUnknownToRunner(clientMessageId: string): void {
    this.sends = this.sends.filter(s => s.clientMessageId !== clientMessageId)
    this.echoRows.delete(clientMessageId)
    if (this.sends.length === 0) this.textRetiredRowUuids.clear()
    connectorTrace({ ev: 'lost', sid: this.record.sessionId, reason: 'unknown' })
    this.paint()
    this.livePart.wake()
  }

  lostLine(): LostLineV1 | null {
    return this.lostLineNotice
  }

  transcriptStoreFailing(): string | null {
    return this.facts?.transcriptStoreFailing ?? null
  }

  private reconcileSends(): boolean {
    if (this.sends.length === 0) return false
    const now = Date.now()
    const landed = new Set<string>()
    const identityKeys = new Set(this.sends.filter(s => UUID_SHAPE.test(s.clientMessageId)).map(s => s.clientMessageId))
    for (let i = this.rawRecords.length - 1; i >= 0 && landed.size < identityKeys.size; i--) {
      const row = this.rawRecords[i]!
      if (row.type === 'user') {
        const ids = [row.uuid, ...((row as { batchUuids?: string[] }).batchUuids ?? [])]
        if (ids.some(id => identityKeys.has(id))) {
          for (const id of ids) if (identityKeys.has(id)) landed.add(id)
          this.textRetiredRowUuids.add(row.uuid)
        }
      } else if (row.type === 'attachment' && row.attachment.type === 'queued_command') {
        const id = row.attachment.source_uuid
        if (id !== undefined && identityKeys.has(id)) landed.add(id)
      } else if (row.type === 'system' && identityKeys.has(row.uuid)) {
        landed.add(row.uuid)
      }
    }
    for (const s of this.sends) {
      if (landed.has(s.clientMessageId)) continue
      if (now - s.sentAtMs > ECHO_RETIRE_MS && s.state !== 'queued') {
        landed.add(s.clientMessageId)
        continue
      }
      if (isNoticeKey(s.clientMessageId)) {
        for (let i = this.rawRecords.length - 1; i >= 0; i--) {
          if (noticeRowLanded(this.rawRecords[i]!, s.text, s.sentAtMs)) {
            landed.add(s.clientMessageId)
            break
          }
        }
        continue
      }
      const idKeyed = UUID_SHAPE.test(s.clientMessageId)
      if (idKeyed && s.crossedRunner !== true) continue
      for (let i = this.rawRecords.length - 1; i >= 0; i--) {
        const m = this.rawRecords[i]!
        if (m.type !== 'user') continue
        const rowUuid = (m as { uuid?: string }).uuid
        if (rowUuid !== undefined && this.textRetiredRowUuids.has(rowUuid)) continue
        const ts = Date.parse((m as { timestamp?: string }).timestamp ?? '')
        if (s.crossedRunner === true) {
          if (!Number.isFinite(ts) || ts < s.sentAtMs || m.isMeta === true) continue
        } else if (!Number.isNaN(ts) && ts + 1000 < s.sentAtMs) continue
        const text = textOfUserRow(m)
        if (text !== '' && (s.crossedRunner === true ? text === s.text : text.includes(s.text))) {
          if (rowUuid !== undefined) this.textRetiredRowUuids.add(rowUuid)
          landed.add(s.clientMessageId)
          break
        }
      }
    }
    if (landed.size === 0) return false
    connectorTrace({ ev: 'send-landed', sid: this.record.sessionId, count: landed.size })
    this.sends = this.sends.filter(s => !landed.has(s.clientMessageId))
    for (const id of landed) this.echoRows.delete(id)
    if (this.sends.length === 0) this.textRetiredRowUuids.clear()
    return true
  }

  private stampArrival(clientMessageId: string, seenAtMs?: number): void {
    this.sendSeq.set(clientMessageId, this.tailPart.arrivalSeqFor(seenAtMs))
  }

  private paint(): void {
    const held: Array<{ seq: number; row: Message }> = []
    const afterTail: Message[] = []
    const live = new Set<string>()
    const tailSeq = this.tailPart.seq()
    for (const s of this.sends) {
      live.add(s.clientMessageId)
      const row = this.echoRows.get(s.clientMessageId)
      if (row === undefined) continue
      const seq = this.sendSeq.get(s.clientMessageId) ?? 0
      if (tailSeq !== null && seq > tailSeq) afterTail.push(row)
      else held.push({ seq, row })
    }
    for (const key of this.sendSeq.keys()) if (!live.has(key)) this.sendSeq.delete(key)
    const foldAtMs = this.deliveredNotices.size === 0 ? Number.NaN : foldClockOf(this.rawRecords)
    for (const [key, notice] of this.deliveredNotices) {
      if (Date.parse(notice.row.timestamp) < foldAtMs || this.rawRecords.some(row => noticeRowLanded(row, notice.text, notice.sentAtMs))) {
        this.deliveredNotices.delete(key)
        continue
      }
      if (tailSeq !== null && notice.seq > tailSeq) afterTail.push(notice.row)
      else held.push({ seq: notice.seq, row: notice.row })
    }
    held.sort((a, b) => a.seq - b.seq)
    for (const committed of this.textRows) {
      const at = held.findIndex(entry => entry.seq > committed.seq)
      const entry = { seq: committed.seq, row: committed.row }
      if (at === -1) held.push(entry)
      else held.splice(at, 0, entry)
    }
    const echoes: Message[] = [...held.map(entry => entry.row), ...afterTail]
    this.rowsAfterTail = afterTail.length
    const kept = withoutRetractedReplies(projectOperatorRewinds(this.rawRecords))
    const dropped = kept.length === this.rawRecords.length ? null : new Set<Message>(kept)
    const answered = endedRunResults(kept, this.facts, this.carrierGoneAtFactsMs !== null)
    this.keptRecords = kept
    this.answeredRows = answered
    if (echoes.length === 0 && this.displayRows.length === 0 && dropped === null && answered.length === 0) {
      this.painted = this.rawRecords
    } else {
      const rows: Message[] = []
      let d = 0
      for (let i = 0; i <= this.rawRecords.length; i++) {
        if (i === this.rawRecords.length) rows.push(...answered)
        while (d < this.displayRows.length && this.displayRows[d]!.anchor <= i) rows.push(this.displayRows[d++]!.row)
        if (i < this.rawRecords.length) {
          const record = this.rawRecords[i]!
          if (dropped === null || dropped.has(record)) rows.push(record)
        }
      }
      while (d < this.displayRows.length) rows.push(this.displayRows[d++]!.row)
      this.painted = [...rows, ...echoes]
    }
    if (this.clearModelReceipt === undefined) {
      try { this.clearModelReceipt = readClearModelReceipt(this.record.home, this.record.sessionId) }
      catch (error) { logForDebugging(`[engine-connector] clear receipt unreadable: ${error}`) }
    }
    if (this.clearModelReceipt != null && !this.rawRecords.some(row => row.uuid === this.clearModelReceipt!.uuid)) {
      this.painted = [this.clearModelReceipt, ...this.painted]
    }
    this.painted = placeLocalCommandRows(placeDeliveredNotices(this.painted, this.deliveredNotices))
    connectorTrace({ ev: 'paint', sid: this.record.sessionId, raw: this.rawRecords.length, display: this.displayRows.length, echoes: echoes.length, painted: this.painted.length, listeners: this.recordListeners.size })
    emitAll(this.recordListeners, 'records')
  }


  checkpointFacts(): CheckpointFactsV1 {
    return this.workPart.checkpointFacts()
  }

  subscribeCheckpoints(listener: () => void): () => void {
    return this.workPart.subscribeCheckpoints(listener)
  }

  async rewind(req: RewindRequestV1): Promise<RewindReceiptV1> {
    try {
      const reply = await this.chainRpc(req.undo === true || req.filePath !== undefined ? {
        op: 'sessionFileRestore',
        sessionId: this.record.sessionId,
        by: 'operator',
        userMessageId: req.userMessageId,
        ...(req.undo === true ? { action: 'undo' } : { action: 'restore', filePath: req.filePath! }),
        ...(req.dryRun === true ? { dryRun: true } : {}),
      } : {
        op: 'sessionRewind',
        sessionId: this.record.sessionId,
        by: 'operator',
        mode: req.mode,
        userMessageId: req.userMessageId,
        ...(req.dryRun === true ? { dryRun: true } : {}),
      })
      if (reply.ok !== true) {
        const error = typeof reply.error === 'string' ? reply.error : ''
        if (reply.refusal === 'daemon-older') {
          return { outcome: 'refused', mode: req.mode, refusal: 'daemon-older', detail: error }
        }
        return { outcome: 'refused', mode: req.mode, refusal: 'restore-failed', detail: `${error !== '' ? error : 'the daemon refused the rewind'} — nothing is assumed restored` }
      }
      const outcome = reply.outcome
      if (outcome !== 'applied' && outcome !== 'refused' && outcome !== 'noop') {
        return { outcome: 'refused', mode: req.mode, refusal: 'restore-failed', detail: `unexpected outcome ${String(outcome)}` }
      }
      const r = reply as unknown as RewindReceiptV1
      const receipt: RewindReceiptV1 = {
        outcome,
        mode: req.mode,
        ...(r.refusal !== undefined ? { refusal: r.refusal } : {}),
        ...(typeof r.detail === 'string' && r.detail !== '' ? { detail: r.detail } : {}),
        ...(r.dryRun === true ? { dryRun: true } : {}),
        ...(r.code !== undefined ? { code: r.code } : {}),
        ...(r.conversation !== undefined ? { conversation: r.conversation } : {}),
      }
      if (receipt.outcome === 'applied' && receipt.conversation !== undefined && receipt.dryRun !== true) void this.tick()
      return receipt
    } catch (e) {
      return { outcome: 'refused', mode: req.mode, refusal: 'restore-failed', detail: `the daemon is not answering — nothing is assumed restored (${e instanceof Error ? e.message : String(e)})` }
    }
  }


  private readFacts(): void {
    const next = readSessionFacts(this.record.sessionId)
    if (next === null) {
      if (this.facts !== null && ((this.facts.work?.length ?? 0) > 0 || (this.facts.mission?.length ?? 0) > 0 || (this.facts.samples?.length ?? 0) > 0) && !existsSync(sessionFactsPath(this.record.sessionId))) {
        this.facts = { ...this.facts, work: [], mission: [], samples: [] }
        this.workPart.refreshWork()
      }
      return
    }
    if (!this.admissionPart.factsArrive(next.atMs)) return
    const prev = this.facts
    this.facts = this.factsFromCarrier(next)
    this.admissionPart.runnerReported(this.facts.runner)
    this.workPart.refreshCheckpoints()
    adoptOpenaiObservedUsage(next.usage?.openaiObserved)
    adoptOpenaiWindowFact(next.usage?.openaiWindow)
    adoptAnthropicWindowFact(next.usage?.anthropicWindow)
    adoptAnthropicObservedUsage(next.usage?.anthropicObserved)
    if (next.openaiCatalogue !== undefined && next.openaiCatalogue.fetchedAtMs !== prev?.openaiCatalogue?.fetchedAtMs) {
      adoptOpenaiCatalogueFact(next.openaiCatalogue)
    }
    const settled = next.modelSettled
    if (
      prev !== null &&
      settled !== undefined &&
      prev.modelSettled?.atMs !== settled.atMs
    ) {
      this.addDisplayRow(
        createModelTransitionMessage({
          previous: settled.from,
          requested: settled.to,
          applied: settled.to,
          resolution: 'applied',
          boundary: 'turn-boundary',
          crossProvider:
            providerFamilyOfSetting(settled.from) !==
            providerFamilyOfSetting(settled.to),
          cacheDisposition: 'keyed-sections-recompute-once',
        }) as unknown as Message,
      )
    }
    const modelMoved =
      prev === null ||
      prev.model.effective !== next.model.effective ||
      prev.model.setting !== next.model.setting ||
      prev.pendingModel !== next.pendingModel ||
      prev.effort !== next.effort ||
      prev.effortSent !== next.effortSent
    const modeMoved = prev === null || prev.permissionMode !== next.permissionMode
    this.factsBusy = this.facts.busy
    if (this.facts.busy) this.armBusyStall()
    else this.disarmBusyStall()
    this.reconcileQueuedSends(next)
    this.completionPart.refreshWorkerTurnMarks()
    this.recomputeLive()
    connectorTrace({ ev: 'facts', sid: this.record.sessionId, busy: next.busy, atMs: next.atMs, queue: next.queue?.length ?? 0, sends: this.sends.map(s => s.state).join(','), inFlight: this.livePart.live().inFlight, ...this.livePart.pressed() })
    if (modelMoved) emitAll(this.modelListeners, 'model')
    if (modeMoved) emitAll(this.permissionListeners, 'permission')
    if (!modelMoved) emitAll(this.modelListeners, 'model')
    const answered = endedRunResults(this.keptRecords, this.facts, this.carrierGoneAtFactsMs !== null)
    const answeredMoved = answered.length !== this.answeredRows.length || answered.some((row, at) => row !== this.answeredRows[at])
    if (this.reconcileSends() || this.clearModelReceipt === undefined || answeredMoved) this.paint()
    this.workPart.refreshWork()
  }

  private readAsks(): void {
    this.asksPart.readAsks()
  }


  private async rpc(req: Record<string, unknown>, timeoutMs = RPC_TIMEOUT_MS): Promise<Record<string, unknown>> {
    const { daemonControlRpc } = await import('../../daemon/controlSocket.js')
    return (await daemonControlRpc(req as never, { timeoutMs })) as Record<string, unknown>
  }

  private verbChain: Promise<unknown> = Promise.resolve()
  private chainRpc(req: Record<string, unknown>): Promise<Record<string, unknown>> {
    const link = this.verbChain.then(() => this.rpc(req))
    this.verbChain = link.catch(() => {})
    return link
  }

  private async deliver(
    text: string,
    opts: { mode?: 'prompt' | 'bash'; pastedContents?: Record<number, PastedContent>; extraBlocks?: ContentBlockParam[]; metaFrom?: { command: string } },
  ): Promise<SendReceiptV1> {
    const { expandPastedTextRefs, pasteUnavailableLine, resolvePastedContents } = await import('../../history.js')
    const resolved = await resolvePastedContents(text, opts.pastedContents ?? {})
    if (resolved.missing.length > 0) {
      return { state: 'refused', detail: pasteUnavailableLine(resolved.missing[0]!) }
    }
    const pastes = resolved.pastedContents
    const expanded = expandPastedTextRefs(text, pastes).trim()
    const images = [...imageBlocksOf(pastes), ...(opts.extraBlocks ?? [])]
    if (expanded === '' && images.length === 0) return REFUSED_EMPTY
    const mode: 'prompt' | 'bash' = opts.mode === 'bash' ? 'bash' : 'prompt'
    const provisionalId =
      this.retainedSend !== null && this.retainedSend.text === expanded ? this.retainedSend.id : randomUUID()
    const meta = opts.metaFrom !== undefined
    const echo = createUserMessage({ uuid: provisionalId, content: mode === 'bash' ? `<${BASH_INPUT_TAG}>${expanded}</${BASH_INPUT_TAG}>` : expanded, ...(meta ? { isMeta: true } : {}) }) as unknown as Message
    this.echoRows.set(provisionalId, this.factsBusy ? ({ ...echo, queued: true } as Message) : echo)
    this.paint()
    const answering = meta ? null : await this.openQuestion()
    const clientMessageId = answering !== null ? `obl-answer:${answering}` : provisionalId
    if (clientMessageId !== provisionalId) {
      const rows = [...this.echoRows]
      this.echoRows.clear()
      for (const [key, row] of rows) this.echoRows.set(key === provisionalId ? clientMessageId : key, row)
    }
    submitTrace('connector-deliver', expanded, { mode, clientMessageId, ...(meta ? { metaFrom: opts.metaFrom!.command } : {}) })
    const send: SeatSend = { clientMessageId, text: expanded, sentAtMs: Date.now(), state: 'pending', mode, ...(meta ? {} : { source: { text, mode, pastedContents: pastes } }) }
    this.sends = [...this.sends.filter(s => s.clientMessageId !== clientMessageId), send]
    this.stampArrival(clientMessageId)
    this.paint()
    this.livePart.wake()
    const settle = (state: 'delivered' | 'held' | 'refused' | 'failed', detail?: string): SendReceiptV1 => {
      this.noteSettled(clientMessageId)
      if (state !== 'delivered') {
        this.sends = this.sends.filter(s => s.clientMessageId !== clientMessageId)
        this.echoRows.delete(clientMessageId)
        this.paint()
      } else {
        const queuedNow = this.factsBusy || this.liveStateWord === 'compacting'
        this.dressSend(clientMessageId, queuedNow ? 'queued' : 'delivered')
        connectorTrace({ ev: 'send', sid: this.record.sessionId, state: queuedNow ? 'queued' : 'delivered' })
      }
      this.retainedSend = state === 'held' || state === 'failed' ? { text: expanded, id: clientMessageId } : null
      if (state === 'delivered') this.admissionPart.sendDelivered()
      this.livePart.wake()
      if (state === 'delivered') {
        return { state: 'accepted' }
      }
      return { state: 'refused', detail: detail ?? (state === 'held' ? 'held — ↵ again replays it' : 'the session did not take it') }
    }
    try {
      const admission = this.admissionPart.pending()
      const refusal = admission !== null ? await admission : null
      if (refusal !== null) {
        return settle('failed', `the session could not resume — ${refusal} · ↵ again retries`)
      }
      const { ensureOwnedDaemon } = await import('../switchboard/ensureDaemon.js')
      if (!(await ensureOwnedDaemon())) {
        return settle('failed', 'the daemon that hosts sessions did not start — ↵ again starts it and retries')
      }
      if (this.isAttached()) seatVerb('focus', this.record.sessionId)
      if (answering !== null) {
        const control = await import('../concourse/boardControl.js')
        const receipt = await control.executeBoardControl({
          verb: 'obligation.answer',
          obligationId: answering,
          sessionId: this.record.sessionId,
          clientMessageId,
          answer: expanded,
          ...(images.length > 0 ? { content: [...(expanded !== '' ? [{ type: 'text', text: expanded }] : []), ...images] } : {}),
          by: 'operator',
        })
        if (receipt.outcome === 'applied' || receipt.outcome === 'noop') return settle('delivered')
        return settle(receipt.outcome === 'failed' ? 'held' : 'refused', receipt.detail)
      }
      const reply = await this.rpc({
        op: 'sessionDispatch',
        clientMessageId,
        prompt: expanded === '' ? '(attachment)' : expanded,
        workspaceDir: '',
        targetSessionId: this.record.sessionId,
        by: 'operator',
        sentAt: new Date(send.sentAtMs).toISOString(),
        ...(mode === 'bash' ? { mode } : {}),
        ...(meta ? { origin: { kind: 'screen-command', command: opts.metaFrom!.command } } : {}),
        ...(images.length > 0 ? { content: [...(expanded !== '' ? [{ type: 'text', text: expanded }] : []), ...images] } : {}),
      })
      const detail = typeof reply.error === 'string' ? reply.error : undefined
      if (reply.ok === true) return settle('delivered')
      const held = typeof reply.heldReason === 'string' || (detail ?? '').startsWith('session-paused')
      return settle(held ? 'held' : 'refused', detail)
    } catch (e) {
      return settle('failed', `the daemon was unreachable — ${e instanceof Error ? e.message : String(e)}`)
    }
  }

  private async openQuestion(): Promise<string | null> {
    try {
      const o = await import('../crew/obligations.js')
      const open = await o.openObligations({ scope: 'switchboard' })
      const row = open.find(r => r.sessionId === this.record.sessionId && !(r.ref ?? '').startsWith('permission:'))
      return row?.obligationId ?? null
    } catch {
      return null
    }
  }


  sessionId(): string {
    return this.record.sessionId
  }

  sendWords(text: string, opts?: SendWordsOptions): Promise<SendReceiptV1> {
    return this.deliver(text, {
      ...(opts?.mode === 'bash' ? { mode: 'bash' as const } : {}),
      ...(opts?.pastedContents !== undefined ? { pastedContents: opts.pastedContents } : {}),
      ...(opts?.metaFrom !== undefined ? { metaFrom: opts.metaFrom } : {}),
    })
  }

  async sendAgentNote(agentId: string, text: string): Promise<SendReceiptV1> {
    const trimmed = text.trim()
    if (trimmed === '' || agentId === '') return REFUSED_EMPTY
    const clientMessageId = randomUUID()
    submitTrace('connector-agent-note', trimmed, { agentId, clientMessageId })
    try {
      const { ensureOwnedDaemon } = await import('../switchboard/ensureDaemon.js')
      if (!(await ensureOwnedDaemon())) {
        return { state: 'refused', detail: 'the daemon that hosts sessions did not start — ↵ again starts it and retries' }
      }
      const reply = await this.rpc({
        op: 'sessionDispatch',
        clientMessageId,
        prompt: trimmed,
        workspaceDir: '',
        targetSessionId: this.record.sessionId,
        by: 'operator',
        mode: 'task-notification',
        agentId,
      })
      if (reply.ok === true) return { state: 'accepted' }
      const detail = typeof reply.error === 'string' ? reply.error : 'the session did not take it'
      return { state: 'refused', detail }
    } catch (e) {
      return { state: 'refused', detail: `the daemon was unreachable — ${e instanceof Error ? e.message : String(e)}` }
    }
  }

  records(): readonly Message[] {
    return this.painted
  }

  subscribeRecords(listener: () => void): () => void {
    this.recordListeners.add(listener)
    return () => {
      this.recordListeners.delete(listener)
    }
  }

  turnActive(): boolean {
    return this.livePart.live().inFlight
  }

  asks(): readonly SessionAskV1[] {
    return this.asksPart.asks()
  }

  subscribeAsks(listener: () => void): () => void {
    return this.asksPart.subscribeAsks(listener)
  }

  answerAsk(askId: string, answer: AskAnswerV1): Promise<AskReceiptV1> {
    return this.asksPart.answerAsk(askId, answer)
  }

  settleAsk(askId: string): void {
    this.asksPart.settleAsk(askId)
  }

  interrupt(): boolean {
    const wasRunning = this.livePart.live().inFlight || this.asksPart.asks().length > 0
    if (!wasRunning) return false
    this.asksPart.dropAll()
    const press = this.livePart.pressInterrupt()
    if (press === null) return true
    const { hard, undo } = press
    void this.chainRpc({ op: 'sessionControl', action: 'interrupt', sessionId: this.record.sessionId, by: 'operator', clientOpId: randomUUID(), ...(hard ? { hard: true } : {}) })
      .then(reply => {
        if (!(reply.ok === true && reply.outcome === 'applied')) undo()
      })
      .catch(undo)
    return true
  }


  recallableSend(): RecallableSendV1 | null {
    let latest: SeatSend | null = null
    for (const s of this.sends) {
      if (s.state === 'taken' || s.withdrawing === true || s.source === undefined) continue
      if (!UUID_SHAPE.test(s.clientMessageId)) continue
      if (s.source.text === '' && Object.keys(s.source.pastedContents).length === 0) continue
      if (latest === null || s.sentAtMs >= latest.sentAtMs) latest = s
    }
    return latest === null || latest.source === undefined ? null : { clientMessageId: latest.clientMessageId, text: latest.source.text }
  }

  async withdrawSend(clientMessageId: string): Promise<WithdrawReceiptV1> {
    const taken: WithdrawReceiptV1 = { withdrawn: false, reason: 'taken', detail: RECALL_TAKEN_LINE }
    const nothing: WithdrawReceiptV1 = { withdrawn: false, reason: 'unknown', detail: RECALL_UNKNOWN_LINE }
    let send = this.sends.find(s => s.clientMessageId === clientMessageId)
    if (send === undefined) return nothing
    if (send.state === 'taken') return taken
    if (send.withdrawing === true) return { withdrawn: false, reason: 'refused', detail: 'a withdraw is already on its way' }
    if (send.state === 'pending') {
      const settled = await this.settled(clientMessageId)
      send = this.sends.find(s => s.clientMessageId === clientMessageId)
      if (send === undefined) return nothing
      if (!settled) return { withdrawn: false, reason: 'refused', detail: 'the line is still on its way to the session — ↑ again in a moment' }
      if (send.state === 'taken') return taken
    }
    this.markWithdrawing(clientMessageId, true)
    connectorTrace({ ev: 'withdraw', sid: this.record.sessionId, state: send.state })
    const refuse = (detail: string): WithdrawReceiptV1 => {
      this.markWithdrawing(clientMessageId, false)
      connectorTrace({ ev: 'withdrawn', sid: this.record.sessionId, withdrawn: false, reason: 'refused' })
      return { withdrawn: false, reason: 'refused', detail }
    }
    try {
      const reply = await this.chainRpc({ op: 'sessionControl', action: 'withdraw-send', sessionId: this.record.sessionId, by: 'operator', clientMessageId })
      if (reply.ok !== true) return refuse(String(reply.error ?? 'the daemon refused the withdraw'))
      if (reply.withdrawn === true) {
        this.sends = this.sends.filter(s => s.clientMessageId !== clientMessageId)
        this.echoRows.delete(clientMessageId)
        if (this.sends.length === 0) this.textRetiredRowUuids.clear()
        this.paint()
        this.livePart.wake()
        connectorTrace({ ev: 'withdrawn', sid: this.record.sessionId, withdrawn: true })
        const source = send.source
        return {
          withdrawn: true,
          text: source?.text ?? (typeof reply.text === 'string' ? reply.text : send.text),
          mode: source?.mode ?? send.mode,
          pastedContents: source?.pastedContents ?? {},
        }
      }
      if (reply.reason !== 'taken' && reply.reason !== 'unknown') {
        return refuse(typeof reply.detail === 'string' && reply.detail !== '' ? reply.detail : 'the daemon refused the withdraw')
      }
      this.markWithdrawing(clientMessageId, false)
      connectorTrace({ ev: 'withdrawn', sid: this.record.sessionId, withdrawn: false, reason: reply.reason })
      if (reply.reason === 'taken') {
        this.dressSend(clientMessageId, 'taken')
        return taken
      }
      this.retireSendUnknownToRunner(clientMessageId)
      return { withdrawn: false, reason: 'unknown', detail: lostLine(send.source?.text ?? send.text), retired: true }
    } catch (e) {
      return refuse(`the daemon is not answering — ${e instanceof Error ? e.message : String(e)}`)
    }
  }

  private markWithdrawing(clientMessageId: string, on: boolean): void {
    this.sends = this.sends.map(s => {
      if (s.clientMessageId !== clientMessageId) return s
      if (on) return { ...s, withdrawing: true as const }
      const { withdrawing: _off, ...rest } = s
      return rest
    })
  }

  private settleWaiters = new Map<string, Array<() => void>>()
  private noteSettled(clientMessageId: string): void {
    const waiters = this.settleWaiters.get(clientMessageId)
    if (waiters === undefined) return
    this.settleWaiters.delete(clientMessageId)
    for (const w of waiters) w()
  }
  private settled(clientMessageId: string): Promise<boolean> {
    const send = this.sends.find(s => s.clientMessageId === clientMessageId)
    if (send === undefined || send.state !== 'pending') return Promise.resolve(true)
    return new Promise<boolean>(resolve => {
      const timer = setTimeout(() => {
        const list = this.settleWaiters.get(clientMessageId)
        if (list !== undefined) this.settleWaiters.set(clientMessageId, list.filter(w => w !== done))
        resolve(false)
      }, PENDING_WITHDRAW_WAIT_MS)
      timer.unref?.()
      const done = (): void => {
        clearTimeout(timer)
        resolve(true)
      }
      this.settleWaiters.set(clientMessageId, [...(this.settleWaiters.get(clientMessageId) ?? []), done])
    })
  }

  stopAgent(agentId: string, note?: string): Promise<AgentControlReceiptV1> {
    return this.agentVerb('stop-agent', agentId, note)
  }

  resumeAgent(agentId: string, note?: string): Promise<AgentControlReceiptV1> {
    return this.agentVerb('resume-agent', agentId, note)
  }

  async backgroundShell(): Promise<AgentControlReceiptV1> {
    try {
      const reply = await this.chainRpc({ op: 'sessionControl', action: 'background-shell', sessionId: this.record.sessionId, by: 'operator' })
      if (reply.ok !== true) return { outcome: 'refused', detail: String(reply.error ?? 'the daemon refused the verb') }
      const detail = typeof reply.detail === 'string' ? reply.detail : undefined
      if (reply.outcome === 'applied') return { outcome: 'applied', ...(detail !== undefined ? { detail } : {}) }
      return { outcome: 'refused', detail: detail ?? `unexpected outcome ${String(reply.outcome)}` }
    } catch (e) {
      return { outcome: 'refused', detail: `the daemon is not answering — ${e instanceof Error ? e.message : String(e)}` }
    }
  }

  async sendNow(): Promise<AgentControlReceiptV1> {
    try {
      const reply = await this.chainRpc({ op: 'sessionControl', action: 'send-now', sessionId: this.record.sessionId, by: 'operator' })
      if (reply.ok !== true) return { outcome: 'refused', detail: String(reply.error ?? 'the daemon refused the verb') }
      const detail = typeof reply.detail === 'string' ? reply.detail : undefined
      if (reply.outcome === 'applied') return { outcome: 'applied', ...(detail !== undefined ? { detail } : {}) }
      return { outcome: 'refused', detail: detail ?? `unexpected outcome ${String(reply.outcome)}` }
    } catch (e) {
      return { outcome: 'refused', detail: `the daemon is not answering — ${e instanceof Error ? e.message : String(e)}` }
    }
  }

  queuedSendCount(): number {
    let count = 0
    for (const s of this.sends) {
      if (s.state === 'queued' && s.heldFor === undefined && s.withdrawing !== true && !isNoticeKey(s.clientMessageId)) count += 1
    }
    return count
  }

  async pauseGate(paused: boolean): Promise<AgentControlReceiptV1> {
    try {
      const reply = await this.chainRpc({ op: 'sessionControl', action: 'pause-gate', sessionId: this.record.sessionId, by: 'operator', paused })
      if (reply.ok !== true) return { outcome: 'refused', detail: String(reply.error ?? 'the daemon refused the verb') }
      const detail = typeof reply.detail === 'string' ? reply.detail : undefined
      if (reply.outcome === 'applied') {
        this.readFacts()
        return { outcome: 'applied', ...(detail !== undefined ? { detail } : {}) }
      }
      return { outcome: 'refused', detail: detail ?? `unexpected outcome ${String(reply.outcome)}` }
    } catch (e) {
      return { outcome: 'refused', detail: `the daemon is not answering — ${e instanceof Error ? e.message : String(e)}` }
    }
  }

  async postBoard(post: BoardPostRequestV1): Promise<BoardPostReceiptV1> {
    try {
      const reply = await this.chainRpc({ op: 'sessionControl', action: 'board-post', sessionId: this.record.sessionId, by: 'operator', clientOpId: post.clientOpId, boardPost: post })
      if (reply.ok !== true) return { ok: false, reason: String(reply.error ?? 'the daemon refused the post') }
      const detail = typeof reply.detail === 'string' ? reply.detail : ''
      if (!detail.startsWith('{')) return { ok: false, reason: detail || `unexpected outcome ${String(reply.outcome)}` }
      const answer = JSON.parse(detail) as { ok: true; event_id: string; seq: number; replay: boolean; address: string; recipients: string[] } | { ok: false; reason: string; candidates?: string[] }
      if (!answer.ok) return answer
      return { ok: true, eventId: answer.event_id, seq: answer.seq, replay: answer.replay, address: answer.address, recipients: answer.recipients }
    } catch (e) {
      return { ok: false, reason: `the daemon is not answering — ${e instanceof Error ? e.message : String(e)}` }
    }
  }

  async leave(opts?: { signal?: AbortSignal }): Promise<LeaveReceiptV1> {
    const skip = (): void => {
      void this.rpc({ op: 'sessionControl', action: 'interrupt', sessionId: this.record.sessionId, by: 'operator', clientOpId: randomUUID() }).catch(() => {})
    }
    if (opts?.signal?.aborted) return { note: 'none', detail: 'the handoff was skipped' }
    opts?.signal?.addEventListener('abort', skip, { once: true })
    try {
      await this.verbChain
      const { daemonControlRpc } = await import('../../daemon/controlSocket.js')
      const reply = (await daemonControlRpc(
        { op: 'sessionControl', action: 'leave', sessionId: this.record.sessionId, by: 'operator' } as never,
        { timeoutMs: LEAVE_RPC_TIMEOUT_MS },
      )) as Record<string, unknown>
      if (reply.ok !== true) return { note: 'none', detail: String(reply.error ?? 'the daemon refused the verb') }
      const detail = typeof reply.detail === 'string' ? reply.detail : undefined
      if (reply.outcome !== 'applied') return { note: 'none', detail: detail ?? `unexpected outcome ${String(reply.outcome)}` }
      let answer: { note?: unknown; noteChars?: unknown } = {}
      try {
        answer = JSON.parse(detail ?? '{}') as { note?: unknown; noteChars?: unknown }
      } catch {
        answer = {}
      }
      if (answer.note === 'stored' || answer.note === 'skipped' || answer.note === 'none') {
        return { note: answer.note, ...(typeof answer.noteChars === 'number' && Number.isInteger(answer.noteChars) && answer.noteChars >= 0 ? { noteChars: answer.noteChars } : {}) }
      }
      return { note: 'none', detail: detail ?? 'the runner answered the leave with a receipt the screen cannot read' }
    } catch (e) {
      return { note: 'none', detail: `the daemon is not answering — ${e instanceof Error ? e.message : String(e)}` }
    } finally {
      opts?.signal?.removeEventListener('abort', skip)
    }
  }

  private async agentVerb(action: 'stop-agent' | 'resume-agent', agentId: string, note?: string): Promise<AgentControlReceiptV1> {
    if (agentId === '') return { outcome: 'refused', detail: `${action} needs a crewmate` }
    try {
      const reply = await this.chainRpc({
        op: 'sessionControl',
        action,
        sessionId: this.record.sessionId,
        by: 'operator',
        agentId,
        ...(note !== undefined ? { note } : {}),
      })
      if (reply.ok !== true) {
        return { outcome: 'refused', detail: String(reply.error ?? 'the daemon refused the verb') }
      }
      const detail = typeof reply.detail === 'string' ? reply.detail : undefined
      if (reply.outcome === 'applied') return { outcome: 'applied', ...(detail !== undefined ? { detail } : {}) }
      return { outcome: 'refused', detail: detail ?? `unexpected outcome ${String(reply.outcome)}` }
    } catch (e) {
      return { outcome: 'refused', detail: `the daemon is not answering — ${e instanceof Error ? e.message : String(e)}` }
    }
  }

  modelFacts(): ModelFactsV1 {
    const retained = this.admissionPart.awaiting() ? this.record.modelKey : undefined
    const effective = retained ?? this.facts?.model.effective ?? this.record.modelKey ?? getEngineModel()
    const effectiveSource: 'live' | 'record' | 'ambient' =
      this.facts !== null && !this.admissionPart.awaiting() ? 'live' : this.facts !== null || this.record.modelKey !== undefined ? 'record' : 'ambient'
    return {
      effective,
      effectiveSource,
      main: effective,
      setting: retained ?? this.facts?.model.setting ?? this.record.modelKey ?? null,
      sessionPin: retained ?? this.facts?.model.setting ?? this.record.modelKey ?? null,
      effort: this.facts?.effort ?? this.record.effort ?? null,
      ...(this.facts?.effortSent !== undefined ? { effortSent: this.facts.effortSent } : {}),
      pendingSwitch: this.facts?.pendingModel !== undefined && this.facts.pendingModel !== null ? { setting: this.facts.pendingModel } : null,
    }
  }

  subscribeModel(listener: () => void): () => void {
    this.modelListeners.add(listener)
    return () => {
      this.modelListeners.delete(listener)
    }
  }

  async setModel(setting: string | null, words?: string): Promise<ModelSwitchReceiptV1> {
    const target = setting ?? getEngineModel()
    const current = this.modelFacts()
    if (current.effective === target && current.pendingSwitch === null) return { state: 'no-op' }
    const busy = this.livePart.live().inFlight
    if (this.facts !== null) {
      this.facts = busy
        ? { ...this.facts, pendingModel: target }
        : { ...this.facts, model: { effective: target, setting: target }, pendingModel: null }
      emitAll(this.modelListeners, 'model')
    }
    const refuse = (detail: string): ModelSwitchReceiptV1 => {
      logForDebugging(`[engine-connector] daemon set-model refused: ${detail}`)
      this.readFacts()
      return { state: 'refused', detail }
    }
    try {
      const reply = await this.chainRpc({ op: 'sessionControl', action: 'set-model', sessionId: this.record.sessionId, by: 'operator', model: target, ...(words === undefined ? {} : { words }) })
      if (reply.ok !== true) return refuse(String(reply.error ?? 'the daemon refused the switch'))
      const outcome = reply.outcome
      const detail = typeof reply.detail === 'string' && reply.detail !== '' ? reply.detail : undefined
      if (outcome === 'refused') return refuse(detail ?? 'the daemon refused the switch')
      if (outcome !== 'applied' && outcome !== 'queued' && outcome !== 'noop') return refuse(`unexpected outcome ${String(outcome)}`)
      if ((outcome === 'queued') !== busy) this.readFacts()
      if (outcome === 'noop') return { state: 'no-op' }
      this.factsFeed.settle(SEAT_VERB_SETTLE_MS)
      if (outcome === 'applied') {
        const respawned = (reply as { respawned?: unknown }).respawned === true
        if (respawned) this.readFacts()
        if (detail !== undefined && (respawned || detail !== `${this.record.runnerId} → ${target}`)) return { state: 'applied', note: detail }
      }
      return { state: outcome }
    } catch (e) {
      return refuse(`the daemon is not answering — the switch did not land (${e instanceof Error ? e.message : String(e)})`)
    }
  }

  async setEffort(level: string): Promise<ModelSwitchReceiptV1> {
    const current = this.modelFacts()
    if (current.effort === level) return { state: 'no-op' }
    const busy = this.livePart.live().inFlight
    if (this.facts !== null && !busy) {
      this.facts = { ...this.facts, effort: level }
      emitAll(this.modelListeners, 'model')
    }
    const refuse = (detail: string): ModelSwitchReceiptV1 => {
      logForDebugging(`[engine-connector] daemon set-effort refused: ${detail}`)
      this.readFacts()
      return { state: 'refused', detail }
    }
    try {
      const reply = await this.chainRpc({ op: 'sessionControl', action: 'set-effort', sessionId: this.record.sessionId, by: 'operator', effort: level })
      if (reply.ok !== true) return refuse(String(reply.error ?? 'the daemon refused the effort'))
      const outcome = reply.outcome
      const detail = typeof reply.detail === 'string' && reply.detail !== '' ? reply.detail : undefined
      if (outcome === 'refused') return refuse(detail ?? 'the daemon refused the effort')
      if (outcome !== 'applied' && outcome !== 'queued' && outcome !== 'noop') return refuse(`unexpected outcome ${String(outcome)}`)
      if ((outcome === 'queued') !== busy) this.readFacts()
      if (outcome === 'noop') return { state: 'no-op' }
      this.factsFeed.settle(SEAT_VERB_SETTLE_MS)
      return { state: outcome }
    } catch (e) {
      return refuse(`the daemon is not answering — the effort did not land (${e instanceof Error ? e.message : String(e)})`)
    }
  }

  usage(): UsageFactsV1 {
    return (
      this.facts?.usage ?? {
        totalCostUSD: 0,
        totalAPIDurationMs: 0,
        totalDurationMs: 0,
        totalLinesAdded: 0,
        totalLinesRemoved: 0,
        totalInputTokens: 0,
        totalOutputTokens: 0,
        totalCacheReadInputTokens: 0,
        totalCacheCreationInputTokens: 0,
        hasUnknownModelCost: false,
      }
    )
  }

  identity(): SeatIdentityV1 {
    return this.facts?.identity ?? { firstPartyApi: false, consoleBilling: false, claudeAiBilling: false, accountEmail: null }
  }

  editOutcomes(): EditOutcomeRowV1[] | null {
    return this.facts?.editOutcomes ?? null
  }

  skillsRoster(): SkillsRosterV1 {
    return { skills: this.facts?.skills ?? [] }
  }

  mcpRoster(): McpRosterV1 {
    return { clients: this.facts?.mcp ?? [] }
  }

  async mcpAction(name: string, action: 'authenticate' | 'reconnect' | 'cancel-auth'): Promise<KitDialReceiptV1> {
    try {
      const reply = await this.rpc({ op: 'sessionControl', action: 'mcp-action', sessionId: this.record.sessionId, by: 'operator', mcpAction: { name, action } }, 300_000)
      return reply.ok === true && reply.outcome === 'applied'
        ? { outcome: 'applied', ...(typeof reply.detail === 'string' ? { detail: reply.detail } : {}) }
        : { outcome: 'refused', detail: String(reply.detail ?? reply.error ?? 'the MCP action refused') }
    } catch (error) {
      return { outcome: 'refused', detail: error instanceof Error ? error.message : String(error) }
    }
  }

  async mcpTools(serverName: string): Promise<McpToolsV1> {
    const unavailable = (detail: string): McpToolsV1 => ({ server: serverName, state: 'unavailable', tools: [], omitted: 0, detail })
    try {
      const reply = await this.rpc({ op: 'sessionControl', action: 'mcp-tools', sessionId: this.record.sessionId, by: 'operator', mcpServer: serverName })
      if (reply.ok !== true) return unavailable(String(reply.error ?? 'the daemon refused the MCP tools list'))
      if (reply.outcome !== 'applied') return unavailable(typeof reply.detail === 'string' && reply.detail !== '' ? reply.detail : `unexpected outcome ${String(reply.outcome)}`)
      return mcpToolsOfReply(reply.mcpTools) ?? unavailable('the daemon answered the MCP tools list with a payload this screen cannot read')
    } catch (e) {
      return unavailable(`the daemon is not answering — ${e instanceof Error ? e.message : String(e)}`)
    }
  }

  async setKit(edit: SessionKitEditV1): Promise<KitDialReceiptV1> {
    try {
      const reply = await this.chainRpc({
        op: 'sessionControl',
        action: 'set-kit',
        sessionId: this.record.sessionId,
        by: 'operator',
        kitEdit: edit,
        clientOpId: `kit-${randomUUID()}`,
      })
      if (reply.ok !== true) return { outcome: 'refused', detail: String(reply.error ?? 'the daemon refused the dial') }
      const outcome = reply.outcome
      if (outcome === 'applied' || outcome === 'queued' || outcome === 'noop' || outcome === 'refused') {
        return { outcome, ...(typeof reply.detail === 'string' && reply.detail !== '' ? { detail: reply.detail } : {}) }
      }
      return { outcome: 'refused', detail: `unexpected outcome ${String(outcome)}` }
    } catch (e) {
      logForDebugging(`[engine-connector] daemon set-kit failed: ${e}`)
      return { outcome: 'refused', detail: 'the daemon is not answering — the dial did not land' }
    }
  }

  spawnSwitches(): SpawnSwitchFacts {
    return this.facts?.spawnSwitches ?? BOTH_SWITCHES_ON
  }

  async setSpawnSwitch(kind: SpawnSwitchKind, on: boolean): Promise<SpawnSwitchReceiptV1> {
    try {
      const reply = await this.chainRpc({
        op: 'sessionControl',
        action: 'set-spawn-switch',
        sessionId: this.record.sessionId,
        by: 'operator',
        spawnSwitch: { kind, on },
      })
      if (reply.ok !== true) return { outcome: 'refused', detail: String(reply.error ?? 'the daemon refused the toggle') }
      const outcome = reply.outcome
      if (outcome === 'applied' || outcome === 'queued' || outcome === 'noop' || outcome === 'refused') {
        this.readFacts()
        return { outcome, ...(typeof reply.detail === 'string' && reply.detail !== '' ? { detail: reply.detail } : {}) }
      }
      return { outcome: 'refused', detail: `unexpected outcome ${String(outcome)}` }
    } catch (e) {
      logForDebugging(`[engine-connector] daemon set-spawn-switch failed: ${e}`)
      return { outcome: 'refused', detail: 'the daemon is not answering — the toggle did not land' }
    }
  }

  workRoster(): WorkRosterV1 {
    return this.workPart.workRoster()
  }

  advisorFacts(): AdvisorFactsV1 | null {
    return this.facts?.advisor ?? null
  }

  swarmBoard(): import('../crewBoard/contracts.js').BoardViewSnapshot | null {
    return this.facts?.swarm ?? null
  }

  subscribeWork(listener: () => void): () => void {
    return this.workPart.subscribeWork(listener)
  }

  permissionMode(): PermissionMode | null {
    return permissionModeOf(this.facts, bootBirthFacts())
  }

  subscribePermissionMode(listener: () => void): () => void {
    this.permissionListeners.add(listener)
    return () => {
      this.permissionListeners.delete(listener)
    }
  }

  async setPermissionMode(mode: PermissionMode): Promise<PermissionModeReceiptV1> {
    const before = this.facts
    if (this.facts !== null) {
      this.facts = { ...this.facts, permissionMode: mode }
      emitAll(this.permissionListeners, 'permission')
    }
    let receipt: PermissionModeReceiptV1
    try {
      const reply = await this.chainRpc({ op: 'sessionControl', action: 'set-permission-mode', sessionId: this.record.sessionId, by: 'operator', mode })
      const outcome = reply.outcome
      receipt =
        reply.ok === true && (outcome === 'applied' || outcome === 'noop')
          ? { outcome, ...(typeof reply.detail === 'string' && reply.detail !== '' ? { detail: reply.detail } : {}) }
          : { outcome: 'refused', detail: typeof reply.detail === 'string' && reply.detail !== '' ? reply.detail : String(reply.error ?? 'the daemon refused the mode change') }
    } catch (e) {
      logForDebugging(`[engine-connector] daemon set-permission-mode failed: ${e}`)
      receipt = { outcome: 'refused', detail: 'the daemon is not answering — the mode change did not land' }
    }
    if (receipt.outcome === 'applied') this.factsFeed.settle(SEAT_VERB_SETTLE_MS)
    if (receipt.outcome === 'refused') {
      if (this.facts !== null && this.facts.permissionMode === mode) {
        this.facts = before !== null ? before : this.facts
        emitAll(this.permissionListeners, 'permission')
      }
      this.readFacts()
    }
    return receipt
  }

  workspace(): WorkspaceFactsV1 {
    if (this.facts !== null) return this.facts.workspace
    const cwd = this.record.worktreePath ?? this.record.workspaceId
    return { cwd, originalCwd: cwd, projectRoot: this.record.workspaceId }
  }

  dispatchSlash(line: string): Promise<SendReceiptV1> {
    const trimmed = line.trim()
    return this.deliver(trimmed.startsWith('/') ? trimmed : `/${trimmed}`, {})
  }


  live(): SessionLiveV1 {
    return this.livePart.live()
  }

  subscribeLive(listener: () => void): () => void {
    return this.livePart.subscribeLive(listener)
  }

  tail(): StreamingTailStore {
    return this.tailPart.store()
  }

  private get textRows(): readonly CommittedTextRow[] {
    return this.tailPart.committedRows()
  }

  tailAnchor(): number {
    return this.painted.length - this.rowsAfterTail
  }

  status(): SeatStatusV1 {
    return this.livePart.status({
      title: liveTitleDeriver?.(this.record) ?? this.record.title,
      projectLabel: this.record.projectLabel,
      ...(this.record.isolation !== undefined ? { isolation: this.record.isolation } : {}),
      ...(this.record.branchLabel !== undefined ? { branchLabel: this.record.branchLabel } : {}),
      runner: this.admissionPart.runnerShown(this.facts?.runner ?? null),
    })
  }
}


const connectors = new Map<string, DaemonSessionConnector>()

export function daemonSessionConnectorFor(record: DaemonSessionRecordV1, runnerLive = false): DaemonSessionConnector {
  let c = connectors.get(record.sessionId)
  if (c === undefined) {
    c = new DaemonSessionConnector(record)
    connectors.set(record.sessionId, c)
  } else {
    c.adoptRecord(record, runnerLive)
  }
  return c
}

export function getDaemonSessionConnector(sessionId: string): DaemonSessionConnector | undefined {
  return connectors.get(sessionId)
}

export type LiveTitleDeriver = (record: DaemonSessionRecordV1) => string | null
let liveTitleDeriver: LiveTitleDeriver | null = null
export function registerLiveTitleDeriver(deriver: LiveTitleDeriver): void {
  liveTitleDeriver = deriver
}

let latestHop: { epoch: number; connector: DaemonSessionConnector } | null = null

export async function focusDaemonSession(record: DaemonSessionRecordV1, runnerLive = false): Promise<DaemonSessionConnector> {
  const connector = daemonSessionConnectorFor(record, runnerLive)
  const epoch = claimHopEpoch()
  latestHop = { epoch, connector }
  await connector.attach()
  const wanted = connector === getFocusedSessionConnector() || (latestHop?.connector === connector && hopEpochIsCurrent(latestHop.epoch))
  if (!wanted) connector.detach()
  if (!hopEpochIsCurrent(epoch)) return connector
  setFocusedSessionConnector(connector)
  return connector
}

let lastFocusedForDetach: unknown = getFocusedSessionConnector()
subscribeFocusedSessionConnector(() => {
  const focused = getFocusedSessionConnector()
  if (focused === lastFocusedForDetach) return
  lastFocusedForDetach = focused
  for (const c of connectors.values()) {
    if (c !== focused && c.isAttached()) c.detach()
  }
})
