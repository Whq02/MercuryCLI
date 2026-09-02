// ============================================================================
//  engine-connector/daemonConnector — a daemon-hosted session behind the
//  connector.
//
//  Every session is a full chat, and every session is daemon-hosted: a full
//  Mercury instance in its own process (its own model, skills, MCP servers,
//  account, permission mode, workspace, queue). THIS connector is a
//  session's doorway into the focused chat, and re-pointing the focused
//  slot at it IS the hop — the whole face (the chat, the composer, the
//  consent card, the readouts, the slash commands, the queue, esc) works on
//  it unchanged. A resumed session paints from its transcript file the
//  moment its connector attaches; its admission settles in the background
//  and the connector's first delivery waits for it.
//
//  What the doors read and where it comes from:
//    · the RECORDS — the session's own transcript file (the one writer is
//      the session's runner): a reader per connector (fs.watch + a 400 ms
//      heartbeat), the composer's echo rows riding the same array until the
//      session's own row with the SAME identity lands (the delivery law:
//      a sent message is delivered instantly, read at the session's next
//      readable moment, exactly once — no client-side queue mirror, no
//      queued/steered states); the live turn (phase, tools in flight, the
//      turn clock) folds from the records;
//    · the FACTS — the daemon-published projection the session's process
//      answered (seatProjections): model, usage, identity, skills, MCP,
//      permission mode, workspace; read synchronously at the hop, watched
//      afterwards, refreshed on demand;
//    · the ASKS — the daemon-published projection of every parked ask with
//      its FULL payload; each becomes a real ToolUseConfirm (the screen's
//      tool table by name, the assistant record from the session's own
//      transcript), so the consent card renders exactly as it does for the
//      in-process engine; its verbs answer through the daemon's door with
//      the full answer;
//    · the LIVE FEEDS — the tail projection streams the reply's text block
//      into the streaming-tail store, and the progress projection
//      (LIVEPAINT) publishes each running tool's latest line into the
//      ephemeral progress store (this connector is that store's ONE
//      writer), so the running row paints one in-place line; both clear at
//      settle and at detach.
//  The verbs — words, answers, interrupt, the model switch, the permission
//  mode — ride the daemon's control socket; each lands an optimistic local
//  state at once (instant and stateful) that the daemon's next projection
//  confirms or corrects.
// ============================================================================
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
import { deserializeLiveMessages, liveTurnStateOf } from '../../utils/conversationRecovery.js'
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

/** An older runner's facts carry no checkpoint field: 'unknown', never 'on'. */
const UNKNOWN_CHECKPOINTS: CheckpointFactsV1 = Object.freeze({ capture: 'unknown' as const, restorable: Object.freeze(new Set<string>()) as ReadonlySet<string> })

/** The daemon record's facts the connector is built from. */
export interface DaemonSessionRecordV1 {
  sessionId: string
  runnerId: string
  title: string
  projectLabel: string
  workspaceId: string
  /** The session's transcript home (the workspace's project dir). */
  home: string
  isolation?: 'exclusive' | 'shared' | 'worktree-isolated' | 'read-only'
  branchLabel?: string
  modelKey?: string
  effort?: string
  worktreePath?: string
}

/** A word the operator sent: pending until the daemon door answers, then
 *  delivered until the session's own row lands (the echo row paints
 *  meanwhile). THE DELIVERY LAW (steer-removal): a sent message is
 *  delivered instantly and read at the session's next readable moment,
 *  exactly once — there is no queued/steered client state to track, so
 *  the send's only job is carrying the echo row until the authoritative
 *  transcript row with the SAME identity retires it. */
interface SeatSend {
  clientMessageId: string
  text: string
  sentAtMs: number
  state: 'pending' | 'delivered'
  mode: 'prompt' | 'bash'
}

const REFUSED_EMPTY: SendReceiptV1 = { state: 'refused', detail: 'nothing to send' }

/** A wire entry back into the internal ProgressMessage the three ephemeral
 *  readers (MessageRow · the collapsed card · the grouped card) hand their
 *  tool's own progress renderer (LIVEPAINT). Shell entries paint through
 *  ShellProgressMessage — output IS the one bounded latest line, so the
 *  block stays one in-place line by construction. MCP entries paint the bar
 *  and/or the message; the identity fields the wire never carried
 *  (serverName/toolName/status) fill neutrally — no progress renderer
 *  paints them. */
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
      // totalBytes is REQUIRED on the powershell shape (its emitter always
      // counts); an absent wire value degrades to 0 honestly.
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

/** The image blocks riding a submission's pastes (the shape the session's
 *  user frame carries). */
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
/** LIVENESS: the live channel's tick while a turn is in flight — the
 *  status row's clocks read seconds, so one emit a second is the cadence. */
const LIVENESS_TICK_MS = 1000
const ECHO_RETIRE_MS = 10 * 60_000
/** A UUID-shaped clientMessageId IS the frame uuid end to end (the dispatch
 *  passes it through) — identity-keyed echo retirement rides this shape. */
const UUID_SHAPE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** The terminal's own seat on the focus verbs — the attachedBy grammar
 *  ('operator:<pid>'), so the daemon can heal a stamp whose terminal died. */
const SEAT_BY = `operator:${process.pid}`

// THE FOCUS VERBS ride ONE chain across every connector: a hop A→B fires
// focus(B) from B's attach and blur(A) from A's detach, and a hop back fires
// focus(A) again — on separate daemon connections a late blur(A) could land
// after that re-focus and clear the seat the operator just took. Serial
// delivery keeps the record's seat on the chat chosen LAST. A link that
// fails (no daemon yet, a timeout) never blocks the next; the daemon's
// reply is a receipt, never a state the screen keeps.
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

/** The screen's tool by name; a session's own tool the screen lacks (its
 *  MCP servers') renders through the generic MCP shell under its name. */
function toolFor(name: string): Tool {
  const known = getAllBaseTools().find(t => t.name === name)
  if (known) return known
  return {
    ...MCPTool,
    name,
    userFacingName: () => name.replace(/^mcp__/, '').replace(/__/g, ' › '),
  } as unknown as Tool
}

/** The change key of a projection file's stat (FN-016 R21, [Windows]):
 *  mtime alone collapsed two publishes inside one Windows clock tick
 *  (~15.6 ms) into one — the tail's text publish and the block-stop clear
 *  a few milliseconds behind it carried the same mtimeMs, so the reading
 *  side missed the block boundary: textActive stayed true, the verb row
 *  stayed suppressed and the hold row stood with a count that no longer
 *  moved. The size joins the key (a text publish strictly grows and the
 *  clear shrinks — the named pair always differs), and the inode too
 *  (every publish is a temp-write plus rename: a fresh file), so an
 *  equal-size same-tick pair still reads apart wherever the filesystem
 *  hands out fresh inodes. */
export function projectionChangeKey(stat: { mtimeMs: number; size: number; ino: number }): string {
  return `${stat.mtimeMs}:${stat.size}:${stat.ino}`
}
/** The key of a projection file that does not exist (yet, or any more). */
export const PROJECTION_ABSENT = 'absent'

/** A feed over one projection file: a directory watch (the file may not
 *  exist yet) plus a stat heartbeat keyed on projectionChangeKey; reads
 *  are the caller's. Exported for its prover. */
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
      // Every fs-event watcher root routes through resolveWatchRoot (the
      // watch-root census law: a symlinked root once killed the process on
      // its first event).
      const watcher = watch(resolveWatchRoot(this.dir), (_event, filename) => {
        if (filename === undefined || filename === null || join(this.dir, String(filename)) === this.path) tick()
      })
      watcher.on('error', () => {
        try {
          watcher.close()
        } catch {
          /* already closed */
        }
        if (this.watcher === watcher) this.watcher = null
      })
      this.watcher = watcher
    } catch {
      /* no watch transport — the heartbeat carries it */
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
      /* already closed */
    }
    this.watcher = null
    this.lastKey = PROJECTION_ABSENT
  }
}

type Listeners = Set<() => void>
/** Forensics (MERCURY_CONNECTOR_TRACE names a file): one JSON line per
 *  transcript-feed event — counts, sizes and event names only, never record
 *  content. Off by default; every append is guarded. */
function connectorTrace(entry: Record<string, unknown>): void {
  const path = flagEnv('MERCURY_CONNECTOR_TRACE')
  if (!path) return
  try {
    appendFileSync(path, `${JSON.stringify({ t: Date.now(), ...entry })}\n`)
  } catch {
    /* forensics must never break the feed */
  }
}

function emitAll(listeners: Listeners, what: string): void {
  // The probe ring stamps every emission by kind (`emit:live`,
  // `emit:records`, …) so the region-invalidation reader can name which
  // feed woke a region — off ⇒ a latched-boolean check, nothing else.
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

  // ── records (the session's own transcript) ──
  private rawRecords: Message[] = []
  /** CONTENT-KEYED IDENTITY (the transcript calm law, chat-feel item 2):
   *  the per-record signatures of the LAST parse. Every tick re-reads the
   *  whole transcript file and would otherwise mint a fresh object for
   *  every record — MessageRow's memo keys on message identity, so one
   *  landed record re-rendered the ENTIRE transcript (the daemon-hosted
   *  chat's tearing). An unchanged record (same serialized bytes at the
   *  same index) keeps the OBJECT the previous tick minted; only the rows
   *  whose content moved take fresh identities. */
  private recordSigs: string[] = []
  private painted: readonly Message[] = []
  // The live view folds from the transcript (phase, tools, the clock); the
  // daemon's OWN turn edge (facts.busy — a user frame hit stdin, the result
  // frame closed it) is the immediate truth the transcript's settled rows
  // trail, so the effective in-flight is EITHER. `liveState` is the fold;
  // `effectiveLive` overrides its inFlight with the union.
  private liveState: SessionLiveV1 = IDLE_LIVE
  private factsBusy = false
  // THE STALLED-TURN DEADLINE (the spun-a-core-forever class, one layer up):
  // factsBusy is ENTERED by a remote fact and was LEFT only by another —
  // a dead runner's last write said busy and nothing ever said otherwise,
  // so the chat's turn indicator spun forever over a corpse (the board
  // tells a dead runner through runnerRecordAlive; the chat could not).
  // Every facts tick while busy touches; expiry fires ONE bounded probe at
  // the truth's owner (session-facts — its refusal 'unknown-session: no
  // live worker record' IS the dead-runner verdict); dead or unreachable
  // flips the live view idle. A live runner's answer ticks the feed and
  // re-arms — an alive-but-slow turn keeps its honest spinner.
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
          // The runner is live and was asked for fresh facts — their landing
          // ticks the feed; re-arm so a wedged runner is re-probed, never
          // condemned (the crew no-condemnation stance).
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
  /** Display-only rows, each ANCHORED at the record count it arrived after
   *  — a resume recap or a screen command's receipt paints where it
   *  happened, and later exchanges land below it. */
  private displayRows: Array<{ row: Message; anchor: number }> = []
  private echoRows = new Map<string, Message>()
  private sends: SeatSend[] = []
  /** Rows already spent by a TEXT-fallback retirement: one landing row
   *  retires at most ONE send, so two in-flight same-text sends (twin
   *  obligation answers) never collapse onto a single landing — the
   *  still-unlanded twin keeps its echo (delivery-verifier B1). Cleared
   *  whenever no sends remain. */
  private textRetiredRowUuids = new Set<string>()
  private retainedSend: { text: string; id: string } | null = null
  private interrupting = false
  private lastSize = -1
  private lastLen = -1
  private transcriptWatcher: FSWatcher | null = null
  private transcriptTimer: ReturnType<typeof setInterval> | null = null
  /** The one running tick pass (see tick()); triggers landing mid-pass set
   *  dirty and the pass reruns once. */
  private tickInFlight: Promise<void> | null = null
  private tickDirty = false
  private readonly transcriptPath: string
  private readonly recordListeners: Listeners = new Set()
  private readonly liveListeners: Listeners = new Set()

  // ── facts ──
  private facts: SessionFactsV1 | null
  private readonly factsFeed: ProjectionFeed
  private readonly modelListeners: Listeners = new Set()
  private readonly permissionListeners: Listeners = new Set()
  // ── the work roster (content-keyed: an unchanged roster re-emits
  //    nothing and the snapshot keeps its identity — the uSES law) ──
  private readonly workListeners: Listeners = new Set()
  private workSnapshot: WorkRosterV1 = { rows: [], mission: [] }
  private workStamp = '[[],[]]'
  // ── the /rewind facts (content-keyed like the roster: an unchanged
  //    answer re-emits nothing and the snapshot keeps its identity) ──
  private readonly checkpointListeners: Listeners = new Set()
  private checkpointSnapshot: CheckpointFactsV1 = UNKNOWN_CHECKPOINTS
  private checkpointStamp = ''

  // ── asks ──
  private askEntries: SessionAskV1[] = []
  private readonly confirms = new Map<string, ToolUseConfirm>()
  private readonly asksFeed: ProjectionFeed
  private readonly askListeners: Listeners = new Set()

  // ── the live tail (the reply's text block as it streams) ──
  private readonly tailFeed: ProjectionFeed
  private readonly tailStore: StreamingTailStore = createStreamingTailStore()
  private tailAtMs = -1
  /** The in-flight turn's cumulative streamed chars (tail projection's
   *  turnChars) — the live token counter's source; 0 when idle/absent. */
  private liveTurnChars = 0
  /** The runner's live state word from the tail projection ('compacting'
   *  while the fold runs); folded into the live phase. */
  private liveStateWord: 'compacting' | null = null

  // ── the liveness owner (LIVENESS) ──
  /** The seat's stamp of the runner's last frame of any kind
   *  (SessionTailV1.lastEventAtMs); null = unspoken, or an old daemon. */
  private lastEventAtMs: number | null = null
  /** The block the runner is streaming right now, and since when
   *  (SessionTailV1.streamBlock / blockSinceMs); null between blocks. */
  private streamBlock: 'thinking' | 'text' | 'tool_use' | null = null
  private blockSinceMs: number | null = null
  /** The running tools' own budgets as their progress ticks carried them,
   *  keyed by parent tool-use id; emptied with the turn. */
  private readonly toolBudgets = new Map<string, { budgetMs: number; elapsedMs: number; atMs: number }>()
  /** While a turn is in flight the live channel ticks once a second so the
   *  status row's clocks ("thinking for 12s") move: a listener whose
   *  snapshot did not move (the screen's live view, the interrupt key)
   *  re-renders nothing — only the row's own sentence key does. */
  private livenessTicker: ReturnType<typeof setInterval> | null = null

  // ── the live tool progress (LIVEPAINT: the ephemeral store's ONE writer) ──
  private readonly progressFeed: ProjectionFeed
  private progressAtMs = -1
  /** seq per PARENT tool-use id already published — an unmoved entry never
   *  re-mints a store frame (the row re-renders only on real movement). */
  private readonly publishedProgressSeqs = new Map<string, number>()

  private attached = false
  /** A resume's admission in flight: the first delivery waits for it (the
   *  session's runner exists only once the daemon admitted the resume). */
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

  // ── attach / detach (the reader runs while the slot holds the session) ──

  /** Start the feeds. Resolves once the FIRST transcript read completed
   *  (painted or torn — never dangles), so the hop can hold its route flip
   *  until the records are on the canvas. */
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
          /* already closed */
        }
        if (this.transcriptWatcher === watcher) this.transcriptWatcher = null
      })
      this.transcriptWatcher = watcher
    } catch {
      /* the file may not exist yet — the heartbeat carries it and re-arms */
    }
    this.factsFeed.start()
    this.asksFeed.start()
    this.tailFeed.start()
    this.progressFeed.start()
    // A stale projection refreshes at once (fire-and-forget; the file feed
    // paints the answer).
    void this.rpc({ op: 'sessionControl', action: 'session-facts', sessionId: this.record.sessionId, by: 'operator' }).catch(() => {})
    // THE FOCUS FACT: the daemon learns this is the chat the operator is
    // looking at (the record's focusedAt/focusedBy) — the launch-authority
    // valve inside the session's runner reads it from there.
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
      /* already closed */
    }
    this.transcriptWatcher = null
    this.factsFeed.stop()
    this.asksFeed.stop()
    this.tailFeed.stop()
    this.progressFeed.stop()
    // The seat goes with the slot: however it was lost (a hop away, a blank
    // chat taking the slot, close-all), the session is no longer the
    // operator's own — the daemon clears the fact.
    seatVerb('blur', this.record.sessionId)
    // A tail is a moment, never a cache: the next hop reads a fresh one.
    // The GHOST is a moment too — reset(null) retires mid-stream text into
    // the settled hold, and a hold that survived the hop painted a stale
    // naked copy beside the row on re-attach (the switch-away-and-back
    // shape of the attach-dedup sighting). Drop it with the slot.
    this.tailStore.reset(null)
    this.tailStore.dropSettled()
    this.tailStore.setMessageId(null)
    this.tailAtMs = -1
    this.liveTurnChars = 0
    this.liveStateWord = null
    // Live tool lines are a moment too — the store empties with the slot
    // (this connector is its one writer; a hop back republishes from the
    // projection at once).
    clearEphemeralProgress()
    this.publishedProgressSeqs.clear()
    this.progressAtMs = -1
    // The cached records, facts and asks stay: a hop back paints them at
    // once and the first tick refreshes.
  }

  /** The progress projection moved (LIVEPAINT): each entry whose seq
   *  advanced publishes into the ephemeral progress store — the store's one
   *  writer since the runner re-home — and the running rows repaint their
   *  one in-place line. An EMPTY map is the seat's clear-on-settle: the
   *  store empties (the full output row owns the truth now). Absent or torn
   *  reads change nothing (fail-soft, the projection discipline). */
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
      // LIVENESS: the tool's own budget and its elapsed time at this tick
      // (read before the seq gate — the budget is a fact of the tool, not
      // of the line's movement).
      if (typeof entry.budgetMs === 'number') {
        this.toolBudgets.set(parentId, { budgetMs: entry.budgetMs, elapsedMs: (entry.elapsedTimeSeconds ?? 0) * 1000, atMs: progress.atMs })
      }
      const prior = this.publishedProgressSeqs.get(parentId)
      if (prior !== undefined && entry.seq <= prior) continue
      this.publishedProgressSeqs.set(parentId, entry.seq)
      publishEphemeralProgress(reconstructedProgressMessage(parentId, entry))
    }
  }

  /** The tail projection moved: the store takes the text block in flight
   *  (or its clear) and paints at its own cadence; the turn's cumulative
   *  streamed-character count (the live token counter's source) rides the
   *  same read — absent means zero, never stale. */
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
    // The runner's state word rides the same read (absent means none — the
    // mixed-version law); a flip repaints the live phase at once.
    this.setLiveStateWord(tail.stateWord === 'compacting' ? 'compacting' : null)
    // LIVENESS: the seat's stamp of the runner's last frame and the block
    // in flight ride the same read (absent means unspoken / an old daemon —
    // the row then claims nothing); a block flip repaints the phase.
    this.lastEventAtMs = typeof tail.lastEventAtMs === 'number' ? tail.lastEventAtMs : null
    const block = tail.streamBlock === 'thinking' || tail.streamBlock === 'text' || tail.streamBlock === 'tool_use' ? tail.streamBlock : null
    this.setStreamBlock(block, block !== null && typeof tail.blockSinceMs === 'number' ? tail.blockSinceMs : null)
    if (tail.atMs === this.tailAtMs && tail.text === this.tailStore.read()) return
    this.tailAtMs = tail.atMs
    const text = tail.text
    // The dedup identity rides beside the text: staged before the feed so
    // the store's id moves atomically with the text transition. An old
    // runner's file carries none — the release law falls back to the text
    // match (the mixed-version law).
    this.tailStore.setMessageId(typeof tail.messageId === 'string' && tail.messageId !== '' ? tail.messageId : null)
    this.tailStore.update(() => text)
  }

  /** SeatLiveExtensionV1.turnChars — the in-flight turn's streamed character
   *  count, read-only from the tail projection's last read. */
  turnChars(): number {
    return this.liveTurnChars
  }

  /** The runner's live state word from the tail projection ('compacting'
   *  while the fold call runs). A flip recomputes the live view — the phase
   *  is the reader-visible fact that moves. */
  private setLiveStateWord(word: 'compacting' | null): void {
    if (this.liveStateWord === word) return
    this.liveStateWord = word
    this.recomputeLive()
  }

  /** LIVENESS: the block the runner is streaming (from the tail projection).
   *  A kind flip recomputes the live view — the phase is the reader-visible
   *  fact that moves; the clock alone moves nothing (the ticker reads it). */
  private setStreamBlock(block: 'thinking' | 'text' | 'tool_use' | null, sinceMs: number | null): void {
    const flipped = this.streamBlock !== block
    this.streamBlock = block
    this.blockSinceMs = sinceMs
    if (flipped) this.recomputeLive()
  }

  /** The live channel's one-second tick while a turn is in flight (and the
   *  slot holds the session): the status row's clocks move on it. Idle
   *  sessions tick nothing. */
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

  /** When the running tool started: the assistant row carrying the
   *  unresolved tool_use (its timestamp — the transcript's own fact),
   *  oldest first; null when no such row is on the canvas yet. */
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

  /** THE FOCUS FACT after a reactivate: the resume door attached this
   *  connector BEFORE the daemon's record stood (the transcript paints
   *  first; the admission settles behind it), so the attach's own focus
   *  verb found no record. Once the record stands the door says the verb
   *  again — the same verb, the same chain, never a second writer; a
   *  connector that lost the slot meanwhile (detached by the hop fence)
   *  says nothing. */
  assertSeat(): void {
    if (this.attached) seatVerb('focus', this.record.sessionId)
  }

  /** Append a DISPLAY-ONLY row (the resume recap, a screen command's
   *  receipt): painted after the records on hand at the moment it arrives,
   *  never written anywhere, never reconciled away. */
  addDisplayRow(row: Message): void {
    const subtype = (row as { subtype?: string }).subtype
    // The resume recap is the re-entry briefing: a session resumed again on
    // the same cached connector gets the NEWEST card, never a stack (the
    // rows stay across detach, so every resume used to append one more).
    const kept =
      row.type === 'system' && subtype === 'away_summary'
        ? this.displayRows.filter(d => !(d.row.type === 'system' && (d.row as { subtype?: string }).subtype === 'away_summary'))
        : this.displayRows
    connectorTrace({ ev: 'display-row', sid: this.record.sessionId, anchor: this.rawRecords.length, subtype: subtype ?? row.type, display: kept.length + 1 })
    this.displayRows = [...kept, { row, anchor: this.rawRecords.length }]
    this.paint()
  }

  /** The session's own transcript file — the committed records a branch
   *  forks from. */
  transcriptFile(): string {
    return this.transcriptPath
  }

  /** The daemon's own record lands (a resume painted from its file before
   *  the admission settled; a respawn under a new worker short): the
   *  record's facts refresh in place and the status row repaints. */
  adoptRecord(next: DaemonSessionRecordV1): void {
    if (next.sessionId !== this.record.sessionId) return
    Object.assign(this.record, next)
    emitAll(this.liveListeners, 'live')
  }

  /** A resume's admission: deliveries wait for it; a refused admission
   *  (the promise settles to the daemon's own sentence, null when admitted)
   *  hands the words back with that sentence. The settled refusal is KEPT
   *  on the connector and announced on the live channel, so every resume
   *  road paints the no-live-runner line — the boot's --resume and the
   *  picker land in the screen without the switch callback. */
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

  /** The daemon's refusal sentence for this session's resume admission —
   *  null while admitted or still settling; cleared by the next delivered
   *  message (the replay revived it). */
  admissionRefusal(): string | null {
    return this.refusedAdmission
  }

  // ── the transcript reader ──

  /** Single-flight with ONE dirty rerun. The 400 ms heartbeat and EVERY
   *  fs.watch event funnel here; each pass is a full transcript load, so a
   *  real append burst used to stack overlapping whole-file loads — and two
   *  overlapped loads can complete out of order, painting the older read
   *  until the next heartbeat. A trigger landing mid-pass marks dirty and
   *  the loop reruns once after the pass: the last pass always STARTED
   *  after the last trigger, so its bytes are read (no dropped trigger),
   *  and a burst of N triggers costs at most one full load plus one rerun
   *  (whose unchanged-size stat gate exits cheap when nothing moved).
   *  Joiners receive the running flight's promise — attach()'s "resolves
   *  once the first read completed" contract keeps. */
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
        // The file appeared after attach: arm the watch now.
        try {
          const watcher = watch(resolveWatchRoot(this.transcriptPath), () => void this.tick())
          watcher.on('error', () => {
            if (this.transcriptWatcher === watcher) this.transcriptWatcher = null
          })
          this.transcriptWatcher = watcher
        } catch {
          /* the heartbeat carries it */
        }
      }
      const { loadFullLog } = await import('../../utils/sessionStorage/logs.js')
      const log = (await loadFullLog({ sessionId: this.record.sessionId, messages: [], fullPath: this.transcriptPath } as never)) as unknown as {
        messages?: unknown[]
      }
      if (!this.attached) return
      const raw = Array.isArray(log?.messages) ? (log.messages as Message[]) : []
      // The size is the tick's stat gate alone — never a liveness clock:
      // the runner's own frames (the seat's stamp on the tail projection)
      // say when the session last spoke.
      if (sizeNow !== -1 && sizeNow !== this.lastSize) this.lastSize = sizeNow
      this.lastLen = raw.length
      // Content-keyed merge (recordIdentity — the pure seam the pool pin
      // drives in BOTH directions): deserializeLiveMessages is a 1:1
      // index-aligned map (migrate + scrub, no split), so a record whose
      // serialized bytes match the last parse at the same index KEEPS the
      // object identity the previous tick handed React — the row memo bails
      // and only moved rows reconcile — while changed bytes always take the
      // fresh object (never a stale paint). A byte-identical re-read (a
      // size-blind stat, a torn-read retry) keeps the ARRAY identity too
      // and wakes no listener at all.
      const merge = mergeRecordsContentKeyed(
        this.rawRecords,
        this.recordSigs,
        raw,
        deserializeLiveMessages(raw),
      )
      this.recordSigs = merge.sigs
      connectorTrace({ ev: 'load', sid: this.record.sessionId, rawLen: raw.length, reusedAll: merge.reusedAll, prevLen: this.rawRecords.length })
      if (merge.reusedAll) return
      this.rawRecords = merge.records
      this.liveState = liveTurnStateOf(this.rawRecords)
      this.reconcileSends()
      this.paint()
      this.recomputeLive()
    } catch (error) {
      /* a torn read — the next tick repaints */
      connectorTrace({ ev: 'tick-error', sid: this.record.sessionId, message: error instanceof Error ? error.message : String(error) })
    }
  }

  /** The effective live view: the fold's phase/tools/clock, but its
   *  in-flight is the union of the fold and the daemon's own turn edge (the
   *  settled transcript trails the edge, so an idle fold under a busy edge
   *  is still a running turn). Emits only when a reader-visible field moved
   *  (a useSyncExternalStore snapshot must keep its identity per heartbeat). */
  private recomputeLive(): void {
    // THE TURN TRUTH IS THE DAEMON'S: its facts say busy from the user frame
    // that opened the turn to the result frame that closed it; a send this
    // connector delivered and whose row has not landed yet bridges the
    // moment before the first facts flip. The records fold contributes the
    // phase and the tool progress of a turn that IS running — never the
    // fact of one: a transcript that ends in an unanswered user row (a
    // session cut mid-turn, a seeded transcript) is IDLE on resume, not a
    // phantom "replying" with a days-old clock.
    const sendInFlight = this.sends.some(s => s.state === 'delivered')
    const inFlight = this.factsBusy || sendInFlight
    // Busy over a fold-idle transcript is the DISPATCH window — the turn is
    // open but nothing has streamed; 'thinking' is the honest claim
    // ('responding' painted a writing indicator before the first token).
    // The one exception: while the runner's state word says the fold is
    // running, the phase is 'compacting' — the fold's own word, never the
    // thinking dress (the summary call is mechanical by law).
    // LIVENESS: while the runner streams a block, the block is the phase —
    // a thinking block is thinking, prose or a tool call being written is
    // responding — ahead of the records fold, which sees a block only once
    // its message lands. A running tool (an unresolved tool_use on the
    // canvas) outranks a stale block stamp: the stream is closed then.
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
    // The published in-progress set rests on the idle edge exactly like the
    // four artifacts below (FN-016 R5): the transcript's unanswered
    // tool_use ids are a fact about the RECORDS, not about a running turn —
    // a session whose log ends in a tool_use with no result (a runner
    // killed mid-tool, a quit or sleep during a call, an interrupt whose
    // settlement never reached disk) resumes IDLE, never with a permanently
    // running tool row whose clock counts up from the paint. The identity
    // of the empty set is stable (IDLE_LIVE's own) so idle heartbeats never
    // read as a change.
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
    // A settled turn never leaves a tail behind (the settled row paints),
    // and the live token count rests with it.
    if (!inFlight && this.tailStore.read() !== null) this.tailStore.reset(null)
    if (!inFlight) this.liveTurnChars = 0
    // The state word rests with the turn too (direct assignment — the
    // setter would recurse into this very fold).
    if (!inFlight) this.liveStateWord = null
    // …nor a live tool line (the belt under the projection's own clear —
    // clearEphemeralProgress no-ops on an empty store).
    if (!inFlight && this.publishedProgressSeqs.size > 0) {
      clearEphemeralProgress()
      this.publishedProgressSeqs.clear()
    }
    // The tools' budgets rest with the turn; the row's clocks tick only
    // while one is in flight.
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

  /** A delivered send retires when the session's OWN row carrying its
   *  IDENTITY lands: a user row whose uuid IS the clientMessageId (the
   *  frame identity rides through the dispatch — one id, composer to
   *  transcript row), or a queued_command attachment row whose source_uuid
   *  is (the mid-turn fold-in's persisted shape). A non-UUID identity (an
   *  obligation answer rides a kernel door that mints its own frame) falls
   *  back to a text match over rows NOT OLDER than the send itself — never
   *  an old-history substring. A send older than ten minutes retires
   *  regardless — never a ghost row. Nothing is fabricated here: the old
   *  steered-inference branch minted an echo row whenever a send's text
   *  left the facts queue (an ESC clear, a replace, an errored turn all
   *  read as "steered"), and those rows never retired against the
   *  attachment-typed landing — the message painted twice for up to ten
   *  minutes. */
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
          // One landing row retires at most ONE send: a row spent by an
          // earlier text-fallback retirement is skipped, so same-text
          // twins each wait for their own landing (B1).
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
    // The operator's rewound windows leave the chat (FN-015 rank 8 — the
    // display projection of the runner's own rewind record): the rows
    // between a rewound turn and its record are dropped BY IDENTITY, so
    // display-row anchors (positions in the raw list) stay true. The
    // transcript keeps every row; the read-only view shows them.
    const kept = projectOperatorRewinds(this.rawRecords)
    const dropped = kept.length === this.rawRecords.length ? null : new Set<Message>(kept)
    if (echoes.length === 0 && this.displayRows.length === 0 && dropped === null) {
      this.painted = this.rawRecords
    } else {
      // Display rows splice in at their anchors (after the record they
      // followed), the echo rows ride the tail.
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

  // ── the /rewind facts + verb (FN-015 rank 8) ──

  /** The runner's fileCheckpoints facts folded into a stable snapshot: an
   *  older runner's answer lacks the field and reads 'unknown' (never 'on'). */
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

  /** THIS session's rewind — the sessionRewind RPC on the seat-mutating
   *  chain; the daemon awaits the runner's own receipt and relays it. The
   *  cockpit's own arms speak the same vocabulary: an older daemon's
   *  unknown-op refusal is 'daemon-older' (the mixed-version law), a daemon
   *  that does not answer 'restore-failed' with nothing assumed restored.
   *  A landed conversation rewind re-reads the transcript at once so the
   *  chat paints the boundary without waiting for the watcher's tick. */
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

  // ── the facts feed ──

  private readFacts(): void {
    const next = readSessionFacts(this.record.sessionId)
    if (next === null) {
      // A RETIRED projection (the session's runner settled; its files went
      // with it) must not leave the work roster claiming live rows — those
      // rows' engine is gone. Only a GONE file empties the roster; a torn
      // read keeps everything and the next publish repaints.
      if (this.facts !== null && ((this.facts.work?.length ?? 0) > 0 || (this.facts.mission?.length ?? 0) > 0) && !existsSync(sessionFactsPath(this.record.sessionId))) {
        this.facts = { ...this.facts, work: [], mission: [] }
        this.refreshWork()
      }
      return
    }
    const prev = this.facts
    this.facts = next
    this.refreshCheckpoints()
    // The OpenAI meter's daemon road: the RUNNER is the only process that
    // sees the x-codex usage headers (no polled endpoint exists on that
    // lane), and its facts projection carries the last-observed bands here.
    // Adoption is per-band by recency (openaiLimitState owns the fold), so
    // the rail and the /usage tab light on the focused session's real
    // signal instead of an eternally-empty screen-local record. Absent =
    // an older runner or a lane that never spoke — nothing changes.
    adoptOpenaiObservedUsage(next.usage?.openaiObserved)
    // The queued-switch settle note (the pings rule): one
    // grey display-only row paints in THIS chat ("model switched to X for
    // this session"), never a conversation write, never a bell (the ping
    // engine watches attention facts, and a settle mints none). The edge
    // drives off the DAEMON'S OWN settlement receipt (facts.modelSettled,
    // stamped where the idle edge applied the parked switch) — never off a
    // same-snapshot coincidence of pendingModel clearing while the child's
    // answer names the new model: that retired test compared the parked
    // SETTING (an alias like 'fable') against the RESOLVED served id, and
    // the daemon's clear publish carries the child's LAGGING answer anyway,
    // so the row never painted (FN-016 R15). The edge fires once per stamp
    // (atMs moves); a FRESH attach adopts a standing stamp silently (prev
    // is null on the first read — a resumed screen must not replay an old
    // settle); a cancel stamps nothing and mints nothing.
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
    // The daemon's own turn edge is the immediate in-flight truth (the
    // settled transcript trails it): a busy edge lifts the live view the
    // moment a user frame hits the child's stdin, and its fall clears an
    // interrupt latch before any flush.
    this.factsBusy = next.busy
    if (next.busy) this.armBusyStall()
    else this.disarmBusyStall()
    this.recomputeLive()
    if (modelMoved) emitAll(this.modelListeners, 'model')
    if (modeMoved) emitAll(this.permissionListeners, 'permission')
    // Usage, identity and rosters are read on render; the records feed
    // re-renders their readers when the transcript moves, and the model
    // feed carries a facts change the readouts must show now.
    if (!modelMoved) emitAll(this.modelListeners, 'model')
    // The facts tick doubles as the echo sweep clock: an idle session's
    // transcript may never move, and the transcript tick early-returns on
    // an unchanged file size — the ten-minute ghost-row bound needs this
    // heartbeat to fire.
    if (this.reconcileSends()) this.paint()
    this.refreshWork()
  }

  /** The work roster follows the facts, content-keyed: an unchanged roster
   *  keeps its snapshot identity (no re-render) and emits nothing. */
  private refreshWork(): void {
    const rows = this.facts?.work ?? []
    const mission = this.facts?.mission ?? []
    const stamp = JSON.stringify([rows, mission])
    if (stamp === this.workStamp) return
    this.workStamp = stamp
    this.workSnapshot = { rows, mission }
    emitAll(this.workListeners, 'work')
  }

  // ── the asks feed ──

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

  /** The FULL consent-card payload from the projection: the card's own verbs
   *  answer through the daemon door with the full answer. */
  private buildConfirm(row: SessionAskProjectionV1): ToolUseConfirm {
    const tool = toolFor(row.toolName)
    // The structured reason first (the card explains the matched rule, the
    // hook, the safety check exactly as the boot session's card does); the
    // plain-text form when that is all the asking side sent.
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
        // The card's abort: the session's turn stops (deny + interrupt).
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
    // The tool's own description (the same sentence the in-process card
    // shows) arrives asynchronously; the card re-reads the getter on its
    // next paint.
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

  // ── the daemon door ──

  private async rpc(req: Record<string, unknown>): Promise<Record<string, unknown>> {
    const { daemonControlRpc } = await import('../../daemon/controlSocket.js')
    return (await daemonControlRpc(req as never, { timeoutMs: RPC_TIMEOUT_MS })) as Record<string, unknown>
  }

  // Seat-MUTATING verbs ride ONE chain: two concurrent RPCs travel on
  // separate daemon connections and could land on the child's stdin in
  // either order — a queue remove issued before an interrupt must reach the
  // session before it (the stdin is serial; the chain makes the deliveries
  // serial too). A failed link never blocks the next.
  private verbChain: Promise<unknown> = Promise.resolve()
  private chainRpc(req: Record<string, unknown>): Promise<Record<string, unknown>> {
    const link = this.verbChain.then(() => this.rpc(req))
    this.verbChain = link.catch(() => {})
    return link
  }

  private async answerThroughDaemon(requestId: string, answer: AskAnswerV1): Promise<AskReceiptV1> {
    // Settle locally FIRST (one settlement): the card leaves at once; the
    // daemon's projection confirms.
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
      // Feedback riding an allow, and any content blocks, follow as the
      // operator's next words to the session (they land after the tool).
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
    // THE ONE IDENTITY: a bare uuid, minted here, riding the dispatch as
    // the frame uuid, the queue entry's uuid, the promptUuid, and the
    // transcript row's uuid — echo retirement and the runner's replay
    // dedup both key on it. A held/failed resend of the SAME words reuses
    // the id (the daemon ledger and the runner both treat it as the same
    // message — delivered at most once whatever the retry count).
    const provisionalId =
      this.retainedSend !== null && this.retainedSend.text === expanded ? this.retainedSend.id : randomUUID()
    // A SENT MESSAGE PAINTS AS A SENT MESSAGE, instantly and
    // unconditionally (the delivery law): the echo row rides the transcript
    // tail until the session's own row with this identity lands. There is
    // no queued/steered fork — the engine reads the words at its next
    // readable moment whatever the turn is doing, and the operator sees
    // exactly what they sent, exactly once. FN-020 row 10: the row paints
    // BEFORE the obligations read below — the echo is no longer gated on a
    // disk read; when the words turn out to answer an open question the
    // row re-keys to the answer's identity before anything else reads it.
    this.echoRows.set(provisionalId, createUserMessage({ content: expanded }) as unknown as Message)
    this.paint()
    // An open non-permission question of the session's is answered by the
    // next words typed (the concourse's obligation.answer verb).
    const answering = await this.openQuestion()
    const clientMessageId = answering !== null ? `obl-answer:${answering}` : provisionalId
    if (clientMessageId !== provisionalId) {
      // Re-key in place, keeping the row's position among any echoes that
      // landed during the read.
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
        // A delivered message IS the revival — the kept refusal is stale.
        this.refusedAdmission = null
        return { state: 'accepted' }
      }
      return { state: 'refused', detail: detail ?? (state === 'held' ? 'held — ↵ again replays it' : 'the session did not take it') }
    }
    try {
      // A resume still being admitted: the words wait on the canvas for the
      // session's runner; a refused admission hands them back with its reason.
      const refusal = this.admission !== null ? await this.admission : null
      if (refusal !== null) {
        return settle('failed', `the session could not resume — ${refusal} · ↵ again retries`)
      }
      const { ensureOwnedDaemon } = await import('../switchboard/ensureDaemon.js')
      if (!(await ensureOwnedDaemon())) {
        return settle('failed', 'the daemon that hosts sessions did not start — ↵ again starts it and retries')
      }
      // The seat re-asserts with every word sent from the focused chat: a
      // focus verb that found no daemon at the hop (it was still starting)
      // lands now, ahead of the words the session may answer with a launch.
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

  /** The session's open NON-permission question, if any (its obligation id). */
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

  // ── EngineConnectorV1 ──

  sessionId(): string {
    return this.record.sessionId
  }

  sendWords(text: string, opts?: SendWordsOptions): Promise<SendReceiptV1> {
    return this.deliver(text, {
      ...(opts?.mode === 'bash' ? { mode: 'bash' as const } : {}),
      ...(opts?.pastedContents !== undefined ? { pastedContents: opts.pastedContents } : {}),
    })
  }

  /** The delivery door's addressed form: the SAME dispatch wire and
   *  identity laws as deliver(), addressed to one agent inside this
   *  session's runner (frame mode 'task-notification' + agentId; the
   *  runner enqueues it scoped and the agent's own drain folds it into its
   *  next turn, exactly once). No echo/sends bookkeeping: the note is not
   *  operator-transcript content — no row will ever land for it in THIS
   *  chat, so an echo would only ghost. */
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

  /** esc: the session's turn stops through the daemon (one request until
   *  the live state falls idle); its parked asks retire with the turn (the
   *  session cancels them itself). True when something was running. */
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
    // The source stamp (FN-013 MODEL-02): live facts, then the durable
    // admission record — both the SESSION's own truth. The final fallback
    // is this process's ambient model state, which is NOT the session's
    // fact; the transition gate refuses to plan from it.
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

  /** THIS session's model, in place, from its next message: the daemon
   *  applies it now (idle) or parks it for the turn's end (busy). The
   *  readout flips at once (an optimistic paint, re-trued by the facts); the
   *  RECEIPT waits for the daemon's word — refused, applied, queued or no-op
   *  come from the one authority that decided them, never from the screen's
   *  own in-flight guess (FN-015 rank 50: the old door minted "applied"
   *  before the RPC settled and could never report a refusal, so the
   *  transcript said the switch happened while the session ran on). */
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
      // The optimistic paint above would otherwise keep showing a model the
      // session never switched to, indefinitely.
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
      // The daemon parked what the screen guessed idle (or the reverse): the
      // facts re-read repaints the projection to the daemon's word.
      if ((outcome === 'queued') !== busy) this.readFacts()
      if (outcome === 'noop') return { state: 'no-op' }
      return { state: outcome }
    } catch (e) {
      // A THROWN rpc (daemon unreachable, timeout) is a refusal too.
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

  /** THIS session's kit dial (KIT-DIALS; ledger L24(3)) — the sessionControl
   *  'set-kit' RPC with a minted op id (the applied arms are exactly-once
   *  under a lost response). No optimistic roster mutation: the daemon's
   *  adjudication is the truth (a mid-turn dial answers 'queued' — flipping
   *  the roster early would paint a lie), and the seat's immediate facts
   *  re-ask repaints the projections within its debounce. */
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

  // ── SeatLiveExtensionV1 ──

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
    // LIVENESS — the one fold. Every clock below is a fact of the runner's
    // own frames (the seat's stamps) or of the transcript's rows; none
    // reads the transcript file's growth.
    const live = this.effectiveLive
    const now = Date.now()
    const quietMs = live.inFlight && this.lastEventAtMs !== null ? Math.max(0, now - this.lastEventAtMs) : null
    const watchdogMs = typeof this.facts?.streamIdleTimeoutMs === 'number' ? this.facts.streamIdleTimeoutMs : null
    let phaseMs: number | null = null
    let toolBudgetMs: number | null = null
    if (live.inFlight) {
      if (live.phase === 'tool') {
        // The tool's elapsed: its assistant row's timestamp (the oldest
        // running one), or the progress tick's own elapsed count carried
        // forward — whichever the canvas knows; its budget is the largest
        // among the running tools that reported one.
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
    // The stuck verdict: the stream itself silent past the watchdog's own
    // warning half — never a tool's silence (the tool's budget is its own),
    // never on a runner that reports no budget or no stamp.
    const stuck =
      live.inFlight &&
      !this.interrupting &&
      live.phase !== 'tool' &&
      quietMs !== null &&
      watchdogMs !== null &&
      quietMs >= streamIdleWarningMsOf(watchdogMs)
    return {
      // L16 on the chat seat: the tag reads the record's title LIVE through
      // the naming owner's derivation the hop registers (stored title · the
      // chat's first words · the stage-1 fact) — the hop-time snapshot alone
      // left every born chat's tag at "new session" while the board moved on.
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

// ── the registry + the hop ──────────────────────────────────────────────────

const connectors = new Map<string, DaemonSessionConnector>()

/** ONE connector per daemon-hosted session (a hop back finds the same one,
 *  its cached records and facts painting at once); a newer record for the
 *  same session refreshes the facts it carries. */
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

/** The chat tag's live title: the naming owner's three stages over the
 *  daemon's record and the session's own transcript, registered by the hop
 *  (services/switchboard/hopIntoSession — the seam that already reads both).
 *  Null lets the hop-time snapshot stand (a record-less resume, a scratch
 *  arena with no records file). */
export type LiveTitleDeriver = (record: DaemonSessionRecordV1) => string | null
let liveTitleDeriver: LiveTitleDeriver | null = null
export function registerLiveTitleDeriver(deriver: LiveTitleDeriver): void {
  liveTitleDeriver = deriver
}

/**
 * THE HOP: the focused slot re-points at the session's connector. Resolves
 * once the session's records are on hand (the first read, bounded by the
 * caller's own ceiling), so the route can flip onto a painted chat.
 */
export async function focusDaemonSession(record: DaemonSessionRecordV1): Promise<DaemonSessionConnector> {
  const connector = daemonSessionConnectorFor(record)
  // The hop claims its epoch BEFORE the load: a newer hop chosen while this
  // transcript reads makes this one a no-op at the commit (the fence).
  const epoch = claimHopEpoch()
  await connector.attach()
  if (!hopEpochIsCurrent(epoch)) return connector
  setFocusedSessionConnector(connector)
  return connector
}

// A connector that lost the slot stops its feeds (its cache stays for the
// next hop); the one holding it keeps reading whichever view is on screen —
// views are not sessions. Only a RE-POINT detaches: the slot's subscribers
// also pulse on every landing edge, and a hop attaches its connector BEFORE
// the slot moves — a pulse inside that window used to detach the very
// connector being hopped into, leaving the slot on a reader that never ran
// again (the frozen transcript: echoes painted, the file's rows never).
let lastFocusedForDetach: unknown = getFocusedSessionConnector()
subscribeFocusedSessionConnector(() => {
  const focused = getFocusedSessionConnector()
  if (focused === lastFocusedForDetach) return
  lastFocusedForDetach = focused
  for (const c of connectors.values()) {
    if (c !== focused && c.isAttached()) c.detach()
  }
})
