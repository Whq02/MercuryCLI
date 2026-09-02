// ============================================================================
//  daemon/sessionSeat — the daemon-hosted session's SEAT doors: what the
//  focused chat needs from a session the daemon hosts, answered by the
//  session's own process and settled by the daemon.
//
//  Every session is a full chat; a hopped-into session gets the whole face.
//  The face's doors that the window lacked are built here:
//    · the FACTS — the child answers a `session_facts` control request from
//      ITS ledgers (model, usage, identity, skills, MCP, permission mode,
//      workspace, its own queue); the daemon stamps the answer with its own
//      truth (a parked model switch) and publishes the projection the
//      screen watches. Asked at spawn, on the child's init frame, after
//      every assistant and result frame, after every verb applied here;
//    · the MODEL-SWITCH verb — idle: the child's own `set_model` now, the
//      record's modelKey (the durable truth respawns read) and the roster's
//      spec patched quietly (no bounce); busy: parked on the record and
//      applied at the roster's idle edge — the daemon is the settlement
//      owner for the sessions it hosts, the way the in-process settlement
//      owner parks a mid-turn pick;
//    · the PERMISSION-MODE verb (the child's `set_permission_mode`);
//      (the queue-edit verbs died with the operator-facing holding pen —
//      the steer-removal ruling; the facts still carry the child's queue
//      as engine bookkeeping, read by nothing on the cockpit);
//    · the ask-cancel retirement: a child that abandons a parked ask (its
//      interrupt) says so with control_cancel_request; the ask retires and
//      the NEEDS YOU row withdraws instead of haunting the rail;
//    · the LIVE TAIL — the runner streams its reply's text deltas
//      (stream_event frames); the seat republishes the text block in flight
//      as the session's tail projection at delta cadence, null between
//      blocks, so the focused chat paints the reply as it arrives;
//    · the LIVE TOOL PROGRESS (LIVEPAINT) — the runner's source-coalesced
//      `ephemeral_tail` tool_progress frames fold into a per-parent map the
//      seat republishes as the session-progress projection; the turn's
//      result frame clears it (the transcript's full output is the
//      settle-time truth — the projection is transient by design).
//  Fail-soft throughout: a torn frame or a dead channel never disturbs the
//  drain; every verb answers a typed outcome.
// ============================================================================
import { logForDebugging } from '../utils/debug.js'
import {
  publishSessionFacts,
  publishSessionProgress,
  publishSessionTail,
  type SessionFactsAnswerV1,
  type SessionFactsV1,
  type SessionProgressEntryV1,
} from '../services/engine-connector/seatProjections.js'
import { workRowRuns } from '../services/engine-connector/workCounts.js'
import { EFFORT_LEVELS, normalizeEffortLevelString } from '../utils/effort.js'
import { readSessionWorkers, updateConcourseWorkers, type ConcourseWorkerRecordV1 } from './concourseSupervisor.js'
import { resolveSessionKitOnRecord, validateSessionKit, type SessionKitEditV1 } from './sessionKit.js'
import { applyConcourseScheduleOp, saturnFactsOf, SATURN_EDIT_BURST_CAP } from './saturn.js'
import { deriveScheduleAccountForModel, readLiveAccountFacts, scheduleAccountVerdict } from './saturnAccount.js'
import { applyConcourseKitOp } from './sessionKitOp.js'
import { onWorkerControlCancel } from './permissionAsks.js'
import type { SessionRewindMode, SessionRewindOutcomeV1 } from './protocol.js'

/** The roster as the seat doors see it. */
export interface SeatRosterPort {
  control(short: string, frame: string): boolean
  list(): ReadonlyArray<{ short: string; outcome?: string; busy?: boolean; turnActive?: boolean }>
  /** Patch a seat's spec model WITHOUT a bounce — the next respawn keeps it. */
  patchSeatModel(short: string, model: string): boolean
  /** The effort sibling of patchSeatModel (the set-effort verb's spec half). */
  patchSeatEffort(short: string, effort: string): boolean
}

export const SESSION_FACTS_REQUEST_PREFIX = 'mercury-session-facts-'
const SEAT_VERB_REQUEST_PREFIX = 'mercury-seat-'
/** The /rewind verb's request ids ride the seat-verb prefix (the existing
 *  control_response arm sees them) with their own marker, so the waiter
 *  lookup never touches a set-model/set-effort settle. */
const SEAT_REWIND_REQUEST_PREFIX = `${SEAT_VERB_REQUEST_PREFIX}rewind-`
/** How long the daemon waits for the runner's own rewind answer: a code
 *  restore is local IO through the journaled commit walk, a conversation
 *  rewind one appended row plus a flush — a runner silent past this is
 *  answered 'no-answer', typed, never a hung cockpit. */
export const REWIND_ANSWER_DEADLINE_MS = 30_000
const FACTS_DEBOUNCE_MS = 250

interface SeatState {
  short: string
  lastAnswer: SessionFactsAnswerV1 | null
  requestSeq: number
  debounce: ReturnType<typeof setTimeout> | null
  /** Armed while the child's answer carries LIVE work: a background
   *  workflow's agents move without any main-channel frame, so the facts
   *  re-ask self-sustains at task cadence until the roster settles. */
  workPoll: ReturnType<typeof setTimeout> | null
  /** The last busy bit published (kept when a publish has no roster on hand). */
  lastBusy: boolean
  /** The session id the tail publishes under (resolved once per seat life). */
  sessionId: string | null
  /** The text block in flight (null between blocks) and its publish throttle. */
  tail: string | null
  /** The provider message id the tail text belongs to (the screen's dedup
   *  identity — SessionTailV1.messageId). Captured at message_start / the
   *  settle-class assistant frame; STANDS through the block's clear so the
   *  screen can retire the ghost against the landed row; zeroes at the
   *  turn's result and on respawn. */
  tailMessageId: string | null
  tailTimer: ReturnType<typeof setTimeout> | null
  tailDirty: boolean
  /** True once a text delta streamed this turn — a settle-class assistant
   *  frame (no deltas) publishes its text through the tail instead, so the
   *  reply paints at projection cadence rather than file-pickup latency. */
  streamedThisTurn: boolean
  /** Cumulative characters the in-flight turn has streamed (the live token
   *  counter's source — SessionTailV1.turnChars). Grows per text delta and
   *  per settle-class reply, survives block boundaries, zeroes at the
   *  turn's result and on respawn. */
  turnChars: number
  /** The runner's live state word (SessionTailV1.stateWord): 'compacting'
   *  while the fold call runs — set by the child's system/status frame,
   *  cleared by its null stamp, the turn's result and a respawn. */
  stateWord: 'compacting' | null
  /** The running tools' latest ephemeral lines (LIVEPAINT), keyed by the
   *  PARENT tool-use id, and the publish throttle twin of the tail's. */
  progress: Map<string, SessionProgressEntryV1>
  progressTimer: ReturnType<typeof setTimeout> | null
  progressDirty: boolean
  /** The daemon's own settlement receipt for the last PARKED model switch
   *  the idle edge applied (FN-016 R15) — published on every facts write so
   *  the screen's settle-note edge drives off the daemon's word, never off
   *  the child's lagging answer. Null until a parked switch settles. */
  lastModelSettle: { from: string; to: string; atMs: number } | null
  /** LIVENESS (SessionTailV1.lastEventAtMs): when the runner last spoke —
   *  the wall clock of its last frame of ANY kind (a stream event, a tool
   *  progress tick, an assistant, user or result frame, a status word),
   *  never the seat's own facts probe traffic. Null until the child's first
   *  frame this seat-life; a respawn zeroes it. */
  lastEventAtMs: number | null
  /** LIVENESS (SessionTailV1.streamBlock): the content block the runner is
   *  streaming right now — thinking, prose or a tool call — null between
   *  blocks and off the stream. */
  streamBlock: 'thinking' | 'text' | 'tool_use' | null
  /** LIVENESS (SessionTailV1.blockSinceMs): when the current block began. */
  blockSinceMs: number | null
  /** The liveness publish throttle: a stamp without a text change rides a
   *  one-second cadence (the status row's own resolution); a block flip
   *  and the first event of a message publish at once. */
  livenessTimer: ReturnType<typeof setTimeout> | null
  livenessDirty: boolean
}

const seats = new Map<string, SeatState>()

function seatOf(short: string): SeatState {
  let s = seats.get(short)
  if (!s) {
    s = { short, lastAnswer: null, requestSeq: 0, debounce: null, workPoll: null, lastBusy: false, sessionId: null, tail: null, tailMessageId: null, tailTimer: null, tailDirty: false, streamedThisTurn: false, turnChars: 0, stateWord: null, progress: new Map(), progressTimer: null, progressDirty: false, lastModelSettle: null, lastEventAtMs: null, streamBlock: null, blockSinceMs: null, livenessTimer: null, livenessDirty: false }
    seats.set(short, s)
  }
  return s
}

/** The tail's publish cadence: a publish per delta would be a rename per
 *  token; one every 40 ms (plus the trailing one) reads continuous. */
const TAIL_PUBLISH_MS = 40

function publishTailNow(seat: SeatState, dir?: string): void {
  if (seat.sessionId === null) return
  seat.tailDirty = false
  // Every tail publish carries the liveness stamp, so a pending
  // liveness-only publish has nothing left to say.
  seat.livenessDirty = false
  try {
    publishSessionTail(
      {
        schema: 1,
        sessionId: seat.sessionId,
        atMs: Date.now(),
        text: seat.tail,
        ...(seat.turnChars > 0 ? { turnChars: seat.turnChars } : {}),
        ...(seat.tailMessageId !== null ? { messageId: seat.tailMessageId } : {}),
        ...(seat.stateWord !== null ? { stateWord: seat.stateWord } : {}),
        ...(seat.lastEventAtMs !== null ? { lastEventAtMs: seat.lastEventAtMs } : {}),
        ...(seat.streamBlock !== null ? { streamBlock: seat.streamBlock } : {}),
        ...(seat.blockSinceMs !== null ? { blockSinceMs: seat.blockSinceMs } : {}),
      },
      dir,
    )
  } catch (e) {
    logForDebugging(`[daemon] session tail publish failed for ${seat.short}: ${e}`)
  }
}

/** Set the seat's tail: a clear publishes at once; text throttles to the
 *  cadence with a trailing publish so the last delta always lands. */
function setSeatTail(seat: SeatState, text: string | null, dir?: string): void {
  seat.tail = text
  if (text === null) {
    if (seat.tailTimer !== null) {
      clearTimeout(seat.tailTimer)
      seat.tailTimer = null
    }
    publishTailNow(seat, dir)
    return
  }
  seat.tailDirty = true
  if (seat.tailTimer !== null) return
  publishTailNow(seat, dir)
  const t = setTimeout(() => {
    seat.tailTimer = null
    if (seat.tailDirty) publishTailNow(seat, dir)
  }, TAIL_PUBLISH_MS)
  t.unref?.()
  seat.tailTimer = t
}

/** The liveness stamp's publish cadence when no text is flowing: a
 *  thinking stretch's deltas, pings and progress ticks bump the stamp many
 *  times a second; the status row reads seconds. */
const LIVENESS_PUBLISH_MS = 1000

/** LIVENESS: the runner spoke. Stamp the clock; `now` publishes at once (a
 *  block flip, the first event of a message, a status word), a bare bump
 *  rides the one-second cadence — and any tail publish in between carries
 *  the stamp and retires the pending one. */
function noteSeatEvent(seat: SeatState, dir: string | undefined, opts?: { now?: boolean }): void {
  seat.lastEventAtMs = Date.now()
  if (opts?.now === true) {
    if (seat.livenessTimer !== null) {
      clearTimeout(seat.livenessTimer)
      seat.livenessTimer = null
    }
    publishTailNow(seat, dir)
    return
  }
  seat.livenessDirty = true
  if (seat.livenessTimer !== null) return
  const t = setTimeout(() => {
    seat.livenessTimer = null
    if (seat.livenessDirty) publishTailNow(seat, dir)
  }, LIVENESS_PUBLISH_MS)
  t.unref?.()
  seat.livenessTimer = t
}

/** The block kinds the liveness owner distinguishes: the model thinking,
 *  writing prose, or writing a tool call (server-side tool calls read as a
 *  tool call too). Anything else is no block of ours. */
function streamBlockOf(type: string | undefined): SeatState['streamBlock'] {
  if (type === 'thinking' || type === 'redacted_thinking') return 'thinking'
  if (type === 'text') return 'text'
  if (type === 'tool_use' || type === 'server_tool_use' || type === 'mcp_tool_use') return 'tool_use'
  return null
}

/** A runner's stream_event frame: the text block in flight becomes the
 *  session's tail; the block's end (or the message's) clears it. Returns
 *  whether the line was genuinely this frame kind — a frame that merely
 *  MENTIONS the token (a tool-input value, a structured-output key
 *  serializes with REAL quotes) must fall through to its own arm. */
function onSeatStreamEvent(seat: SeatState, line: string, dir?: string): boolean {
  let frame: { type?: string; event?: { type?: string; content_block?: { type?: string }; delta?: { type?: string; text?: string }; message?: { id?: string } } }
  try {
    frame = JSON.parse(line) as typeof frame
  } catch {
    return false
  }
  if (frame.type !== 'stream_event' || !frame.event) return false
  const ev = frame.event
  // LIVENESS: every stream event is the runner speaking — a thinking delta
  // with no text, a signature delta, a ping, a block boundary all count.
  // The boundary arms below publish at once themselves (a tail publish
  // carries the stamp); a delta rides the cadence.
  noteSeatEvent(seat, dir)
  if (ev.type === 'content_block_start') {
    seat.streamBlock = streamBlockOf(ev.content_block?.type)
    seat.blockSinceMs = seat.streamBlock === null ? null : Date.now()
    publishTailNow(seat, dir)
    return true
  }
  if (ev.type === 'message_start') {
    // A NEW message begins: a still-held tail (a settle-class hold, or an
    // aborted stream's remnant) belongs to a message that ENDED — its row
    // owns the text now. Clear it first, under the OLD identity (the
    // ghost's), so the screen retires it against the landed row; the
    // appender below must never concatenate a new stream onto held text.
    if (seat.tail !== null) setSeatTail(seat, null, dir)
    // The dedup identity: the streamed text about to arrive belongs to this
    // provider message — the same id its settled transcript row will carry.
    // Assign-or-null, never inherit: a message without an id must not wear
    // the previous message's identity.
    const id = ev.message?.id
    seat.tailMessageId = typeof id === 'string' && id !== '' ? id : null
    // A new message: no block is open yet; the stamp publishes at once so
    // the row's silence clock restarts on the first event after dispatch.
    seat.streamBlock = null
    seat.blockSinceMs = null
    publishTailNow(seat, dir)
  } else if (ev.type === 'content_block_delta' && ev.delta?.type === 'text_delta' && typeof ev.delta.text === 'string') {
    seat.streamedThisTurn = true
    seat.turnChars += ev.delta.text.length
    setSeatTail(seat, (seat.tail ?? '') + ev.delta.text, dir)
  } else if (ev.type === 'content_block_stop' || ev.type === 'message_stop') {
    // LIVENESS: the block kind STANDS through a block boundary — the message
    // is still open and the next block begins within the same breath, so
    // the phase does not flicker back to the dispatch wait between two
    // blocks (each flicker re-rendered the screen's live view twice). The
    // message's end clears it: what comes next is the fold's to say.
    if (ev.type === 'message_stop') {
      seat.streamBlock = null
      seat.blockSinceMs = null
    }
    // The id deliberately STANDS through this clear: it is the ghost's
    // identity — the screen retires the held text against the landed row.
    if (seat.tail !== null) setSeatTail(seat, null, dir)
    else publishTailNow(seat, dir)
  }
  return true
}

/** The progress projection's publish cadence: the runner already coalesces
 *  to one frame per 250ms beat per tool, so this throttle only batches
 *  CONCURRENT tools' frames into one rename. */
const PROGRESS_PUBLISH_MS = 100

function publishProgressNow(seat: SeatState, dir?: string): void {
  if (seat.sessionId === null) return
  seat.progressDirty = false
  try {
    publishSessionProgress(
      { schema: 1, sessionId: seat.sessionId, atMs: Date.now(), tools: Object.fromEntries(seat.progress) },
      dir,
    )
  } catch (e) {
    logForDebugging(`[daemon] session progress publish failed for ${seat.short}: ${e}`)
  }
}

function scheduleProgressPublish(seat: SeatState, dir?: string): void {
  seat.progressDirty = true
  if (seat.progressTimer !== null) return
  publishProgressNow(seat, dir)
  const t = setTimeout(() => {
    seat.progressTimer = null
    if (seat.progressDirty) publishProgressNow(seat, dir)
  }, PROGRESS_PUBLISH_MS)
  t.unref?.()
  seat.progressTimer = t
}

/** CLEAR-ON-SETTLE (and on respawn): the turn's running-tool lines retire
 *  with the turn — the transcript's full output is the settle-time truth
 *  (the projection is transient by design; see SessionProgressV1). An
 *  already-empty map publishes nothing. */
function clearSeatProgress(seat: SeatState, dir?: string): void {
  if (seat.progress.size === 0) return
  seat.progress.clear()
  if (seat.progressTimer !== null) {
    clearTimeout(seat.progressTimer)
    seat.progressTimer = null
  }
  publishProgressNow(seat, dir)
}

/** A runner's `ephemeral_tail` tool_progress frame (LIVEPAINT Layer 2): the
 *  latest line folds into the seat's per-parent map and republishes at beat
 *  cadence. A malformed or foreign frame is skipped whole — an OLD runner
 *  never sends these at all (the screen then paints no tail and the glyph
 *  pulse still runs from the records fold: the mixed-version law). */
function onSeatEphemeralProgress(seat: SeatState, line: string, dir?: string): boolean {
  let frame: {
    type?: string
    tool_use_id?: string
    parent_tool_use_id?: string | null
    progress?: {
      kind?: string
      data_type?: string
      seq?: number
      latest_line?: string
      elapsed_time_seconds?: number
      total_lines?: number
      total_bytes?: number
      mcp_progress?: number
      mcp_total?: number
      budget_ms?: number
    }
  }
  try {
    frame = JSON.parse(line) as typeof frame
  } catch {
    return false
  }
  // Ownership is the frame KIND — a mention-shaped line falls through.
  if (frame.type !== 'tool_progress') return false
  // LIVENESS: a running tool's tick is the runner speaking.
  noteSeatEvent(seat, dir)
  const payload = frame.progress
  if (
    payload?.kind !== 'ephemeral_tail' ||
    typeof frame.parent_tool_use_id !== 'string' ||
    typeof frame.tool_use_id !== 'string' ||
    typeof payload.data_type !== 'string' ||
    typeof payload.seq !== 'number'
  ) {
    return true
  }
  const prior = seat.progress.get(frame.parent_tool_use_id)
  if (prior !== undefined && payload.seq <= prior.seq) return true
  seat.progress.set(frame.parent_tool_use_id, {
    toolUseID: frame.tool_use_id,
    dataType: payload.data_type,
    seq: payload.seq,
    ...(typeof payload.latest_line === 'string' ? { latestLine: payload.latest_line } : {}),
    ...(typeof payload.elapsed_time_seconds === 'number' ? { elapsedTimeSeconds: payload.elapsed_time_seconds } : {}),
    ...(typeof payload.total_lines === 'number' ? { totalLines: payload.total_lines } : {}),
    ...(typeof payload.total_bytes === 'number' ? { totalBytes: payload.total_bytes } : {}),
    ...(typeof payload.mcp_progress === 'number' ? { mcpProgress: payload.mcp_progress } : {}),
    ...(typeof payload.mcp_total === 'number' ? { mcpTotal: payload.mcp_total } : {}),
    ...(typeof payload.budget_ms === 'number' ? { budgetMs: payload.budget_ms } : {}),
  })
  scheduleProgressPublish(seat, dir)
  return true
}

/** A SETTLE-class reply (an assistant frame whose turn streamed no deltas)
 *  publishes its text through the tail the moment the frame lands: the
 *  focused chat paints it at projection cadence instead of waiting for the
 *  transcript file pickup — the reveal law for streams, extended to settle
 *  messages. The screen's ghost release hides the tail once the row itself
 *  paints (any assistant row of the current turn, both sides trimmed), and
 *  the turn's result frame clears it here. */
function onSeatAssistantFrame(seat: SeatState, line: string, dir?: string): void {
  if (seat.streamedThisTurn) return
  let frame: { type?: string; message?: { id?: string; content?: Array<{ type?: string; text?: string }> } }
  try {
    frame = JSON.parse(line) as typeof frame
  } catch {
    return
  }
  if (frame.type !== 'assistant' || !Array.isArray(frame.message?.content)) return
  const text = frame.message.content
    .filter(block => block.type === 'text' && typeof block.text === 'string')
    .map(block => block.text)
    .join('')
  if (text !== '') {
    // The held text's dedup identity: the frame's own provider message id —
    // the screen retires the hold the instant the row bearing it paints.
    // Assign-or-null, never inherit a previous message's identity.
    const id = frame.message.id
    seat.tailMessageId = typeof id === 'string' && id !== '' ? id : null
    seat.turnChars += text.length
    setSeatTail(seat, text, dir)
  }
}

function liveRecordByShort(short: string, dir?: string): ConcourseWorkerRecordV1 | undefined {
  const rec = readSessionWorkers(dir)[short]
  return rec && rec.endedAt === undefined ? rec : undefined
}

function liveRecordBySession(sessionId: string, dir?: string): ConcourseWorkerRecordV1 | undefined {
  return Object.values(readSessionWorkers(dir)).find(r => r.sessionId === sessionId && r.endedAt === undefined)
}

/** A seat with a turn OPEN: the raw turn fact first, the capped busy
 *  decision as the fallback for a seat that never observed a turn boundary
 *  (the delivery clock). The cap alone said "not busy" for a turn past
 *  twenty minutes while it still ran, so /model applied mid-flight and the
 *  runner pushed its rows into a conversation the turn was reading
 *  (FN-015 rank 69). Exported for the pin. */
export function seatTurnOpen(row: { outcome?: string; busy?: boolean; turnActive?: boolean } | undefined): boolean {
  if (row === undefined || row.outcome) return false
  if (row.turnActive === true) return true
  return row.busy === true
}

function seatBusy(short: string, roster: SeatRosterPort): boolean {
  return seatTurnOpen(roster.list().find(j => j.short === short))
}

// ── the facts projection ────────────────────────────────────────────────────

const ZERO_USAGE: SessionFactsAnswerV1['usage'] = {
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

/** The projection before the child's first answer: the record's own facts
 *  (model, workspace, the spawn permission posture) over honest zeros. */
function skeletonAnswer(rec: ConcourseWorkerRecordV1): SessionFactsAnswerV1 {
  const cwd = rec.worktreePath ?? rec.workspaceId
  return {
    model: { effective: rec.modelKey, setting: rec.modelKey },
    usage: ZERO_USAGE,
    identity: { firstPartyApi: false, consoleBilling: false, claudeAiBilling: false, accountEmail: null },
    skills: [],
    mcp: [],
    permissionMode: 'flow',
    workspace: { cwd, originalCwd: cwd, projectRoot: rec.workspaceId, instructionRoots: [] },
    queue: [],
  }
}

/** Compose the record's truth over the child's latest answer and publish. */
export function publishSeatFacts(short: string, dir?: string, roster?: SeatRosterPort): void {
  const rec = liveRecordByShort(short, dir)
  if (!rec) return
  const seat = seatOf(short)
  const answer = seat.lastAnswer ?? skeletonAnswer(rec)
  const facts: SessionFactsV1 = {
    schema: 1,
    sessionId: rec.sessionId,
    atMs: Date.now(),
    ...answer,
    // The record is the durable model truth; the child's answer names the
    // model its next call runs, and they agree once a switch applied.
    model: {
      effective: seat.lastAnswer?.model.effective ?? rec.modelKey,
      setting: seat.lastAnswer?.model.setting ?? rec.modelKey,
    },
    pendingModel: rec.pendingModelKey ?? null,
    // The settle receipt rides EVERY publish once stamped (FN-016 R15) —
    // the screen's edge fires on the stamp's atMs moving, so a publish the
    // watcher missed can never lose the settle note.
    ...(seat.lastModelSettle !== null ? { modelSettled: seat.lastModelSettle } : {}),
    busy: roster !== undefined ? seatBusy(short, roster) : seat.lastBusy,
    // SATURN: the record's schedule roster + held count, additive and
    // absent-preserving (saturnFactsOf answers {} for a schedule-less
    // record — absent ≠ empty rides the wire).
    ...saturnFactsOf(rec, Date.now()),
  }
  seat.lastBusy = facts.busy
  try {
    publishSessionFacts(facts, dir)
  } catch (e) {
    logForDebugging(`[daemon] session facts publish failed for ${short}: ${e}`)
  }
}

/** Ask the child for its facts (debounced; a burst of assistant frames
 *  costs one request). */
export function requestSessionFacts(
  short: string,
  roster: SeatRosterPort,
  opts?: { immediate?: boolean },
): void {
  const seat = seatOf(short)
  const fire = (): void => {
    seat.debounce = null
    seat.requestSeq += 1
    const requestId = `${SESSION_FACTS_REQUEST_PREFIX}${short}-${seat.requestSeq}`
    roster.control(
      short,
      JSON.stringify({ type: 'control_request', request_id: requestId, request: { subtype: 'session_facts' } }),
    )
  }
  if (opts?.immediate) {
    if (seat.debounce !== null) {
      clearTimeout(seat.debounce)
      seat.debounce = null
    }
    fire()
    return
  }
  if (seat.debounce !== null) return
  const t = setTimeout(fire, FACTS_DEBOUNCE_MS)
  t.unref?.()
  seat.debounce = t
}

/** The work-poll cadence — the task framework's own POLL_INTERVAL_MS twin
 *  (declared locally: the daemon takes no task-module import). */
const WORK_POLL_MS = 1000

/**
 * Keep the facts fresh while the session's answer carries LIVE work. A
 * background workflow or agent progresses without emitting a single
 * main-channel frame once its launching turn settled, so no frame-driven
 * re-ask would fire; this self-sustaining 1 s re-ask runs exactly while a
 * roster row is running/pending ('paused' spins nothing) and disarms the
 * moment the roster settles.
 */
function armWorkPoll(short: string, roster: SeatRosterPort): void {
  const seat = seats.get(short)
  if (seat === undefined) return
  // The ONE counting law decides "live" here too (workRowRuns): the poll
  // spins exactly for the rows the chip and the boards count as running.
  const live = (seat.lastAnswer?.work ?? []).some(workRowRuns)
  if (!live) {
    if (seat.workPoll !== null) {
      clearTimeout(seat.workPoll)
      seat.workPoll = null
    }
    return
  }
  if (seat.workPoll !== null) return
  const t = setTimeout(() => {
    seat.workPoll = null
    // A settled worker's seat left the map — nothing to ask.
    if (seats.get(short) !== undefined) requestSessionFacts(short, roster, { immediate: true })
  }, WORK_POLL_MS)
  t.unref?.()
  seat.workPoll = t
}

/**
 * THE COMPLETION STAMP (KIT-RUNNER): a facts answer carrying a RESOLVED kit
 * completes a record whose stamp is still UNRESOLVED — the only road from
 * provisional to resolved, and it runs once (the pen refuses a resolved or
 * pre-kit record; a still-unresolved answer stamps nothing). The answer's
 * kit is narrowed by the wire's own validator first — a malformed report
 * never touches the record. Fail-soft: a refused stamp is a debug line,
 * never a drain disturbance.
 */
/** The seat deps SATURN's facts-borne edits apply with — the SAME resolvers
 *  the wire arm wires (one derivation, one verdict, everywhere). */
function seatScheduleDeps(): import('./saturn.js').ScheduleOpDepsV1 {
  return {
    deriveAccount: deriveScheduleAccountForModel,
    preflight: (account, nextFireMs) =>
      scheduleAccountVerdict({ account, nextFireMs, nowMs: Date.now(), live: readLiveAccountFacts(account) }),
  }
}

/** SATURN's roster push (subtype 'schedule_roster', the kit_edit family):
 *  the record's post-apply roster rides down so the child's list/remove
 *  tools speak real ids. Best-effort — a dead channel repaints at respawn. */
export function pushScheduleRoster(short: string, roster: SeatRosterPort, dir?: string): void {
  const rec = liveRecordByShort(short, dir)
  if (!rec) return
  roster.control(
    short,
    JSON.stringify({
      type: 'control_request',
      request_id: verbRequestId(short, 'schedule-roster'),
      request: { subtype: 'schedule_roster', schedules: saturnFactsOf(rec, Date.now()).schedules ?? [] },
    }),
  )
}

/**
 * SATURN's facts-borne apply arm (the lead's tool-road ruling — the
 * R4/kit-completion beat, reversed): the answer's pendingScheduleEdits
 * apply through the record's ONE writer as 'model:<sessionId>' (the same
 * derivation + preflight the wire arm wires), then the post-apply roster
 * pushes down and the facts re-ask settles the projection. Each edit rode
 * exactly one answer (the child's send-and-clear), so adds never double.
 * Bounded: the bridge refuses past the SAME cap at the source (an edit it
 * accepted is never dropped here); this clip is the belt for a foreign
 * child, and it says so in the log when it ever bites.
 */
function applySessionScheduleAnswer(short: string, answer: SessionFactsAnswerV1, roster: SeatRosterPort, dir?: string): void {
  const edits = (answer as { pendingScheduleEdits?: unknown }).pendingScheduleEdits
  if (!Array.isArray(edits) || edits.length === 0) return
  const rec = liveRecordByShort(short, dir)
  if (!rec) return
  const by = `model:${rec.sessionId}`
  const bounded = edits.slice(0, SATURN_EDIT_BURST_CAP)
  if (edits.length > bounded.length) {
    logForDebugging(`[daemon] schedule edits from ${short} clipped to ${bounded.length} (${edits.length} sent)`)
  }
  for (const raw of bounded) {
    const op = (raw as { op?: unknown } | null)?.op
    if (op !== 'add' && op !== 'remove' && op !== 'pause' && op !== 'resume') {
      logForDebugging(`[daemon] schedule edit from ${short} skipped — unknown op ${String(op)}`)
      continue
    }
    const outcome = applyConcourseScheduleOp(rec.sessionId, raw as import('./saturn.js').ScheduleOpRequestV1, by, seatScheduleDeps(), dir)
    logForDebugging(`[daemon] schedule edit (${op}) from ${short}: ${outcome.outcome}${outcome.detail !== undefined ? ` — ${outcome.detail}` : ''}`)
  }
  pushScheduleRoster(short, roster, dir)
  requestSessionFacts(short, roster, { immediate: true })
}

function maybeResolveSessionKit(short: string, answer: SessionFactsAnswerV1, dir?: string): void {
  const reported = answer.kit
  if (reported === undefined) return
  const rec = liveRecordByShort(short, dir)
  if (!rec || rec.kit === undefined || rec.kit.resolved !== false) return
  const validated = validateSessionKit(reported)
  if (!validated.ok || validated.kit.resolved === false) {
    if (!validated.ok) logForDebugging(`[daemon] kit completion refused for ${short} — ${validated.reason}`)
    return
  }
  try {
    updateConcourseWorkers(workers => {
      const w = workers[short]
      if (!w || w.endedAt !== undefined) return
      resolveSessionKitOnRecord(w, validated.kit)
    }, dir)
  } catch (e) {
    logForDebugging(`[daemon] kit completion stamp failed for ${short}: ${e}`)
  }
}

function isFactsAnswer(raw: unknown): raw is SessionFactsAnswerV1 {
  const r = raw as Partial<SessionFactsAnswerV1> | null
  return (
    !!r &&
    typeof r === 'object' &&
    !!r.model &&
    typeof r.model.effective === 'string' &&
    !!r.usage &&
    typeof r.usage.totalCostUSD === 'number' &&
    Array.isArray(r.skills) &&
    Array.isArray(r.mcp) &&
    typeof r.permissionMode === 'string' &&
    !!r.workspace &&
    Array.isArray(r.queue)
  )
}

/**
 * The roster drain's per-line hook for session workers: the child's facts
 * answer lands here; its init frame and every assistant frame ask for a
 * fresh one; a control_cancel_request retires the parked ask it names.
 * Substring tests keep the hot path cheap; torn lines are skipped.
 */
export function onSeatLine(short: string, line: string, roster: SeatRosterPort, dir?: string): void {
  if (line.includes('"stream_event"')) {
    const seat = seatOf(short)
    if (seat.sessionId === null) seat.sessionId = liveRecordByShort(short, dir)?.sessionId ?? null
    if (onSeatStreamEvent(seat, line, dir)) return
    // A frame that merely MENTIONS the token (a tool-input value or a
    // nested key serializes with REAL quotes — the escaped-quote argument
    // covers string CONTENT only) falls through to its own arm.
  }
  if (line.includes('"ephemeral_tail"')) {
    // The kind token is LIVEPAINT's alone; mention-shaped frames still
    // fall through (delivery-verifier E-legs).
    const seat = seatOf(short)
    if (seat.sessionId === null) seat.sessionId = liveRecordByShort(short, dir)?.sessionId ?? null
    if (onSeatEphemeralProgress(seat, line, dir)) return
  }
  if (line.includes('"tool_progress"')) {
    // LIVENESS: any other tool_progress frame (an agent's, a test runner's
    // — no seat arm owns them) is still the runner speaking. Parse
    // decides; a mention-shaped line falls through.
    try {
      if ((JSON.parse(line) as { type?: string }).type === 'tool_progress') {
        const seat = seatOf(short)
        if (seat.sessionId === null) seat.sessionId = liveRecordByShort(short, dir)?.sessionId ?? null
        noteSeatEvent(seat, dir)
        return
      }
    } catch {
      /* torn frame — nobody's */
    }
  }
  if (line.includes('"control_response"') && line.includes(SESSION_FACTS_REQUEST_PREFIX)) {
    try {
      const frame = JSON.parse(line) as {
        type?: string
        response?: { subtype?: string; request_id?: string; response?: unknown }
      }
      const response = frame.response
      if (
        frame.type === 'control_response' &&
        response?.subtype === 'success' &&
        typeof response.request_id === 'string' &&
        response.request_id.startsWith(SESSION_FACTS_REQUEST_PREFIX) &&
        isFactsAnswer(response.response)
      ) {
        seatOf(short).lastAnswer = response.response
        maybeResolveSessionKit(short, response.response, dir)
        applySessionScheduleAnswer(short, response.response, roster, dir)
        publishSeatFacts(short, dir, roster)
        armWorkPoll(short, roster)
      }
    } catch {
      /* torn frame — the next answer repaints */
    }
    return
  }
  if (
    line.includes('"task_started"') ||
    line.includes('"task_progress"') ||
    line.includes('"task_notification"')
  ) {
    // The child narrates its background work (system frames, flushed live
    // even between turns while tasks run): every movement re-asks the facts
    // so the session's work roster follows within the debounce. The bare
    // substring test is sound — inside a JSON string value a double quote
    // is escaped, so `"task_…"` with real quotes only ever appears as the
    // frame's own subtype token.
    requestSessionFacts(short, roster)
    return
  }
  if (line.includes('"control_response"') && line.includes(SEAT_VERB_REQUEST_PREFIX)) {
    if (line.includes(SEAT_REWIND_REQUEST_PREFIX)) {
      // The /rewind verb's answer: the waiter settles with the runner's own
      // receipt (or its typed refusal) BEFORE the facts re-ask below.
      try {
        settleRewindAnswer(JSON.parse(line) as Parameters<typeof settleRewindAnswer>[0])
      } catch {
        /* torn frame — the deadline answers typed */
      }
    }
    // A verb settled in the child (queue edit, permission mode): the facts
    // it changed are re-read at once.
    requestSessionFacts(short, roster, { immediate: true })
    return
  }
  if (line.includes('"control_cancel_request"')) {
    try {
      const frame = JSON.parse(line) as { type?: string; request_id?: string }
      if (frame.type === 'control_cancel_request') {
        if (typeof frame.request_id === 'string') {
          onWorkerControlCancel(frame.request_id, dir)
        }
        return
      }
    } catch {
      /* torn frame — no arm can own it; fall through costs nothing */
    }
  }
  if (line.includes('"init"') && line.includes('"system"')) {
    try {
      const frame = JSON.parse(line) as { type?: string; subtype?: string }
      if (frame.type === 'system') {
        if (frame.subtype === 'init') requestSessionFacts(short, roster, { immediate: true })
        return
      }
    } catch {
      /* torn frame */
    }
  }
  if (line.includes('"subtype":"status"')) {
    // The runner's status word (system/status frames — the compact service
    // stamps 'compacting' at fold start and null at its restore): the seat
    // relays it through the tail projection as the live state word, so the
    // glass can speak the fold's own word instead of the in-flight thinking
    // default. Parse decides — a mention-shaped line (the token inside a
    // string value serializes with escaped quotes, but the belt costs
    // nothing) falls through to its own arm.
    try {
      const frame = JSON.parse(line) as { type?: string; subtype?: string; status?: unknown }
      if (frame.type === 'system' && frame.subtype === 'status') {
        const seat = seatOf(short)
        if (seat.sessionId === null) seat.sessionId = liveRecordByShort(short, dir)?.sessionId ?? null
        const next = frame.status === 'compacting' ? ('compacting' as const) : null
        // LIVENESS: a status word is the runner speaking; a flip publishes
        // the stamp with the word at once.
        noteSeatEvent(seat, dir)
        if (seat.stateWord !== next) {
          seat.stateWord = next
          publishTailNow(seat, dir)
        }
        return
      }
    } catch {
      /* torn frame — the next status repaints */
    }
  }
  if (line.includes('"user"')) {
    // LIVENESS: a user frame on the child's stdout is a tool result (or a
    // fold's replay) landing — the runner speaking. Parse decides (a
    // mention-shaped line falls through to its own arm); nothing else here
    // owns a user frame.
    try {
      if ((JSON.parse(line) as { type?: string }).type === 'user') {
        const seat = seatOf(short)
        if (seat.sessionId === null) seat.sessionId = liveRecordByShort(short, dir)?.sessionId ?? null
        noteSeatEvent(seat, dir)
        return
      }
    } catch {
      /* torn frame — nobody's */
    }
  }
  if (line.includes('"assistant"') || line.includes('"result"')) {
    // TYPE-KEYED, deliberately: the assistant arm returning on a bare
    // substring match let a RESULT frame that merely mentioned
    // "assistant" (a structured-output key, a permission denial's tool
    // input — nested keys and exact values serialize with real quotes)
    // skip the settle beat entirely: turnChars never zeroed, the tail
    // ghost stood, the stream/settle classification leaked into the next
    // turn (delivery-verifier E1). One parse decides which arm owns it.
    let kind: string | undefined
    try {
      kind = (JSON.parse(line) as { type?: string }).type
    } catch {
      return // a torn frame is nobody's; the next line repaints
    }
    if (kind === 'assistant') {
      const seat = seatOf(short)
      if (seat.sessionId === null) seat.sessionId = liveRecordByShort(short, dir)?.sessionId ?? null
      // LIVENESS: the landed message is the runner speaking.
      noteSeatEvent(seat, dir)
      // A settle-class reply rides the tail projection at once (see
      // onSeatAssistantFrame) — the reveal law, extended to settle messages.
      onSeatAssistantFrame(seat, line, dir)
      // Cost and tokens move per API call; the readout follows within the
      // debounce, mid-turn included (the in-process ledger ticks the same way).
      requestSessionFacts(short, roster)
      return
    }
    if (kind === 'result') {
      // The turn's settle: the tail clears (the transcript row owns the
      // text now) and the next turn's stream/settle classification starts
      // fresh.
      const seat = seatOf(short)
      seat.streamedThisTurn = false
      // The live token count retires with the turn (the settled row and
      // the usage facts own the truth now); the clear publish carries 0.
      // The dedup identity retires with it — the next turn starts unnamed.
      // The state word too: a fold that died without its restore stamp must
      // never leave 'compacting' standing over an idle chat.
      seat.turnChars = 0
      seat.tailMessageId = null
      seat.stateWord = null
      // LIVENESS: the result is the runner's last word of the turn; no
      // block stands past it. The stamp itself stays (the connector reads
      // liveness only while a turn is in flight).
      noteSeatEvent(seat, dir)
      seat.streamBlock = null
      seat.blockSinceMs = null
      setSeatTail(seat, null, dir)
      clearSeatProgress(seat, dir)
    }
  }
}

/** The busy→idle edge: a parked model switch applies now; the facts refresh. */
export function onSeatIdle(short: string, roster: SeatRosterPort, dir?: string): void {
  const rec = liveRecordByShort(short, dir)
  if (!rec) return
  // eslint-disable-next-line no-console
  console.error(`[daemon] seat idle edge: ${short}${rec.pendingModelKey !== undefined ? ` — applying the parked model ${rec.pendingModelKey}` : ''}${rec.pendingEffort !== undefined ? ` — applying the parked effort ${rec.pendingEffort}` : ''}`)
  if (rec.pendingModelKey !== undefined) applyModelNow(rec, rec.pendingModelKey, roster, dir, { parkedSettle: true })
  if (rec.pendingEffort !== undefined) applyEffortNow(rec, rec.pendingEffort, roster, dir)
  // The parked kit dials' lawful beat (KIT-DIALS; the operator's mid-turn
  // ruling): the turn ended — apply through the one writer, forward once.
  drainPendingKitDials(short, roster, dir)
  publishSeatFacts(short, dir, roster)
  requestSessionFacts(short, roster, { immediate: true })
}

/** A session worker spawned (first boot or respawn): publish the skeleton
 *  so a hop paints the record's facts at once, and ask the child. */
export function onSeatSpawned(short: string, roster: SeatRosterPort, dir?: string): void {
  // A respawn means the child that held a pending rewind is gone with its
  // answer — the waiter settles typed, never as a silent success.
  rejectRewindWaiters(short, "the session's runner restarted before it answered the rewind — nothing is assumed restored")
  const seat = seatOf(short)
  seat.lastAnswer = null
  seat.sessionId = liveRecordByShort(short, dir)?.sessionId ?? null
  // A child that died mid-turn leaves a half-count behind; the respawn
  // zeroes it with the tail — the dedup identity and the state word included
  // (a child dead mid-fold must not leak 'compacting' into its next life).
  seat.turnChars = 0
  seat.tailMessageId = null
  const hadWord = seat.stateWord !== null
  seat.stateWord = null
  // LIVENESS: the dead child's clock and block are its own; the new child
  // starts unspoken (null — the row claims nothing until it speaks).
  const hadLiveness = seat.lastEventAtMs !== null || seat.streamBlock !== null
  seat.lastEventAtMs = null
  seat.streamBlock = null
  seat.blockSinceMs = null
  if (seat.livenessTimer !== null) {
    clearTimeout(seat.livenessTimer)
    seat.livenessTimer = null
  }
  seat.livenessDirty = false
  if (seat.tail !== null || hadWord || hadLiveness) setSeatTail(seat, null, dir)
  // A child that died mid-turn leaves mid-run lines behind; the respawn is
  // a clear beat (the transcript already holds whatever settled).
  clearSeatProgress(seat, dir)
  // A child that died mid-turn boots on the pre-edit spec; parked dials
  // apply here — the respawn IS a lawful beat (KIT-DIALS).
  drainPendingKitDials(short, roster, dir)
  // SATURN: a fresh (or respawned) child starts with an empty roster latch
  // — push the record's schedule roster so its list/remove tools speak
  // real ids from the first turn.
  pushScheduleRoster(short, roster, dir)
  publishSeatFacts(short, dir, roster)
  requestSessionFacts(short, roster, { immediate: true })
}

/** A settled worker's seat state goes with it. */
export function onSeatSettled(short: string): void {
  rejectRewindWaiters(short, "the session's runner ended before it answered the rewind — nothing is assumed restored")
  const seat = seats.get(short)
  if (seat?.debounce !== null && seat?.debounce !== undefined) clearTimeout(seat.debounce)
  if (seat?.workPoll !== null && seat?.workPoll !== undefined) clearTimeout(seat.workPoll)
  if (seat?.tailTimer !== null && seat?.tailTimer !== undefined) clearTimeout(seat.tailTimer)
  if (seat?.progressTimer !== null && seat?.progressTimer !== undefined) clearTimeout(seat.progressTimer)
  if (seat?.livenessTimer !== null && seat?.livenessTimer !== undefined) clearTimeout(seat.livenessTimer)
  seats.delete(short)
}

// ── the verbs ───────────────────────────────────────────────────────────────

export type SeatVerbOutcome = { outcome: 'applied' | 'queued' | 'noop' | 'refused'; detail?: string }

function verbRequestId(short: string, verb: string): string {
  return `${SEAT_VERB_REQUEST_PREFIX}${verb}-${short}-${Date.now().toString(36)}`
}

// ── the /rewind verb (v5) ───────────────────────────────────────────────────
// The runner that owns the session adjudicates (the point, the checkpoint,
// drift, the compaction fold) and answers on its control channel; the seat
// forwards, waits under a deadline, and relays the typed receipt. Every arm
// of this road speaks SessionRewindOutcomeV1 — a refusal always names why.

interface RewindWaiter {
  short: string
  mode: SessionRewindMode
  settle: (outcome: SessionRewindOutcomeV1) => void
}

const rewindWaiters = new Map<string, RewindWaiter>()
let rewindSeq = 0

function refusedRewind(mode: SessionRewindMode, refusal: NonNullable<SessionRewindOutcomeV1['refusal']>, detail: string): SessionRewindOutcomeV1 {
  return { outcome: 'refused', mode, refusal, detail }
}

function isRewindOutcome(value: unknown): value is SessionRewindOutcomeV1 {
  if (!value || typeof value !== 'object') return false
  const v = value as { outcome?: unknown; mode?: unknown }
  return (
    (v.outcome === 'applied' || v.outcome === 'refused' || v.outcome === 'noop') &&
    (v.mode === 'code' || v.mode === 'conversation' || v.mode === 'both')
  )
}

/**
 * Ask THIS session's runner to rewind: restore its files to the checkpoint
 * at a user message, wind its conversation back to that turn boundary, or
 * both. Mid-turn refuses typed (the conversation a turn is reading is never
 * rewritten under it — press esc first); no live channel refuses typed; a
 * runner silent past the deadline answers 'no-answer'; an older runner's
 * unsupported-subtype error answers 'runner-older'.
 */
export function rewindSession(
  sessionId: string,
  req: { mode: SessionRewindMode; userMessageId: string; dryRun?: boolean },
  roster: SeatRosterPort,
  dir?: string,
  opts?: { deadlineMs?: number },
): Promise<SessionRewindOutcomeV1> {
  const rec = liveRecordBySession(sessionId, dir)
  if (!rec) return Promise.resolve(refusedRewind(req.mode, 'unknown-session', 'no live worker record owns this session'))
  if (seatBusy(rec.runnerId, roster)) {
    return Promise.resolve(refusedRewind(req.mode, 'turn-active', 'a turn is running in this session — press esc to stop it, then /rewind again'))
  }
  const requestId = `${SEAT_REWIND_REQUEST_PREFIX}${rec.runnerId}-${Date.now().toString(36)}-${(++rewindSeq).toString(36)}`
  const deadlineMs = opts?.deadlineMs ?? REWIND_ANSWER_DEADLINE_MS
  return new Promise<SessionRewindOutcomeV1>(resolve => {
    const timer = setTimeout(() => {
      if (!rewindWaiters.delete(requestId)) return
      resolve(refusedRewind(req.mode, 'no-answer', `the session's runner did not answer the rewind within ${Math.round(deadlineMs / 1000)}s — nothing is assumed restored`))
    }, deadlineMs)
    timer.unref?.()
    rewindWaiters.set(requestId, {
      short: rec.runnerId,
      mode: req.mode,
      settle: outcome => {
        clearTimeout(timer)
        rewindWaiters.delete(requestId)
        resolve(outcome)
      },
    })
    const delivered = roster.control(
      rec.runnerId,
      JSON.stringify({
        type: 'control_request',
        request_id: requestId,
        request: {
          subtype: 'rewind_session',
          user_message_id: req.userMessageId,
          mode: req.mode,
          ...(req.dryRun === true ? { dry_run: true } : {}),
        },
      }),
    )
    if (!delivered) {
      clearTimeout(timer)
      rewindWaiters.delete(requestId)
      resolve(refusedRewind(req.mode, 'no-channel', 'the session has no live control channel'))
    }
  })
}

/** A rewind control_response settles its waiter: success relays the
 *  runner's receipt verbatim; an error frame speaks typed — an older
 *  runner's unsupported-subtype refusal is 'runner-older', anything else
 *  'restore-failed' with the runner's own sentence. */
function settleRewindAnswer(frame: { type?: string; response?: { subtype?: string; request_id?: string; response?: unknown; error?: unknown } }): boolean {
  const response = frame.response
  if (frame.type !== 'control_response' || !response || typeof response.request_id !== 'string') return false
  const waiter = rewindWaiters.get(response.request_id)
  if (waiter === undefined) return false
  if (response.subtype === 'success' && isRewindOutcome(response.response)) {
    waiter.settle(response.response)
    return true
  }
  const error = typeof response.error === 'string' && response.error !== '' ? response.error : 'the runner refused the rewind'
  const older = /unsupported control request subtype/i.test(error)
  waiter.settle(
    older
      ? refusedRewind(waiter.mode, 'runner-older', "the session's runner predates the rewind verb — /daemon restart when ready, then reopen the session")
      : refusedRewind(waiter.mode, 'restore-failed', error),
  )
  return true
}

/** A runner that ends or restarts mid-wait answers every pending rewind
 *  typed — nothing is assumed restored. */
function rejectRewindWaiters(short: string, detail: string): void {
  for (const [requestId, waiter] of rewindWaiters) {
    if (waiter.short !== short) continue
    rewindWaiters.delete(requestId)
    waiter.settle(refusedRewind(waiter.mode, 'no-answer', detail))
  }
}

/** TEST-ONLY: pending rewind waiters (the deadline and settle proofs). */
export function _pendingRewindWaitersForTesting(): number {
  return rewindWaiters.size
}

function applyModelNow(
  rec: ConcourseWorkerRecordV1,
  model: string,
  roster: SeatRosterPort,
  dir?: string,
  opts?: {
    /** True when this apply SETTLES a PARKED switch at the idle edge — the
     *  one case the settle note is scoped to. The receipt is stamped
     *  BEFORE the publish below, with `from` read off the still-lagging
     *  answer (the serving truth at the flip), so the screen's edge drives
     *  off the daemon's own word (FN-016 R15). An immediate idle apply
     *  stamps nothing: its surface already words the receipt. */
    parkedSettle?: boolean
  },
): SeatVerbOutcome {
  const delivered = roster.control(
    rec.runnerId,
    JSON.stringify({
      type: 'control_request',
      request_id: verbRequestId(rec.runnerId, 'set-model'),
      request: { subtype: 'set_model', model },
    }),
  )
  if (!delivered) return { outcome: 'refused', detail: 'the session has no live control channel' }
  // eslint-disable-next-line no-console
  console.error(`[daemon] seat set-model applied: ${rec.runnerId} → ${model}`)
  if (opts?.parkedSettle === true) {
    const seat = seatOf(rec.runnerId)
    const from = seat.lastAnswer?.model.effective ?? rec.modelKey
    seat.lastModelSettle = { from, to: model, atMs: Date.now() }
  }
  roster.patchSeatModel(rec.runnerId, model)
  updateConcourseWorkers(workers => {
    const w = workers[rec.runnerId]
    if (w && w.endedAt === undefined) {
      w.modelKey = model
      delete w.pendingModelKey
    }
  }, dir)
  publishSeatFacts(rec.runnerId, dir, roster)
  return { outcome: 'applied', detail: `${rec.runnerId} → ${model}` }
}

/**
 * Switch THIS session's model, in place, from its next message: idle
 * applies now; busy parks it on the record (visible as the pending switch)
 * and the idle edge applies it; the same model no-ops.
 */
export function setSessionModel(sessionId: string, model: string, roster: SeatRosterPort, dir?: string): SeatVerbOutcome {
  const rec = liveRecordBySession(sessionId, dir)
  if (!rec) return { outcome: 'refused', detail: 'unknown-session: no live worker record owns this session' }
  if (rec.modelKey === model && rec.pendingModelKey === undefined) return { outcome: 'noop', detail: `already on ${model}` }
  if (seatBusy(rec.runnerId, roster)) {
    updateConcourseWorkers(workers => {
      const w = workers[rec.runnerId]
      if (w && w.endedAt === undefined) {
        if (w.modelKey === model) delete w.pendingModelKey
        else w.pendingModelKey = model
      }
    }, dir)
    // eslint-disable-next-line no-console
    console.error(`[daemon] seat set-model parked (the session is mid-turn): ${rec.runnerId} → ${model}`)
    publishSeatFacts(rec.runnerId, dir, roster)
    return { outcome: 'queued', detail: `${model} applies when this turn ends` }
  }
  return applyModelNow(rec, model, roster, dir)
}

function applyEffortNow(
  rec: ConcourseWorkerRecordV1,
  effort: string,
  roster: SeatRosterPort,
  dir?: string,
): SeatVerbOutcome {
  const delivered = roster.control(
    rec.runnerId,
    JSON.stringify({
      type: 'control_request',
      request_id: verbRequestId(rec.runnerId, 'set-effort'),
      request: { subtype: 'set_effort', effort },
    }),
  )
  if (!delivered) return { outcome: 'refused', detail: 'the session has no live control channel' }
  // eslint-disable-next-line no-console
  console.error(`[daemon] seat set-effort applied: ${rec.runnerId} → ${effort}`)
  roster.patchSeatEffort(rec.runnerId, effort)
  updateConcourseWorkers(workers => {
    const w = workers[rec.runnerId]
    if (w && w.endedAt === undefined) {
      w.effort = effort
      delete w.pendingEffort
    }
  }, dir)
  publishSeatFacts(rec.runnerId, dir, roster)
  return { outcome: 'applied', detail: `${rec.runnerId} → ${effort}` }
}

/**
 * Switch THIS session's effort, in place — set-model's effort sibling with
 * the identical grammar: idle applies now (the child's set_effort control),
 * busy parks it on the record and the idle edge applies it; the same effort
 * no-ops. The value grammar is the child union's — validated against the
 * one effort owner, never a second enum.
 */
export function setSessionEffort(sessionId: string, effort: string, roster: SeatRosterPort, dir?: string): SeatVerbOutcome {
  // The ONE normalizer answers first: a plain spelling ('max effort',
  // 'x high') is the same request as its ladder word; junk refuses typed.
  const level = normalizeEffortLevelString(effort)
  if (level === undefined) {
    return { outcome: 'refused', detail: `unknown effort '${effort}' — the levels are ${EFFORT_LEVELS.join(' | ')}` }
  }
  effort = level
  const rec = liveRecordBySession(sessionId, dir)
  if (!rec) return { outcome: 'refused', detail: 'unknown-session: no live worker record owns this session' }
  if (rec.effort === effort && rec.pendingEffort === undefined) return { outcome: 'noop', detail: `already on ${effort}` }
  if (seatBusy(rec.runnerId, roster)) {
    updateConcourseWorkers(workers => {
      const w = workers[rec.runnerId]
      if (w && w.endedAt === undefined) {
        if (w.effort === effort) delete w.pendingEffort
        else w.pendingEffort = effort
      }
    }, dir)
    // eslint-disable-next-line no-console
    console.error(`[daemon] seat set-effort parked (the session is mid-turn): ${rec.runnerId} → ${effort}`)
    publishSeatFacts(rec.runnerId, dir, roster)
    return { outcome: 'queued', detail: `${effort} applies when this turn ends` }
  }
  return applyEffortNow(rec, effort, roster, dir)
}

/** The mid-turn park's honest line (KIT-DIALS; the operator's ruling:
 *  apply at the NEXT LAWFUL BEAT — never yank a tool mid-call). */
export const KIT_DIAL_QUEUED_DETAIL = 'the dials apply when this turn ends'

/**
 * THE SESSION-KIT DIAL (KIT-DIALS; ledger L24(3)): the sessionControl
 * 'set-kit' arm's seat half — the record write and the live apply are ONE
 * operation. Idle: the record's one writer applies the edit
 * (applyConcourseKitOp; a pre-kit record materializes first) and the
 * post-edit kit forwards WHOLE to the live child (the kit_edit verb — the
 * child flips its latch, reconciles its catalogue MCP plane, re-derives its
 * command table). Busy: the edit PARKS on the record with its asker
 * (pendingKitEdits — the pendingModelKey shape) and the next lawful beat
 * drains it — the idle edge, or the seat's respawn (a child that died
 * mid-turn boots on the pre-edit spec; the drain re-applies and forwards);
 * the caller hears the honest 'queued' line, never silence. A dial on a
 * session with no live control channel still lands on the record — the
 * durable truth its next boot carries.
 */
export function setSessionKitDial(
  sessionId: string,
  edit: SessionKitEditV1,
  by: string,
  roster: SeatRosterPort,
  dir?: string,
): SeatVerbOutcome {
  const rec = liveRecordBySession(sessionId, dir)
  if (!rec) return { outcome: 'refused', detail: 'unknown-session: no live worker record owns this session' }
  if (seatBusy(rec.runnerId, roster)) {
    updateConcourseWorkers(workers => {
      const w = workers[rec.runnerId]
      if (w && w.endedAt === undefined) w.pendingKitEdits = [...(w.pendingKitEdits ?? []), { edit, by }]
    }, dir)
    // eslint-disable-next-line no-console
    console.error(`[daemon] seat set-kit parked (the session is mid-turn): ${rec.runnerId}`)
    publishSeatFacts(rec.runnerId, dir, roster)
    return { outcome: 'queued', detail: KIT_DIAL_QUEUED_DETAIL }
  }
  const out = applyConcourseKitOp(sessionId, edit, by, dir)
  if (out.outcome !== 'applied') return out
  const forwarded = forwardSessionKit(rec.runnerId, roster, dir)
  publishSeatFacts(rec.runnerId, dir, roster)
  requestSessionFacts(rec.runnerId, roster, { immediate: true })
  return forwarded
    ? { outcome: 'applied', ...(out.detail !== undefined ? { detail: out.detail } : {}) }
    : {
        outcome: 'applied',
        detail: `${out.detail ?? 'applied'} — no live control channel; the record holds the kit and the session's next boot applies it`,
      }
}

/** Deliver the record's CURRENT kit to the live child, whole (the child's
 *  kit_edit verb — the record was edited first, so record and process
 *  speak one truth). False when no channel or no kit stands. */
function forwardSessionKit(short: string, roster: SeatRosterPort, dir?: string): boolean {
  const rec = liveRecordByShort(short, dir)
  if (!rec || rec.kit === undefined) return false
  return roster.control(
    short,
    JSON.stringify({
      type: 'control_request',
      request_id: verbRequestId(short, 'kit-edit'),
      request: { subtype: 'kit_edit', kit: rec.kit },
    }),
  )
}

/** The parked dials' drain at the NEXT LAWFUL BEAT (the idle edge; the
 *  seat's respawn): every parked edit applies in arrival order through the
 *  record's one writer, then ONE forward of the final kit. */
function drainPendingKitDials(short: string, roster: SeatRosterPort, dir?: string): void {
  const rec = liveRecordByShort(short, dir)
  if (!rec) return
  const parked = rec.pendingKitEdits ?? []
  if (parked.length === 0) return
  updateConcourseWorkers(workers => {
    const w = workers[short]
    if (w && w.endedAt === undefined) delete w.pendingKitEdits
  }, dir)
  // eslint-disable-next-line no-console
  console.error(`[daemon] seat set-kit applying ${parked.length} parked dial${parked.length === 1 ? '' : 's'} at the turn's end: ${short}`)
  for (const entry of parked) applyConcourseKitOp(rec.sessionId, entry.edit, entry.by, dir)
  forwardSessionKit(short, roster, dir)
}

export function setSessionPermissionMode(
  sessionId: string,
  mode: string,
  roster: SeatRosterPort,
  dir?: string,
): SeatVerbOutcome {
  const rec = liveRecordBySession(sessionId, dir)
  if (!rec) return { outcome: 'refused', detail: 'unknown-session: no live worker record owns this session' }
  const delivered = roster.control(
    rec.runnerId,
    JSON.stringify({
      type: 'control_request',
      request_id: verbRequestId(rec.runnerId, 'set-permission-mode'),
      request: { subtype: 'set_permission_mode', mode },
    }),
  )
  return delivered
    ? { outcome: 'applied', detail: `${rec.runnerId} mode → ${mode}` }
    : { outcome: 'refused', detail: 'the session has no live control channel' }
}

/** A forced facts refresh (the screen asks after a hop when the file is old). */
export function refreshSessionFacts(sessionId: string, roster: SeatRosterPort, dir?: string): SeatVerbOutcome {
  const rec = liveRecordBySession(sessionId, dir)
  if (!rec) return { outcome: 'refused', detail: 'unknown-session: no live worker record owns this session' }
  requestSessionFacts(rec.runnerId, roster, { immediate: true })
  return { outcome: 'applied', detail: `facts requested from ${rec.runnerId}` }
}
