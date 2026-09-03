import { logForDebugging } from '../utils/debug.js'
import {
  publishSessionFacts,
  publishSessionProgress,
  publishSessionTail,
  type SessionFactsAnswerV1,
  type SessionFactsV1,
  type SessionProgressEntryV1,
} from '../services/engine-connector/seatProjections.js'
import { decodeRequestWait, type RequestWaitV1 } from '../services/providers/streamIdleBudget.js'
import { workRowRuns } from '../services/engine-connector/workCounts.js'
import { EFFORT_LEVELS, normalizeEffortLevelString } from '../utils/effort.js'
import { readSessionWorkers, updateConcourseWorkers, type ConcourseWorkerRecordV1 } from './concourseSupervisor.js'
import { resolveSessionKitOnRecord, validateSessionKit, type SessionKitEditV1 } from './sessionKit.js'
import {
  SPAWN_SWITCH_KINDS,
  spawnSwitchFactsOfRecord,
  spawnSwitchOfRecord,
  spawnSwitchToggleReceipt,
  type SpawnSwitchKind,
} from '../services/switchboard/spawnSwitches.js'
import { applyConcourseScheduleOp, saturnFactsOf, SATURN_EDIT_BURST_CAP } from './saturn.js'
import { deriveScheduleAccountForModel, readLiveAccountFacts, scheduleAccountVerdict } from './saturnAccount.js'
import { applyConcourseKitOp } from './sessionKitOp.js'
import { onWorkerControlCancel } from './permissionAsks.js'
import type { SessionRewindMode, SessionRewindOutcomeV1 } from './protocol.js'

export interface SeatRosterPort {
  control(short: string, frame: string): boolean
  list(): ReadonlyArray<{ short: string; outcome?: string; busy?: boolean; turnActive?: boolean }>
  patchSeatModel(short: string, model: string): boolean
  patchSeatEffort(short: string, effort: string): boolean
}

export const SESSION_FACTS_REQUEST_PREFIX = 'mercury-session-facts-'
const SEAT_VERB_REQUEST_PREFIX = 'mercury-seat-'
const SEAT_REWIND_REQUEST_PREFIX = `${SEAT_VERB_REQUEST_PREFIX}rewind-`
export const REWIND_ANSWER_DEADLINE_MS = 30_000
const FACTS_DEBOUNCE_MS = 250

interface SeatState {
  short: string
  lastAnswer: SessionFactsAnswerV1 | null
  requestSeq: number
  debounce: ReturnType<typeof setTimeout> | null
  workPoll: ReturnType<typeof setTimeout> | null
  lastBusy: boolean
  sessionId: string | null
  tail: string | null
  tailMessageId: string | null
  tailTimer: ReturnType<typeof setTimeout> | null
  tailDirty: boolean
  streamedThisTurn: boolean
  turnChars: number
  stateWord: 'compacting' | 'waiting-on-agents' | null
  waitingOnAgents: number
  wait: RequestWaitV1 | null
  progress: Map<string, SessionProgressEntryV1>
  progressTimer: ReturnType<typeof setTimeout> | null
  progressDirty: boolean
  lastModelSettle: { from: string; to: string; atMs: number } | null
  lastEventAtMs: number | null
  streamBlock: 'thinking' | 'text' | 'tool_use' | null
  blockSinceMs: number | null
  livenessTimer: ReturnType<typeof setTimeout> | null
  livenessDirty: boolean
}

const seats = new Map<string, SeatState>()

function seatOf(short: string): SeatState {
  let s = seats.get(short)
  if (!s) {
    s = { short, lastAnswer: null, requestSeq: 0, debounce: null, workPoll: null, lastBusy: false, sessionId: null, tail: null, tailMessageId: null, tailTimer: null, tailDirty: false, streamedThisTurn: false, turnChars: 0, stateWord: null, waitingOnAgents: 0, wait: null, progress: new Map(), progressTimer: null, progressDirty: false, lastModelSettle: null, lastEventAtMs: null, streamBlock: null, blockSinceMs: null, livenessTimer: null, livenessDirty: false }
    seats.set(short, s)
  }
  return s
}

const TAIL_PUBLISH_MS = 40

function publishTailNow(seat: SeatState, dir?: string): void {
  if (seat.sessionId === null) return
  seat.tailDirty = false
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
        ...(seat.stateWord === 'waiting-on-agents' ? { waitingOnAgents: seat.waitingOnAgents } : {}),
        ...(seat.wait !== null ? { wait: seat.wait } : {}),
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

const LIVENESS_PUBLISH_MS = 1000

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

function streamBlockOf(type: string | undefined): SeatState['streamBlock'] {
  if (type === 'thinking' || type === 'redacted_thinking') return 'thinking'
  if (type === 'text') return 'text'
  if (type === 'tool_use' || type === 'server_tool_use' || type === 'mcp_tool_use') return 'tool_use'
  return null
}

function onSeatStreamEvent(seat: SeatState, line: string, dir?: string): boolean {
  let frame: { type?: string; event?: { type?: string; content_block?: { type?: string }; delta?: { type?: string; text?: string }; message?: { id?: string } } }
  try {
    frame = JSON.parse(line) as typeof frame
  } catch {
    return false
  }
  if (frame.type !== 'stream_event' || !frame.event) return false
  const ev = frame.event
  noteSeatEvent(seat, dir)
  if (ev.type === 'content_block_start') {
    seat.streamBlock = streamBlockOf(ev.content_block?.type)
    seat.blockSinceMs = seat.streamBlock === null ? null : Date.now()
    publishTailNow(seat, dir)
    return true
  }
  if (ev.type === 'message_start') {
    if (seat.tail !== null) setSeatTail(seat, null, dir)
    const id = ev.message?.id
    seat.tailMessageId = typeof id === 'string' && id !== '' ? id : null
    seat.streamBlock = null
    seat.blockSinceMs = null
    publishTailNow(seat, dir)
  } else if (ev.type === 'content_block_delta' && ev.delta?.type === 'text_delta' && typeof ev.delta.text === 'string') {
    seat.streamedThisTurn = true
    seat.turnChars += ev.delta.text.length
    setSeatTail(seat, (seat.tail ?? '') + ev.delta.text, dir)
  } else if (ev.type === 'content_block_stop' || ev.type === 'message_stop') {
    if (ev.type === 'message_stop') {
      seat.streamBlock = null
      seat.blockSinceMs = null
    }
    if (seat.tail !== null) setSeatTail(seat, null, dir)
    else publishTailNow(seat, dir)
  }
  return true
}

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

function clearSeatProgress(seat: SeatState, dir?: string): void {
  if (seat.progress.size === 0) return
  seat.progress.clear()
  if (seat.progressTimer !== null) {
    clearTimeout(seat.progressTimer)
    seat.progressTimer = null
  }
  publishProgressNow(seat, dir)
}

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
  if (frame.type !== 'tool_progress') return false
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

export function seatTurnOpen(row: { outcome?: string; busy?: boolean; turnActive?: boolean } | undefined): boolean {
  if (row === undefined || row.outcome) return false
  if (row.turnActive === true) return true
  return row.busy === true
}

function seatBusy(short: string, roster: SeatRosterPort): boolean {
  return seatTurnOpen(roster.list().find(j => j.short === short))
}


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
    model: {
      effective: seat.lastAnswer?.model.effective ?? rec.modelKey,
      setting: seat.lastAnswer?.model.setting ?? rec.modelKey,
    },
    pendingModel: rec.pendingModelKey ?? null,
    spawnSwitches: spawnSwitchFactsOfRecord(rec),
    ...(rec.pendingSpawnSwitches !== undefined && rec.pendingSpawnSwitches.length > 0
      ? { pendingSpawnSwitches: rec.pendingSpawnSwitches.map(p => ({ kind: p.kind, on: p.on })) }
      : {}),
    ...(seat.lastModelSettle !== null ? { modelSettled: seat.lastModelSettle } : {}),
    busy: roster !== undefined ? seatBusy(short, roster) : seat.lastBusy,
    ...saturnFactsOf(rec, Date.now()),
  }
  seat.lastBusy = facts.busy
  try {
    publishSessionFacts(facts, dir)
  } catch (e) {
    logForDebugging(`[daemon] session facts publish failed for ${short}: ${e}`)
  }
}

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

const WORK_POLL_MS = 1000

function armWorkPoll(short: string, roster: SeatRosterPort): void {
  const seat = seats.get(short)
  if (seat === undefined) return
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
    if (seats.get(short) !== undefined) requestSessionFacts(short, roster, { immediate: true })
  }, WORK_POLL_MS)
  t.unref?.()
  seat.workPoll = t
}

function seatScheduleDeps(): import('./saturn.js').ScheduleOpDepsV1 {
  return {
    deriveAccount: deriveScheduleAccountForModel,
    preflight: (account, nextFireMs) =>
      scheduleAccountVerdict({ account, nextFireMs, nowMs: Date.now(), live: readLiveAccountFacts(account) }),
  }
}

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

export function onSeatLine(short: string, line: string, roster: SeatRosterPort, dir?: string): void {
  if (line.includes('"stream_event"')) {
    const seat = seatOf(short)
    if (seat.sessionId === null) seat.sessionId = liveRecordByShort(short, dir)?.sessionId ?? null
    if (onSeatStreamEvent(seat, line, dir)) return
  }
  if (line.includes('"ephemeral_tail"')) {
    const seat = seatOf(short)
    if (seat.sessionId === null) seat.sessionId = liveRecordByShort(short, dir)?.sessionId ?? null
    if (onSeatEphemeralProgress(seat, line, dir)) return
  }
  if (line.includes('"tool_progress"')) {
    try {
      if ((JSON.parse(line) as { type?: string }).type === 'tool_progress') {
        const seat = seatOf(short)
        if (seat.sessionId === null) seat.sessionId = liveRecordByShort(short, dir)?.sessionId ?? null
        noteSeatEvent(seat, dir)
        return
      }
    } catch {
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
    }
    return
  }
  if (
    line.includes('"task_started"') ||
    line.includes('"task_progress"') ||
    line.includes('"task_notification"')
  ) {
    requestSessionFacts(short, roster)
    return
  }
  if (line.includes('"control_response"') && line.includes(SEAT_VERB_REQUEST_PREFIX)) {
    if (line.includes(SEAT_REWIND_REQUEST_PREFIX)) {
      try {
        settleRewindAnswer(JSON.parse(line) as Parameters<typeof settleRewindAnswer>[0])
      } catch {
      }
    }
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
    }
  }
  if (line.includes('"subtype":"status"')) {
    try {
      const frame = JSON.parse(line) as { type?: string; subtype?: string; status?: unknown }
      if (frame.type === 'system' && frame.subtype === 'status') {
        const seat = seatOf(short)
        if (seat.sessionId === null) seat.sessionId = liveRecordByShort(short, dir)?.sessionId ?? null
        if (frame.status !== null && typeof frame.status === 'object' && 'wait' in (frame.status as object)) {
          const raw = (frame.status as { wait?: unknown }).wait
          const next = decodeRequestWait(raw)
          noteSeatEvent(seat, dir)
          if (JSON.stringify(seat.wait) !== JSON.stringify(next)) {
            seat.wait = next
            publishTailNow(seat, dir)
          }
          return
        }
        const waiting =
          frame.status !== null && typeof frame.status === 'object'
            ? (frame.status as { waitingOnAgents?: unknown }).waitingOnAgents
            : undefined
        const next =
          frame.status === 'compacting'
            ? ('compacting' as const)
            : typeof waiting === 'number' && Number.isFinite(waiting) && waiting > 0
              ? ('waiting-on-agents' as const)
              : null
        const count = next === 'waiting-on-agents' ? Math.floor(waiting as number) : 0
        noteSeatEvent(seat, dir)
        if (seat.stateWord !== next || seat.waitingOnAgents !== count) {
          seat.stateWord = next
          seat.waitingOnAgents = count
          publishTailNow(seat, dir)
        }
        return
      }
    } catch {
    }
  }
  if (line.includes('"user"')) {
    try {
      if ((JSON.parse(line) as { type?: string }).type === 'user') {
        const seat = seatOf(short)
        if (seat.sessionId === null) seat.sessionId = liveRecordByShort(short, dir)?.sessionId ?? null
        noteSeatEvent(seat, dir)
        return
      }
    } catch {
    }
  }
  if (line.includes('"assistant"') || line.includes('"result"')) {
    let kind: string | undefined
    try {
      kind = (JSON.parse(line) as { type?: string }).type
    } catch {
      return
    }
    if (kind === 'assistant') {
      const seat = seatOf(short)
      if (seat.sessionId === null) seat.sessionId = liveRecordByShort(short, dir)?.sessionId ?? null
      noteSeatEvent(seat, dir)
      onSeatAssistantFrame(seat, line, dir)
      requestSessionFacts(short, roster)
      return
    }
    if (kind === 'result') {
      const seat = seatOf(short)
      seat.streamedThisTurn = false
      seat.turnChars = 0
      seat.tailMessageId = null
      seat.stateWord = null
      seat.waitingOnAgents = 0
      seat.wait = null
      noteSeatEvent(seat, dir)
      seat.streamBlock = null
      seat.blockSinceMs = null
      setSeatTail(seat, null, dir)
      clearSeatProgress(seat, dir)
    }
  }
}

export function onSeatIdle(short: string, roster: SeatRosterPort, dir?: string): void {
  const rec = liveRecordByShort(short, dir)
  if (!rec) return
  // eslint-disable-next-line no-console
  console.error(`[daemon] seat idle edge: ${short}${rec.pendingModelKey !== undefined ? ` — applying the parked model ${rec.pendingModelKey}` : ''}${rec.pendingEffort !== undefined ? ` — applying the parked effort ${rec.pendingEffort}` : ''}`)
  if (rec.pendingModelKey !== undefined) applyModelNow(rec, rec.pendingModelKey, roster, dir, { parkedSettle: true })
  if (rec.pendingEffort !== undefined) applyEffortNow(rec, rec.pendingEffort, roster, dir)
  drainPendingKitDials(short, roster, dir)
  drainPendingSpawnSwitches(short, roster, dir)
  publishSeatFacts(short, dir, roster)
  requestSessionFacts(short, roster, { immediate: true })
}

export function onSeatSpawned(short: string, roster: SeatRosterPort, dir?: string): void {
  rejectRewindWaiters(short, "the session's runner restarted before it answered the rewind — nothing is assumed restored")
  const seat = seatOf(short)
  seat.lastAnswer = null
  seat.sessionId = liveRecordByShort(short, dir)?.sessionId ?? null
  seat.turnChars = 0
  seat.tailMessageId = null
  const hadWord = seat.stateWord !== null || seat.wait !== null
  seat.stateWord = null
  seat.waitingOnAgents = 0
  seat.wait = null
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
  clearSeatProgress(seat, dir)
  drainPendingKitDials(short, roster, dir)
  forwardRecordSpawnSwitches(short, roster, dir)
  drainPendingSpawnSwitches(short, roster, dir)
  pushScheduleRoster(short, roster, dir)
  publishSeatFacts(short, dir, roster)
  requestSessionFacts(short, roster, { immediate: true })
}

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


export type SeatVerbOutcome = { outcome: 'applied' | 'queued' | 'noop' | 'refused'; detail?: string }

function verbRequestId(short: string, verb: string): string {
  return `${SEAT_VERB_REQUEST_PREFIX}${verb}-${short}-${Date.now().toString(36)}`
}


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

function rejectRewindWaiters(short: string, detail: string): void {
  for (const [requestId, waiter] of rewindWaiters) {
    if (waiter.short !== short) continue
    rewindWaiters.delete(requestId)
    waiter.settle(refusedRewind(waiter.mode, 'no-answer', detail))
  }
}

export function _pendingRewindWaitersForTesting(): number {
  return rewindWaiters.size
}

function applyModelNow(
  rec: ConcourseWorkerRecordV1,
  model: string,
  roster: SeatRosterPort,
  dir?: string,
  opts?: {
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

export function setSessionEffort(sessionId: string, effort: string, roster: SeatRosterPort, dir?: string): SeatVerbOutcome {
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

export const KIT_DIAL_QUEUED_DETAIL = 'the dials apply when this turn ends'

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


export function setSessionSpawnSwitch(
  sessionId: string,
  toggle: { kind: SpawnSwitchKind; on: boolean },
  by: string,
  roster: SeatRosterPort,
  dir?: string,
): SeatVerbOutcome {
  const rec = liveRecordBySession(sessionId, dir)
  if (!rec) return { outcome: 'refused', detail: 'unknown-session: no live worker record owns this session' }
  const parkedForKind = (rec.pendingSpawnSwitches ?? []).filter(p => p.kind === toggle.kind)
  const parked = parkedForKind[parkedForKind.length - 1]
  const effectiveOn = parked !== undefined ? parked.on : spawnSwitchOfRecord(rec, toggle.kind).on
  if (effectiveOn === toggle.on) return { outcome: 'noop', detail: spawnSwitchToggleReceipt(toggle.kind, toggle.on, 'noop') }
  if (seatBusy(rec.runnerId, roster)) {
    updateConcourseWorkers(workers => {
      const w = workers[rec.runnerId]
      if (w && w.endedAt === undefined) {
        w.pendingSpawnSwitches = [...(w.pendingSpawnSwitches ?? []).filter(p => p.kind !== toggle.kind), { kind: toggle.kind, on: toggle.on, by }]
      }
    }, dir)
    // eslint-disable-next-line no-console
    console.error(`[daemon] seat set-spawn-switch parked (the session is mid-turn): ${rec.runnerId} → ${toggle.kind} ${toggle.on ? 'on' : 'off'}`)
    publishSeatFacts(rec.runnerId, dir, roster)
    return { outcome: 'queued', detail: spawnSwitchToggleReceipt(toggle.kind, toggle.on, 'queued') }
  }
  return applySpawnSwitchNow(rec, toggle, roster, dir)
}

function applySpawnSwitchNow(
  rec: ConcourseWorkerRecordV1,
  toggle: { kind: SpawnSwitchKind; on: boolean },
  roster: SeatRosterPort,
  dir?: string,
): SeatVerbOutcome {
  updateConcourseWorkers(workers => {
    const w = workers[rec.runnerId]
    if (w && w.endedAt === undefined) w.spawnSwitches = { ...(w.spawnSwitches ?? {}), [toggle.kind]: toggle.on ? 'on' : 'off' }
  }, dir)
  const delivered = forwardSpawnSwitch(rec.runnerId, toggle, roster)
  // eslint-disable-next-line no-console
  console.error(`[daemon] seat set-spawn-switch applied: ${rec.runnerId} → ${toggle.kind} ${toggle.on ? 'on' : 'off'}${delivered ? '' : ' (no live control channel; the record holds it)'}`)
  publishSeatFacts(rec.runnerId, dir, roster)
  requestSessionFacts(rec.runnerId, roster, { immediate: true })
  const receipt = spawnSwitchToggleReceipt(toggle.kind, toggle.on, 'applied')
  return delivered
    ? { outcome: 'applied', detail: receipt }
    : { outcome: 'applied', detail: `${receipt} — no live control channel; the record holds the switch and the session's next boot applies it` }
}

function forwardSpawnSwitch(short: string, toggle: { kind: SpawnSwitchKind; on: boolean }, roster: SeatRosterPort): boolean {
  return roster.control(
    short,
    JSON.stringify({
      type: 'control_request',
      request_id: verbRequestId(short, `spawn-switch-${toggle.kind}`),
      request: { subtype: 'spawn_switch', switch: toggle.kind, on: toggle.on },
    }),
  )
}

function forwardRecordSpawnSwitches(short: string, roster: SeatRosterPort, dir?: string): void {
  const rec = liveRecordByShort(short, dir)
  if (!rec?.spawnSwitches) return
  for (const kind of SPAWN_SWITCH_KINDS) {
    const held = rec.spawnSwitches[kind]
    if (held !== undefined) forwardSpawnSwitch(short, { kind, on: held === 'on' }, roster)
  }
}

function drainPendingSpawnSwitches(short: string, roster: SeatRosterPort, dir?: string): void {
  const rec = liveRecordByShort(short, dir)
  if (!rec) return
  const parked = rec.pendingSpawnSwitches ?? []
  if (parked.length === 0) return
  updateConcourseWorkers(workers => {
    const w = workers[short]
    if (w && w.endedAt === undefined) delete w.pendingSpawnSwitches
  }, dir)
  // eslint-disable-next-line no-console
  console.error(`[daemon] seat set-spawn-switch applying ${parked.length} parked toggle${parked.length === 1 ? '' : 's'} at the turn's end: ${short}`)
  for (const entry of parked) {
    const fresh = liveRecordByShort(short, dir)
    if (fresh) applySpawnSwitchNow(fresh, { kind: entry.kind, on: entry.on }, roster, dir)
  }
}

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

export function refreshSessionFacts(sessionId: string, roster: SeatRosterPort, dir?: string): SeatVerbOutcome {
  const rec = liveRecordBySession(sessionId, dir)
  if (!rec) return { outcome: 'refused', detail: 'unknown-session: no live worker record owns this session' }
  requestSessionFacts(rec.runnerId, roster, { immediate: true })
  return { outcome: 'applied', detail: `facts requested from ${rec.runnerId}` }
}
