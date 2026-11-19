import { statSync, watch, type FSWatcher } from 'node:fs'
import { flagEnabled } from '../../substrate/flagRegistry.js'
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
import { CarrierPart } from './daemon/carrier.js'
import { CompletionPart } from './daemon/completion.js'
import { DeliveryPart } from './daemon/delivery.js'
import { FactsPart } from './daemon/facts.js'
import { FoldPart } from './daemon/fold.js'
import { SendsPart } from './daemon/sends.js'
import { connectorTrace, emitAll, REFUSED_EMPTY, type Listeners } from './daemon/shared.js'
import { TailPart } from './daemon/tail.js'
import { LivePart } from './daemon/live.js'
import { WorkPart } from './daemon/work.js'
import { HEARTBEAT_MS, ProjectionFeed } from './daemon/feed.js'
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
export { HEARTBEAT_MS, PROJECTION_ABSENT, ProjectionFeed, projectionChangeKey } from './daemon/feed.js'
const RPC_TIMEOUT_MS = 15_000
const LEAVE_RPC_TIMEOUT_MS = 135_000
const IDLE_TRANSCRIPT_FLOOR_MS = 2000
export const IDLE_PROJECTION_FLOOR_MS = 10_000
export const SEAT_VERB_SETTLE_MS = 4000
export const CARRIER_GONE_WORDS = 'the background daemon ended — the next prompt starts a new one'

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

interface ConnectorHands {
  rpc?(req: Record<string, unknown>, timeoutMs: number): Promise<Record<string, unknown>>
  tickOnce?(pass: () => Promise<void>): Promise<void>
  armTranscriptWatcher?(): void
  armTranscriptTimer?(): void
  factsRead?(read: () => void): void
}

async function carrierRpc(req: Record<string, unknown>, timeoutMs: number): Promise<Record<string, unknown>> {
  const { daemonControlRpc } = await import('../../daemon/controlSocket.js')
  return (await daemonControlRpc(req as never, { timeoutMs })) as Record<string, unknown>
}

export class DaemonSessionConnector implements EngineConnectorV1, SeatLiveExtensionV1 {
  readonly carrier = 'daemon' as const

  private rawRecords: Message[] = []
  private recordSigs: string[] = []
  private painted: readonly Message[] = []
  private keptRecords: readonly Message[] = []
  private answeredRows: readonly Message[] = []
  private liveState: SessionLiveV1 = IDLE_LIVE
  private readonly carrierPart = new CarrierPart({
    sessionId: () => this.record.sessionId,
    rpc: req => this.rpc(req),
    factsBusy: () => this.factsPart.busy(),
    factsAtMs: () => this.factsPart.read()?.atMs ?? 0,
    dropBusy: () => this.factsPart.dropBusy(),
    recomputeLive: () => this.recomputeLive(),
    carrierWentAway: () => this.carrierWentAway(),
  })

  private carrierWentAway(): void {
    this.factsPart.strip()
    this.workPart.refreshWork()
    this.recomputeLive()
    this.addDisplayRow(createSeatReceiptMessage(CARRIER_GONE_WORDS, 'warning') as unknown as Message)
  }
  private displayRows: Array<{ row: Message; anchor: number }> = []
  private clearModelReceipt: Message | null | undefined
  private rowsAfterTail = 0
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

  private readonly sendsPart = new SendsPart({
    sessionId: () => this.record.sessionId,
    rows: () => this.rawRecords,
    paint: () => this.paint(),
    compacting: () => this.liveStateWord === 'compacting',
    wakeLive: () => this.livePart.wake(),
    arrivalSeqFor: seenAtMs => this.tailPart.arrivalSeqFor(seenAtMs),
    noticeSeqAt: atMs => this.tailPart.noticeSeqAt(atMs),
    retireTextRowsWithRunner: () => this.tailPart.retireTextRowsWithRunner(),
    noteSendDemoted: () => this.completionPart.noteSendDemoted(),
    noteSendTaken: () => this.completionPart.noteSendTaken(),
    lostWithRunnerLine: lines => lostWithRunnerLine(lines),
  })
  private readonly deliveryPart = new DeliveryPart({
    sessionId: () => this.record.sessionId,
    factsBusy: () => this.factsPart.busy(),
    compacting: () => this.liveStateWord === 'compacting',
    paint: () => this.paint(),
    wakeLive: () => this.livePart.wake(),
    openQuestion: () => this.openQuestion(),
    admissionPending: () => this.admissionPart.pending(),
    sendDelivered: () => this.admissionPart.sendDelivered(),
    assertSeat: () => this.assertSeat(),
    rpc: req => this.rpc(req),
    chainRpc: req => this.chainRpc(req),
    imageBlocks: pastes => imageBlocksOf(pastes),
    lostLine: words => lostLine(words),
    recallTakenLine: RECALL_TAKEN_LINE,
    recallUnknownLine: RECALL_UNKNOWN_LINE,
    echo: (clientMessageId, row) => this.sendsPart.echo(clientMessageId, row),
    rekeyEcho: (from, to) => this.sendsPart.rekeyEcho(from, to),
    enlist: send => this.sendsPart.enlist(send),
    drop: clientMessageId => this.sendsPart.drop(clientMessageId),
    withdrawn: clientMessageId => this.sendsPart.withdrawn(clientMessageId),
    dress: (clientMessageId, state) => this.sendsPart.dressSend(clientMessageId, state),
    sendOf: clientMessageId => this.sendsPart.sendOf(clientMessageId),
    markWithdrawing: (clientMessageId, on) => this.sendsPart.markWithdrawing(clientMessageId, on),
    retireUnknown: clientMessageId => this.sendsPart.retireSendUnknownToRunner(clientMessageId),
  })
  private readonly factsPart: FactsPart
  private readonly completionPart: CompletionPart
  private readonly admissionPart = new AdmissionPart({ wakeLive: () => this.livePart.wake() })
  private readonly factsFeed: ProjectionFeed
  private readonly workPart = new WorkPart({ facts: () => this.factsPart.read(), carrierGone: () => this.carrierPart.gone() })

  private readonly asksPart = new AsksPart({
    record: () => this.record,
    rows: () => this.rawRecords,
    facts: () => this.factsPart.read(),
    permissionMode: () => this.permissionMode(),
    chainRpc: req => this.chainRpc(req),
    deliver: (text, opts) => this.deliveryPart.deliver(text, opts),
  })
  private readonly asksFeed: ProjectionFeed

  private readonly tailFeed: ProjectionFeed
  private readonly tailPart = new TailPart({
    sessionId: () => this.record.sessionId,
    rows: () => this.rawRecords,
    model: () => this.modelFacts().effective,
    paint: () => this.paint(),
  })
  private readonly foldPart = new FoldPart({ recomputeLive: () => this.recomputeLive() })
  private readonly livePart: LivePart = new LivePart({
    sessionId: () => this.record.sessionId,
    attached: () => this.attached,
    factsBusy: () => this.factsPart.busy(),
    work: () => this.factsPart.read()?.work ?? [],
    factsTurnStartedAt: () => this.factsPart.read()?.turnStartedAt,
    streamIdleTimeoutMs: () => this.factsPart.streamIdleTimeoutMs(),
    model: () => this.modelFacts().effective,
    anySendDelivered: () => this.sendsPart.anyDelivered(),
    redressQueuedSends: () => this.sendsPart.redressQueued(),
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
    probeCarrier: () => this.carrierPart.probeCarrier(),
  })

  private readonly progressFeed: ProjectionFeed

  private attached = false

  constructor(readonly record: DaemonSessionRecordV1, private readonly hands: ConnectorHands = {}) {
    this.transcriptPath = join(record.home, `${record.sessionId}.jsonl`)
    this.factsPart = new FactsPart({
      sessionId: () => this.record.sessionId,
      recordModel: () => this.record.modelKey,
      recordEffort: () => this.record.effort,
      recordWorkspace: () => ({ cwd: this.record.worktreePath ?? this.record.workspaceId, projectRoot: this.record.workspaceId }),
      awaitingRunner: () => this.admissionPart.awaiting(),
      adoptUsage: usage => {
        adoptOpenaiObservedUsage(usage?.openaiObserved)
        adoptOpenaiWindowFact(usage?.openaiWindow)
        adoptAnthropicWindowFact(usage?.anthropicWindow)
        adoptAnthropicObservedUsage(usage?.anthropicObserved)
      },
      adoptOpenaiCatalogue: list => {
        adoptOpenaiCatalogueFact(list)
      },
    })
    this.completionPart = new CompletionPart({
      sessionId: () => this.record.sessionId,
      factsBusy: () => this.factsPart.busy(),
      hasUnreadTranscript: () => this.hasUnreadTranscript(),
      tick: () => this.tick(),
    })
    this.admissionPart.seed(this.factsPart.read()?.atMs ?? null, record.runnerId === '')
    this.workPart.refreshWork()
    const idleFloor = (): number => (this.turnInFlight ? HEARTBEAT_MS : IDLE_PROJECTION_FLOOR_MS)
    const factsRead = (): void => this.readFacts()
    this.hands.factsRead?.(factsRead)
    this.factsFeed = new ProjectionFeed(sessionFactsDir(), sessionFactsPath(record.sessionId), factsRead, idleFloor)
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
    this.carrierPart.disarmBusyStall()
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
    if (this.hands.armTranscriptWatcher !== undefined) return this.hands.armTranscriptWatcher()
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
    if (this.hands.armTranscriptTimer !== undefined) return this.hands.armTranscriptTimer()
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
      this.factsPart.seedAgain()
      this.admissionPart.parked(this.factsPart.read()?.atMs ?? null)
    }
    Object.assign(this.record, next)
    if (runnerLive) this.admissionPart.runnerLive()
    this.factsPart.wakeModel()
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
          await (this.hands.tickOnce === undefined ? this.tickOnce() : this.hands.tickOnce(() => this.tickOnce()))
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
      this.sendsPart.reconcileSends()
      this.tailPart.retireTextRows()
      this.paint()
      if (this.admissionPart.awaiting() || this.factsPart.read()?.runner?.state === 'starting') this.readFacts()
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

  heldForCompaction(): string[] {
    return this.sendsPart.heldForCompaction()
  }

  lostLine(): LostLineV1 | null {
    return this.sendsPart.lostLine()
  }

  transcriptStoreFailing(): string | null {
    return this.factsPart.transcriptStoreFailing()
  }

  private paint(): void {
    const tailSeq = this.tailPart.seq()
    const { held, afterTail } = this.sendsPart.echoes(tailSeq)
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
    const answered = endedRunResults(kept, this.factsPart.read(), this.carrierPart.gone())
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
    this.painted = placeLocalCommandRows(this.sendsPart.placeDelivered(this.painted))
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
      if (this.factsPart.dropRowsWithNoFile()) this.workPart.refreshWork()
      return
    }
    if (!this.admissionPart.factsArrive(next.atMs)) return
    const held = this.carrierPart.factsFromCarrier(next)
    const { prev, modelMoved, modeMoved } = this.factsPart.take(next, held)
    this.admissionPart.runnerReported(held.runner)
    this.workPart.refreshCheckpoints()
    this.factsPart.handOn(next, prev)
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
    if (this.factsPart.followBusy()) this.carrierPart.armBusyStall()
    else this.carrierPart.disarmBusyStall()
    this.sendsPart.reconcileQueuedSends(next)
    this.completionPart.refreshWorkerTurnMarks()
    this.recomputeLive()
    connectorTrace({ ev: 'facts', sid: this.record.sessionId, busy: next.busy, atMs: next.atMs, queue: next.queue?.length ?? 0, sends: this.sendsPart.states(), inFlight: this.livePart.live().inFlight, ...this.livePart.pressed() })
    this.factsPart.wake(modelMoved, modeMoved)
    const answered = endedRunResults(this.keptRecords, this.factsPart.read(), this.carrierPart.gone())
    const answeredMoved = answered.length !== this.answeredRows.length || answered.some((row, at) => row !== this.answeredRows[at])
    if (this.sendsPart.reconcileSends() || this.clearModelReceipt === undefined || answeredMoved) this.paint()
    this.workPart.refreshWork()
  }

  private readAsks(): void {
    this.asksPart.readAsks()
  }

  private rpc(req: Record<string, unknown>, timeoutMs = RPC_TIMEOUT_MS): Promise<Record<string, unknown>> {
    return this.hands.rpc === undefined ? carrierRpc(req, timeoutMs) : this.hands.rpc(req, timeoutMs)
  }

  private verbChain: Promise<unknown> = Promise.resolve()
  private chainRpc(req: Record<string, unknown>): Promise<Record<string, unknown>> {
    const link = this.verbChain.then(() => this.rpc(req))
    this.verbChain = link.catch(() => {})
    return link
  }

  private async openQuestion(): Promise<string | null> {
    try {
      return await this.questionOpen()
    } catch {
      return null
    }
  }
  private async questionOpen(): Promise<string | null> {
    const open = await (await import('../crew/obligations.js')).openObligations({ scope: 'switchboard' })
    const row = open.find(r => r.sessionId === this.record.sessionId && !(r.ref ?? '').startsWith('permission:'))
    return row?.obligationId ?? null
  }
  sessionId(): string {
    return this.record.sessionId
  }

  sendWords(text: string, opts?: SendWordsOptions): Promise<SendReceiptV1> {
    return this.deliveryPart.sendWords(text, opts)
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
    return this.sendsPart.recallableSend()
  }

  withdrawSend(clientMessageId: string): Promise<WithdrawReceiptV1> {
    return this.deliveryPart.withdrawSend(clientMessageId)
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
    return this.sendsPart.queuedSendCount()
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
    return this.factsPart.modelFacts()
  }

  subscribeModel(listener: () => void): () => void {
    return this.factsPart.subscribeModel(listener)
  }

  async setModel(setting: string | null, words?: string): Promise<ModelSwitchReceiptV1> {
    const target = setting ?? getEngineModel()
    const current = this.modelFacts()
    if (current.effective === target && current.pendingSwitch === null) return { state: 'no-op' }
    const busy = this.livePart.live().inFlight
    this.factsPart.showModel(target, busy)
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
      if (outcome === 'noop' || (outcome === 'queued') !== busy) this.readFacts()
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
    this.factsPart.showEffort(level, busy)
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
    return this.factsPart.usage()
  }

  identity(): SeatIdentityV1 {
    return this.factsPart.identity()
  }

  editOutcomes(): EditOutcomeRowV1[] | null {
    return this.factsPart.editOutcomes()
  }

  skillsRoster(): SkillsRosterV1 {
    return this.factsPart.skillsRoster()
  }

  mcpRoster(): McpRosterV1 {
    return this.factsPart.mcpRoster()
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
    return this.factsPart.spawnSwitches()
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
    return this.factsPart.advisorFacts()
  }

  swarmBoard(): import('../crewBoard/contracts.js').BoardViewSnapshot | null {
    return this.factsPart.swarmBoard()
  }

  subscribeWork(listener: () => void): () => void {
    return this.workPart.subscribeWork(listener)
  }

  permissionMode(): PermissionMode | null {
    return permissionModeOf(this.factsPart.read(), bootBirthFacts())
  }

  subscribePermissionMode(listener: () => void): () => void {
    return this.factsPart.subscribePermissionMode(listener)
  }

  async setPermissionMode(mode: PermissionMode): Promise<PermissionModeReceiptV1> {
    const before = this.factsPart.showMode(mode)
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
      this.factsPart.restoreMode(before, mode)
      this.readFacts()
    }
    return receipt
  }

  workspace(): WorkspaceFactsV1 {
    return this.factsPart.workspace()
  }

  dispatchSlash(line: string): Promise<SendReceiptV1> {
    return this.deliveryPart.dispatchSlash(line)
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
      runner: this.admissionPart.runnerShown(this.factsPart.read()?.runner ?? null),
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
