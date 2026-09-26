import { logForDebugging } from '../utils/debug.js'
import {
  publishSessionFacts,
  publishSessionProgress,
  publishSessionTail,
  type SessionFactsAnswerV1,
  type SessionFactsV1,
  type SessionProgressEntryV1,
} from '../services/engine-connector/seatProjections.js'
import {
  rewindOutcomeFromWire,
  scheduleRosterToWire,
  sessionFactsFromWire,
  sessionKitToWire,
} from '../services/engine-connector/seatWire.js'
import { decodeRequestWait, requestWaitFromWire, type RequestWaitV1 } from '../services/providers/streamIdleBudget.js'
import { decodeFoldStatus, foldStatusFromWire, type FoldStatusV1 } from '../services/compact/foldStatus.js'
import { workRowRuns } from '../services/engine-connector/workCounts.js'
import { EFFORT_LEVELS, normalizeEffortLevelString } from '../utils/effort.js'
import { markConcourseWorkerActivity, readSessionWorkers, reviveConcourseWorker, updateConcourseWorkers, workerPidAlive, type ConcourseWorkerRecordV1 } from './concourseSupervisor.js'
import { isSeatVerbAppliedParsedFrame, SEAT_VERB_APPLIED_SUBTYPE, type SeatVerbAppliedFrame } from './runnerFrames.js'
import type { StreamJsonChildSpec } from './headlessRun.js'
import type { PermissionMode } from '../types/permissions.js'
import type { TextPhase } from '../types/wire.js'
import { describeSignInRead, refreshSignInReads } from './signInView.js'
import { validateWorkerModelChoice } from '../services/concourse/workerModels.js'
import { getMarketingNameForModel } from '../utils/model/model.js'
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
import type { QuiescenceAnswer, QuiescenceRequest } from './runnerQuiescence.js'
import type { SessionRewindMode, SessionRewindOutcomeV1 } from './protocol.js'

export interface SeatRosterPort {
  control(short: string, frame: string): boolean
  list(): ReadonlyArray<{ short: string; outcome?: string; busy?: boolean; turnActive?: boolean; state?: string; turnStartedAt?: number }>
  patchSeatModel(short: string, model: string): boolean
  patchSeatEffort(short: string, effort: string): boolean
  has?(short: string): { present: boolean }
  kill?(short: string): boolean
  registerLongLived?(short: string, spec: StreamJsonChildSpec): { ok: boolean; pid?: number; error?: string }
}

export const SESSION_FACTS_REQUEST_PREFIX = 'mercury-session-facts-'
const SEAT_VERB_REQUEST_PREFIX = 'mercury-seat-'
const SEAT_REWIND_REQUEST_PREFIX = `${SEAT_VERB_REQUEST_PREFIX}rewind-`
export const REWIND_ANSWER_DEADLINE_MS = 30_000
const SEAT_CREDENTIAL_CHANGE_REQUEST_PREFIX = 'mercury-credential-change-'
let credentialChangeSeq = 0

export function relayCredentialChange(
  roster: Pick<SeatRosterPort, 'control'> & { liveWorkerFacts(): ReadonlyArray<{ short: string; kind: 'long-lived' | 'one-shot' }> },
): string[] {
  const told: string[] = []
  for (const worker of roster.liveWorkerFacts()) {
    if (worker.kind !== 'long-lived') continue
    const requestId = `${SEAT_CREDENTIAL_CHANGE_REQUEST_PREFIX}${Date.now().toString(36)}-${(++credentialChangeSeq).toString(36)}`
    const frame = JSON.stringify({ type: 'control_request', request_id: requestId, request: { subtype: 'credential_change' } })
    if (roster.control(worker.short, frame)) told.push(worker.short)
  }
  return told
}
const FACTS_DEBOUNCE_MS = 250

interface SeatState {
  short: string
  lastAnswer: SessionFactsAnswerV1 | null
  generation: number
  requestSeq: number
  debounce: ReturnType<typeof setTimeout> | null
  workPoll: ReturnType<typeof setTimeout> | null
  lastBusy: boolean
  sessionId: string | null
  tail: string | null
  tailMessageId: string | null
  tailPhase: TextPhase | null
  tailTimer: ReturnType<typeof setTimeout> | null
  tailDirty: boolean
  streamedThisTurn: boolean
  turnChars: number
  turnOutputTokens: number | null
  messageOutputTokens: number
  stateWord: 'compacting' | 'waiting-on-agents' | null
  waitingOnAgents: number
  fold: FoldStatusV1 | null
  wait: RequestWaitV1 | null
  progress: Map<string, SessionProgressEntryV1>
  progressTimer: ReturnType<typeof setTimeout> | null
  progressDirty: boolean
  lastModelSettle: { from: string; to: string; atMs: number } | null
  heldModel: { requestId: string; model: string } | null
  heldEffort: { requestId: string; effort: string } | null
  heldSpawnSwitches: Partial<Record<SpawnSwitchKind, { requestId: string; on: boolean }>>
  lastEventAtMs: number | null
  streamBlock: 'thinking' | 'text' | 'tool_use' | null
  blockSinceMs: number | null
  livenessTimer: ReturnType<typeof setTimeout> | null
  livenessDirty: boolean
}

const seats = new Map<string, SeatState>()
const seatGenerations = new Map<string, number>()

export function seatGenerationOf(short: string): number {
  return seats.get(short)?.generation ?? seatGenerations.get(short) ?? 0
}

function seatOf(short: string): SeatState {
  let s = seats.get(short)
  if (!s) {
    s = { short, lastAnswer: null, generation: seatGenerations.get(short) ?? 0, requestSeq: 0, debounce: null, workPoll: null, lastBusy: false, sessionId: null, tail: null, tailMessageId: null, tailPhase: null, tailTimer: null, tailDirty: false, streamedThisTurn: false, turnChars: 0, turnOutputTokens: null, messageOutputTokens: 0, stateWord: null, waitingOnAgents: 0, fold: null, wait: null, progress: new Map(), progressTimer: null, progressDirty: false, lastModelSettle: null, heldModel: null, heldEffort: null, heldSpawnSwitches: {}, lastEventAtMs: null, streamBlock: null, blockSinceMs: null, livenessTimer: null, livenessDirty: false }
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
        ...(seat.turnOutputTokens !== null ? { turnOutputTokens: seat.turnOutputTokens + seat.messageOutputTokens } : {}),
        ...(seat.tailMessageId !== null ? { messageId: seat.tailMessageId } : {}),
        ...(seat.tailPhase !== null ? { phase: seat.tailPhase } : {}),
        ...(seat.stateWord !== null ? { stateWord: seat.stateWord } : {}),
        ...(seat.stateWord === 'waiting-on-agents' ? { waitingOnAgents: seat.waitingOnAgents } : {}),
        ...(seat.stateWord === 'compacting' && seat.fold !== null ? { fold: seat.fold } : {}),
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
  scheduleTailPublish(seat, dir)
}

function scheduleTailPublish(seat: SeatState, dir?: string): void {
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

function textPhaseOf(raw: unknown): TextPhase | null {
  return raw === 'commentary' || raw === 'final_answer' ? raw : null
}

function foldMessageOutputTokens(seat: SeatState): void {
  if (seat.turnOutputTokens !== null) seat.turnOutputTokens += seat.messageOutputTokens
  seat.messageOutputTokens = 0
}

function onSeatStreamEvent(seat: SeatState, line: string, dir?: string): boolean {
  let frame: { type?: string; event?: { type?: string; content_block?: { type?: string; phase?: unknown; input?: unknown }; delta?: { type?: string; text?: string; thinking?: string; partial_json?: string }; message?: { id?: string }; usage?: { output_tokens?: unknown } } }
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
    if (seat.streamBlock === 'tool_use') {
      const input = ev.content_block?.input
      if (typeof input === 'string') seat.turnChars += input.length
      else if (input && typeof input === 'object' && Object.keys(input).length > 0) seat.turnChars += JSON.stringify(input).length
    }
    if (ev.content_block?.type === 'text') seat.tailPhase = textPhaseOf(ev.content_block.phase)
    publishTailNow(seat, dir)
    return true
  }
  if (ev.type === 'message_start') {
    if (seat.tail !== null) setSeatTail(seat, null, dir)
    const id = ev.message?.id
    seat.tailMessageId = typeof id === 'string' && id !== '' ? id : null
    foldMessageOutputTokens(seat)
    seat.tailPhase = null
    seat.streamBlock = null
    seat.blockSinceMs = null
    publishTailNow(seat, dir)
  } else if (ev.type === 'content_block_delta' && ev.delta?.type === 'text_delta' && typeof ev.delta.text === 'string') {
    seat.streamedThisTurn = true
    seat.turnChars += ev.delta.text.length
    setSeatTail(seat, (seat.tail ?? '') + ev.delta.text, dir)
  } else if (ev.type === 'content_block_delta' && ev.delta?.type === 'thinking_delta' && typeof ev.delta.thinking === 'string') {
    seat.turnChars += ev.delta.thinking.length
    scheduleTailPublish(seat, dir)
  } else if (ev.type === 'content_block_delta' && ev.delta?.type === 'input_json_delta' && typeof ev.delta.partial_json === 'string') {
    seat.turnChars += ev.delta.partial_json.length
    scheduleTailPublish(seat, dir)
  } else if (ev.type === 'message_delta') {
    const outputTokens = ev.usage?.output_tokens
    if (typeof outputTokens === 'number' && Number.isFinite(outputTokens) && outputTokens > 0) {
      seat.messageOutputTokens = Math.floor(outputTokens)
      if (seat.turnOutputTokens === null) seat.turnOutputTokens = 0
      publishTailNow(seat, dir)
    }
  } else if (ev.type === 'content_block_stop' || ev.type === 'message_stop') {
    if (ev.type === 'message_stop') {
      seat.streamBlock = null
      seat.blockSinceMs = null
      foldMessageOutputTokens(seat)
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
  let frame: { type?: string; parent_tool_use_id?: unknown; message?: { id?: string; content?: Array<{ type?: string; text?: string; phase?: unknown }> } }
  try {
    frame = JSON.parse(line) as typeof frame
  } catch {
    return
  }
  if (frame.type !== 'assistant' || !Array.isArray(frame.message?.content)) return
  if (typeof frame.parent_tool_use_id === 'string') return
  const textBlocks = frame.message.content.filter(block => block.type === 'text' && typeof block.text === 'string')
  const text = textBlocks.map(block => block.text).join('')
  if (text !== '') {
    const id = frame.message.id
    seat.tailMessageId = typeof id === 'string' && id !== '' ? id : null
    seat.tailPhase = textPhaseOf(textBlocks[0]?.phase)
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

function publishActivity(short: string, roster: SeatRosterPort | undefined, dir?: string, lastTurnAt?: number): void {
  const seat = seatOf(short)
  markConcourseWorkerActivity(short, {
    turnActive: roster !== undefined ? seatBusy(short, roster) : seat.lastBusy,
    work: seat.lastAnswer?.work,
    waitingOnAgents: seat.waitingOnAgents,
    ...(lastTurnAt !== undefined ? { lastTurnAt } : {}),
  }, dir)
}

function seatTurnStartedAt(short: string, roster: SeatRosterPort): number | undefined {
  return roster.list().find(j => j.short === short)?.turnStartedAt
}

export function switchAppliesWhileAgentsHold(turnOpen: boolean, stateWord: SeatState['stateWord']): boolean {
  if (!turnOpen) return true
  return stateWord === 'waiting-on-agents'
}

function seatBusyForSwitch(short: string, roster: SeatRosterPort): boolean {
  return !switchAppliesWhileAgentsHold(seatBusy(short, roster), seatOf(short).stateWord)
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

export function spawnPostureWordOf(rec: Pick<ConcourseWorkerRecordV1, 'permissionMode'>): { permissionMode: PermissionMode } | Record<string, never> {
  return rec.permissionMode !== undefined ? { permissionMode: rec.permissionMode } : {}
}

function skeletonAnswer(rec: ConcourseWorkerRecordV1): Omit<SessionFactsAnswerV1, 'permissionMode'> & { permissionMode?: PermissionMode } {
  const cwd = rec.worktreePath ?? rec.workspaceId
  return {
    model: { effective: rec.modelKey, setting: rec.modelKey },
    usage: ZERO_USAGE,
    identity: { firstPartyApi: false, consoleBilling: false, claudeAiBilling: false, accountEmail: null },
    skills: [],
    mcp: [],
    ...spawnPostureWordOf(rec),
    workspace: { cwd, originalCwd: cwd, projectRoot: rec.workspaceId, instructionRoots: [] },
    queue: [],
  }
}

export function queueReadinessFacts(seat: Pick<SeatState, 'lastAnswer'>): { queueReady: boolean } {
  return { queueReady: seat.lastAnswer !== null }
}

export function publishSeatFacts(short: string, dir?: string, roster?: SeatRosterPort): void {
  const rec = liveRecordByShort(short, dir)
  if (!rec) return
  const seat = seatOf(short)
  const answer = seat.lastAnswer ?? skeletonAnswer(rec)
  const { box: boxAnswer, ...answerRest } = answer
  const facts: SessionFactsV1 = {
    schema: 1,
    sessionId: rec.sessionId,
    atMs: Date.now(),
    ...answerRest,
    ...(seat.generation > 0 ? { runnerGeneration: seat.generation } : {}),
    ...queueReadinessFacts(seat),
    model: {
      effective: seat.lastAnswer?.model.effective ?? rec.modelKey,
      setting: seat.lastAnswer?.model.setting ?? rec.modelKey,
    },
    pendingModel: rec.pendingModelKey ?? null,
    ...(rec.effort !== undefined ? { effort: rec.effort } : {}),
    spawnSwitches: spawnSwitchFactsOfRecord(rec),
    ...(rec.pendingSpawnSwitches !== undefined && rec.pendingSpawnSwitches.length > 0
      ? { pendingSpawnSwitches: rec.pendingSpawnSwitches.map(p => ({ kind: p.kind, on: p.on })) }
      : {}),
    ...(seat.lastModelSettle !== null ? { modelSettled: seat.lastModelSettle } : {}),
    busy: roster !== undefined ? seatBusy(short, roster) : seat.lastBusy,
    ...(roster !== undefined && seatTurnStartedAt(short, roster) !== undefined ? { turnStartedAt: seatTurnStartedAt(short, roster) } : {}),
    ...saturnFactsOf(rec, Date.now()),
    ...(boxAnswer !== undefined ? { box: boxAnswer } : {}),
  }
  seat.lastBusy = facts.busy
  try {
    publishActivity(short, roster, dir)
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
    if (seats.get(short) === undefined) return
    requestSessionFacts(short, roster, { immediate: true })
    armWorkPoll(short, roster)
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
      request: { subtype: 'schedule_roster', schedules: scheduleRosterToWire(saturnFactsOf(rec, Date.now()).schedules ?? []) },
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
      const answer =
        frame.type === 'control_response' &&
        response?.subtype === 'success' &&
        typeof response.request_id === 'string' &&
        response.request_id.startsWith(SESSION_FACTS_REQUEST_PREFIX)
          ? sessionFactsFromWire(response.response)
          : null
      if (answer !== null) {
        seatOf(short).lastAnswer = answer
        maybeResolveSessionKit(short, answer, dir)
        applySessionScheduleAnswer(short, answer, roster, dir)
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
    line.includes('"task_notification"') ||
    line.includes('"mission_updated"') ||
    line.includes('"samples_updated"')
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
    if (line.includes(SEAT_AGENT_REQUEST_PREFIX)) {
      try {
        settleAgentVerbAnswer(JSON.parse(line) as Parameters<typeof settleAgentVerbAnswer>[0])
      } catch {
      }
    }
    if (line.includes(SEAT_WITHDRAW_REQUEST_PREFIX)) {
      try {
        settleWithdrawAnswer(JSON.parse(line) as Parameters<typeof settleWithdrawAnswer>[0])
      } catch {
      }
    }
    if (line.includes(SEAT_MODE_REQUEST_PREFIX)) {
      try {
        settleModeAnswer(JSON.parse(line) as Parameters<typeof settleModeAnswer>[0])
      } catch {
      }
    }
    if (line.includes(SEAT_MODEL_REQUEST_PREFIX) || line.includes(SEAT_EFFORT_REQUEST_PREFIX) || line.includes(SEAT_SPAWN_SWITCH_REQUEST_PREFIX)) {
      try {
        settleSeatVerbAnswer(JSON.parse(line) as Parameters<typeof settleSeatVerbAnswer>[0])
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
  if (line.includes(SEAT_VERB_APPLIED_SUBTYPE)) {
    try {
      const frame = JSON.parse(line) as Record<string, unknown>
      if (isSeatVerbAppliedParsedFrame(frame)) {
        onSeatVerbApplied(short, frame as unknown as SeatVerbAppliedFrame, roster, dir)
        requestSessionFacts(short, roster, { immediate: true })
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
          const next = decodeRequestWait(requestWaitFromWire(raw))
          noteSeatEvent(seat, dir)
          if (JSON.stringify(seat.wait) !== JSON.stringify(next)) {
            seat.wait = next
            publishTailNow(seat, dir)
          }
          return
        }
        if (frame.status !== null && typeof frame.status === 'object' && 'stream_activity' in (frame.status as object)) {
          noteSeatEvent(seat, dir)
          return
        }
        const statusObject = frame.status !== null && typeof frame.status === 'object' ? (frame.status as { waiting_on_agents?: unknown; compacting?: unknown }) : null
        const waiting = statusObject?.waiting_on_agents
        const foldStamped = statusObject !== null && 'compacting' in statusObject
        const next =
          frame.status === 'compacting' || foldStamped
            ? ('compacting' as const)
            : typeof waiting === 'number' && Number.isFinite(waiting) && waiting > 0
              ? ('waiting-on-agents' as const)
              : null
        const count = next === 'waiting-on-agents' ? Math.floor(waiting as number) : 0
        const fold = foldStamped ? decodeFoldStatus(foldStatusFromWire(statusObject.compacting)) : null
        noteSeatEvent(seat, dir)
        const foldMoved = JSON.stringify(seat.fold) !== JSON.stringify(fold)
        if (seat.stateWord !== next || seat.waitingOnAgents !== count || foldMoved) {
          seat.stateWord = next
          seat.waitingOnAgents = count
          seat.fold = fold
          publishTailNow(seat, dir)
          publishActivity(short, roster, dir)
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
    let tagged = false
    try {
      const parsed = JSON.parse(line) as { type?: string; parent_tool_use_id?: unknown }
      kind = parsed.type
      tagged = typeof parsed.parent_tool_use_id === 'string'
    } catch {
      return
    }
    if (kind === 'assistant') {
      const seat = seatOf(short)
      if (seat.sessionId === null) seat.sessionId = liveRecordByShort(short, dir)?.sessionId ?? null
      noteSeatEvent(seat, dir)
      if (tagged) {
        requestSessionFacts(short, roster)
        return
      }
      onSeatAssistantFrame(seat, line, dir)
      publishActivity(short, roster, dir, Date.now())
      requestSessionFacts(short, roster)
      return
    }
    if (kind === 'result') {
      const seat = seatOf(short)
      seat.streamedThisTurn = false
      seat.turnChars = 0
      seat.turnOutputTokens = null
      seat.messageOutputTokens = 0
      seat.tailMessageId = null
      seat.tailPhase = null
      seat.stateWord = null
      seat.waitingOnAgents = 0
      seat.fold = null
      seat.wait = null
      noteSeatEvent(seat, dir)
      seat.streamBlock = null
      seat.blockSinceMs = null
      setSeatTail(seat, null, dir)
      clearSeatProgress(seat, dir)
      markConcourseWorkerActivity(short, { turnActive: false, work: seat.lastAnswer?.work, lastTurnAt: Date.now() }, dir)
    }
  }
}

export function onSeatIdle(short: string, roster: SeatRosterPort, dir?: string): void {
  const rec = liveRecordByShort(short, dir)
  if (!rec) return
  const seat = seatOf(short)
  const parkedModel = rec.pendingModelKey !== undefined && seat.heldModel === null ? rec.pendingModelKey : undefined
  const parkedEffort = rec.pendingEffort !== undefined && seat.heldEffort === null ? rec.pendingEffort : undefined
  // eslint-disable-next-line no-console
  console.error(`[daemon] seat idle edge: ${short}${parkedModel !== undefined ? ` — applying the parked model ${parkedModel}` : ''}${parkedEffort !== undefined ? ` — applying the parked effort ${parkedEffort}` : ''}`)
  if (parkedModel !== undefined) void forwardModel(rec, parkedModel, roster, dir, { parked: true, settle: true })
  if (parkedEffort !== undefined) void forwardEffort(rec, parkedEffort, roster, dir, { parked: true })
  drainPendingKitDials(short, roster, dir)
  drainPendingSpawnSwitches(short, roster, dir)
  publishSeatFacts(short, dir, roster)
  requestSessionFacts(short, roster, { immediate: true })
}

export function onSeatSpawned(short: string, roster: SeatRosterPort, dir?: string): void {
  rejectRewindWaiters(short, "the session's runner restarted before it answered the rewind — nothing is assumed restored")
  rejectAgentVerbWaiters(short, "the session's runner restarted before it answered — nothing is assumed stopped or resumed")
  rejectWithdrawWaiters(short, "the session's runner restarted before it answered the withdraw — nothing is assumed taken back")
  rejectModeWaiters(short, "the session's runner restarted before it answered the mode change — the band follows its facts")
  const seat = seatOf(short)
  seat.lastAnswer = null
  seat.generation += 1
  seatGenerations.set(short, seat.generation)
  seat.heldModel = null
  seat.heldEffort = null
  seat.heldSpawnSwitches = {}
  rejectSeatVerbWaiters(short)
  seat.sessionId = liveRecordByShort(short, dir)?.sessionId ?? null
  seat.turnChars = 0
  seat.turnOutputTokens = null
  seat.messageOutputTokens = 0
  seat.tailMessageId = null
  seat.tailPhase = null
  const hadWord = seat.stateWord !== null || seat.wait !== null
  seat.stateWord = null
  seat.waitingOnAgents = 0
  seat.fold = null
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
  rejectAgentVerbWaiters(short, "the session's runner ended before it answered — nothing is assumed stopped or resumed")
  rejectWithdrawWaiters(short, "the session's runner ended before it answered the withdraw — nothing is assumed taken back")
  rejectModeWaiters(short, "the session's runner ended before it answered the mode change")
  rejectSeatVerbWaiters(short)
  const seat = seats.get(short)
  if (seat?.debounce !== null && seat?.debounce !== undefined) clearTimeout(seat.debounce)
  if (seat?.workPoll !== null && seat?.workPoll !== undefined) clearTimeout(seat.workPoll)
  if (seat?.tailTimer !== null && seat?.tailTimer !== undefined) clearTimeout(seat.tailTimer)
  if (seat?.progressTimer !== null && seat?.progressTimer !== undefined) clearTimeout(seat.progressTimer)
  if (seat?.livenessTimer !== null && seat?.livenessTimer !== undefined) clearTimeout(seat.livenessTimer)
  seats.delete(short)
}


export type SeatVerbOutcome = { outcome: 'applied' | 'queued' | 'noop' | 'refused'; detail?: string; respawned?: true }

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
  const outcome = response.subtype === 'success' ? rewindOutcomeFromWire(response.response) : null
  if (outcome !== null) {
    waiter.settle(outcome)
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


const SEAT_AGENT_REQUEST_PREFIX = `${SEAT_VERB_REQUEST_PREFIX}agent-`
export const AGENT_VERB_ANSWER_DEADLINE_MS = 10_000

export type SessionAgentVerb = 'stop-agent' | 'resume-agent'

interface AgentVerbWaiter {
  short: string
  settle: (outcome: SeatVerbOutcome) => void
  verb?: string
}

const agentVerbWaiters = new Map<string, AgentVerbWaiter>()
let agentVerbSeq = 0

export function controlSessionAgent(
  sessionId: string,
  agentId: string,
  verb: SessionAgentVerb,
  roster: SeatRosterPort,
  dir?: string,
  opts?: { note?: string; deadlineMs?: number },
): Promise<SeatVerbOutcome> {
  const rec = liveRecordBySession(sessionId, dir)
  if (!rec) return Promise.resolve({ outcome: 'refused', detail: 'unknown-session: no live worker record owns this session' })
  if (agentId === '') return Promise.resolve({ outcome: 'refused', detail: `${verb} requires agentId` })
  const requestId = `${SEAT_AGENT_REQUEST_PREFIX}${verb}-${rec.runnerId}-${Date.now().toString(36)}-${(++agentVerbSeq).toString(36)}`
  const deadlineMs = opts?.deadlineMs ?? AGENT_VERB_ANSWER_DEADLINE_MS
  return new Promise<SeatVerbOutcome>(resolve => {
    const timer = setTimeout(() => {
      if (!agentVerbWaiters.delete(requestId)) return
      resolve({ outcome: 'refused', detail: `the session's runner did not answer the ${verb} within ${Math.round(deadlineMs / 1000)}s` })
    }, deadlineMs)
    timer.unref?.()
    agentVerbWaiters.set(requestId, {
      short: rec.runnerId,
      verb,
      settle: outcome => {
        clearTimeout(timer)
        agentVerbWaiters.delete(requestId)
        resolve(outcome)
      },
    })
    const request =
      verb === 'stop-agent'
        ? { subtype: 'stop_task', task_id: agentId }
        : { subtype: 'resume_task', task_id: agentId, ...(opts?.note !== undefined ? { note: opts.note } : {}) }
    const delivered = roster.control(rec.runnerId, JSON.stringify({ type: 'control_request', request_id: requestId, request }))
    if (!delivered) {
      clearTimeout(timer)
      agentVerbWaiters.delete(requestId)
      resolve({ outcome: 'refused', detail: 'the session has no live control channel' })
      return
    }
    // eslint-disable-next-line no-console
    console.error(`[daemon] seat ${verb} sent: ${rec.runnerId} → ${agentId}`)
  })
}

function settleAgentVerbAnswer(frame: { type?: string; response?: { subtype?: string; request_id?: string; response?: unknown; error?: unknown } }): boolean {
  const response = frame.response
  if (frame.type !== 'control_response' || !response || typeof response.request_id !== 'string') return false
  const waiter = agentVerbWaiters.get(response.request_id)
  if (waiter === undefined) return false
  if (response.subtype === 'success') {
    const payload = response.response && typeof response.response === 'object' ? (response.response as Record<string, unknown>) : {}
    const detail = Object.keys(payload).length > 0 ? JSON.stringify(payload) : undefined
    waiter.settle({ outcome: 'applied', ...(detail !== undefined ? { detail } : {}) })
    return true
  }
  const error = typeof response.error === 'string' && response.error !== '' ? response.error : 'the runner refused the verb'
  const older = /unsupported control request subtype/i.test(error)
  waiter.settle({
    outcome: 'refused',
    detail: older
      ? waiter.verb === 'background-shell'
        ? "this session's runner predates shift+B · /daemon restart, then reopen the session"
        : waiter.verb === 'pause-gate'
          ? "this session's runner predates the pause gate · /daemon restart, then reopen the session"
          : "the session's runner predates the crew stop and resume verbs — /daemon restart when ready, then reopen the session"
      : error,
  })
  return true
}

export function backgroundSessionShell(
  sessionId: string,
  roster: SeatRosterPort,
  dir?: string,
  opts?: { deadlineMs?: number },
): Promise<SeatVerbOutcome> {
  const rec = liveRecordBySession(sessionId, dir)
  if (!rec) return Promise.resolve({ outcome: 'refused', detail: 'unknown-session: no live worker record owns this session' })
  const requestId = `${SEAT_AGENT_REQUEST_PREFIX}background-shell-${rec.runnerId}-${Date.now().toString(36)}-${(++agentVerbSeq).toString(36)}`
  const deadlineMs = opts?.deadlineMs ?? AGENT_VERB_ANSWER_DEADLINE_MS
  return new Promise<SeatVerbOutcome>(resolve => {
    const timer = setTimeout(() => {
      if (!agentVerbWaiters.delete(requestId)) return
      resolve({ outcome: 'refused', detail: `the session's runner did not answer the background-shell within ${Math.round(deadlineMs / 1000)}s` })
    }, deadlineMs)
    timer.unref?.()
    agentVerbWaiters.set(requestId, {
      short: rec.runnerId,
      verb: 'background-shell',
      settle: outcome => {
        clearTimeout(timer)
        agentVerbWaiters.delete(requestId)
        resolve(outcome)
      },
    })
    const delivered = roster.control(rec.runnerId, JSON.stringify({ type: 'control_request', request_id: requestId, request: { subtype: 'background_shell' } }))
    if (!delivered) {
      clearTimeout(timer)
      agentVerbWaiters.delete(requestId)
      resolve({ outcome: 'refused', detail: 'the session has no live control channel' })
      return
    }
    // eslint-disable-next-line no-console
    console.error(`[daemon] seat background-shell sent: ${rec.runnerId}`)
  })
}

export function pauseSessionGate(
  sessionId: string,
  paused: boolean,
  roster: SeatRosterPort,
  dir?: string,
  opts?: { deadlineMs?: number },
): Promise<SeatVerbOutcome> {
  const rec = liveRecordBySession(sessionId, dir)
  if (!rec) return Promise.resolve({ outcome: 'refused', detail: 'unknown-session: no live worker record owns this session' })
  const requestId = `${SEAT_AGENT_REQUEST_PREFIX}pause-gate-${rec.runnerId}-${Date.now().toString(36)}-${(++agentVerbSeq).toString(36)}`
  const deadlineMs = opts?.deadlineMs ?? AGENT_VERB_ANSWER_DEADLINE_MS
  return new Promise<SeatVerbOutcome>(resolve => {
    const timer = setTimeout(() => {
      if (!agentVerbWaiters.delete(requestId)) return
      resolve({ outcome: 'refused', detail: `the session's runner did not answer the pause-gate within ${Math.round(deadlineMs / 1000)}s` })
    }, deadlineMs)
    timer.unref?.()
    agentVerbWaiters.set(requestId, {
      short: rec.runnerId,
      verb: 'pause-gate',
      settle: outcome => {
        clearTimeout(timer)
        agentVerbWaiters.delete(requestId)
        resolve(outcome)
      },
    })
    const delivered = roster.control(rec.runnerId, JSON.stringify({ type: 'control_request', request_id: requestId, request: { subtype: 'pause_gate', paused } }))
    if (!delivered) {
      clearTimeout(timer)
      agentVerbWaiters.delete(requestId)
      resolve({ outcome: 'refused', detail: 'the session has no live control channel' })
      return
    }
    // eslint-disable-next-line no-console
    console.error(`[daemon] seat pause-gate sent: ${rec.runnerId} → ${paused ? 'closed' : 'open'}`)
  })
}

export const QUIESCE_ANSWER_DEADLINE_MS = 10_000

export function quiesceSessionRunner(
  runnerId: string,
  request: QuiescenceRequest,
  roster: Pick<SeatRosterPort, 'control'>,
  opts?: { deadlineMs?: number },
): Promise<QuiescenceAnswer> {
  const requestId = `${SEAT_AGENT_REQUEST_PREFIX}quiesce-${request.action}-${runnerId}-${Date.now().toString(36)}-${(++agentVerbSeq).toString(36)}`
  const deadlineMs = opts?.deadlineMs ?? QUIESCE_ANSWER_DEADLINE_MS
  return new Promise<QuiescenceAnswer>(resolve => {
    const timer = setTimeout(() => {
      if (!agentVerbWaiters.delete(requestId)) return
      resolve({ ok: false, token: request.token, reason: `the session's runner did not answer the quiesce ${request.action} within ${Math.round(deadlineMs / 1000)}s` })
    }, deadlineMs)
    timer.unref?.()
    agentVerbWaiters.set(requestId, {
      short: runnerId,
      settle: outcome => {
        clearTimeout(timer)
        agentVerbWaiters.delete(requestId)
        if (outcome.outcome !== 'applied') {
          resolve({ ok: false, token: request.token, reason: outcome.detail ?? 'the runner refused the quiesce' })
          return
        }
        let payload: { token?: unknown; phase?: unknown } = {}
        try {
          payload = outcome.detail !== undefined ? (JSON.parse(outcome.detail) as { token?: unknown; phase?: unknown }) : {}
        } catch {}
        const phase = payload.phase
        if (payload.token !== request.token || (phase !== 'prepared' && phase !== 'committed' && phase !== 'cancelled')) {
          resolve({ ok: false, token: request.token, reason: 'the runner answered with another token or phase' })
          return
        }
        resolve({ ok: true, token: request.token, phase })
      },
    })
    const delivered = roster.control(runnerId, JSON.stringify({ type: 'control_request', request_id: requestId, request }))
    if (!delivered) {
      clearTimeout(timer)
      agentVerbWaiters.delete(requestId)
      resolve({ ok: false, token: request.token, reason: 'the session has no live control channel' })
    }
  })
}

function rejectAgentVerbWaiters(short: string, detail: string): void {
  for (const [requestId, waiter] of agentVerbWaiters) {
    if (waiter.short !== short) continue
    agentVerbWaiters.delete(requestId)
    waiter.settle({ outcome: 'refused', detail })
  }
}

export function _pendingAgentVerbWaitersForTesting(): number {
  return agentVerbWaiters.size
}

export function settleSeatControlAnswer(line: string): boolean {
  try {
    return settleAgentVerbAnswer(JSON.parse(line) as Parameters<typeof settleAgentVerbAnswer>[0])
  } catch {
    return false
  }
}


const SEAT_WITHDRAW_REQUEST_PREFIX = `${SEAT_VERB_REQUEST_PREFIX}withdraw-`
export const WITHDRAW_ANSWER_DEADLINE_MS = 5_000

export type SeatWithdrawOutcome = SeatVerbOutcome & { withdrawn?: boolean; text?: string; reason?: 'taken' | 'unknown' }

interface WithdrawWaiter {
  short: string
  settle: (outcome: SeatWithdrawOutcome) => void
}

const withdrawWaiters = new Map<string, WithdrawWaiter>()
let withdrawSeq = 0

export function withdrawSessionSend(
  sessionId: string,
  clientMessageId: string,
  roster: SeatRosterPort,
  dir?: string,
  opts?: { deadlineMs?: number },
): Promise<SeatWithdrawOutcome> {
  const rec = liveRecordBySession(sessionId, dir)
  if (!rec) return Promise.resolve({ outcome: 'refused', detail: 'unknown-session: no live worker record owns this session' })
  if (clientMessageId === '') return Promise.resolve({ outcome: 'refused', detail: 'withdraw-send requires clientMessageId' })
  const requestId = `${SEAT_WITHDRAW_REQUEST_PREFIX}${rec.runnerId}-${Date.now().toString(36)}-${(++withdrawSeq).toString(36)}`
  const deadlineMs = opts?.deadlineMs ?? WITHDRAW_ANSWER_DEADLINE_MS
  return new Promise<SeatWithdrawOutcome>(resolve => {
    const timer = setTimeout(() => {
      if (!withdrawWaiters.delete(requestId)) return
      resolve({ outcome: 'refused', detail: `the session's runner did not answer the withdraw within ${Math.round(deadlineMs / 1000)}s` })
    }, deadlineMs)
    timer.unref?.()
    withdrawWaiters.set(requestId, {
      short: rec.runnerId,
      settle: outcome => {
        clearTimeout(timer)
        withdrawWaiters.delete(requestId)
        resolve(outcome)
      },
    })
    const delivered = roster.control(
      rec.runnerId,
      JSON.stringify({ type: 'control_request', request_id: requestId, request: { subtype: 'withdraw_send', client_message_id: clientMessageId } }),
    )
    if (!delivered) {
      clearTimeout(timer)
      withdrawWaiters.delete(requestId)
      resolve({ outcome: 'refused', detail: 'the session has no live control channel' })
    }
  })
}

function settleWithdrawAnswer(frame: { type?: string; response?: { subtype?: string; request_id?: string; response?: unknown; error?: unknown } }): boolean {
  const response = frame.response
  if (frame.type !== 'control_response' || !response || typeof response.request_id !== 'string') return false
  const waiter = withdrawWaiters.get(response.request_id)
  if (waiter === undefined) return false
  if (response.subtype === 'success') {
    const payload = response.response && typeof response.response === 'object' ? (response.response as Record<string, unknown>) : {}
    if (payload.withdrawn === true) {
      waiter.settle({ outcome: 'applied', withdrawn: true, text: typeof payload.text === 'string' ? payload.text : '' })
      return true
    }
    const reason: 'taken' | 'unknown' = payload.reason === 'taken' ? 'taken' : 'unknown'
    waiter.settle({ outcome: 'refused', withdrawn: false, reason, detail: reason === 'taken' ? 'the runner already took the line' : "the runner's queue never held the line" })
    return true
  }
  const error = typeof response.error === 'string' && response.error !== '' ? response.error : 'the runner refused the withdraw'
  const older = /unsupported control request subtype/i.test(error)
  waiter.settle({
    outcome: 'refused',
    detail: older ? "the session's runner predates the recall — /daemon restart when ready, then reopen the session" : error,
  })
  return true
}

function rejectWithdrawWaiters(short: string, detail: string): void {
  for (const [requestId, waiter] of withdrawWaiters) {
    if (waiter.short !== short) continue
    withdrawWaiters.delete(requestId)
    waiter.settle({ outcome: 'refused', detail })
  }
}

export function _pendingWithdrawWaitersForTesting(): number {
  return withdrawWaiters.size
}

const SEAT_MODEL_REQUEST_PREFIX = `${SEAT_VERB_REQUEST_PREFIX}set-model-`
const SEAT_EFFORT_REQUEST_PREFIX = `${SEAT_VERB_REQUEST_PREFIX}set-effort-`
const SEAT_SPAWN_SWITCH_REQUEST_PREFIX = `${SEAT_VERB_REQUEST_PREFIX}spawn-switch-`
export const SEAT_VERB_ANSWER_DEADLINE_MS = 5_000

type SeatVerbAnswer = { at: 'now' | 'turn-boundary'; model?: string } | { refused: string } | { silent: true }
type SeatVerbWaiter = { short: string; settle: (answer: SeatVerbAnswer) => void }
const seatVerbWaiters = new Map<string, SeatVerbWaiter>()
let seatVerbSeq = 0

function seatVerbRequestId(short: string, verb: 'set-model' | 'set-effort' | 'spawn-switch'): string {
  return `${SEAT_VERB_REQUEST_PREFIX}${verb}-${short}-${Date.now().toString(36)}-${(++seatVerbSeq).toString(36)}`
}

function awaitSeatVerbAnswer(short: string, requestId: string): { answer: Promise<SeatVerbAnswer>; abandon: () => void } {
  let settle: (answer: SeatVerbAnswer) => void = () => {}
  const answer = new Promise<SeatVerbAnswer>(resolve => {
    const timer = setTimeout(() => {
      if (seatVerbWaiters.delete(requestId)) resolve({ silent: true })
    }, SEAT_VERB_ANSWER_DEADLINE_MS)
    timer.unref?.()
    settle = (word: SeatVerbAnswer): void => {
      clearTimeout(timer)
      seatVerbWaiters.delete(requestId)
      resolve(word)
    }
    seatVerbWaiters.set(requestId, { short, settle })
  })
  return { answer, abandon: () => settle({ silent: true }) }
}

function settleSeatVerbAnswer(frame: { type?: string; response?: { subtype?: string; request_id?: string; response?: unknown; error?: unknown } }): boolean {
  const response = frame.response
  if (frame.type !== 'control_response' || !response || typeof response.request_id !== 'string') return false
  const waiter = seatVerbWaiters.get(response.request_id)
  if (waiter === undefined) return false
  if (response.subtype === 'success') {
    const answer = response.response !== null && typeof response.response === 'object' ? (response.response as { at?: unknown; model?: unknown }) : {}
    waiter.settle({ at: answer.at === 'turn-boundary' ? 'turn-boundary' : 'now', ...(typeof answer.model === 'string' && answer.model !== '' ? { model: answer.model } : {}) })
    return true
  }
  const error = typeof response.error === 'string' && response.error !== '' ? response.error : 'the runner refused the switch'
  waiter.settle({ refused: error })
  return true
}

function rejectSeatVerbWaiters(short: string): void {
  for (const waiter of [...seatVerbWaiters.values()]) {
    if (waiter.short === short) waiter.settle({ silent: true })
  }
}

function parkModel(rec: ConcourseWorkerRecordV1, model: string, dir?: string): void {
  updateConcourseWorkers(workers => {
    const w = workers[rec.runnerId]
    if (w && w.endedAt === undefined) {
      if (w.modelKey === model) delete w.pendingModelKey
      else w.pendingModelKey = model
    }
  }, dir)
}

function unparkModel(rec: ConcourseWorkerRecordV1, dir?: string): void {
  updateConcourseWorkers(workers => {
    const w = workers[rec.runnerId]
    if (w && w.endedAt === undefined) delete w.pendingModelKey
  }, dir)
}

function landModel(rec: ConcourseWorkerRecordV1, model: string, roster: SeatRosterPort, dir: string | undefined, settle: boolean, served?: string): void {
  // eslint-disable-next-line no-console
  console.error(`[daemon] seat set-model applied: ${rec.runnerId} → ${model}`)
  const seat = seatOf(rec.runnerId)
  if (settle) {
    const from = seat.lastAnswer?.model.effective ?? rec.modelKey
    seat.lastModelSettle = { from, to: model, atMs: Date.now() }
  }
  if (seat.lastAnswer !== null) {
    seat.lastAnswer = { ...seat.lastAnswer, model: { effective: served ?? model, setting: model } }
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
}

async function forwardModel(rec: ConcourseWorkerRecordV1, model: string, roster: SeatRosterPort, dir: string | undefined, opts: { parked: boolean; settle: boolean }): Promise<SeatVerbOutcome> {
  const queued: SeatVerbOutcome = { outcome: 'queued', detail: `${model} applies when this turn ends` }
  const requestId = seatVerbRequestId(rec.runnerId, 'set-model')
  const waiter = awaitSeatVerbAnswer(rec.runnerId, requestId)
  const delivered = roster.control(
    rec.runnerId,
    JSON.stringify({
      type: 'control_request',
      request_id: requestId,
      request: { subtype: 'set_model', model },
    }),
  )
  if (!delivered) {
    waiter.abandon()
    return opts.parked ? queued : respawnOnModel(rec, model, roster, dir)
  }
  const seat = seatOf(rec.runnerId)
  seat.heldModel = { requestId, model }
  const word = await waiter.answer
  if ('at' in word && word.at === 'turn-boundary') {
    if (!opts.parked) {
      parkModel(rec, model, dir)
      publishSeatFacts(rec.runnerId, dir, roster)
    }
    logForDebugging(`[daemon] seat set-model held by the runner for its turn boundary: ${rec.runnerId} → ${model}`)
    return queued
  }
  if (seat.heldModel !== null && seat.heldModel.requestId === requestId) seat.heldModel = null
  if ('refused' in word) {
    if (opts.parked) {
      unparkModel(rec, dir)
      publishSeatFacts(rec.runnerId, dir, roster)
    }
    return { outcome: 'refused', detail: word.refused }
  }
  if ('silent' in word && opts.parked) return queued
  landModel(rec, model, roster, dir, 'at' in word && opts.settle, 'model' in word ? word.model : undefined)
  return { outcome: 'applied', detail: liveSwitchReceipt(rec, model, dir) }
}

function liveSwitchReceipt(rec: ConcourseWorkerRecordV1, model: string, dir?: string): string {
  const plain = `${rec.runnerId} → ${model}`
  const now = liveRecordByShort(rec.runnerId, dir) ?? rec
  return now.crash === undefined ? plain : `${goneRunnerWords(now, undefined)} and is back — ${plain}`
}

export async function setSessionModel(sessionId: string, model: string, roster: SeatRosterPort, dir?: string): Promise<SeatVerbOutcome> {
  const rec = liveRecordBySession(sessionId, dir)
  if (!rec) return { outcome: 'refused', detail: 'unknown-session: no live worker record owns this session' }
  if (rec.modelKey === model && rec.pendingModelKey === undefined) return { outcome: 'noop', detail: `already on ${model}` }
  const gone = rec.pid !== undefined && !workerPidAlive(rec)
  const parked = !gone && seatBusyForSwitch(rec.runnerId, roster)
  if (parked) {
    parkModel(rec, model, dir)
    // eslint-disable-next-line no-console
    console.error(`[daemon] seat set-model parked (the session is mid-turn): ${rec.runnerId} → ${model}`)
    publishSeatFacts(rec.runnerId, dir, roster)
  }
  return forwardModel(rec, model, roster, dir, { parked, settle: false })
}

function clockOf(atMs: number): string {
  return new Date(atMs).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false })
}

function goneRunnerWords(rec: ConcourseWorkerRecordV1, row: { outcome?: string } | undefined): string {
  if (rec.crash !== undefined) {
    const head = rec.crash.reason.replace(/ · resumed.*$/, '').replace(/ — .*$/, '')
    return `the runner had exited at ${clockOf(rec.crash.at)} (${head})`
  }
  if (row?.outcome === 'killed') return 'the runner had been cut (the stop)'
  return 'the runner had exited'
}

async function respawnOnModel(rec: ConcourseWorkerRecordV1, model: string, roster: SeatRosterPort, dir?: string): Promise<SeatVerbOutcome> {
  const row = roster.list().find(j => j.short === rec.runnerId)
  if (roster.registerLongLived === undefined || roster.has === undefined || roster.kill === undefined) {
    return { outcome: 'refused', detail: 'the session has no live control channel, and this roster cannot respawn its runner' }
  }
  refreshSignInReads(true)
  const validated = await validateWorkerModelChoice(model, 'session')
  if (!validated.ok) {
    const read = validated.reason.startsWith('no-credential:') ? ` — ${describeSignInRead(validated.reason.slice('no-credential:'.length))}` : ''
    return {
      outcome: 'refused',
      detail: `${goneRunnerWords(rec, row)} and cannot restart on ${model}: model refused (${validated.reason})${validated.action !== undefined ? ` · ${validated.action}` : ''}${validated.detail !== undefined ? ` — ${validated.detail}` : ''}${read}`,
    }
  }
  const name = ((): string => {
    try {
      return getMarketingNameForModel(model) ?? model
    } catch {
      return model
    }
  })()
  if (row !== undefined && row.outcome === undefined && row.state === 'spawning') {
    roster.patchSeatModel(rec.runnerId, model)
    updateConcourseWorkers(workers => {
      const w = workers[rec.runnerId]
      if (w && w.endedAt === undefined) {
        w.modelKey = model
        delete w.pendingModelKey
      }
    }, dir)
    const receipt = `${goneRunnerWords(rec, row)} — restarting on ${name}`
    // eslint-disable-next-line no-console
    console.error(`[daemon] seat set-model rides the respawn: ${rec.runnerId} → ${model} (${receipt})`)
    publishSeatFacts(rec.runnerId, dir, roster)
    return { outcome: 'applied', detail: receipt, respawned: true }
  }
  const reviveRoster = {
    kill: (short: string): boolean => roster.kill!(short),
    has: (short: string): { present: boolean } => roster.has!(short),
    registerLongLived: (short: string, spec: StreamJsonChildSpec): { ok: boolean; pid?: number; error?: string } => roster.registerLongLived!(short, spec),
  }
  const revived = reviveConcourseWorker(rec.sessionId, 'operator:set-model', reviveRoster, { clearCrash: true, modelOverride: model }, dir)
  if (revived.outcome === 'noop') {
    return { outcome: 'refused', detail: `the runner's control channel is closed while its process (pid ${rec.pid ?? '?'}) still stands — retry in a moment` }
  }
  if (revived.outcome === 'refused') {
    return { outcome: 'refused', detail: `${goneRunnerWords(rec, row)} and could not restart on ${model}: ${revived.detail ?? revived.reason}` }
  }
  const receipt = `${goneRunnerWords(rec, row)} — restarted on ${name}`
  // eslint-disable-next-line no-console
  console.error(`[daemon] seat set-model respawned: ${rec.runnerId} → ${model} (${receipt})`)
  onSeatSpawned(rec.runnerId, roster, dir)
  return { outcome: 'applied', detail: receipt, respawned: true }
}

function parkEffort(rec: ConcourseWorkerRecordV1, effort: string, dir?: string): void {
  updateConcourseWorkers(workers => {
    const w = workers[rec.runnerId]
    if (w && w.endedAt === undefined) {
      if (w.effort === effort) delete w.pendingEffort
      else w.pendingEffort = effort
    }
  }, dir)
}

function unparkEffort(rec: ConcourseWorkerRecordV1, dir?: string): void {
  updateConcourseWorkers(workers => {
    const w = workers[rec.runnerId]
    if (w && w.endedAt === undefined) delete w.pendingEffort
  }, dir)
}

function landEffort(rec: ConcourseWorkerRecordV1, effort: string, roster: SeatRosterPort, dir?: string): void {
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
  requestSessionFacts(rec.runnerId, roster, { immediate: true })
}

async function forwardEffort(rec: ConcourseWorkerRecordV1, effort: string, roster: SeatRosterPort, dir: string | undefined, opts: { parked: boolean }): Promise<SeatVerbOutcome> {
  const queued: SeatVerbOutcome = { outcome: 'queued', detail: `${effort} applies when this turn ends` }
  const requestId = seatVerbRequestId(rec.runnerId, 'set-effort')
  const waiter = awaitSeatVerbAnswer(rec.runnerId, requestId)
  const delivered = roster.control(
    rec.runnerId,
    JSON.stringify({
      type: 'control_request',
      request_id: requestId,
      request: { subtype: 'set_effort', effort },
    }),
  )
  if (!delivered) {
    waiter.abandon()
    return opts.parked ? queued : { outcome: 'refused', detail: 'the session has no live control channel' }
  }
  const seat = seatOf(rec.runnerId)
  seat.heldEffort = { requestId, effort }
  const word = await waiter.answer
  if ('at' in word && word.at === 'turn-boundary') {
    if (!opts.parked) {
      parkEffort(rec, effort, dir)
      publishSeatFacts(rec.runnerId, dir, roster)
    }
    logForDebugging(`[daemon] seat set-effort held by the runner for its turn boundary: ${rec.runnerId} → ${effort}`)
    return queued
  }
  if (seat.heldEffort !== null && seat.heldEffort.requestId === requestId) seat.heldEffort = null
  if ('refused' in word) {
    if (opts.parked) {
      unparkEffort(rec, dir)
      publishSeatFacts(rec.runnerId, dir, roster)
    }
    return { outcome: 'refused', detail: word.refused }
  }
  if ('silent' in word && opts.parked) return queued
  landEffort(rec, effort, roster, dir)
  return { outcome: 'applied', detail: `${rec.runnerId} → ${effort}` }
}

function onSeatVerbApplied(short: string, frame: SeatVerbAppliedFrame, roster: SeatRosterPort, dir?: string): void {
  const rec = liveRecordByShort(short, dir)
  if (!rec) return
  const seat = seatOf(short)
  if (frame.verb === 'set_model') {
    const held = seat.heldModel !== null && seat.heldModel.requestId === frame.request_id ? seat.heldModel : null
    const model = held !== null ? held.model : typeof frame.model === 'string' && rec.pendingModelKey === frame.model ? frame.model : undefined
    if (model === undefined) return
    if (held !== null) seat.heldModel = null
    const served = typeof frame.model === 'string' && frame.model !== '' ? frame.model : undefined
    landModel(rec, model, roster, dir, rec.pendingModelKey === model, served)
    return
  }
  if (frame.verb === 'spawn_switch') {
    const kind = frame.switch
    const on = frame.on
    if ((kind !== 'subagents' && kind !== 'workflows') || typeof on !== 'boolean') return
    const heldToggle = seat.heldSpawnSwitches[kind]
    const known = heldToggle !== undefined ? heldToggle.requestId === frame.request_id : (rec.pendingSpawnSwitches ?? []).some(p => p.kind === kind && p.on === on)
    if (!known) return
    if (heldToggle !== undefined) dropHeldSpawnSwitch(seat, kind, heldToggle.requestId)
    landSpawnSwitchOnRecord(rec, { kind, on }, roster, dir, true)
    return
  }
  const held = seat.heldEffort !== null && seat.heldEffort.requestId === frame.request_id ? seat.heldEffort : null
  const effort = held !== null ? held.effort : typeof frame.effort === 'string' && rec.pendingEffort === frame.effort ? frame.effort : undefined
  if (effort === undefined) return
  if (held !== null) seat.heldEffort = null
  landEffort(rec, effort, roster, dir)
}

export async function setSessionEffort(sessionId: string, effort: string, roster: SeatRosterPort, dir?: string): Promise<SeatVerbOutcome> {
  const level = normalizeEffortLevelString(effort)
  if (level === undefined) {
    return { outcome: 'refused', detail: `unknown effort '${effort}' — the levels are ${EFFORT_LEVELS.join(' | ')}` }
  }
  effort = level
  const rec = liveRecordBySession(sessionId, dir)
  if (!rec) return { outcome: 'refused', detail: 'unknown-session: no live worker record owns this session' }
  if (rec.effort === effort && rec.pendingEffort === undefined) return { outcome: 'noop', detail: `already on ${effort}` }
  const parked = seatBusyForSwitch(rec.runnerId, roster)
  if (parked) {
    parkEffort(rec, effort, dir)
    // eslint-disable-next-line no-console
    console.error(`[daemon] seat set-effort parked (the session is mid-turn): ${rec.runnerId} → ${effort}`)
    publishSeatFacts(rec.runnerId, dir, roster)
  }
  return forwardEffort(rec, effort, roster, dir, { parked })
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
      request: { subtype: 'kit_edit', kit: sessionKitToWire(rec.kit) },
    }),
  )
}


export async function setSessionSpawnSwitch(
  sessionId: string,
  toggle: { kind: SpawnSwitchKind; on: boolean },
  by: string,
  roster: SeatRosterPort,
  dir?: string,
): Promise<SeatVerbOutcome> {
  const rec = liveRecordBySession(sessionId, dir)
  if (!rec) return { outcome: 'refused', detail: 'unknown-session: no live worker record owns this session' }
  const parkedForKind = (rec.pendingSpawnSwitches ?? []).filter(p => p.kind === toggle.kind)
  const parked = parkedForKind[parkedForKind.length - 1]
  const effectiveOn = parked !== undefined ? parked.on : spawnSwitchOfRecord(rec, toggle.kind).on
  if (effectiveOn === toggle.on) return { outcome: 'noop', detail: spawnSwitchToggleReceipt(toggle.kind, toggle.on, 'noop') }
  if (seatBusy(rec.runnerId, roster)) {
    parkSpawnSwitch(rec, toggle, by, dir)
    // eslint-disable-next-line no-console
    console.error(`[daemon] seat set-spawn-switch parked (the session is mid-turn): ${rec.runnerId} → ${toggle.kind} ${toggle.on ? 'on' : 'off'}`)
    publishSeatFacts(rec.runnerId, dir, roster)
    return forwardSpawnSwitchToBoundary(rec, toggle, by, roster, dir, { parked: true })
  }
  return forwardSpawnSwitchToBoundary(rec, toggle, by, roster, dir, { parked: false })
}

function parkSpawnSwitch(rec: ConcourseWorkerRecordV1, toggle: { kind: SpawnSwitchKind; on: boolean }, by: string, dir?: string): void {
  updateConcourseWorkers(workers => {
    const w = workers[rec.runnerId]
    if (w && w.endedAt === undefined) {
      w.pendingSpawnSwitches = [...(w.pendingSpawnSwitches ?? []).filter(p => p.kind !== toggle.kind), { kind: toggle.kind, on: toggle.on, by }]
    }
  }, dir)
}

function unparkSpawnSwitch(rec: ConcourseWorkerRecordV1, kind: SpawnSwitchKind, dir?: string): void {
  updateConcourseWorkers(workers => {
    const w = workers[rec.runnerId]
    if (!w || w.endedAt !== undefined) return
    const rest = (w.pendingSpawnSwitches ?? []).filter(p => p.kind !== kind)
    if (rest.length > 0) w.pendingSpawnSwitches = rest
    else delete w.pendingSpawnSwitches
  }, dir)
}

function dropHeldSpawnSwitch(seat: SeatState, kind: SpawnSwitchKind, requestId: string): void {
  const held = seat.heldSpawnSwitches[kind]
  if (held === undefined || held.requestId !== requestId) return
  const rest: SeatState['heldSpawnSwitches'] = {}
  for (const other of SPAWN_SWITCH_KINDS) {
    const entry = seat.heldSpawnSwitches[other]
    if (other !== kind && entry !== undefined) rest[other] = entry
  }
  seat.heldSpawnSwitches = rest
}

async function forwardSpawnSwitchToBoundary(
  rec: ConcourseWorkerRecordV1,
  toggle: { kind: SpawnSwitchKind; on: boolean },
  by: string,
  roster: SeatRosterPort,
  dir: string | undefined,
  opts: { parked: boolean },
): Promise<SeatVerbOutcome> {
  const queued: SeatVerbOutcome = { outcome: 'queued', detail: spawnSwitchToggleReceipt(toggle.kind, toggle.on, 'queued') }
  const requestId = seatVerbRequestId(rec.runnerId, 'spawn-switch')
  const waiter = awaitSeatVerbAnswer(rec.runnerId, requestId)
  const delivered = roster.control(
    rec.runnerId,
    JSON.stringify({
      type: 'control_request',
      request_id: requestId,
      request: { subtype: 'spawn_switch', switch: toggle.kind, on: toggle.on },
    }),
  )
  if (!delivered) {
    waiter.abandon()
    return opts.parked ? queued : landSpawnSwitchOnRecord(rec, toggle, roster, dir, false)
  }
  const seat = seatOf(rec.runnerId)
  seat.heldSpawnSwitches = { ...seat.heldSpawnSwitches, [toggle.kind]: { requestId, on: toggle.on } }
  const word = await waiter.answer
  if ('at' in word && word.at === 'turn-boundary') {
    if (!opts.parked) {
      parkSpawnSwitch(rec, toggle, by, dir)
      publishSeatFacts(rec.runnerId, dir, roster)
    }
    logForDebugging(`[daemon] seat set-spawn-switch held by the runner for its turn boundary: ${rec.runnerId} → ${toggle.kind} ${toggle.on ? 'on' : 'off'}`)
    return queued
  }
  dropHeldSpawnSwitch(seat, toggle.kind, requestId)
  if ('refused' in word) {
    if (opts.parked) {
      unparkSpawnSwitch(rec, toggle.kind, dir)
      publishSeatFacts(rec.runnerId, dir, roster)
    }
    return { outcome: 'refused', detail: spawnSwitchToggleReceipt(toggle.kind, toggle.on, 'refused', word.refused) }
  }
  if ('silent' in word && opts.parked) return queued
  return landSpawnSwitchOnRecord(rec, toggle, roster, dir, true)
}

function landSpawnSwitchOnRecord(
  rec: ConcourseWorkerRecordV1,
  toggle: { kind: SpawnSwitchKind; on: boolean },
  roster: SeatRosterPort,
  dir: string | undefined,
  delivered: boolean,
): SeatVerbOutcome {
  updateConcourseWorkers(workers => {
    const w = workers[rec.runnerId]
    if (!w || w.endedAt !== undefined) return
    w.spawnSwitches = { ...(w.spawnSwitches ?? {}), [toggle.kind]: toggle.on ? 'on' : 'off' }
    const rest = (w.pendingSpawnSwitches ?? []).filter(p => p.kind !== toggle.kind)
    if (rest.length > 0) w.pendingSpawnSwitches = rest
    else delete w.pendingSpawnSwitches
  }, dir)
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
  const seat = seatOf(short)
  const parked = (rec.pendingSpawnSwitches ?? []).filter(p => seat.heldSpawnSwitches[p.kind] === undefined)
  if (parked.length === 0) return
  // eslint-disable-next-line no-console
  console.error(`[daemon] seat set-spawn-switch applying ${parked.length} parked toggle${parked.length === 1 ? '' : 's'} at the turn's end: ${short}`)
  for (const entry of parked) {
    const fresh = liveRecordByShort(short, dir)
    if (fresh) void forwardSpawnSwitchToBoundary(fresh, { kind: entry.kind, on: entry.on }, entry.by, roster, dir, { parked: true })
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


const SEAT_MODE_REQUEST_PREFIX = `${SEAT_VERB_REQUEST_PREFIX}set-permission-mode-`
export const PERMISSION_MODE_ANSWER_DEADLINE_MS = 5_000

interface ModeWaiter {
  short: string
  mode: string
  settle: (outcome: SeatVerbOutcome) => void
}

const modeWaiters = new Map<string, ModeWaiter>()
let modeSeq = 0

export function setSessionPermissionMode(
  sessionId: string,
  mode: string,
  roster: SeatRosterPort,
  dir?: string,
  opts?: { deadlineMs?: number },
): Promise<SeatVerbOutcome> {
  const rec = liveRecordBySession(sessionId, dir)
  if (!rec) return Promise.resolve({ outcome: 'refused', detail: 'unknown-session: no live worker record owns this session' })
  const requestId = `${SEAT_MODE_REQUEST_PREFIX}${rec.runnerId}-${Date.now().toString(36)}-${(++modeSeq).toString(36)}`
  const deadlineMs = opts?.deadlineMs ?? PERMISSION_MODE_ANSWER_DEADLINE_MS
  return new Promise<SeatVerbOutcome>(resolve => {
    const timer = setTimeout(() => {
      if (!modeWaiters.delete(requestId)) return
      resolve({ outcome: 'refused', detail: `the session's runner did not answer the mode change within ${Math.round(deadlineMs / 1000)}s — the band follows its facts` })
    }, deadlineMs)
    timer.unref?.()
    modeWaiters.set(requestId, {
      short: rec.runnerId,
      mode,
      settle: outcome => {
        clearTimeout(timer)
        modeWaiters.delete(requestId)
        resolve(outcome)
      },
    })
    const delivered = roster.control(
      rec.runnerId,
      JSON.stringify({
        type: 'control_request',
        request_id: requestId,
        request: { subtype: 'set_permission_mode', mode },
      }),
    )
    if (!delivered) {
      clearTimeout(timer)
      modeWaiters.delete(requestId)
      resolve({ outcome: 'refused', detail: 'the session has no live control channel' })
    }
  })
}

function settleModeAnswer(frame: { type?: string; response?: { subtype?: string; request_id?: string; error?: unknown } }): boolean {
  const response = frame.response
  if (frame.type !== 'control_response' || !response || typeof response.request_id !== 'string') return false
  const waiter = modeWaiters.get(response.request_id)
  if (waiter === undefined) return false
  if (response.subtype === 'success') {
    waiter.settle({ outcome: 'applied', detail: `${waiter.short} mode → ${waiter.mode}` })
    return true
  }
  const error = typeof response.error === 'string' && response.error !== '' ? response.error : 'the runner refused the mode change'
  waiter.settle({ outcome: 'refused', detail: error })
  return true
}

function rejectModeWaiters(short: string, detail: string): void {
  for (const [requestId, waiter] of modeWaiters) {
    if (waiter.short !== short) continue
    modeWaiters.delete(requestId)
    waiter.settle({ outcome: 'refused', detail })
  }
}

export function _pendingModeWaitersForTesting(): number {
  return modeWaiters.size
}

export function refreshSessionFacts(sessionId: string, roster: SeatRosterPort, dir?: string): SeatVerbOutcome {
  const rec = liveRecordBySession(sessionId, dir)
  if (!rec) return { outcome: 'refused', detail: 'unknown-session: no live worker record owns this session' }
  requestSessionFacts(rec.runnerId, roster, { immediate: true })
  return { outcome: 'applied', detail: `facts requested from ${rec.runnerId}` }
}
