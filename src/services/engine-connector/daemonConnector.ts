import { appendFileSync, existsSync, statSync, watch, mkdirSync, type FSWatcher } from 'node:fs'
import { flagEnv } from '../../substrate/flagRegistry.js'
import { armInactivityDeadline } from '../../utils/deadline.js'
import { resolveWatchRoot } from '../../utils/watchRoot.js'
import { join } from 'node:path'
import type { Message, AssistantMessage } from '../../types/message.js'
import type { ContentBlockParam } from '../../types/wire.js'
import type { PermissionMode } from '../../types/permissions.js'
import { decodeDecisionReasonFromWire } from '../../utils/permissions/decisionReasonWire.js'
import type { PastedContent } from '../../utils/config/schema.js'
import { submitTrace } from '../../utils/submitTrace.js'
import type { Tool, ToolUseContext } from '../../Tool.js'
import type { ToolUseConfirm } from '../../components/permissions/PermissionRequest.js'
import { logForDebugging } from '../../utils/debug.js'
import { randomUUID } from 'node:crypto'
import type { SessionKitEditV1 } from '../../daemon/sessionKit.js'
import { createAssistantMessage, createUserMessage } from '../../utils/messages/factories.js'
import { createModelTransitionMessage } from '../../utils/messages/systemMessages.js'
import { providerFamilyOfSetting } from '../../utils/model/modelTransition.js'
import { createLiveTurnFold, deserializeLiveMessages, type LiveTurnFold } from '../../utils/conversationRecovery.js'
import type { TranscriptChainCursor } from '../../utils/sessionStorage/transcriptReader.js'
import { createFileStateCacheWithSizeLimit, READ_FILE_STATE_CACHE_SIZE } from '../../utils/fileStateCache.js'
import { getAllBaseTools } from '../../tools.js'
import { MCPTool } from '../../tools/MCPTool/MCPTool.js'
import { getMainLoopModel } from '../../utils/model/model.js'
import { createStreamingTailStore, type StreamingTailStore } from '../../utils/messages/streamingTailStore.js'
import { adoptOpenaiObservedUsage } from '../providers/openai/openaiLimitState.js'
import { mergeRecordsContentKeyed } from './recordIdentity.js'
import {
  readSessionAsks,
  readSessionFacts,
  readSessionProgress,
  readSessionTail,
  sessionAsksDir,
  sessionAsksPath,
  sessionFactsDir,
  sessionFactsPath,
  sessionProgressDir,
  sessionProgressPath,
  sessionTailDir,
  sessionTailPath,
  type SessionAskProjectionV1,
  type SessionFactsV1,
  type SessionProgressEntryV1,
} from './seatProjections.js'
import { clearEphemeralProgress, publishEphemeralProgress } from '../../state/ephemeralProgressStore.js'
import type { ProgressMessage } from '../../types/message.js'
import type { MCPProgress, ShellProgress } from '../../types/tools.js'
import { IDLE_LIVE, type SeatLiveExtensionV1, type SeatStatusV1, type SessionLiveV1 } from './seatLive.js'
import { fluxMark } from '../../utils/flux/fluxProbe.js'
import { streamIdleWarningMsOf } from '../providers/streamIdleBudget.js'
import { getFocusedSessionConnector, setFocusedSessionConnector, subscribeFocusedSessionConnector, claimHopEpoch, hopEpochIsCurrent } from './focusedConnector.js'
import type {
  AskAnswerV1,
  AskReceiptV1,
  CheckpointFactsV1,
  EngineConnectorV1,
  KitDialReceiptV1,
  McpRosterV1,
  ModelFactsV1,
  ModelSwitchReceiptV1,
  RewindReceiptV1,
  RewindRequestV1,
  SeatIdentityV1,
  SendReceiptV1,
  SendWordsOptions,
  SessionAskV1,
  SkillsRosterV1,
  UsageFactsV1,
  WorkRosterV1,
  WorkspaceFactsV1,
} from './types.js'
import { projectOperatorRewinds } from '../compact/checkpointRewind.js'

const UNKNOWN_CHECKPOINTS: CheckpointFactsV1 = Object.freeze({ capture: 'unknown' as const, restorable: Object.freeze(new Set<string>()) as ReadonlySet<string> })

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

interface SeatSend {
  clientMessageId: string
  text: string
  sentAtMs: number
  state: 'pending' | 'delivered'
  mode: 'prompt' | 'bash'
}

const REFUSED_EMPTY: SendReceiptV1 = { state: 'refused', detail: 'nothing to send' }

function reconstructedProgressMessage(parentToolUseID: string, entry: SessionProgressEntryV1): ProgressMessage {
  let data: ShellProgress | MCPProgress
  if (entry.dataType === 'mcp_progress') {
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

export function imageBlocksOf(pastes: Record<number, PastedContent>): ContentBlockParam[] {
  return Object.entries(pastes)
    .map(([id, content]) => ({ id: Number(id), content }))
    .filter(entry => entry.content.type === 'image' && Boolean(entry.content.content))
    .sort((a, b) => a.id - b.id)
    .map(
      entry =>
        ({
          type: 'image',
          source: { type: 'base64', media_type: entry.content.mediaType ?? 'image/png', data: entry.content.content },
        }) as unknown as ContentBlockParam,
    )
}
const RPC_TIMEOUT_MS = 15_000
const HEARTBEAT_MS = 400
const LIVENESS_TICK_MS = 1000
const ECHO_RETIRE_MS = 10 * 60_000
const UUID_SHAPE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

const SEAT_BY = `operator:${process.pid}`

let seatChain: Promise<unknown> = Promise.resolve()
function seatVerb(action: 'focus' | 'blur', sessionId: string): void {
  seatChain = seatChain
    .then(async () => {
      const { daemonControlRpc } = await import('../../daemon/controlSocket.js')
      const reply = (await daemonControlRpc({ op: 'sessionControl', action, sessionId, by: SEAT_BY } as never, { timeoutMs: RPC_TIMEOUT_MS })) as { ok?: boolean; error?: string }
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

function toolFor(name: string): Tool {
  const known = getAllBaseTools().find(t => t.name === name)
  if (known) return known
  return {
    ...MCPTool,
    name,
    userFacingName: () => name.replace(/^mcp__/, '').replace(/__/g, ' › '),
  } as unknown as Tool
}

export function projectionChangeKey(stat: { mtimeMs: number; size: number; ino: number }): string {
  return `${stat.mtimeMs}:${stat.size}:${stat.ino}`
}
export const PROJECTION_ABSENT = 'absent'

export class ProjectionFeed {
  private watcher: FSWatcher | null = null
  private timer: ReturnType<typeof setInterval> | null = null
  private lastKey = PROJECTION_ABSENT
  constructor(
    private readonly dir: string,
    private readonly path: string,
    private readonly onChange: () => void,
  ) {}
  start(): void {
    if (this.timer !== null) return
    const tick = (): void => {
      let key = PROJECTION_ABSENT
      try {
        key = projectionChangeKey(statSync(this.path))
      } catch {
        key = PROJECTION_ABSENT
      }
      if (key !== this.lastKey) {
        this.lastKey = key
        this.onChange()
      }
    }
    this.timer = setInterval(tick, HEARTBEAT_MS)
    this.timer.unref?.()
    try {
      mkdirSync(this.dir, { recursive: true })
      const watcher = watch(resolveWatchRoot(this.dir), (_event, filename) => {
        if (filename === undefined || filename === null || join(this.dir, String(filename)) === this.path) tick()
      })
      watcher.on('error', () => {
        try {
          watcher.close()
        } catch {
        }
        if (this.watcher === watcher) this.watcher = null
      })
      this.watcher = watcher
    } catch {
    }
    tick()
  }
  stop(): void {
    if (this.timer !== null) {
      clearInterval(this.timer)
      this.timer = null
    }
    try {
      this.watcher?.close()
    } catch {
    }
    this.watcher = null
    this.lastKey = PROJECTION_ABSENT
  }
}

type Listeners = Set<() => void>
function connectorTrace(entry: Record<string, unknown>): void {
  const path = flagEnv('MERCURY_CONNECTOR_TRACE')
  if (!path) return
  try {
    appendFileSync(path, `${JSON.stringify({ t: Date.now(), ...entry })}\n`)
  } catch {
  }
}

function emitAll(listeners: Listeners, what: string): void {
  fluxMark(`emit:${what}`)
  for (const l of [...listeners]) {
    try {
      l()
    } catch (e) {
      logForDebugging(`[engine-connector] daemon ${what} listener threw (ignored): ${e}`)
    }
  }
}

export class DaemonSessionConnector implements EngineConnectorV1, SeatLiveExtensionV1 {
  readonly carrier = 'daemon' as const

  private rawRecords: Message[] = []
  private recordSigs: string[] = []
  private painted: readonly Message[] = []
  private liveState: SessionLiveV1 = IDLE_LIVE
  private factsBusy = false
  private busyStallDeadline: ReturnType<typeof armInactivityDeadline> | null = null
  private static readonly BUSY_STALL_MS = 45_000

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
  private effectiveLive: SessionLiveV1 = IDLE_LIVE
  private displayRows: Array<{ row: Message; anchor: number }> = []
  private echoRows = new Map<string, Message>()
  private sends: SeatSend[] = []
  private textRetiredRowUuids = new Set<string>()
  private retainedSend: { text: string; id: string } | null = null
  private interrupting = false
  private lastSize = -1
  private lastLen = -1
  private chainCursor: TranscriptChainCursor | null = null
  private readonly liveFold: LiveTurnFold = createLiveTurnFold()
  private releaseTranscript: (() => void) | null = null
  private transcriptWatcher: FSWatcher | null = null
  private transcriptTimer: ReturnType<typeof setInterval> | null = null
  private tickInFlight: Promise<void> | null = null
  private tickDirty = false
  private readonly transcriptPath: string
  private readonly recordListeners: Listeners = new Set()
  private readonly liveListeners: Listeners = new Set()

  private facts: SessionFactsV1 | null
  private readonly factsFeed: ProjectionFeed
  private readonly modelListeners: Listeners = new Set()
  private readonly permissionListeners: Listeners = new Set()
  private readonly workListeners: Listeners = new Set()
  private workSnapshot: WorkRosterV1 = { rows: [], mission: [] }
  private workStamp = '[[],[]]'
  private readonly checkpointListeners: Listeners = new Set()
  private checkpointSnapshot: CheckpointFactsV1 = UNKNOWN_CHECKPOINTS
  private checkpointStamp = ''

  private askEntries: SessionAskV1[] = []
  private readonly confirms = new Map<string, ToolUseConfirm>()
  private readonly asksFeed: ProjectionFeed
  private readonly askListeners: Listeners = new Set()

  private readonly tailFeed: ProjectionFeed
  private readonly tailStore: StreamingTailStore = createStreamingTailStore()
  private tailAtMs = -1
  private liveTurnChars = 0
  private liveStateWord: 'compacting' | null = null

  private lastEventAtMs: number | null = null
  private streamBlock: 'thinking' | 'text' | 'tool_use' | null = null
  private blockSinceMs: number | null = null
  private readonly toolBudgets = new Map<string, { budgetMs: number; elapsedMs: number; atMs: number }>()
  private livenessTicker: ReturnType<typeof setInterval> | null = null

  private readonly progressFeed: ProjectionFeed
  private progressAtMs = -1
  private readonly publishedProgressSeqs = new Map<string, number>()

  private attached = false
  private admission: Promise<string | null> | null = null
  private refusedAdmission: string | null = null

  constructor(readonly record: DaemonSessionRecordV1) {
    this.transcriptPath = join(record.home, `${record.sessionId}.jsonl`)
    this.facts = readSessionFacts(record.sessionId)
    this.factsFeed = new ProjectionFeed(sessionFactsDir(), sessionFactsPath(record.sessionId), () => this.readFacts())
    this.asksFeed = new ProjectionFeed(sessionAsksDir(), sessionAsksPath(record.sessionId), () => this.readAsks())
    this.tailFeed = new ProjectionFeed(sessionTailDir(), sessionTailPath(record.sessionId), () => this.readTail())
    this.progressFeed = new ProjectionFeed(sessionProgressDir(), sessionProgressPath(record.sessionId), () => this.readProgress())
    this.readAsks()
    this.refreshWork()
    this.refreshCheckpoints()
  }


  attach(): Promise<void> {
    if (this.attached) return Promise.resolve()
    this.attached = true
    connectorTrace({ ev: 'attach', sid: this.record.sessionId, raw: this.rawRecords.length, display: this.displayRows.length })
    const timer = setInterval(() => void this.tick(), HEARTBEAT_MS)
    timer.unref?.()
    this.transcriptTimer = timer
    try {
      const watcher = watch(resolveWatchRoot(this.transcriptPath), () => void this.tick())
      watcher.on('error', () => {
        try {
          watcher.close()
        } catch {
        }
        if (this.transcriptWatcher === watcher) this.transcriptWatcher = null
      })
      this.transcriptWatcher = watcher
    } catch {
    }
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
    this.syncLivenessTicker(false)
    connectorTrace({ ev: 'detach', sid: this.record.sessionId, raw: this.rawRecords.length, display: this.displayRows.length })
    if (this.transcriptTimer !== null) {
      clearInterval(this.transcriptTimer)
      this.transcriptTimer = null
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
    this.tailStore.reset(null)
    this.tailStore.dropSettled()
    this.tailStore.setMessageId(null)
    this.tailAtMs = -1
    this.liveTurnChars = 0
    this.liveStateWord = null
    clearEphemeralProgress()
    this.publishedProgressSeqs.clear()
    this.progressAtMs = -1
  }

  private readProgress(): void {
    const progress = readSessionProgress(this.record.sessionId)
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

  private readTail(): void {
    const tail = readSessionTail(this.record.sessionId)
    if (tail === null) {
      this.liveTurnChars = 0
      this.setLiveStateWord(null)
      this.setStreamBlock(null, null)
      this.lastEventAtMs = null
      if (this.tailStore.read() !== null) this.tailStore.update(() => null)
      return
    }
    this.liveTurnChars = tail.turnChars ?? 0
    this.setLiveStateWord(tail.stateWord === 'compacting' ? 'compacting' : null)
    this.lastEventAtMs = typeof tail.lastEventAtMs === 'number' ? tail.lastEventAtMs : null
    const block = tail.streamBlock === 'thinking' || tail.streamBlock === 'text' || tail.streamBlock === 'tool_use' ? tail.streamBlock : null
    this.setStreamBlock(block, block !== null && typeof tail.blockSinceMs === 'number' ? tail.blockSinceMs : null)
    if (tail.atMs === this.tailAtMs && tail.text === this.tailStore.read()) return
    this.tailAtMs = tail.atMs
    const text = tail.text
    this.tailStore.setMessageId(typeof tail.messageId === 'string' && tail.messageId !== '' ? tail.messageId : null)
    this.tailStore.update(() => text)
  }

  turnChars(): number {
    return this.liveTurnChars
  }

  private setLiveStateWord(word: 'compacting' | null): void {
    if (this.liveStateWord === word) return
    this.liveStateWord = word
    this.recomputeLive()
  }

  private setStreamBlock(block: 'thinking' | 'text' | 'tool_use' | null, sinceMs: number | null): void {
    const flipped = this.streamBlock !== block
    this.streamBlock = block
    this.blockSinceMs = sinceMs
    if (flipped) this.recomputeLive()
  }

  private syncLivenessTicker(inFlight: boolean): void {
    if (inFlight && this.attached) {
      if (this.livenessTicker !== null) return
      const t = setInterval(() => emitAll(this.liveListeners, 'liveness'), LIVENESS_TICK_MS)
      t.unref?.()
      this.livenessTicker = t
      return
    }
    if (this.livenessTicker !== null) {
      clearInterval(this.livenessTicker)
      this.livenessTicker = null
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

  transcriptFile(): string {
    return this.transcriptPath
  }

  adoptRecord(next: DaemonSessionRecordV1): void {
    if (next.sessionId !== this.record.sessionId) return
    Object.assign(this.record, next)
    emitAll(this.liveListeners, 'live')
  }

  awaitAdmission(admission: Promise<string | null>): void {
    this.admission = admission
    void admission.then(refusal => {
      if (refusal !== null) {
        this.refusedAdmission = refusal
        emitAll(this.liveListeners, 'live')
      }
    })
    void admission.finally(() => {
      if (this.admission === admission) this.admission = null
    })
  }

  admissionRefusal(): string | null {
    return this.refusedAdmission
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
    try {
      let sizeNow = -1
      try {
        sizeNow = statSync(this.transcriptPath).size
      } catch {
        sizeNow = -1
      }
      connectorTrace({ ev: 'tick', sid: this.record.sessionId, sizeNow, lastSize: this.lastSize, lastLen: this.lastLen })
      if (sizeNow !== -1 && sizeNow === this.lastSize && this.lastLen >= 0) return
      if (sizeNow !== -1 && this.transcriptWatcher === null) {
        try {
          const watcher = watch(resolveWatchRoot(this.transcriptPath), () => void this.tick())
          watcher.on('error', () => {
            if (this.transcriptWatcher === watcher) this.transcriptWatcher = null
          })
          this.transcriptWatcher = watcher
        } catch {
        }
      }
      const reader = await import('../../utils/sessionStorage/transcriptReader.js')
      if (this.releaseTranscript === null) this.releaseTranscript = reader.retainTranscript(this.transcriptPath)
      const chain = await reader.readTranscriptChainSince(this.transcriptPath, this.chainCursor)
      if (!this.attached) return
      this.chainCursor = chain.cursor
      const raw = chain.rows as unknown as Message[]
      if (sizeNow !== -1 && sizeNow !== this.lastSize) this.lastSize = sizeNow
      this.lastLen = raw.length
      const merge = mergeRecordsContentKeyed(
        this.rawRecords,
        this.recordSigs,
        raw,
        deserializeLiveMessages(raw),
        reader.chainRowSigner(),
      )
      this.recordSigs = merge.sigs
      connectorTrace({ ev: 'load', sid: this.record.sessionId, rawLen: raw.length, reusedAll: merge.reusedAll, prevLen: this.rawRecords.length, since: chain.since, rewound: chain.rewound })
      if (merge.reusedAll) return
      this.rawRecords = merge.records
      this.liveState = this.liveFold.fold(this.rawRecords, chain.since)
      this.reconcileSends()
      this.paint()
      this.recomputeLive()
    } catch (error) {
      connectorTrace({ ev: 'tick-error', sid: this.record.sessionId, message: error instanceof Error ? error.message : String(error) })
    }
  }

  private recomputeLive(): void {
    const sendInFlight = this.sends.some(s => s.state === 'delivered')
    const inFlight = this.factsBusy || sendInFlight
    const streaming: SessionLiveV1['phase'] | null =
      this.streamBlock === 'thinking' ? 'thinking' : this.streamBlock !== null ? 'responding' : null
    const phase: SessionLiveV1['phase'] =
      inFlight && this.liveStateWord === 'compacting'
        ? 'compacting'
        : inFlight && this.liveState.phase !== 'tool' && streaming !== null
          ? streaming
          : inFlight && this.liveState.phase === 'idle'
            ? 'thinking'
            : this.liveState.phase
    const inProgressToolUseIDs = inFlight
      ? this.liveState.inProgressToolUseIDs
      : IDLE_LIVE.inProgressToolUseIDs
    const prev = this.effectiveLive
    const changed =
      inFlight !== prev.inFlight ||
      phase !== prev.phase ||
      this.liveState.turnStartedAtMs !== prev.turnStartedAtMs ||
      inProgressToolUseIDs.size !== prev.inProgressToolUseIDs.size ||
      [...inProgressToolUseIDs].some(id => !prev.inProgressToolUseIDs.has(id))
    if (!inFlight && this.interrupting) this.interrupting = false
    if (!inFlight && this.tailStore.read() !== null) this.tailStore.reset(null)
    if (!inFlight) this.liveTurnChars = 0
    if (!inFlight) this.liveStateWord = null
    if (!inFlight && this.publishedProgressSeqs.size > 0) {
      clearEphemeralProgress()
      this.publishedProgressSeqs.clear()
    }
    if (!inFlight && this.toolBudgets.size > 0) this.toolBudgets.clear()
    this.syncLivenessTicker(inFlight)
    if (!changed) return
    this.effectiveLive = {
      inFlight,
      phase,
      inProgressToolUseIDs,
      turnStartedAtMs: this.liveState.turnStartedAtMs ?? (inFlight ? Date.now() : null),
    }
    emitAll(this.liveListeners, 'live')
  }

  private reconcileSends(): boolean {
    if (this.sends.length === 0) return false
    const now = Date.now()
    const landed = new Set<string>()
    for (const s of this.sends) {
      if (now - s.sentAtMs > ECHO_RETIRE_MS) {
        landed.add(s.clientMessageId)
        continue
      }
      const idKeyed = UUID_SHAPE.test(s.clientMessageId)
      for (let i = this.rawRecords.length - 1; i >= 0; i--) {
        const m = this.rawRecords[i]!
        if (idKeyed) {
          if (m.type === 'user' && (m as { uuid?: string }).uuid === s.clientMessageId) {
            landed.add(s.clientMessageId)
            break
          }
          const att = (m as { attachment?: { type?: string; source_uuid?: string } }).attachment
          if (m.type === 'attachment' && att?.type === 'queued_command' && att.source_uuid === s.clientMessageId) {
            landed.add(s.clientMessageId)
            break
          }
        } else if (m.type === 'user') {
          const rowUuid = (m as { uuid?: string }).uuid
          if (rowUuid !== undefined && this.textRetiredRowUuids.has(rowUuid)) continue
          const ts = Date.parse((m as { timestamp?: string }).timestamp ?? '')
          if (!Number.isNaN(ts) && ts + 1000 < s.sentAtMs) continue
          const text = textOfUserRow(m)
          if (text !== '' && text.includes(s.text)) {
            if (rowUuid !== undefined) this.textRetiredRowUuids.add(rowUuid)
            landed.add(s.clientMessageId)
            break
          }
        }
      }
    }
    if (landed.size === 0) return false
    this.sends = this.sends.filter(s => !landed.has(s.clientMessageId))
    for (const id of landed) this.echoRows.delete(id)
    if (this.sends.length === 0) this.textRetiredRowUuids.clear()
    return true
  }

  private paint(): void {
    const echoes: Message[] = []
    for (const s of this.sends) {
      const row = this.echoRows.get(s.clientMessageId)
      if (row !== undefined) echoes.push(row)
    }
    const kept = projectOperatorRewinds(this.rawRecords)
    const dropped = kept.length === this.rawRecords.length ? null : new Set<Message>(kept)
    if (echoes.length === 0 && this.displayRows.length === 0 && dropped === null) {
      this.painted = this.rawRecords
    } else {
      const rows: Message[] = []
      let d = 0
      for (let i = 0; i <= this.rawRecords.length; i++) {
        while (d < this.displayRows.length && this.displayRows[d]!.anchor <= i) rows.push(this.displayRows[d++]!.row)
        if (i < this.rawRecords.length) {
          const record = this.rawRecords[i]!
          if (dropped === null || dropped.has(record)) rows.push(record)
        }
      }
      while (d < this.displayRows.length) rows.push(this.displayRows[d++]!.row)
      this.painted = [...rows, ...echoes]
    }
    connectorTrace({ ev: 'paint', sid: this.record.sessionId, raw: this.rawRecords.length, display: this.displayRows.length, echoes: echoes.length, painted: this.painted.length, listeners: this.recordListeners.size })
    emitAll(this.recordListeners, 'records')
  }


  private refreshCheckpoints(): void {
    const fc = this.facts?.fileCheckpoints
    const stamp = fc === undefined ? '' : `${fc.capture ? '1' : '0'}|${fc.restorable.join(',')}`
    if (stamp === this.checkpointStamp) return
    this.checkpointStamp = stamp
    this.checkpointSnapshot =
      fc === undefined ? UNKNOWN_CHECKPOINTS : { capture: fc.capture ? 'on' : 'off', restorable: new Set(fc.restorable) }
    emitAll(this.checkpointListeners, 'checkpoints')
  }

  checkpointFacts(): CheckpointFactsV1 {
    return this.checkpointSnapshot
  }

  subscribeCheckpoints(listener: () => void): () => void {
    this.checkpointListeners.add(listener)
    return () => {
      this.checkpointListeners.delete(listener)
    }
  }

  async rewind(req: RewindRequestV1): Promise<RewindReceiptV1> {
    try {
      const reply = await this.chainRpc({
        op: 'sessionRewind',
        sessionId: this.record.sessionId,
        by: 'operator',
        mode: req.mode,
        userMessageId: req.userMessageId,
        ...(req.dryRun === true ? { dryRun: true } : {}),
      })
      if (reply.ok !== true) {
        const error = typeof reply.error === 'string' ? reply.error : ''
        if (reply.code === 'EUNKNOWN' && /unknown op/i.test(error)) {
          return { outcome: 'refused', mode: req.mode, refusal: 'daemon-older', detail: 'the daemon predates the rewind verb — /daemon restart when ready, then /rewind again' }
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
      if (this.facts !== null && ((this.facts.work?.length ?? 0) > 0 || (this.facts.mission?.length ?? 0) > 0) && !existsSync(sessionFactsPath(this.record.sessionId))) {
        this.facts = { ...this.facts, work: [], mission: [] }
        this.refreshWork()
      }
      return
    }
    const prev = this.facts
    this.facts = next
    this.refreshCheckpoints()
    adoptOpenaiObservedUsage(next.usage?.openaiObserved)
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
      prev.pendingModel !== next.pendingModel
    const modeMoved = prev === null || prev.permissionMode !== next.permissionMode
    this.factsBusy = next.busy
    if (next.busy) this.armBusyStall()
    else this.disarmBusyStall()
    this.recomputeLive()
    if (modelMoved) emitAll(this.modelListeners, 'model')
    if (modeMoved) emitAll(this.permissionListeners, 'permission')
    if (!modelMoved) emitAll(this.modelListeners, 'model')
    if (this.reconcileSends()) this.paint()
    this.refreshWork()
  }

  private refreshWork(): void {
    const rows = this.facts?.work ?? []
    const mission = this.facts?.mission ?? []
    const stamp = JSON.stringify([rows, mission])
    if (stamp === this.workStamp) return
    this.workStamp = stamp
    this.workSnapshot = { rows, mission }
    emitAll(this.workListeners, 'work')
  }


  private readAsks(): void {
    const projection = readSessionAsks(this.record.sessionId)
    const rows: SessionAskProjectionV1[] = projection?.asks ?? []
    const nextIds = rows.map(r => r.requestId)
    const sameIds = nextIds.length === this.askEntries.length && nextIds.every((id, i) => id === this.askEntries[i]!.id)
    if (sameIds && projection !== null) return
    if (projection === null && this.askEntries.length === 0) return
    const next: SessionAskV1[] = []
    for (const row of rows) {
      let confirm = this.confirms.get(row.requestId)
      if (confirm === undefined) {
        confirm = this.buildConfirm(row)
        this.confirms.set(row.requestId, confirm)
      }
      next.push({ id: row.requestId, confirm })
    }
    for (const id of [...this.confirms.keys()]) if (!nextIds.includes(id)) this.confirms.delete(id)
    this.askEntries = next
    emitAll(this.askListeners, 'asks')
  }

  private assistantRecordFor(toolUseId: string, toolName: string, input: Record<string, unknown>): AssistantMessage {
    for (let i = this.rawRecords.length - 1; i >= 0; i--) {
      const m = this.rawRecords[i]!
      if (m.type !== 'assistant') continue
      const content = (m as { message?: { content?: unknown } }).message?.content
      if (Array.isArray(content) && content.some(b => (b as { type?: string; id?: string }).type === 'tool_use' && (b as { id?: string }).id === toolUseId)) {
        return m as AssistantMessage
      }
    }
    return createAssistantMessage({
      content: [{ type: 'tool_use', id: toolUseId, name: toolName, input }] as unknown as Parameters<
        typeof createAssistantMessage
      >[0]['content'],
    })
  }

  private standInToolUseContext(): ToolUseContext {
    const facts = this.facts
    return {
      options: {
        commands: [],
        debug: false,
        verbose: false,
        mainLoopModel: facts?.model.effective ?? this.record.modelKey ?? getMainLoopModel(),
        tools: getAllBaseTools(),
        mcpClients: [],
        isNonInteractiveSession: false,
        agentDefinitions: { activeAgents: [], allAgents: [] },
      },
      abortController: new AbortController(),
      readFileState: createFileStateCacheWithSizeLimit(READ_FILE_STATE_CACHE_SIZE),
      getAppState: () => {
        throw new Error('a daemon-hosted session has no in-process app state')
      },
      setAppState: () => {},
      messages: this.rawRecords,
      setResponseLength: () => {},
      updateFileHistoryState: () => {},
      updateAttributionState: () => {},
    } as unknown as ToolUseContext
  }

  private buildConfirm(row: SessionAskProjectionV1): ToolUseConfirm {
    const tool = toolFor(row.toolName)
    const decisionReason =
      decodeDecisionReasonFromWire(row.decisionReasonDetail) ??
      (row.decisionReason !== undefined ? { type: 'other' as const, reason: row.decisionReason } : undefined)
    const permissionResult = {
      behavior: 'ask' as const,
      message: row.description ?? `${row.toolName} asks to run`,
      ...(row.suggestions !== undefined ? { suggestions: row.suggestions } : {}),
      ...(row.blockedPath !== undefined ? { blockedPath: row.blockedPath } : {}),
      ...(decisionReason !== undefined ? { decisionReason } : {}),
    }
    let description = row.description ?? tool.userFacingName(row.input as never) ?? row.toolName
    const confirm: ToolUseConfirm = {
      assistantMessage: this.assistantRecordFor(row.toolUseId, row.toolName, row.input),
      tool,
      get description() {
        return description
      },
      input: row.input,
      toolUseContext: this.standInToolUseContext(),
      toolUseID: row.toolUseId,
      permissionResult: permissionResult as ToolUseConfirm['permissionResult'],
      permissionPromptStartTimeMs: row.askedAt,
      onUserInteraction: () => {},
      onAbort: () => {
        void this.answerThroughDaemon(row.requestId, { kind: 'abort' })
      },
      onAllow: async (updatedInput, permissionUpdates, feedback, contentBlocks) => {
        await this.answerThroughDaemon(row.requestId, {
          kind: 'allow',
          updatedInput: updatedInput as Record<string, unknown>,
          permissionUpdates,
          feedback,
          contentBlocks,
        })
      },
      onReject: async (feedback, contentBlocks) => {
        await this.answerThroughDaemon(row.requestId, { kind: 'deny', feedback, contentBlocks })
      },
      recheckPermission: async () => {},
    }
    void Promise.resolve(
      tool.description(row.input as never, {
        isNonInteractiveSession: false,
        toolPermissionContext: { mode: this.facts?.permissionMode ?? 'default' } as never,
        tools: getAllBaseTools(),
      }),
    )
      .then(text => {
        if (typeof text === 'string' && text.trim() !== '') description = text
      })
      .catch(() => {})
    return confirm
  }


  private async rpc(req: Record<string, unknown>): Promise<Record<string, unknown>> {
    const { daemonControlRpc } = await import('../../daemon/controlSocket.js')
    return (await daemonControlRpc(req as never, { timeoutMs: RPC_TIMEOUT_MS })) as Record<string, unknown>
  }

  private verbChain: Promise<unknown> = Promise.resolve()
  private chainRpc(req: Record<string, unknown>): Promise<Record<string, unknown>> {
    const link = this.verbChain.then(() => this.rpc(req))
    this.verbChain = link.catch(() => {})
    return link
  }

  private async answerThroughDaemon(requestId: string, answer: AskAnswerV1): Promise<AskReceiptV1> {
    this.settleAsk(requestId)
    try {
      const reply = await this.chainRpc({
        op: 'sessionControl',
        action: 'answer-permission',
        sessionId: this.record.sessionId,
        by: 'operator',
        requestId,
        allow: answer.kind === 'allow',
        answer:
          answer.kind === 'allow'
            ? {
                ...(answer.updatedInput !== undefined ? { updatedInput: answer.updatedInput } : {}),
                ...(answer.permissionUpdates !== undefined && answer.permissionUpdates.length > 0
                  ? { permissionUpdates: answer.permissionUpdates }
                  : {}),
              }
            : answer.kind === 'deny'
              ? { ...(answer.feedback !== undefined ? { feedback: answer.feedback } : {}) }
              : { interrupt: true },
      })
      const ok = reply.ok === true && reply.outcome === 'applied'
      if (!ok) return { ok: false, detail: String(reply.detail ?? reply.error ?? 'the ask was already answered') }
      const feedback = answer.kind === 'allow' || answer.kind === 'deny' ? answer.feedback?.trim() : undefined
      const blocks = answer.kind === 'allow' || answer.kind === 'deny' ? answer.contentBlocks : undefined
      if ((answer.kind === 'allow' && feedback) || (blocks !== undefined && blocks.length > 0)) {
        void this.deliver(feedback ?? '', { extraBlocks: blocks })
      }
      return { ok: true }
    } catch (e) {
      return { ok: false, detail: `the daemon was unreachable — ${e instanceof Error ? e.message : String(e)}` }
    }
  }

  private async deliver(
    text: string,
    opts: { mode?: 'prompt' | 'bash'; pastedContents?: Record<number, PastedContent>; extraBlocks?: ContentBlockParam[] },
  ): Promise<SendReceiptV1> {
    const pastes = opts.pastedContents ?? {}
    const { expandPastedTextRefs } = await import('../../history.js')
    const expanded = expandPastedTextRefs(text, pastes).trim()
    const images = [...imageBlocksOf(pastes), ...(opts.extraBlocks ?? [])]
    if (expanded === '' && images.length === 0) return REFUSED_EMPTY
    const mode: 'prompt' | 'bash' = opts.mode === 'bash' ? 'bash' : 'prompt'
    const provisionalId =
      this.retainedSend !== null && this.retainedSend.text === expanded ? this.retainedSend.id : randomUUID()
    this.echoRows.set(provisionalId, createUserMessage({ content: expanded }) as unknown as Message)
    this.paint()
    const answering = await this.openQuestion()
    const clientMessageId = answering !== null ? `obl-answer:${answering}` : provisionalId
    if (clientMessageId !== provisionalId) {
      const rows = [...this.echoRows]
      this.echoRows.clear()
      for (const [key, row] of rows) this.echoRows.set(key === provisionalId ? clientMessageId : key, row)
    }
    submitTrace('connector-deliver', expanded, { mode, clientMessageId })
    const send: SeatSend = { clientMessageId, text: expanded, sentAtMs: Date.now(), state: 'pending', mode }
    this.sends = [...this.sends.filter(s => s.clientMessageId !== clientMessageId), send]
    this.paint()
    emitAll(this.liveListeners, 'live')
    const settle = (state: 'delivered' | 'held' | 'refused' | 'failed', detail?: string): SendReceiptV1 => {
      if (state !== 'delivered') {
        this.sends = this.sends.filter(s => s.clientMessageId !== clientMessageId)
        this.echoRows.delete(clientMessageId)
        this.paint()
      } else {
        this.sends = this.sends.map(s => (s.clientMessageId === clientMessageId ? { ...s, state: 'delivered' as const } : s))
      }
      this.retainedSend = state === 'held' || state === 'failed' ? { text: expanded, id: clientMessageId } : null
      emitAll(this.liveListeners, 'live')
      if (state === 'delivered') {
        this.refusedAdmission = null
        return { state: 'accepted' }
      }
      return { state: 'refused', detail: detail ?? (state === 'held' ? 'held — ↵ again replays it' : 'the session did not take it') }
    }
    try {
      const refusal = this.admission !== null ? await this.admission : null
      if (refusal !== null) {
        return settle('failed', `the session could not resume — ${refusal} · ↵ again retries`)
      }
      const { ensureOwnedDaemon } = await import('../switchboard/ensureDaemon.js')
      if (!(await ensureOwnedDaemon())) {
        return settle('failed', 'the daemon that hosts sessions did not start — ↵ again starts it and retries')
      }
      if (this.isAttached()) seatVerb('focus', this.record.sessionId)
      if (answering !== null) {
        const kernel = await import('../concourse/coordinatorKernel.js')
        const receipt = await kernel.executeKernelDecision({
          verb: 'obligation.answer',
          obligationId: answering,
          sessionId: this.record.sessionId,
          clientMessageId,
          answer: expanded,
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
        ...(mode === 'bash' ? { mode } : {}),
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
    return this.effectiveLive.inFlight
  }

  asks(): readonly SessionAskV1[] {
    return this.askEntries
  }

  subscribeAsks(listener: () => void): () => void {
    this.askListeners.add(listener)
    return () => {
      this.askListeners.delete(listener)
    }
  }

  answerAsk(askId: string, answer: AskAnswerV1): Promise<AskReceiptV1> {
    if (!this.askEntries.some(a => a.id === askId)) {
      return Promise.resolve({ ok: false, detail: 'no pending ask carries that id' })
    }
    return this.answerThroughDaemon(askId, answer)
  }

  settleAsk(askId: string): void {
    if (!this.askEntries.some(a => a.id === askId)) return
    this.askEntries = this.askEntries.filter(a => a.id !== askId)
    this.confirms.delete(askId)
    emitAll(this.askListeners, 'asks')
  }

  interrupt(): boolean {
    const wasRunning = this.effectiveLive.inFlight || this.askEntries.length > 0
    if (!wasRunning) return false
    for (const entry of this.askEntries) this.confirms.delete(entry.id)
    this.askEntries = []
    emitAll(this.askListeners, 'asks')
    if (!this.interrupting) {
      this.interrupting = true
      emitAll(this.liveListeners, 'live')
      void this.chainRpc({ op: 'sessionControl', action: 'interrupt', sessionId: this.record.sessionId, by: 'operator' })
        .then(reply => {
          if (!(reply.ok === true && reply.outcome === 'applied')) {
            this.interrupting = false
            emitAll(this.liveListeners, 'live')
          }
        })
        .catch(() => {
          this.interrupting = false
          emitAll(this.liveListeners, 'live')
        })
    }
    return true
  }

  modelFacts(): ModelFactsV1 {
    const effective = this.facts?.model.effective ?? this.record.modelKey ?? getMainLoopModel()
    const effectiveSource: 'live' | 'record' | 'ambient' =
      this.facts !== null ? 'live' : this.record.modelKey !== undefined ? 'record' : 'ambient'
    return {
      effective,
      effectiveSource,
      main: effective,
      setting: this.facts?.model.setting ?? this.record.modelKey ?? null,
      sessionPin: null,
      pendingSwitch: this.facts?.pendingModel !== undefined && this.facts.pendingModel !== null ? { setting: this.facts.pendingModel } : null,
    }
  }

  subscribeModel(listener: () => void): () => void {
    this.modelListeners.add(listener)
    return () => {
      this.modelListeners.delete(listener)
    }
  }

  async setModel(setting: string | null): Promise<ModelSwitchReceiptV1> {
    const target = setting ?? getMainLoopModel()
    const current = this.modelFacts()
    if (current.effective === target && current.pendingSwitch === null) return { state: 'no-op' }
    const busy = this.effectiveLive.inFlight
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
      const reply = await this.chainRpc({ op: 'sessionControl', action: 'set-model', sessionId: this.record.sessionId, by: 'operator', model: target })
      if (reply.ok !== true) return refuse(String(reply.error ?? 'the daemon refused the switch'))
      const outcome = reply.outcome
      const detail = typeof reply.detail === 'string' && reply.detail !== '' ? reply.detail : undefined
      if (outcome === 'refused') return refuse(detail ?? 'the daemon refused the switch')
      if (outcome !== 'applied' && outcome !== 'queued' && outcome !== 'noop') return refuse(`unexpected outcome ${String(outcome)}`)
      if ((outcome === 'queued') !== busy) this.readFacts()
      if (outcome === 'noop') return { state: 'no-op' }
      return { state: outcome }
    } catch (e) {
      return refuse(`the daemon is not answering — the switch did not land (${e instanceof Error ? e.message : String(e)})`)
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

  skillsRoster(): SkillsRosterV1 {
    return { skills: this.facts?.skills ?? [] }
  }

  mcpRoster(): McpRosterV1 {
    return { clients: this.facts?.mcp ?? [] }
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

  workRoster(): WorkRosterV1 {
    return this.workSnapshot
  }

  subscribeWork(listener: () => void): () => void {
    this.workListeners.add(listener)
    return () => {
      this.workListeners.delete(listener)
    }
  }

  permissionMode(): PermissionMode {
    return (this.facts?.permissionMode ?? 'flow') as PermissionMode
  }

  subscribePermissionMode(listener: () => void): () => void {
    this.permissionListeners.add(listener)
    return () => {
      this.permissionListeners.delete(listener)
    }
  }

  setPermissionMode(mode: PermissionMode): void {
    if (this.facts !== null) {
      this.facts = { ...this.facts, permissionMode: mode }
      emitAll(this.permissionListeners, 'permission')
    }
    void this.chainRpc({ op: 'sessionControl', action: 'set-permission-mode', sessionId: this.record.sessionId, by: 'operator', mode }).catch(e =>
      logForDebugging(`[engine-connector] daemon set-permission-mode failed: ${e}`),
    )
  }

  workspace(): WorkspaceFactsV1 {
    if (this.facts !== null) return this.facts.workspace
    const cwd = this.record.worktreePath ?? this.record.workspaceId
    return { cwd, originalCwd: cwd, projectRoot: this.record.workspaceId, instructionRoots: [] }
  }

  dispatchSlash(line: string): Promise<SendReceiptV1> {
    const trimmed = line.trim()
    return this.deliver(trimmed.startsWith('/') ? trimmed : `/${trimmed}`, {})
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

  tail(): StreamingTailStore {
    return this.tailStore
  }

  status(): SeatStatusV1 {
    const live = this.effectiveLive
    const now = Date.now()
    const quietMs = live.inFlight && this.lastEventAtMs !== null ? Math.max(0, now - this.lastEventAtMs) : null
    const watchdogMs = typeof this.facts?.streamIdleTimeoutMs === 'number' ? this.facts.streamIdleTimeoutMs : null
    let phaseMs: number | null = null
    let toolBudgetMs: number | null = null
    if (live.inFlight) {
      if (live.phase === 'tool') {
        const started = this.toolStartedAtMs(live.inProgressToolUseIDs)
        if (started !== null) phaseMs = Math.max(0, now - started)
        for (const [id, budget] of this.toolBudgets) {
          if (!live.inProgressToolUseIDs.has(id)) continue
          toolBudgetMs = Math.max(toolBudgetMs ?? 0, budget.budgetMs)
          phaseMs = Math.max(phaseMs ?? 0, budget.elapsedMs + Math.max(0, now - budget.atMs))
        }
      } else if (this.blockSinceMs !== null) {
        phaseMs = Math.max(0, now - this.blockSinceMs)
      } else if (live.turnStartedAtMs !== null) {
        phaseMs = Math.max(0, now - live.turnStartedAtMs)
      }
    }
    const stuck =
      live.inFlight &&
      !this.interrupting &&
      live.phase !== 'tool' &&
      quietMs !== null &&
      watchdogMs !== null &&
      quietMs >= streamIdleWarningMsOf(watchdogMs)
    return {
      title: liveTitleDeriver?.(this.record) ?? this.record.title,
      projectLabel: this.record.projectLabel,
      interrupting: this.interrupting,
      quietMs,
      watchdogMs,
      phaseMs,
      toolBudgetMs,
      stuck,
      ...(this.record.isolation !== undefined ? { isolation: this.record.isolation } : {}),
      ...(this.record.branchLabel !== undefined ? { branchLabel: this.record.branchLabel } : {}),
    }
  }
}


const connectors = new Map<string, DaemonSessionConnector>()

export function daemonSessionConnectorFor(record: DaemonSessionRecordV1): DaemonSessionConnector {
  let c = connectors.get(record.sessionId)
  if (c === undefined) {
    c = new DaemonSessionConnector(record)
    connectors.set(record.sessionId, c)
  } else {
    c.adoptRecord(record)
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

export async function focusDaemonSession(record: DaemonSessionRecordV1): Promise<DaemonSessionConnector> {
  const connector = daemonSessionConnectorFor(record)
  const epoch = claimHopEpoch()
  await connector.attach()
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
