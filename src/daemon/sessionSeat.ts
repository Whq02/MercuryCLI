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
import { decodeRequestWait, type RequestWaitV1 } from '../services/providers/streamIdleBudget.js'
import { decodeFoldStatus, type FoldStatusV1 } from '../services/compact/foldStatus.js'
import { workRowRuns } from '../services/engine-connector/workCounts.js'
import { EFFORT_LEVELS, normalizeEffortLevelString } from '../utils/effort.js'
import { markConcourseWorkerActivity, readSessionWorkers, reviveConcourseWorker, updateConcourseWorkers, workerPidAlive, type ConcourseWorkerRecordV1 } from './concourseSupervisor.js'
import type { LooseRow } from '../rows/read.js'
import type { ParamsOf, ResultOf, SessionAppliedParams } from '../runner/wire/methods.js'
import { isRpcError, RPC_METHOD_NOT_FOUND } from '../runner/wire/errors.js'
import { PeerClosed, PeerDeadline, type RequestOptions } from '../runner/wire/peer.js'
import type { RunnerDoor, Verb } from './runnerConnection.js'
import type { RunnerChildSpec } from './headlessRun.js'
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
import { retireWorkerAsks, RUNNER_ENDED_ASK_CAUSE, RUNNER_RESTARTED_ASK_CAUSE } from './permissionAsks.js'
import type { QuiescenceAnswer, QuiescenceRequest } from './runnerQuiescence.js'
import type { SessionRewindMode, SessionRewindOutcomeV1 } from './protocol.js'

export interface SeatRosterPort {
  door(short: string): RunnerDoor | undefined
  list(): ReadonlyArray<{ short: string; outcome?: string; busy?: boolean; turnActive?: boolean; state?: string; turnStartedAt?: number }>
  patchSeatModel(short: string, model: string): boolean
  patchSeatEffort(short: string, effort: string): boolean
  has?(short: string): { present: boolean }
  kill?(short: string): boolean
  registerLongLived?(short: string, spec: RunnerChildSpec): { ok: boolean; pid?: number; error?: string }
}

export const REWIND_ANSWER_DEADLINE_MS = 30_000

export function relayCredentialChange(
  roster: Pick<SeatRosterPort, 'door'> & { liveWorkerFacts(): ReadonlyArray<{ short: string; kind: 'long-lived' | 'one-shot' }> },
): string[] {
  const told: string[] = []
  for (const worker of roster.liveWorkerFacts()) {
    if (worker.kind !== 'long-lived') continue
    const door = roster.door(worker.short)
    if (door === undefined || door.closed) continue
    door.notify('credentials/changed', {})
    told.push(worker.short)
  }
  return told
}

export type DoorFailure = { kind: 'left' | 'silent' | 'older' | 'refused'; words: string }

export function doorFailureOf(error: unknown, verb: string, deadlineMs: number): DoorFailure {
  if (error instanceof PeerClosed) return { kind: 'left', words: `the session's runner left before it answered the ${verb}` }
  if (error instanceof PeerDeadline) return { kind: 'silent', words: `the session's runner did not answer the ${verb} within ${Math.round(deadlineMs / 1000)}s` }
  if (isRpcError(error) && error.code === RPC_METHOD_NOT_FOUND) return { kind: 'older', words: `the session's runner predates the ${verb}` }
  const words = error instanceof Error && error.message !== '' ? error.message : `the runner refused the ${verb}`
  return { kind: 'refused', words }
}

export const NO_DOOR_DETAIL = 'the session has no live runner door'

function runnerAnswered(asked: { ok: true } | { ok: false; failure: DoorFailure }): boolean {
  return asked.ok || (asked.failure.kind !== 'silent' && asked.failure.kind !== 'left')
}

export async function askSeat<M extends Verb>(
  roster: Pick<SeatRosterPort, 'door'>,
  short: string,
  method: M,
  params: ParamsOf<M>,
  verb: string,
  deadlineMs: number,
  opts?: Pick<RequestOptions, 'signal'>,
): Promise<{ ok: true; result: ResultOf<M>; id: number } | { ok: false; failure: DoorFailure; id: number | null }> {
  const door = roster.door(short)
  if (door === undefined || door.closed) return { ok: false, failure: { kind: 'left', words: NO_DOOR_DETAIL }, id: null }
  const sent = door.send(method, params, { deadlineMs, ...(opts?.signal !== undefined ? { signal: opts.signal } : {}) })
  try {
    return { ok: true, result: await sent.answer, id: sent.id }
  } catch (error) {
    return { ok: false, failure: doorFailureOf(error, verb, deadlineMs), id: sent.id }
  }
}
const FACTS_DEBOUNCE_MS = 250

interface SeatState {
  short: string
  lastAnswer: SessionFactsAnswerV1 | null
  generation: number
  debounce: ReturnType<typeof setTimeout> | null
  workPoll: ReturnType<typeof setTimeout> | null
  lastBusy: boolean
  lastFactsAtMs: number
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
  turnThinkingChars: number
  firstByteAtMs: number | null
  stateWord: 'compacting' | 'waiting-on-agents' | null
  waitingOnAgents: number
  fold: FoldStatusV1 | null
  wait: RequestWaitV1 | null
  progress: Map<string, SessionProgressEntryV1>
  progressTimer: ReturnType<typeof setTimeout> | null
  progressDirty: boolean
  lastModelSettle: { from: string; to: string; atMs: number } | null
  heldModel: { requestId: number; model: string } | null
  heldEffort: { requestId: number; effort: string } | null
  heldSpawnSwitches: Partial<Record<SpawnSwitchKind, { requestId: number; on: boolean }>>
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
    s = { short, lastAnswer: null, generation: seatGenerations.get(short) ?? 0, debounce: null, workPoll: null, lastBusy: false, lastFactsAtMs: 0, sessionId: null, tail: null, tailMessageId: null, tailPhase: null, tailTimer: null, tailDirty: false, streamedThisTurn: false, turnChars: 0, turnOutputTokens: null, messageOutputTokens: 0, turnThinkingChars: 0, firstByteAtMs: null, stateWord: null, waitingOnAgents: 0, fold: null, wait: null, progress: new Map(), progressTimer: null, progressDirty: false, lastModelSettle: null, heldModel: null, heldEffort: null, heldSpawnSwitches: {}, lastEventAtMs: null, streamBlock: null, blockSinceMs: null, livenessTimer: null, livenessDirty: false }
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
        ...(seat.turnThinkingChars > 0 ? { turnThinkingChars: seat.turnThinkingChars } : {}),
        ...(seat.firstByteAtMs !== null ? { firstByteAtMs: seat.firstByteAtMs } : {}),
        ...(seat.tailMessageId !== null ? { messageId: seat.tailMessageId } : {}),
        ...(seat.tailPhase !== null ? { phase: seat.tailPhase } : {}),
        ...(seat.stateWord !== null ? { stateWord: seat.stateWord } : {}),
        ...(seat.stateWord === 'waiting-on-agents' ? { waitingOnAgents: seat.waitingOnAgents } : {}),
        ...(seat.fold !== null ? { fold: seat.fold } : {}),
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

type SeatRow = LooseRow

function seatBlockOf(of: unknown): SeatState['streamBlock'] {
  if (of === 'reasoning') return 'thinking'
  if (of === 'text') return 'text'
  if (of === 'tool_call') return 'tool_use'
  return null
}

function onSeatPartialRow(seat: SeatState, row: SeatRow, dir?: string): void {
  noteSeatEvent(seat, dir)
  const messageId = typeof row.message_id === 'string' && row.message_id !== '' ? row.message_id : null
  if (row.type === 'retracted') {
    seat.tailMessageId = null
    seat.streamBlock = null
    seat.blockSinceMs = null
    if (seat.tail !== null) setSeatTail(seat, null, dir)
    else publishTailNow(seat, dir)
    return
  }
  if (row.type === 'block_start') {
    if (messageId !== seat.tailMessageId) {
      if (seat.tail !== null) setSeatTail(seat, null, dir)
      seat.tailMessageId = messageId
      if (seat.firstByteAtMs === null) seat.firstByteAtMs = Date.now()
      foldMessageOutputTokens(seat)
      seat.tailPhase = null
    }
    seat.streamBlock = seatBlockOf(row.of)
    seat.blockSinceMs = seat.streamBlock === null ? null : Date.now()
    if (row.of === 'text') seat.tailPhase = textPhaseOf(row.phase)
    publishTailNow(seat, dir)
    return
  }
  if (row.type === 'text_delta' && typeof row.text === 'string') {
    seat.streamedThisTurn = true
    seat.turnChars += row.text.length
    setSeatTail(seat, (seat.tail ?? '') + row.text, dir)
    return
  }
  if (row.type === 'reasoning_delta' && typeof row.text === 'string') {
    seat.turnChars += row.text.length
    seat.turnThinkingChars += row.text.length
    scheduleTailPublish(seat, dir)
    return
  }
  if (row.type === 'tool_input_delta' && typeof row.json === 'string') {
    seat.turnChars += row.json.length
    scheduleTailPublish(seat, dir)
  }
}

function onSeatStepRow(seat: SeatState, row: SeatRow, dir?: string): void {
  noteSeatEvent(seat, dir)
  const outputTokens = (row.usage as { output_tokens?: unknown } | undefined)?.output_tokens
  if (typeof outputTokens === 'number' && Number.isFinite(outputTokens) && outputTokens > 0) {
    seat.messageOutputTokens = Math.floor(outputTokens)
    if (seat.turnOutputTokens === null) seat.turnOutputTokens = 0
  }
  seat.streamBlock = null
  seat.blockSinceMs = null
  foldMessageOutputTokens(seat)
  if (seat.tail !== null) setSeatTail(seat, null, dir)
  else publishTailNow(seat, dir)
}

function textPhaseOf(raw: unknown): TextPhase | null {
  return raw === 'commentary' || raw === 'final_answer' ? raw : null
}

function foldMessageOutputTokens(seat: SeatState): void {
  if (seat.turnOutputTokens !== null) seat.turnOutputTokens += seat.messageOutputTokens
  seat.messageOutputTokens = 0
}

function stampFirstByte(seat: SeatState, next: RequestWaitV1 | null): boolean {
  const before = seat.firstByteAtMs
  if (next !== null && next.kind === 'first-byte') seat.firstByteAtMs = null
  else if (next === null && seat.wait !== null && seat.wait.kind === 'first-byte' && seat.firstByteAtMs === null) seat.firstByteAtMs = Date.now()
  return seat.firstByteAtMs !== before
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

function onSeatToolUpdate(seat: SeatState, row: SeatRow, dir?: string): void {
  noteSeatEvent(seat, dir)
  if (typeof row.call_id !== 'string' || typeof row.tick !== 'number' || typeof row.source !== 'string') return
  const key = typeof row.parent_call_id === 'string' ? row.parent_call_id : row.call_id
  const prior = seat.progress.get(key)
  if (prior !== undefined && row.tick <= prior.seq) return
  const dataType = row.source === 'mcp' ? 'mcp_progress' : row.source === 'powershell' ? 'powershell_progress' : 'bash_progress'
  seat.progress.set(key, {
    toolUseID: row.call_id,
    dataType,
    seq: row.tick,
    ...(typeof row.line === 'string' ? { latestLine: row.line } : {}),
    ...(typeof row.elapsed_s === 'number' ? { elapsedTimeSeconds: row.elapsed_s } : {}),
    ...(typeof row.lines === 'number' ? { totalLines: row.lines } : {}),
    ...(typeof row.bytes === 'number' ? { totalBytes: row.bytes } : {}),
    ...(typeof row.progress === 'number' ? { mcpProgress: row.progress } : {}),
    ...(typeof row.total === 'number' ? { mcpTotal: row.total } : {}),
    ...(typeof row.budget_ms === 'number' ? { budgetMs: row.budget_ms } : {}),
  })
  scheduleProgressPublish(seat, dir)
}

function onSeatTextRow(seat: SeatState, row: SeatRow, dir?: string): void {
  if (seat.streamedThisTurn) {
    if (seat.tail !== null) setSeatTail(seat, null, dir)
    else publishTailNow(seat, dir)
    return
  }
  const text = typeof row.text === 'string' ? row.text : ''
  if (text === '') return
  const id = row.message_id
  seat.tailMessageId = typeof id === 'string' && id !== '' ? id : null
  seat.tailPhase = textPhaseOf(row.phase)
  seat.turnChars += text.length
  setSeatTail(seat, text, dir)
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
    workspace: { cwd, originalCwd: cwd, projectRoot: rec.workspaceId },
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
  seat.lastFactsAtMs = Math.max(Date.now(), seat.lastFactsAtMs + 1)
  const facts: SessionFactsV1 = {
    schema: 1,
    sessionId: rec.sessionId,
    atMs: seat.lastFactsAtMs,
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
  dir?: string,
): void {
  const seat = seatOf(short)
  const fire = (): void => {
    seat.debounce = null
    const door = roster.door(short)
    if (door === undefined || door.closed) return
    const generation = seat.generation
    door.request('session/facts', {}).then(
      result => {
        if (seats.get(short) !== seat || seat.generation !== generation) return
        onFactsAnswer(short, result, roster, dir)
      },
      (error: unknown) => {
        if (!(error instanceof PeerClosed)) logForDebugging(`[daemon] facts for ${short}: ${error instanceof Error ? error.message : String(error)}`)
      },
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

function armWorkPoll(short: string, roster: SeatRosterPort, dir?: string): void {
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
    requestSessionFacts(short, roster, { immediate: true }, dir)
    armWorkPoll(short, roster, dir)
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

export function pushScheduleRoster(short: string, roster: SeatRosterPort, dir?: string): boolean {
  const rec = liveRecordByShort(short, dir)
  if (!rec) return false
  const door = roster.door(short)
  if (door === undefined || door.closed) return false
  door.request('schedule/roster', { schedules: scheduleRosterToWire(saturnFactsOf(rec, Date.now()).schedules ?? []) }).catch((error: unknown) => {
    if (!(error instanceof PeerClosed)) logForDebugging(`[daemon] schedule roster for ${short}: ${error instanceof Error ? error.message : String(error)}`)
  })
  return true
}

export function onFactsAnswer(short: string, result: unknown, roster: SeatRosterPort, dir?: string): void {
  const answer = sessionFactsFromWire(result)
  if (answer === null) return
  seatOf(short).lastAnswer = answer
  maybeResolveSessionKit(short, answer, dir)
  applySessionScheduleAnswer(short, answer, roster, dir)
  publishSeatFacts(short, dir, roster)
  armWorkPoll(short, roster, dir)
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
  requestSessionFacts(short, roster, { immediate: true }, dir)
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

function seatWaitOf(row: SeatRow): RequestWaitV1 | null {
  const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null)
  if (row.state === 'done') return null
  if (row.state === 'first_byte' || row.state === 'loading') {
    return decodeRequestWait({
      kind: 'first-byte',
      cold: row.cold === true,
      promptTokens: num(row.prompt_tokens_estimate) ?? 0,
      model: typeof row.model === 'string' ? row.model : '',
      budgetMs: num(row.budget_ms) ?? 0,
      sinceMs: num(row.since_ms) ?? 0,
      attempt: num(row.attempt) ?? 1,
      ...(row.promise === true ? { promise: true } : {}),
      ...(row.state === 'loading' ? { phase: 'loading' } : {}),
      ...(num(row.size_gb) !== null ? { sizeGb: num(row.size_gb) } : {}),
      ...(num(row.checked_ms) !== null ? { checkedMs: num(row.checked_ms) } : {}),
    })
  }
  if (row.state === 'retry') {
    return decodeRequestWait({ kind: 'retry', attempt: num(row.attempt) ?? 1, of: num(row.of) ?? 1, reason: typeof row.reason === 'string' ? row.reason : '', delayMs: num(row.delay_ms) ?? 0, sinceMs: num(row.since_ms) ?? 0 })
  }
  if (row.state === 'silence') {
    return decodeRequestWait({ kind: 'silence', model: typeof row.model === 'string' ? row.model : '', silentMs: num(row.silent_ms) ?? 0, sinceMs: num(row.since_ms) ?? 0, answered: row.answered === true, ...(num(row.ask_at_ms) !== null ? { askAtMs: num(row.ask_at_ms) } : {}) })
  }
  return null
}

function seatFoldOf(row: SeatRow, startedAtMs: number): FoldStatusV1 | null {
  const stages = Array.isArray(row.stages) ? row.stages : []
  if (stages.length === 0) return null
  return decodeFoldStatus({
    schema: 1,
    trigger: row.trigger === 'manual' ? 'manual' : 'auto',
    startedAtMs,
    stages,
    stage: typeof row.stage === 'string' ? row.stage : null,
    fill: typeof row.fill === 'number' ? row.fill : null,
    summaryTokens: typeof row.summary_tokens === 'number' ? row.summary_tokens : 0,
    summaryCapTokens: typeof row.summary_cap_tokens === 'number' ? row.summary_cap_tokens : 0,
    attempt: typeof row.attempt === 'number' ? row.attempt : 1,
    ...(typeof row.exit === 'string' ? { exit: row.exit, endedAtMs: Date.now() } : {}),
  })
}

const foldStartedAt = new Map<string, number>()

export function onSeatApplied(short: string, params: SessionAppliedParams, roster: SeatRosterPort, dir?: string): void {
  onSeatVerbApplied(short, params, roster, dir)
  requestSessionFacts(short, roster, { immediate: true }, dir)
}

export function onSeatRow(short: string, row: SeatRow, roster: SeatRosterPort, dir?: string): void {
  const seatFor = (): SeatState => {
    const seat = seatOf(short)
    if (seat.sessionId === null) seat.sessionId = liveRecordByShort(short, dir)?.sessionId ?? null
    return seat
  }
  const tagged = typeof row.parent_call_id === 'string'
  switch (row.type) {
    case 'block_start':
    case 'text_delta':
    case 'reasoning_delta':
    case 'tool_input_delta':
    case 'retracted':
      onSeatPartialRow(seatFor(), row, dir)
      return
    case 'tool_update':
      onSeatToolUpdate(seatFor(), row, dir)
      return
    case 'task':
    case 'mission_updated':
    case 'samples_updated':
      requestSessionFacts(short, roster, undefined, dir)
      return
    case 'session':
    case 'mode':
      requestSessionFacts(short, roster, { immediate: true }, dir)
      return
    case 'wait': {
      const seat = seatFor()
      const next = seatWaitOf(row)
      noteSeatEvent(seat, dir)
      const stampMoved = stampFirstByte(seat, next)
      if (stampMoved || JSON.stringify(seat.wait) !== JSON.stringify(next)) {
        seat.wait = next
        publishTailNow(seat, dir)
      }
      return
    }
    case 'heartbeat':
    case 'notice':
    case 'command_output':
    case 'rate_limit':
    case 'tool_result':
      noteSeatEvent(seatFor(), dir)
      return
    case 'turn':
    case 'compaction': {
      const seat = seatFor()
      if (row.type === 'turn' && row.state !== 'waiting') {
        noteSeatEvent(seat, dir)
        return
      }
      let fold: FoldStatusV1 | null = seat.fold
      let foldLive = seat.stateWord === 'compacting'
      let waiting = seat.waitingOnAgents
      if (row.type === 'compaction') {
        if (row.state === 'started' || !foldStartedAt.has(short)) foldStartedAt.set(short, Date.now())
        fold = seatFoldOf(row, foldStartedAt.get(short) ?? Date.now())
        foldLive = row.state !== 'ended' && (fold === null || fold.exit === undefined)
        if (row.state === 'ended') foldStartedAt.delete(short)
      } else {
        waiting = typeof row.agents === 'number' && Number.isFinite(row.agents) ? Math.floor(row.agents) : 0
      }
      const next = foldLive ? ('compacting' as const) : waiting > 0 ? ('waiting-on-agents' as const) : null
      const count = next === 'waiting-on-agents' ? waiting : 0
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
    case 'step': {
      const seat = seatFor()
      if (tagged) {
        noteSeatEvent(seat, dir)
        requestSessionFacts(short, roster, undefined, dir)
        return
      }
      onSeatStepRow(seat, row, dir)
      requestSessionFacts(short, roster, undefined, dir)
      return
    }
    case 'text':
    case 'reasoning':
    case 'tool_call': {
      const seat = seatFor()
      noteSeatEvent(seat, dir)
      if (tagged) {
        requestSessionFacts(short, roster, undefined, dir)
        return
      }
      if (row.type === 'text') onSeatTextRow(seat, row, dir)
      publishActivity(short, roster, dir, Date.now())
      requestSessionFacts(short, roster, undefined, dir)
      return
    }
    case 'outcome': {
      const seat = seatOf(short)
      seat.streamedThisTurn = false
      seat.turnChars = 0
      seat.turnOutputTokens = null
      seat.messageOutputTokens = 0
      seat.turnThinkingChars = 0
      seat.firstByteAtMs = null
      seat.tailMessageId = null
      seat.tailPhase = null
      seat.stateWord = null
      seat.waitingOnAgents = 0
      seat.fold = null
      seat.wait = null
      foldStartedAt.delete(short)
      noteSeatEvent(seat, dir)
      seat.streamBlock = null
      seat.blockSinceMs = null
      setSeatTail(seat, null, dir)
      clearSeatProgress(seat, dir)
      markConcourseWorkerActivity(short, { turnActive: false, work: seat.lastAnswer?.work, lastTurnAt: Date.now() }, dir)
      return
    }
    default:
      return
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
  requestSessionFacts(short, roster, { immediate: true }, dir)
}

export function onSeatSpawned(short: string, roster: SeatRosterPort, dir?: string): void {
  retireWorkerAsks(short, RUNNER_RESTARTED_ASK_CAUSE, dir)
  const seat = seatOf(short)
  seat.lastAnswer = null
  seat.generation += 1
  seatGenerations.set(short, seat.generation)
  seat.heldModel = null
  seat.heldEffort = null
  seat.heldSpawnSwitches = {}
  seat.sessionId = liveRecordByShort(short, dir)?.sessionId ?? null
  seat.turnChars = 0
  seat.turnOutputTokens = null
  seat.messageOutputTokens = 0
  seat.turnThinkingChars = 0
  seat.firstByteAtMs = null
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
  requestSessionFacts(short, roster, { immediate: true }, dir)
}

export function onSeatSettled(short: string): void {
  retireWorkerAsks(short, RUNNER_ENDED_ASK_CAUSE)
  const seat = seats.get(short)
  if (seat?.debounce !== null && seat?.debounce !== undefined) clearTimeout(seat.debounce)
  if (seat?.workPoll !== null && seat?.workPoll !== undefined) clearTimeout(seat.workPoll)
  if (seat?.tailTimer !== null && seat?.tailTimer !== undefined) clearTimeout(seat.tailTimer)
  if (seat?.progressTimer !== null && seat?.progressTimer !== undefined) clearTimeout(seat.progressTimer)
  if (seat?.livenessTimer !== null && seat?.livenessTimer !== undefined) clearTimeout(seat.livenessTimer)
  seats.delete(short)
}


export type SeatVerbOutcome = { outcome: 'applied' | 'queued' | 'noop' | 'refused'; detail?: string; respawned?: true }


function refusedRewind(mode: SessionRewindMode, refusal: NonNullable<SessionRewindOutcomeV1['refusal']>, detail: string): SessionRewindOutcomeV1 {
  return { outcome: 'refused', mode, refusal, detail }
}

export async function rewindSession(
  sessionId: string,
  req: { mode: SessionRewindMode; userMessageId: string; dryRun?: boolean },
  roster: SeatRosterPort,
  dir?: string,
  opts?: { deadlineMs?: number },
): Promise<SessionRewindOutcomeV1> {
  const rec = liveRecordBySession(sessionId, dir)
  if (!rec) return refusedRewind(req.mode, 'unknown-session', 'no live worker record owns this session')
  if (seatBusy(rec.runnerId, roster)) {
    return refusedRewind(req.mode, 'turn-active', 'a turn is running in this session — press esc to stop it, then /rewind again')
  }
  const deadlineMs = opts?.deadlineMs ?? REWIND_ANSWER_DEADLINE_MS
  const asked = await askSeat(roster, rec.runnerId, 'session/rewind', { user_message_id: req.userMessageId, mode: req.mode, ...(req.dryRun === true ? { dry_run: true } : {}) }, 'rewind', deadlineMs)
  if (runnerAnswered(asked)) requestSessionFacts(rec.runnerId, roster, { immediate: true }, dir)
  if (asked.ok) {
    const outcome = rewindOutcomeFromWire(asked.result)
    return outcome ?? refusedRewind(req.mode, 'restore-failed', 'the runner answered the rewind with a receipt the seat cannot read')
  }
  const { failure } = asked
  if (failure.kind === 'left' && asked.id === null) return refusedRewind(req.mode, 'no-channel', failure.words)
  if (failure.kind === 'left' || failure.kind === 'silent') return refusedRewind(req.mode, 'no-answer', `${failure.words} — nothing is assumed restored`)
  if (failure.kind === 'older') return refusedRewind(req.mode, 'runner-older', "the session's runner predates the rewind verb — /daemon restart when ready, then reopen the session")
  return refusedRewind(req.mode, 'restore-failed', failure.words)
}


export const AGENT_VERB_ANSWER_DEADLINE_MS = 10_000

export type SessionAgentVerb = 'stop-agent' | 'resume-agent'

function crewVerbRefusal(failure: DoorFailure, older: string): SeatVerbOutcome {
  if (failure.kind === 'older') return { outcome: 'refused', detail: older }
  if (failure.kind === 'left' && failure.words === NO_DOOR_DETAIL) return { outcome: 'refused', detail: failure.words }
  if (failure.kind === 'left') return { outcome: 'refused', detail: `${failure.words} — nothing is assumed done` }
  return { outcome: 'refused', detail: failure.words }
}

function appliedDetail(result: unknown): SeatVerbOutcome {
  const payload = result !== null && typeof result === 'object' ? (result as Record<string, unknown>) : {}
  const detail = Object.keys(payload).length > 0 ? JSON.stringify(payload) : undefined
  return { outcome: 'applied', ...(detail !== undefined ? { detail } : {}) }
}

export async function controlSessionAgent(
  sessionId: string,
  agentId: string,
  verb: SessionAgentVerb,
  roster: SeatRosterPort,
  dir?: string,
  opts?: { note?: string; deadlineMs?: number },
): Promise<SeatVerbOutcome> {
  const rec = liveRecordBySession(sessionId, dir)
  if (!rec) return { outcome: 'refused', detail: 'unknown-session: no live worker record owns this session' }
  if (agentId === '') return { outcome: 'refused', detail: `${verb} requires agentId` }
  const deadlineMs = opts?.deadlineMs ?? AGENT_VERB_ANSWER_DEADLINE_MS
  const params = { agent_id: agentId, ...(opts?.note !== undefined ? { note: opts.note } : {}) }
  const asked = await askSeat(roster, rec.runnerId, verb === 'stop-agent' ? 'agent/stop' : 'agent/resume', params, verb, deadlineMs)
  if (runnerAnswered(asked)) requestSessionFacts(rec.runnerId, roster, { immediate: true }, dir)
  if (asked.ok) {
    // eslint-disable-next-line no-console
    console.error(`[daemon] seat ${verb} applied: ${rec.runnerId} → ${agentId}`)
    return appliedDetail(asked.result)
  }
  return crewVerbRefusal(asked.failure, "the session's runner predates the crew stop and resume verbs — /daemon restart when ready, then reopen the session")
}

export async function backgroundSessionShell(
  sessionId: string,
  roster: SeatRosterPort,
  dir?: string,
  opts?: { deadlineMs?: number },
): Promise<SeatVerbOutcome> {
  const rec = liveRecordBySession(sessionId, dir)
  if (!rec) return { outcome: 'refused', detail: 'unknown-session: no live worker record owns this session' }
  const deadlineMs = opts?.deadlineMs ?? AGENT_VERB_ANSWER_DEADLINE_MS
  const asked = await askSeat(roster, rec.runnerId, 'shell/background', {}, 'background-shell', deadlineMs)
  if (runnerAnswered(asked)) requestSessionFacts(rec.runnerId, roster, { immediate: true }, dir)
  if (asked.ok) {
    // eslint-disable-next-line no-console
    console.error(`[daemon] seat background-shell applied: ${rec.runnerId}`)
    return appliedDetail(asked.result)
  }
  return crewVerbRefusal(asked.failure, "this session's runner predates shift+B · /daemon restart, then reopen the session")
}

export async function pauseSessionGate(
  sessionId: string,
  paused: boolean,
  roster: SeatRosterPort,
  dir?: string,
  opts?: { deadlineMs?: number },
): Promise<SeatVerbOutcome> {
  const rec = liveRecordBySession(sessionId, dir)
  if (!rec) return { outcome: 'refused', detail: 'unknown-session: no live worker record owns this session' }
  const deadlineMs = opts?.deadlineMs ?? AGENT_VERB_ANSWER_DEADLINE_MS
  const asked = await askSeat(roster, rec.runnerId, 'session/pause_gate', { paused }, 'pause-gate', deadlineMs)
  if (runnerAnswered(asked)) requestSessionFacts(rec.runnerId, roster, { immediate: true }, dir)
  if (asked.ok) {
    // eslint-disable-next-line no-console
    console.error(`[daemon] seat pause-gate applied: ${rec.runnerId} → ${paused ? 'closed' : 'open'}`)
    return appliedDetail(asked.result)
  }
  return crewVerbRefusal(asked.failure, "this session's runner predates the pause gate · /daemon restart, then reopen the session")
}

export const QUIESCE_ANSWER_DEADLINE_MS = 10_000

export async function quiesceSessionRunner(
  runnerId: string,
  request: QuiescenceRequest,
  roster: Pick<SeatRosterPort, 'door'>,
  opts?: { deadlineMs?: number },
): Promise<QuiescenceAnswer> {
  const deadlineMs = opts?.deadlineMs ?? QUIESCE_ANSWER_DEADLINE_MS
  const asked = await askSeat(roster, runnerId, 'session/quiesce', { action: request.action, token: request.token }, `quiesce ${request.action}`, deadlineMs)
  if (!asked.ok) return { ok: false, token: request.token, reason: asked.failure.words }
  const { token, phase } = asked.result
  if (token !== request.token || (phase !== 'prepared' && phase !== 'committed' && phase !== 'cancelled')) {
    return { ok: false, token: request.token, reason: 'the runner answered with another token or phase' }
  }
  return { ok: true, token: request.token, phase }
}


export const WITHDRAW_ANSWER_DEADLINE_MS = 5_000

export type SeatWithdrawOutcome = SeatVerbOutcome & { withdrawn?: boolean; text?: string; reason?: 'taken' | 'unknown' }

export async function withdrawSessionSend(
  sessionId: string,
  clientMessageId: string,
  roster: SeatRosterPort,
  dir?: string,
  opts?: { deadlineMs?: number },
): Promise<SeatWithdrawOutcome> {
  const rec = liveRecordBySession(sessionId, dir)
  if (!rec) return { outcome: 'refused', detail: 'unknown-session: no live worker record owns this session' }
  if (clientMessageId === '') return { outcome: 'refused', detail: 'withdraw-send requires clientMessageId' }
  const deadlineMs = opts?.deadlineMs ?? WITHDRAW_ANSWER_DEADLINE_MS
  const asked = await askSeat(roster, rec.runnerId, 'queue/withdraw', { id: clientMessageId }, 'withdraw', deadlineMs)
  if (runnerAnswered(asked)) requestSessionFacts(rec.runnerId, roster, { immediate: true }, dir)
  if (asked.ok) {
    const payload = asked.result
    if (payload.withdrawn) return { outcome: 'applied', withdrawn: true, text: payload.text }
    return { outcome: 'refused', withdrawn: false, reason: payload.reason, detail: payload.reason === 'taken' ? 'the runner already took the line' : "the runner's queue never held the line" }
  }
  return crewVerbRefusal(asked.failure, "the session's runner predates the recall — /daemon restart when ready, then reopen the session")
}

export const SEAT_VERB_ANSWER_DEADLINE_MS = 5_000

type SeatVerbAnswer = { at: 'now' | 'turn_end'; model?: string; id: number } | { refused: string } | { silent: true }

function seatVerbAnswerOf(asked: Awaited<ReturnType<typeof askSeat<'session/set_model' | 'session/set_effort' | 'session/set_spawn_switch'>>>): SeatVerbAnswer {
  if (asked.ok) {
    const model = 'model' in asked.result && asked.result.model !== '' ? { model: asked.result.model } : {}
    return { at: asked.result.at, ...model, id: asked.id }
  }
  if (asked.failure.kind === 'left' || asked.failure.kind === 'silent') return { silent: true }
  return { refused: asked.failure.words }
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
  const door = roster.door(rec.runnerId)
  if (door === undefined || door.closed) return opts.parked ? queued : respawnOnModel(rec, model, roster, dir)
  const sent = door.send('session/set_model', { model }, { deadlineMs: SEAT_VERB_ANSWER_DEADLINE_MS })
  const seat = seatOf(rec.runnerId)
  seat.heldModel = { requestId: sent.id, model }
  const asked = await sent.answer.then(result => ({ ok: true as const, result, id: sent.id }), (error: unknown) => ({ ok: false as const, failure: doorFailureOf(error, 'set-model', SEAT_VERB_ANSWER_DEADLINE_MS), id: sent.id }))
  if (runnerAnswered(asked)) requestSessionFacts(rec.runnerId, roster, { immediate: true }, dir)
  const word = seatVerbAnswerOf(asked)
  if ('at' in word && word.at === 'turn_end') {
    if (!opts.parked) {
      parkModel(rec, model, dir)
      publishSeatFacts(rec.runnerId, dir, roster)
    }
    logForDebugging(`[daemon] seat set-model held by the runner for its turn boundary: ${rec.runnerId} → ${model}`)
    return queued
  }
  if (seat.heldModel !== null && seat.heldModel.requestId === sent.id) seat.heldModel = null
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
    return { outcome: 'refused', detail: `${NO_DOOR_DETAIL}, and this roster cannot respawn its runner` }
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
    registerLongLived: (short: string, spec: RunnerChildSpec): { ok: boolean; pid?: number; error?: string } => roster.registerLongLived!(short, spec),
  }
  const revived = reviveConcourseWorker(rec.sessionId, 'operator:set-model', reviveRoster, { clearCrash: true, modelOverride: model }, dir)
  if (revived.outcome === 'noop') {
    return { outcome: 'refused', detail: `the runner's door is closed while its process (pid ${rec.pid ?? '?'}) still stands — retry in a moment` }
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
  requestSessionFacts(rec.runnerId, roster, { immediate: true }, dir)
}

async function forwardEffort(rec: ConcourseWorkerRecordV1, effort: string, roster: SeatRosterPort, dir: string | undefined, opts: { parked: boolean }): Promise<SeatVerbOutcome> {
  const queued: SeatVerbOutcome = { outcome: 'queued', detail: `${effort} applies when this turn ends` }
  const door = roster.door(rec.runnerId)
  if (door === undefined || door.closed) return opts.parked ? queued : { outcome: 'refused', detail: NO_DOOR_DETAIL }
  const sent = door.send('session/set_effort', { effort }, { deadlineMs: SEAT_VERB_ANSWER_DEADLINE_MS })
  const seat = seatOf(rec.runnerId)
  seat.heldEffort = { requestId: sent.id, effort }
  const asked = await sent.answer.then(result => ({ ok: true as const, result, id: sent.id }), (error: unknown) => ({ ok: false as const, failure: doorFailureOf(error, 'set-effort', SEAT_VERB_ANSWER_DEADLINE_MS), id: sent.id }))
  if (runnerAnswered(asked)) requestSessionFacts(rec.runnerId, roster, { immediate: true }, dir)
  const word = seatVerbAnswerOf(asked)
  if ('at' in word && word.at === 'turn_end') {
    if (!opts.parked) {
      parkEffort(rec, effort, dir)
      publishSeatFacts(rec.runnerId, dir, roster)
    }
    logForDebugging(`[daemon] seat set-effort held by the runner for its turn boundary: ${rec.runnerId} → ${effort}`)
    return queued
  }
  if (seat.heldEffort !== null && seat.heldEffort.requestId === sent.id) seat.heldEffort = null
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

function onSeatVerbApplied(short: string, frame: SessionAppliedParams, roster: SeatRosterPort, dir?: string): void {
  const rec = liveRecordByShort(short, dir)
  if (!rec) return
  const seat = seatOf(short)
  if (frame.verb === 'set_model') {
    const held = seat.heldModel !== null && seat.heldModel.requestId === frame.request_id ? seat.heldModel : null
    const model = held !== null ? held.model : frame.model !== undefined && rec.pendingModelKey === frame.model ? frame.model : undefined
    if (model === undefined) return
    if (held !== null) seat.heldModel = null
    const served = frame.model !== undefined && frame.model !== '' ? frame.model : undefined
    landModel(rec, model, roster, dir, rec.pendingModelKey === model, served)
    return
  }
  if (frame.verb === 'set_spawn_switch') {
    const kind = frame.switch
    const on = frame.on
    if (kind === undefined || typeof on !== 'boolean') return
    const heldToggle = seat.heldSpawnSwitches[kind]
    const known = heldToggle !== undefined ? heldToggle.requestId === frame.request_id : (rec.pendingSpawnSwitches ?? []).some(p => p.kind === kind && p.on === on)
    if (!known) return
    if (heldToggle !== undefined) dropHeldSpawnSwitch(seat, kind, heldToggle.requestId)
    landSpawnSwitchOnRecord(rec, { kind, on }, roster, dir, true)
    return
  }
  const held = seat.heldEffort !== null && seat.heldEffort.requestId === frame.request_id ? seat.heldEffort : null
  const effort = held !== null ? held.effort : frame.effort !== undefined && rec.pendingEffort === frame.effort ? frame.effort : undefined
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
  requestSessionFacts(rec.runnerId, roster, { immediate: true }, dir)
  return forwarded
    ? { outcome: 'applied', ...(out.detail !== undefined ? { detail: out.detail } : {}) }
    : {
        outcome: 'applied',
        detail: `${out.detail ?? 'applied'} — no live runner door; the record holds the kit and the session's next boot applies it`,
      }
}

function forwardSessionKit(short: string, roster: SeatRosterPort, dir?: string): boolean {
  const rec = liveRecordByShort(short, dir)
  if (!rec || rec.kit === undefined) return false
  const door = roster.door(short)
  if (door === undefined || door.closed) return false
  door.request('session/set_kit', { kit: sessionKitToWire(rec.kit) }).then(
    () => requestSessionFacts(short, roster, { immediate: true }, dir),
    (error: unknown) => {
      if (!(error instanceof PeerClosed)) logForDebugging(`[daemon] seat set-kit for ${short}: ${error instanceof Error ? error.message : String(error)}`)
    },
  )
  return true
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

function dropHeldSpawnSwitch(seat: SeatState, kind: SpawnSwitchKind, requestId: number): void {
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
  const door = roster.door(rec.runnerId)
  if (door === undefined || door.closed) return opts.parked ? queued : landSpawnSwitchOnRecord(rec, toggle, roster, dir, false)
  const sent = door.send('session/set_spawn_switch', { switch: toggle.kind, on: toggle.on }, { deadlineMs: SEAT_VERB_ANSWER_DEADLINE_MS })
  const seat = seatOf(rec.runnerId)
  seat.heldSpawnSwitches = { ...seat.heldSpawnSwitches, [toggle.kind]: { requestId: sent.id, on: toggle.on } }
  const asked = await sent.answer.then(result => ({ ok: true as const, result, id: sent.id }), (error: unknown) => ({ ok: false as const, failure: doorFailureOf(error, 'spawn-switch', SEAT_VERB_ANSWER_DEADLINE_MS), id: sent.id }))
  if (runnerAnswered(asked)) requestSessionFacts(rec.runnerId, roster, { immediate: true }, dir)
  const word = seatVerbAnswerOf(asked)
  if ('at' in word && word.at === 'turn_end') {
    if (!opts.parked) {
      parkSpawnSwitch(rec, toggle, by, dir)
      publishSeatFacts(rec.runnerId, dir, roster)
    }
    logForDebugging(`[daemon] seat set-spawn-switch held by the runner for its turn boundary: ${rec.runnerId} → ${toggle.kind} ${toggle.on ? 'on' : 'off'}`)
    return queued
  }
  dropHeldSpawnSwitch(seat, toggle.kind, sent.id)
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
  console.error(`[daemon] seat set-spawn-switch applied: ${rec.runnerId} → ${toggle.kind} ${toggle.on ? 'on' : 'off'}${delivered ? '' : ' (no live runner door; the record holds it)'}`)
  publishSeatFacts(rec.runnerId, dir, roster)
  requestSessionFacts(rec.runnerId, roster, { immediate: true }, dir)
  const receipt = spawnSwitchToggleReceipt(toggle.kind, toggle.on, 'applied')
  return delivered
    ? { outcome: 'applied', detail: receipt }
    : { outcome: 'applied', detail: `${receipt} — no live runner door; the record holds the switch and the session's next boot applies it` }
}

function forwardSpawnSwitch(short: string, toggle: { kind: SpawnSwitchKind; on: boolean }, roster: SeatRosterPort): boolean {
  const door = roster.door(short)
  if (door === undefined || door.closed) return false
  door.request('session/set_spawn_switch', { switch: toggle.kind, on: toggle.on }, { deadlineMs: SEAT_VERB_ANSWER_DEADLINE_MS }).catch((error: unknown) => {
    if (!(error instanceof PeerClosed)) logForDebugging(`[daemon] seat spawn-switch re-forward for ${short}: ${error instanceof Error ? error.message : String(error)}`)
  })
  return true
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


export const PERMISSION_MODE_ANSWER_DEADLINE_MS = 5_000

export async function setSessionPermissionMode(
  sessionId: string,
  mode: string,
  roster: SeatRosterPort,
  dir?: string,
  opts?: { deadlineMs?: number },
): Promise<SeatVerbOutcome> {
  const rec = liveRecordBySession(sessionId, dir)
  if (!rec) return { outcome: 'refused', detail: 'unknown-session: no live worker record owns this session' }
  const deadlineMs = opts?.deadlineMs ?? PERMISSION_MODE_ANSWER_DEADLINE_MS
  const asked = await askSeat(roster, rec.runnerId, 'session/set_mode', { mode }, 'mode change', deadlineMs)
  if (runnerAnswered(asked)) requestSessionFacts(rec.runnerId, roster, { immediate: true }, dir)
  if (asked.ok) return { outcome: 'applied', detail: `${rec.runnerId} mode → ${asked.result.mode}` }
  const { failure } = asked
  if (failure.kind === 'left' && asked.id === null) return { outcome: 'refused', detail: failure.words }
  if (failure.kind === 'left' || failure.kind === 'silent') return { outcome: 'refused', detail: `${failure.words} — the band follows its facts` }
  return { outcome: 'refused', detail: failure.words }
}

export function refreshSessionFacts(sessionId: string, roster: SeatRosterPort, dir?: string): SeatVerbOutcome {
  const rec = liveRecordBySession(sessionId, dir)
  if (!rec) return { outcome: 'refused', detail: 'unknown-session: no live worker record owns this session' }
  requestSessionFacts(rec.runnerId, roster, { immediate: true }, dir)
  return { outcome: 'applied', detail: `facts requested from ${rec.runnerId}` }
}
