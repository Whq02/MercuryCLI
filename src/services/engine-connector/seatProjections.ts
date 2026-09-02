// ============================================================================
//  engine-connector/seatProjections — the daemon-hosted session's
//  projections the screen reads: ITS FACTS, ITS ASKS, and the two live
//  feeds (ITS TAIL and ITS TOOL PROGRESS).
//
//  The daemon publishes one file per session under its own dir:
//    <daemonDir>/session-facts/<sessionId>.json — the session's model,
//      usage, identity, skills, MCP roster, permission mode, workspace and
//      queue, answered by the SESSION'S PROCESS (the child's session_facts
//      control verb) and stamped by the daemon;
//    <daemonDir>/session-asks/<sessionId>.json — every parked consent ask
//      with its FULL payload (tool, input, the offered rules, the blocked
//      path, the decision reason, the asking tool use), so the focused chat
//      renders the same consent card the in-process engine gets;
//    <daemonDir>/session-tail/<sessionId>.json — the reply text block in
//      flight (SessionTailV1 below);
//    <daemonDir>/session-progress/<sessionId>.json — the running tools'
//      latest ephemeral lines (SessionProgressV1 below, LIVEPAINT).
//  The screen's daemon connector watches the files (fs.watch + a heartbeat,
//  the transcript reader's own discipline) and reads them synchronously, so
//  a hop paints the session's own numbers on its first frame. Reads are
//  fail-soft: a torn or absent file answers null and the next publish
//  repaints. This module carries no daemon dependency beyond the dir
//  resolver, so both processes import it.
// ============================================================================
import { mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { daemonDir } from '../../daemon/controlSocket.js'
import { publishAtomic } from '../../substrate/fileStore.js'
import type { PermissionMode, PermissionUpdate } from '../../types/permissions.js'
import type { DecisionReasonWireV1 } from '../../utils/permissions/decisionReasonWire.js'
import type { PromptInputMode, QueuePriority } from '../../types/textInputTypes.js'
import type {
  McpRosterEntryV1,
  MissionRowV1,
  SeatIdentityV1,
  SkillsRosterEntryV1,
  UsageFactsV1,
  WorkRowV1,
  WorkspaceFactsV1,
} from './types.js'

// ── the facts ───────────────────────────────────────────────────────────────

/** One queued entry as the session's own queue holds it. */
export interface QueuedFactV1 {
  uuid?: string
  /** The queued text (content blocks fold to their text). */
  value: string
  mode: PromptInputMode
  priority?: QueuePriority
}

/** What the SESSION'S PROCESS answers to a session_facts control request. */
export interface SessionFactsAnswerV1 {
  model: {
    /** The model the session's next call runs. */
    effective: string
    /** The stored setting (null = the default rung). */
    setting: string | null
  }
  usage: UsageFactsV1
  identity: SeatIdentityV1
  skills: SkillsRosterEntryV1[]
  mcp: McpRosterEntryV1[]
  permissionMode: PermissionMode
  workspace: WorkspaceFactsV1
  queue: QueuedFactV1[]
  /** The session's work roster — its runner's own task store, projected
   *  (workflows · agents · teammates · shells · monitors · dreams).
   *  Optional on the wire: an older runner's answer simply lacks it and
   *  every reader treats absence as the empty roster. */
  work?: WorkRowV1[]
  /** The session's mission ledger (its own TaskCreate/TaskUpdate list) —
   *  optional on the wire like `work`; absence reads as the empty ledger. */
  mission?: MissionRowV1[]
  /** The session's KIT as the PROCESS holds it (the consumed-once latch;
   *  KIT-RUNNER). Optional on the wire: an un-kitted or older runner simply
   *  omits it. When the daemon's record holds an UNRESOLVED stamp and this
   *  answer carries a RESOLVED kit, the daemon completes the record — the
   *  only road from provisional to resolved. */
  kit?: import('../../daemon/sessionKit.js').SessionKitV1
  /** SATURN's facts-borne tool road (the runner holds no control client):
   *  the schedule edits the session's OWN tools queued since the last
   *  answer — SEND-AND-CLEAR (each edit rides exactly one answer; a
   *  repeated list would double-apply adds). The seat applies each through
   *  the record's one writer as 'model:<sessionId>' and pushes the
   *  post-apply roster back down. Optional on the wire: an older runner
   *  simply never carries it. */
  pendingScheduleEdits?: import('../../daemon/saturn.js').ScheduleOpRequestV1[]
  /** The /rewind facts (FN-015 rank 8): whether THIS runner captures file
   *  checkpoints and which user messages carry a saved point — the cockpit
   *  offers a code restore only where one exists. Optional on the wire: an
   *  older runner omits it and the cockpit reads 'unknown' (never 'on'). */
  fileCheckpoints?: FileCheckpointFactsV1
  /** LIVENESS — the stream idle budget THIS runner's watchdog aborts at, in
   *  ms (providers/streamIdleBudget, resolved in the runner's own process
   *  for the session's route): the focused chat's status row says "stuck"
   *  only against this number and names it. Optional on the wire: an older
   *  runner omits it and the row never claims stuckness. */
  streamIdleTimeoutMs?: number
}

/** The runner's checkpoint truth, as the facts carry it. */
export interface FileCheckpointFactsV1 {
  /** True when the runner captures per-turn file checkpoints. */
  capture: boolean
  /** The user message ids that carry a saved point (oldest first). */
  restorable: string[]
}

/** The published projection: the answer stamped with the daemon's own truth
 *  (a parked model switch lives on the daemon's record, not in the child). */
export interface SessionFactsV1 extends SessionFactsAnswerV1 {
  schema: 1
  sessionId: string
  /** When the daemon stamped it. */
  atMs: number
  /** A model switch parked until the session's turn ends (the daemon is
   *  the settlement owner); null when none. */
  pendingModel: string | null
  /** The daemon's OWN settlement receipt for a PARKED switch it applied at
   *  the turn boundary (FN-016 R15): the settle-note edge drives off THIS,
   *  never off a same-snapshot coincidence of pendingModel clearing while
   *  the child's lagging answer still names the old model. `to` is the
   *  parked SETTING verbatim (alias or id — the label helper renders it);
   *  `from` is the serving truth at the flip. Absent when no parked switch
   *  has settled this seat-life; an older daemon simply never carries it. */
  modelSettled?: { from: string; to: string; atMs: number }
  /** The daemon's own turn truth for the session (a user frame opened a
   *  turn; the child's result frame closed it) — the prompt edge the
   *  transcript's own rows follow a flush later. */
  busy: boolean
  /** SATURN (daemon/saturn.ts): the session's schedule roster, projected
   *  from the daemon's record (the child never speaks it; the record is
   *  the truth). ABSENT when the record holds none — absent ≠ empty rides
   *  the wire too, and an older screen ignores the field. */
  schedules?: import('../../daemon/saturn.js').SaturnFactsRowV1[]
  /** SATURN: how many fires stand HELD on the session's own account (the
   *  "/logins releases N held fires" line). Absent when none. */
  heldFireCount?: number
}

// ── the asks ────────────────────────────────────────────────────────────────

/** One parked consent ask, full payload. */
export interface SessionAskProjectionV1 {
  /** The daemon's ask identity (the child's control request id). */
  requestId: string
  /** The asking tool use (the consent card's key and the transcript's). */
  toolUseId: string
  toolName: string
  input: Record<string, unknown>
  /** The rules the session offers for "allow always". */
  suggestions?: PermissionUpdate[]
  blockedPath?: string
  /** The plain-text reason (any host's form). */
  decisionReason?: string
  /** The structured reason the card explains — the matched rule ("The rule
   *  Bash(rm:*) requires confirmation"), the mode, a hook, a safety check,
   *  a compound command's per-part verdicts. */
  decisionReasonDetail?: DecisionReasonWireV1
  /** A description the asking side composed (sandbox asks carry one). */
  description?: string
  askedAt: number
}

export interface SessionAsksV1 {
  schema: 1
  sessionId: string
  asks: SessionAskProjectionV1[]
}

/** The session's LIVE TAIL — the text block its runner is streaming right
 *  now, republished at delta cadence; null between text blocks. The screen
 *  paints it exactly as the streaming reveal, so a reply reads as it
 *  arrives whichever process carries the session. */
export interface SessionTailV1 {
  schema: 1
  sessionId: string
  atMs: number
  text: string | null
  /** Cumulative characters the IN-FLIGHT TURN has streamed (every text block
   *  so far, settle-class replies included) — the live token counter's one
   *  truth (chars/4 at the spinner). Persists across block boundaries while
   *  `text` clears between them; the turn's result zeroes it. ADDITIVE (the
   *  mixed-version law): an old writer omits it and the reader treats
   *  absence as zero — the counter shows nothing rather than a lie. */
  turnChars?: number
  /** The PROVIDER MESSAGE ID of the message the tail text belongs to (the
   *  same id the settled transcript row carries as message.id) — the
   *  screen's dedup identity: a visible row bearing it retires the tail,
   *  published text and settle ghost both, the instant the row paints.
   *  Captured at message_start for streams and from the assistant frame for
   *  settle-class replies; it STANDS through the text clear (the ghost's
   *  identity) and zeroes with the turn's result. ADDITIVE (the
   *  mixed-version law): an old writer omits it and the reader falls back
   *  to the text-match release. */
  messageId?: string
  /** The runner's LIVE STATE WORD — 'compacting' while the fold call runs
   *  (the compact service stamps the status at fold start; its restore, the
   *  turn's result frame and a respawn all clear it). The connector lifts it
   *  into the live phase so the glass speaks the fold's own word instead of
   *  the in-flight thinking default. ADDITIVE (the mixed-version law): an
   *  old writer omits it and the reader treats absence as none. */
  stateWord?: 'compacting'
  /** LIVENESS — when the runner last spoke: the wall clock of its last
   *  frame of ANY kind (a stream event — an empty thinking delta and a ping
   *  count —, a tool progress tick, an assistant, user or result frame, a
   *  status word), never the seat's own facts probe traffic. The focused
   *  chat's liveness owner measures the stream's silence from this stamp,
   *  never from the transcript file's growth (a long think, a long tool
   *  run and a real hang all leave the transcript still). ADDITIVE: an old
   *  writer omits it and the reader claims nothing about stuckness. */
  lastEventAtMs?: number
  /** LIVENESS — the content block the runner is streaming RIGHT NOW
   *  (content_block_start … content_block_stop): the model is thinking,
   *  writing prose, or writing a tool call. Absent between blocks and off
   *  the stream (a tool running, the dispatch wait). ADDITIVE. */
  streamBlock?: 'thinking' | 'text' | 'tool_use'
  /** LIVENESS — when the current block began (its start frame's arrival),
   *  the "thinking for 2m" clock's source. ADDITIVE; absent with the block. */
  blockSinceMs?: number
}

/** One running tool's latest ephemeral tick, as the runner's
 *  `ephemeral_tail` frame carried it (LIVEPAINT Layer 2). */
export interface SessionProgressEntryV1 {
  /** The progress child id (each tick mints its own; the map key is the
   *  PARENT tool-use id — the ephemeral store's key). */
  toolUseID: string
  /** 'bash_progress' | 'powershell_progress' | 'mcp_progress'. */
  dataType: string
  /** The runner's per-parent monotonic tick counter. */
  seq: number
  latestLine?: string
  elapsedTimeSeconds?: number
  totalLines?: number
  totalBytes?: number
  mcpProgress?: number
  mcpTotal?: number
  /** LIVENESS — the running tool's OWN deadline budget in ms (a shell's
   *  effective timeout, default or requested), as its progress frame
   *  carried it: the status row names it beside the elapsed time ("running
   *  a tool for 4m (its own timeout at 10m)"). ADDITIVE: a tool without a
   *  budget, or an old runner, omits it and the row names no deadline. */
  budgetMs?: number
}

/** The session's LIVE TOOL PROGRESS — at most one latest-line entry per
 *  running tool, folded by the seat from the runner's source-coalesced
 *  `ephemeral_tail` frames and republished at beat cadence.
 *
 *  TRANSIENT BY DESIGN, like the tail: the turn's result frame clears the
 *  whole map (the transcript's full tool output IS the settle-time truth),
 *  so a line dropped inside a beat or standing at the clear needs NO
 *  delivery guarantee — do not "fix" the missing last line here; the full
 *  output at settle is the guarantee. MIXED-VERSION LAW: an old runner
 *  never sends the frames, so this file never appears (the screen paints no
 *  tail; the glyph pulse still runs from the records fold); an old screen
 *  never reads it; a reader treats an absent or torn file as the empty
 *  map. */
export interface SessionProgressV1 {
  schema: 1
  sessionId: string
  atMs: number
  /** Keyed by the PARENT tool-use id. */
  tools: Record<string, SessionProgressEntryV1>
}

// ── paths ───────────────────────────────────────────────────────────────────

function safeName(sessionId: string): string {
  return sessionId.replace(/[^A-Za-z0-9._-]/g, '_')
}

export function sessionFactsDir(dir: string = daemonDir()): string {
  return join(dir, 'session-facts')
}

export function sessionAsksDir(dir: string = daemonDir()): string {
  return join(dir, 'session-asks')
}

export function sessionFactsPath(sessionId: string, dir?: string): string {
  return join(sessionFactsDir(dir), `${safeName(sessionId)}.json`)
}

export function sessionAsksPath(sessionId: string, dir?: string): string {
  return join(sessionAsksDir(dir), `${safeName(sessionId)}.json`)
}

export function sessionTailDir(dir: string = daemonDir()): string {
  return join(dir, 'session-tail')
}

export function sessionTailPath(sessionId: string, dir?: string): string {
  return join(sessionTailDir(dir), `${safeName(sessionId)}.json`)
}

export function sessionProgressDir(dir: string = daemonDir()): string {
  return join(dir, 'session-progress')
}

export function sessionProgressPath(sessionId: string, dir?: string): string {
  return join(sessionProgressDir(dir), `${safeName(sessionId)}.json`)
}

// ── reads (the screen) ──────────────────────────────────────────────────────

function readJson<T>(path: string, accept: (raw: unknown) => raw is T): T | null {
  try {
    const raw = JSON.parse(readFileSync(path, 'utf8')) as unknown
    return accept(raw) ? raw : null
  } catch {
    return null
  }
}

function isFacts(raw: unknown): raw is SessionFactsV1 {
  const r = raw as Partial<SessionFactsV1> | null
  return (
    !!r &&
    typeof r === 'object' &&
    r.schema === 1 &&
    typeof r.sessionId === 'string' &&
    !!r.model &&
    typeof r.model.effective === 'string' &&
    !!r.usage &&
    Array.isArray(r.queue)
  )
}

function isAsks(raw: unknown): raw is SessionAsksV1 {
  const r = raw as Partial<SessionAsksV1> | null
  return !!r && typeof r === 'object' && r.schema === 1 && typeof r.sessionId === 'string' && Array.isArray(r.asks)
}

export function readSessionFacts(sessionId: string, dir?: string): SessionFactsV1 | null {
  return readJson(sessionFactsPath(sessionId, dir), isFacts)
}

export function readSessionAsks(sessionId: string, dir?: string): SessionAsksV1 | null {
  return readJson(sessionAsksPath(sessionId, dir), isAsks)
}

function isTail(raw: unknown): raw is SessionTailV1 {
  const r = raw as Partial<SessionTailV1> | null
  return !!r && typeof r === 'object' && r.schema === 1 && typeof r.sessionId === 'string' && typeof r.atMs === 'number' && (r.text === null || typeof r.text === 'string')
}

export function readSessionTail(sessionId: string, dir?: string): SessionTailV1 | null {
  return readJson(sessionTailPath(sessionId, dir), isTail)
}

function isProgress(raw: unknown): raw is SessionProgressV1 {
  const r = raw as Partial<SessionProgressV1> | null
  return (
    !!r &&
    typeof r === 'object' &&
    r.schema === 1 &&
    typeof r.sessionId === 'string' &&
    typeof r.atMs === 'number' &&
    !!r.tools &&
    typeof r.tools === 'object' &&
    !Array.isArray(r.tools)
  )
}

export function readSessionProgress(sessionId: string, dir?: string): SessionProgressV1 | null {
  return readJson(sessionProgressPath(sessionId, dir), isProgress)
}

// ── writes (the daemon) ─────────────────────────────────────────────────────

// The facts and the asks publish through the durable-state authority's one
// publication door (fileStore.publishAtomic — exclusive temp, fsync before
// rename, dir fsync), never a private write route. Publications of the same
// file chain in order, so a burst lands newest-last on disk; a failed
// publication is logged by the primitive and the next one proceeds.
const publishChains = new Map<string, Promise<void>>()
function publishOrdered(path: string, bytes: string): void {
  const prev = publishChains.get(path) ?? Promise.resolve()
  const next = prev.then(() => publishAtomic(path, bytes)).catch(() => {})
  publishChains.set(path, next)
  void next.then(() => {
    if (publishChains.get(path) === next) publishChains.delete(path)
  })
}

export function publishSessionFacts(facts: SessionFactsV1, dir?: string): void {
  mkdirSync(sessionFactsDir(dir), { recursive: true })
  publishOrdered(sessionFactsPath(facts.sessionId, dir), `${JSON.stringify(facts)}\n`)
}

export function publishSessionAsks(asks: SessionAsksV1, dir?: string): void {
  mkdirSync(sessionAsksDir(dir), { recursive: true })
  publishOrdered(sessionAsksPath(asks.sessionId, dir), `${JSON.stringify(asks)}\n`)
}

/** The tail republishes at delta cadence: an atomic rename (a reader never
 *  sees a torn file) without the durable fsync — the tail is a transient
 *  live feed, never durable state (the transcript is the durable truth), so
 *  it takes no write route of the durability estate: plain temp + rename. */
export function publishSessionTail(tail: SessionTailV1, dir?: string): void {
  const dest = sessionTailPath(tail.sessionId, dir)
  mkdirSync(sessionTailDir(dir), { recursive: true })
  const tmp = `${dest}.${process.pid}.tmp`
  writeFileSync(tmp, `${JSON.stringify(tail)}\n`)
  renameSync(tmp, dest)
}

/** The progress projection takes the tail's exact write discipline: a
 *  transient live feed — plain temp + rename, no durable fsync. */
export function publishSessionProgress(progress: SessionProgressV1, dir?: string): void {
  const dest = sessionProgressPath(progress.sessionId, dir)
  mkdirSync(sessionProgressDir(dir), { recursive: true })
  const tmp = `${dest}.${process.pid}.tmp`
  writeFileSync(tmp, `${JSON.stringify(progress)}\n`)
  renameSync(tmp, dest)
}

/** A daemon boot starts with no parked ask and no live child (the parent
 *  watch took the children with the old daemon): the projections of that
 *  life are stale by construction and go. */
export function resetSeatProjections(dir?: string): void {
  for (const d of [sessionFactsDir(dir), sessionAsksDir(dir), sessionTailDir(dir), sessionProgressDir(dir)]) {
    try {
      for (const f of readdirSync(d)) rmSync(join(d, f), { force: true })
    } catch {
      /* nothing published yet */
    }
  }
}

/** A settled session's projections retire with its record. */
export function retireSeatProjections(sessionId: string, dir?: string): void {
  for (const p of [sessionFactsPath(sessionId, dir), sessionAsksPath(sessionId, dir), sessionTailPath(sessionId, dir), sessionProgressPath(sessionId, dir)]) {
    rmSync(p, { force: true })
  }
}
