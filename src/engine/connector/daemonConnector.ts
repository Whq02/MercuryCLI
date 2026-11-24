import { flagEnabled } from '../../platform/substrate/flagRegistry.js'
import { join } from 'node:path'
import type { Message } from '../message-shapes/message.js'
import type { PermissionMode } from '../../permissions/rules/permissions.js'
import type { PastedContent } from '../../platform/config/schema.js'
import { storedImageRefBlock } from '../../platform/images/imageStore.js'
import { logForDebugging } from '../../platform/logs/debugLog.js'
import { randomUUID } from 'node:crypto'
import type { SessionKitEditV1 } from '../../daemon/session-seat/sessionKit.js'
import type { SpawnSwitchFacts, SpawnSwitchKind } from '../../daemon/switchboard/spawnSwitches.js'
import { createModelTransitionMessage, createSeatReceiptMessage } from '../message-shapes/systemMessages.js'
import { providerFamilyOfSetting } from '../../models/catalogue/modelTransition.js'
import type { StreamingTailStore } from '../message-shapes/streamingTailStore.js'
import { adoptOpenaiObservedUsage, adoptOpenaiWindowFact } from '../../models/roads/openai/openaiLimitState.js'
import { adoptOpenaiCatalogueFact } from '../../models/roads/openai/openaiCatalogue.js'
import { adoptAnthropicObservedUsage, adoptAnthropicWindowFact } from '../../models/roads/anthropic/anthropicLimits.js'
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
import type { LiveTurnFactsV1, LostLineV1, SeatLiveExtensionV1, SeatStatusV1, SessionLiveV1 } from './seatLive.js'
import type { CommittedTextRow } from './midTurnText.js'
import type { FoldStatusV1 } from '../compaction/foldStatus.js'
import { getFocusedSessionConnector, setFocusedSessionConnector, subscribeFocusedSessionConnector, claimHopEpoch, hopEpochIsCurrent } from './focusedConnector.js'
import type {
  AdvisorFactsV1,
  CrewmateControlReceiptV1,
  AskAnswerV1,
  AskReceiptV1,
  BoardPostReceiptV1,
  BoardPostRequestV1,
  CheckpointFactsV1,
  EditOutcomeRowV1,
  EmptyDetailControlMethods,
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
import { bootBirthFacts, type BootBirthFacts } from '../../daemon/switchboard/bootBirthFacts.js'
import { swarmMasterEnabled } from '../../crew/board/seam.js'
import type { BoardViewSnapshot } from '../../crew/board/contracts.js'
import { seatInitialPermissionMode } from '../../daemon/concourse-workers/concourseWorkers.js'
import { AdmissionPart } from './daemon/admission.js'
import { AsksPart } from './daemon/asks.js'
import { CarrierPart } from './daemon/carrier.js'
import { CompletionPart } from './daemon/completion.js'
import { DeliveryPart } from './daemon/delivery.js'
import { FactsPart } from './daemon/facts.js'
import { FoldPart } from './daemon/fold.js'
import { SendsPart } from './daemon/sends.js'
import { connectorTrace } from './daemon/shared.js'
import { TailPart } from './daemon/tail.js'
import { LivePart } from './daemon/live.js'
import { WorkPart } from './daemon/work.js'
import { TranscriptPart } from './daemon/transcript.js'
import { VerbsPart } from './daemon/verbs.js'
import { DialsPart, SEAT_VERB_SETTLE_MS } from './daemon/dials.js'
import { HEARTBEAT_MS, ProjectionFeed } from './projectionFeed.js'
import { passedOver } from '../../platform/errors/passedOver.js'
import { installEmptyDetailControlMethods } from './emptyDetailControls.js'

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

type DispatchedImageBlock =
  | NonNullable<ReturnType<typeof storedImageRefBlock>>
  | { type: 'image'; source: { type: 'base64'; media_type: string; data: string } }

export function imageBlocksOf(pastes: Record<number, PastedContent>): DispatchedImageBlock[] {
  return Object.entries(pastes)
    .map(([id, content]) => ({ id: Number(id), content }))
    .filter(entry => entry.content.type === 'image' && Boolean(entry.content.content))
    .sort((a, b) => a.id - b.id)
    .map(
      entry =>
        storedImageRefBlock(entry.content) ?? {
          type: 'image' as const,
          source: { type: 'base64' as const, media_type: entry.content.mediaType ?? 'image/png', data: entry.content.content },
        },
    )
}
export { HEARTBEAT_MS, PROJECTION_ABSENT, ProjectionFeed, projectionChangeKey } from './projectionFeed.js'
const RPC_TIMEOUT_MS = 15_000
export const IDLE_PROJECTION_FLOOR_MS = 10_000
const TURN_END_SETTLE_MS = 4000
export { SEAT_VERB_SETTLE_MS } from './daemon/dials.js'
export const CARRIER_GONE_WORDS = 'the background daemon ended — the next prompt starts a new one'

const SEAT_BY = `operator:${process.pid}`

let seatChain: Promise<unknown> = Promise.resolve()
function seatVerb(action: 'focus' | 'blur', sessionId: string): void {
  seatChain = seatChain
    .then(async () => {
      const { daemonControlRpc } = await import('../../daemon/control/controlSocket.js')
      let terminalApplication: { identity: string; name: string; windowId?: string | null; tty?: string | null } | null | undefined
      if (action === 'focus' && flagEnabled('MERCURY_COMPUTER_USE')) {
        const { resolveDesktopDriver } = await import('../../integrations/desktop/resolveDriver.js')
        const driver = resolveDesktopDriver()
        const terminal = driver.state === 'ok' ? await driver.driver.ownTerminalApplication() : null
        terminalApplication = terminal?.ok && terminal.value !== null ? { identity: terminal.value.identity, name: terminal.value.name, windowId: terminal.value.windowId ?? null, tty: terminal.value.tty ?? null } : null
      }
      const reply = await daemonControlRpc({ op: 'sessionControl', action, sessionId, by: SEAT_BY, ...(terminalApplication !== undefined ? { terminalApplication } : {}) }, { timeoutMs: RPC_TIMEOUT_MS })
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
  const { daemonControlRpc } = await import('../../daemon/control/controlSocket.js')
  return (await daemonControlRpc(req as never, { timeoutMs })) as Record<string, unknown>
}

function modelSettledRow(settled: { from: string; to: string }): Message {
  return createModelTransitionMessage({
    previous: settled.from,
    requested: settled.to,
    applied: settled.to,
    resolution: 'applied',
    boundary: 'turn-boundary',
    crossProvider:
      providerFamilyOfSetting(settled.from) !==
      providerFamilyOfSetting(settled.to),
    cacheDisposition: 'keyed-sections-recompute-once',
  })
}

async function questionOpenFor(sessionId: string): Promise<string | null> {
  const open = await (await import('../../crew/crewmates/obligations.js')).openObligations({ scope: 'switchboard' })
  const row = open.find(r => r.sessionId === sessionId && !(r.ref ?? '').startsWith('permission:'))
  return row?.obligationId ?? null
}

function seatLabelsOf(record: DaemonSessionRecordV1): Pick<DaemonSessionRecordV1, 'title' | 'projectLabel'> & Partial<Pick<DaemonSessionRecordV1, 'isolation' | 'branchLabel'>> {
  return {
    title: liveTitleDeriver?.(record) ?? record.title,
    projectLabel: record.projectLabel,
    ...(record.isolation !== undefined ? { isolation: record.isolation } : {}),
    ...(record.branchLabel !== undefined ? { branchLabel: record.branchLabel } : {}),
  }
}

abstract class ConnectorHandOffs {
  abstract readonly record: DaemonSessionRecordV1
  protected abstract readonly transcriptPart: TranscriptPart
  protected abstract readonly sendsPart: SendsPart
  protected abstract readonly deliveryPart: DeliveryPart
  protected abstract readonly factsPart: FactsPart
  protected abstract readonly completionPart: CompletionPart
  protected abstract readonly admissionPart: AdmissionPart
  protected abstract readonly workPart: WorkPart
  protected abstract readonly asksPart: AsksPart
  protected abstract readonly tailPart: TailPart
  protected abstract readonly foldPart: FoldPart
  protected abstract readonly livePart: LivePart
  protected abstract readonly verbsPart: VerbsPart
  protected abstract readonly dialsPart: DialsPart

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

  addDisplayRow(row: Message): void {
    this.transcriptPart.addDisplayRow(row)
  }

  transcriptFile(): string {
    return this.transcriptPart.transcriptFile()
  }

  awaitAdmission(admission: Promise<string | null>): void {
    this.admissionPart.awaitAdmission(admission)
  }

  admissionRefusal(): string | null {
    return this.admissionPart.admissionRefusal()
  }

  lastTurnCompletedAtMs(): number | null {
    return this.completionPart.lastTurnCompletedAtMs()
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

  checkpointFacts(): CheckpointFactsV1 {
    return this.workPart.checkpointFacts()
  }

  subscribeCheckpoints(listener: () => void): () => void {
    return this.workPart.subscribeCheckpoints(listener)
  }

  rewind(req: RewindRequestV1): Promise<RewindReceiptV1> {
    return this.verbsPart.rewind(req)
  }

  sessionId(): string {
    return this.record.sessionId
  }

  sendWords(text: string, opts?: SendWordsOptions): Promise<SendReceiptV1> {
    return this.deliveryPart.sendWords(text, opts)
  }

  sendAgentNote(agentId: string, text: string): Promise<SendReceiptV1> {
    return this.verbsPart.sendAgentNote(agentId, text)
  }

  records(): readonly Message[] {
    return this.transcriptPart.records()
  }

  subscribeRecords(listener: () => void): () => void {
    return this.transcriptPart.subscribeRecords(listener)
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

  recallableSend(): RecallableSendV1 | null {
    return this.sendsPart.recallableSend()
  }

  withdrawSend(clientMessageId: string): Promise<WithdrawReceiptV1> {
    return this.deliveryPart.withdrawSend(clientMessageId)
  }

  stopAgent(agentId: string, note?: string): Promise<CrewmateControlReceiptV1> {
    return this.verbsPart.agentVerb('stop-agent', agentId, note)
  }

  resumeAgent(agentId: string, note?: string): Promise<CrewmateControlReceiptV1> {
    return this.verbsPart.agentVerb('resume-agent', agentId, note)
  }

  queuedSendCount(): number {
    return this.sendsPart.queuedSendCount()
  }

  pauseGate(paused: boolean): Promise<CrewmateControlReceiptV1> {
    return this.verbsPart.pauseGate(paused)
  }

  postBoard(post: BoardPostRequestV1): Promise<BoardPostReceiptV1> {
    return this.verbsPart.postBoard(post)
  }

  leave(opts?: { signal?: AbortSignal }): Promise<LeaveReceiptV1> {
    return this.verbsPart.leave(opts)
  }

  modelFacts(): ModelFactsV1 {
    return this.factsPart.modelFacts()
  }

  subscribeModel(listener: () => void): () => void {
    return this.factsPart.subscribeModel(listener)
  }

  setModel(setting: string | null, words?: string, replacedDefault?: string): Promise<ModelSwitchReceiptV1> {
    return this.dialsPart.setModel(setting, words, replacedDefault)
  }

  setEffort(level: string): Promise<ModelSwitchReceiptV1> {
    return this.dialsPart.setEffort(level)
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

  mcpAction(name: string, action: 'authenticate' | 'reconnect' | 'cancel-auth'): Promise<KitDialReceiptV1> {
    return this.dialsPart.mcpAction(name, action)
  }

  mcpTools(serverName: string): Promise<McpToolsV1> {
    return this.dialsPart.mcpTools(serverName)
  }

  setKit(edit: SessionKitEditV1): Promise<KitDialReceiptV1> {
    return this.dialsPart.setKit(edit)
  }

  spawnSwitches(): SpawnSwitchFacts {
    return this.factsPart.spawnSwitches()
  }

  setSpawnSwitch(kind: SpawnSwitchKind, on: boolean): Promise<SpawnSwitchReceiptV1> {
    return this.dialsPart.setSpawnSwitch(kind, on)
  }

  workRoster(): WorkRosterV1 {
    return this.workPart.workRoster()
  }

  advisorFacts(): AdvisorFactsV1 | null {
    return this.factsPart.advisorFacts()
  }

  swarmBoard(): BoardViewSnapshot | null {
    if (this.factsPart.read() !== null) return this.factsPart.swarmBoard()
    return swarmMasterEnabled() ? this.factsPart.pendingSwarm() : null
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

  setPermissionMode(mode: PermissionMode): Promise<PermissionModeReceiptV1> {
    return this.dialsPart.setPermissionMode(mode)
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

  tailAnchor(): number {
    return this.transcriptPart.tailAnchor()
  }

  status(): SeatStatusV1 {
    return this.livePart.status({ ...seatLabelsOf(this.record), runner: this.admissionPart.runnerShown(this.factsPart.read()?.runner ?? null) })
  }
}

interface ConnectorHandOffs extends EmptyDetailControlMethods {}

abstract class ConnectorOwnWork extends ConnectorHandOffs {
  protected abstract readonly hands: ConnectorHands
  protected abstract readonly carrierPart: CarrierPart
  protected abstract readonly factsFeed: ProjectionFeed
  protected abstract readonly asksFeed: ProjectionFeed
  protected abstract readonly tailFeed: ProjectionFeed
  protected abstract readonly progressFeed: ProjectionFeed
  protected abstract turnInFlight: boolean
  protected abstract attached: boolean
  protected abstract verbChain: Promise<unknown>

  protected carrierWentAway(): void {
    this.factsPart.strip()
    this.workPart.refreshWork()
    this.recomputeLive()
    this.addDisplayRow(createSeatReceiptMessage(CARRIER_GONE_WORDS, 'warning'))
  }

  attach(): Promise<void> {
    if (this.attached) return Promise.resolve()
    this.attached = true
    connectorTrace({ ev: 'attach', sid: this.record.sessionId, raw: this.transcriptPart.rows().length, display: this.transcriptPart.displayCount() })
    this.transcriptPart.armTranscriptWatcher()
    this.transcriptPart.armTranscriptTimer()
    this.factsFeed.start()
    this.asksFeed.start()
    this.tailFeed.start()
    this.progressFeed.start()
    this.factsFeed.recheckSoon()
    void this.rpc({ op: 'sessionControl', action: 'session-facts', sessionId: this.record.sessionId, by: 'operator' }).catch(passedOver)
    seatVerb('focus', this.record.sessionId)
    return this.tick()
  }

  detach(): void {
    this.carrierPart.disarmBusyStall()
    if (!this.attached) return
    this.attached = false
    this.livePart.syncLivenessTicker(false)
    connectorTrace({ ev: 'detach', sid: this.record.sessionId, raw: this.transcriptPart.rows().length, display: this.transcriptPart.displayCount() })
    this.transcriptPart.detached()
    this.factsFeed.stop()
    this.asksFeed.stop()
    this.tailFeed.stop()
    this.progressFeed.stop()
    seatVerb('blur', this.record.sessionId)
    this.tailPart.detached()
    this.livePart.detached()
  }

  protected readTail(): void {
    const tail = readSessionTail(this.record.sessionId)
    if (tail === null) {
      this.livePart.tailGone()
      this.tailPart.clearTail(Date.now())
      return
    }
    this.livePart.takeTail(tail)
    this.tailPart.takeTail(tail)
  }

  protected syncFeedCadence(inFlight: boolean): void {
    if (this.turnInFlight === inFlight) return
    this.turnInFlight = inFlight
    this.transcriptPart.armTranscriptTimer()
    if (!inFlight) this.factsFeed.settle(TURN_END_SETTLE_MS)
    this.factsFeed.rearm()
    this.asksFeed.rearm()
    this.tailFeed.rearm()
    this.progressFeed.rearm()
  }

  feedCadencesForProofs(): { transcript: number; facts: number; asks: number; tail: number; progress: number } {
    return {
      transcript: this.transcriptPart.heartbeatMs(),
      facts: this.factsFeed.heartbeatMs(),
      asks: this.asksFeed.heartbeatMs(),
      tail: this.tailFeed.heartbeatMs(),
      progress: this.progressFeed.heartbeatMs(),
    }
  }

  isAttached(): boolean {
    return this.attached
  }

  assertSeat(): void {
    if (this.attached) seatVerb('focus', this.record.sessionId)
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

  protected tick(): Promise<void> {
    return this.transcriptPart.tick()
  }

  protected recomputeLive(): void {
    this.livePart.recomputeLive()
  }

  protected paint(): void {
    this.transcriptPart.paint()
  }

  protected readFacts(): void {
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
      this.addDisplayRow(modelSettledRow(settled))
    }
    if (this.factsPart.followBusy()) this.carrierPart.armBusyStall()
    else this.carrierPart.disarmBusyStall()
    this.sendsPart.reconcileQueuedSends(next)
    this.completionPart.refreshWorkerTurnMarks()
    this.recomputeLive()
    connectorTrace({ ev: 'facts', sid: this.record.sessionId, busy: next.busy, atMs: next.atMs, queue: next.queue?.length ?? 0, sends: this.sendsPart.states(), inFlight: this.livePart.live().inFlight, ...this.livePart.pressed() })
    this.factsPart.wake(modelMoved, modeMoved)
    const answered = endedRunResults(this.transcriptPart.kept(), this.factsPart.read(), this.carrierPart.gone())
    const answeredMoved = answered.length !== this.transcriptPart.answered().length || answered.some((row, at) => row !== this.transcriptPart.answered()[at])
    if (this.sendsPart.reconcileSends() || this.transcriptPart.clearReceipt() === undefined || answeredMoved) this.paint()
    this.workPart.refreshWork()
  }

  protected readAsks(): void {
    this.asksPart.readAsks()
  }

  protected rpc(req: Record<string, unknown>, timeoutMs = RPC_TIMEOUT_MS): Promise<Record<string, unknown>> {
    return this.hands.rpc === undefined ? carrierRpc(req, timeoutMs) : this.hands.rpc(req, timeoutMs)
  }

  protected chainRpc(req: Record<string, unknown>): Promise<Record<string, unknown>> {
    const link = this.verbChain.then(() => this.rpc(req))
    this.verbChain = link.catch(passedOver)
    return link
  }

  protected async openQuestion(): Promise<string | null> {
    try {
      const id = await questionOpenFor(this.record.sessionId)
      this.deliveryPart.noteOpenQuestionRead()
      return id
    } catch (error) {
      passedOver(error)
      this.deliveryPart.noteOpenQuestionUnread(error instanceof Error ? error.message : String(error))
      return null
    }
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
}

export class DaemonSessionConnector extends ConnectorOwnWork implements EngineConnectorV1, SeatLiveExtensionV1 {
  readonly carrier = 'daemon' as const

  static {
    installEmptyDetailControlMethods(DaemonSessionConnector.prototype, (self, key) => self.verbsPart.controlVerb(key))
  }

  protected readonly carrierPart = new CarrierPart({
    sessionId: () => this.record.sessionId,
    rpc: req => this.rpc(req),
    factsBusy: () => this.factsPart.busy(),
    factsAtMs: () => this.factsPart.read()?.atMs ?? 0,
    dropBusy: () => this.factsPart.dropBusy(),
    recomputeLive: () => this.recomputeLive(),
    carrierWentAway: () => this.carrierWentAway(),
  })
  protected turnInFlight = false
  protected readonly transcriptPart: TranscriptPart

  protected readonly sendsPart = new SendsPart({
    sessionId: () => this.record.sessionId,
    rows: () => this.transcriptPart.rows(),
    paint: () => this.paint(),
    folding: () => this.liveStateWord === 'compacting',
    wakeLive: () => this.livePart.wake(),
    arrivalSeqFor: seenAtMs => this.tailPart.arrivalSeqFor(seenAtMs),
    noticeSeqAt: atMs => this.tailPart.noticeSeqAt(atMs),
    retireTextRowsWithRunner: () => this.tailPart.retireTextRowsWithRunner(),
    noteSendDemoted: () => this.completionPart.noteSendDemoted(),
    noteSendTaken: () => this.completionPart.noteSendTaken(),
    lostWithRunnerLine: lines => lostWithRunnerLine(lines),
  })
  protected readonly deliveryPart = new DeliveryPart({
    sessionId: () => this.record.sessionId,
    factsBusy: () => this.factsPart.busy(),
    folding: () => this.liveStateWord === 'compacting',
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
    unconfirmedDraft: key => this.sendsPart.unconfirmedDraft(key),
    sendOf: clientMessageId => this.sendsPart.sendOf(clientMessageId),
    markWithdrawing: (clientMessageId, on) => this.sendsPart.markWithdrawing(clientMessageId, on),
    retireUnknown: clientMessageId => this.sendsPart.retireSendUnknownToRunner(clientMessageId),
  })
  protected readonly factsPart: FactsPart
  protected readonly completionPart: CompletionPart
  protected readonly admissionPart = new AdmissionPart({ wakeLive: () => this.livePart.wake() })
  protected readonly factsFeed: ProjectionFeed
  protected readonly workPart = new WorkPart({ facts: () => this.factsPart.read(), carrierGone: () => this.carrierPart.gone() })

  protected readonly asksPart = new AsksPart({
    record: () => this.record,
    rows: () => this.transcriptPart.rows(),
    facts: () => this.factsPart.read(),
    permissionMode: () => this.permissionMode(),
    chainRpc: req => this.chainRpc(req),
    deliver: (text, opts) => this.deliveryPart.deliver(text, opts),
    recheckAsks: () => {
      this.asksFeed.settle(SEAT_VERB_SETTLE_MS)
      this.asksFeed.recheckSoon()
    },
    settleFacts: () => {
      this.factsFeed.settle(SEAT_VERB_SETTLE_MS)
      this.factsFeed.recheckSoon()
    },
  })
  protected readonly asksFeed: ProjectionFeed

  protected readonly tailFeed: ProjectionFeed
  protected readonly tailPart = new TailPart({
    sessionId: () => this.record.sessionId,
    rows: () => this.transcriptPart.rows(),
    model: () => this.modelFacts().effective,
    paint: () => this.paint(),
  })
  protected readonly foldPart = new FoldPart({ recomputeLive: () => this.recomputeLive() })
  protected readonly livePart: LivePart = new LivePart({
    sessionId: () => this.record.sessionId,
    attached: () => this.attached,
    factsBusy: () => this.factsPart.busy(),
    work: () => this.factsPart.read()?.work ?? [],
    factsTurnStartedAt: () => this.factsPart.read()?.turnStartedAt,
    streamIdleTimeoutMs: () => this.factsPart.streamIdleTimeoutMs(),
    model: () => this.modelFacts().effective,
    anySendDelivered: () => this.sendsPart.anyDelivered(),
    redressQueuedSends: () => this.sendsPart.redressQueued(),
    transcriptLive: () => this.transcriptPart.live(),
    toolStartedAtMs: inProgress => this.transcriptPart.toolStartedAtMs(inProgress),
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

  protected readonly verbsPart = new VerbsPart({
    record: () => this.record,
    rpc: (req, timeoutMs) => this.rpc(req, timeoutMs),
    chainRpc: req => this.chainRpc(req),
    verbChain: () => this.verbChain,
    tick: () => this.tick(),
    readFacts: () => this.readFacts(),
  })

  protected readonly dialsPart = new DialsPart({
    record: () => this.record,
    rpc: (req, timeoutMs) => this.rpc(req, timeoutMs),
    chainRpc: req => this.chainRpc(req),
    readFacts: () => this.readFacts(),
    live: () => this.livePart.live(),
    modelFacts: () => this.modelFacts(),
    showModel: (target, busy) => this.factsPart.showModel(target, busy),
    showEffort: (level, busy) => this.factsPart.showEffort(level, busy),
    showMode: mode => this.factsPart.showMode(mode),
    restoreMode: (before, mode) => this.factsPart.restoreMode(before, mode),
    settleFacts: windowMs => this.factsFeed.settle(windowMs),
  })

  protected readonly progressFeed: ProjectionFeed

  protected attached = false
  protected verbChain: Promise<unknown> = Promise.resolve()

  constructor(readonly record: DaemonSessionRecordV1, protected readonly hands: ConnectorHands = {}) {
    super()
    this.transcriptPart = new TranscriptPart({
      transcriptPath: join(record.home, `${record.sessionId}.jsonl`),
      armWatcherByHand: () => {
        if (this.hands.armTranscriptWatcher === undefined) return false
        this.hands.armTranscriptWatcher()
        return true
      },
      armTimerByHand: () => {
        if (this.hands.armTranscriptTimer === undefined) return false
        this.hands.armTranscriptTimer()
        return true
      },
      tickByHand: pass => (this.hands.tickOnce === undefined ? undefined : this.hands.tickOnce(pass)),
      record: () => this.record,
      attached: () => this.attached,
      turnInFlight: () => this.turnInFlight,
      facts: () => this.factsPart.read(),
      carrierGone: () => this.carrierPart.gone(),
      admissionAwaiting: () => this.admissionPart.awaiting(),
      readFacts: () => this.readFacts(),
      recomputeLive: () => this.recomputeLive(),
      tailSeq: () => this.tailPart.seq(),
      textRows: () => this.textRows,
      dropCommittedRows: () => this.tailPart.dropCommittedRows(),
      releaseTail: () => this.tailPart.releaseTail(),
      retireTextRows: () => this.tailPart.retireTextRows(),
      echoes: tailSeq => this.sendsPart.echoes(tailSeq),
      reconcileSends: () => this.sendsPart.reconcileSends(),
      placeDelivered: rows => this.sendsPart.placeDelivered(rows),
      landingsAfter: seq => this.tailPart.landingsAfter(seq),
    })
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
      hasUnreadTranscript: () => this.transcriptPart.hasUnreadTranscript(),
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

  private get liveStateWord(): 'compacting' | 'waiting-on-agents' | null {
    return this.livePart.stateWord()
  }

  private get textRows(): readonly CommittedTextRow[] {
    return this.tailPart.committedRows()
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
