import type { SessionFactsAnswerV1, SessionProgressEntryV1 } from '../../engine/connector/seatProjections.js'
import type { RequestWaitV1 } from '../../models/roads/streamIdleBudget.js'
import type { FoldStatusV1 } from '../../engine/compaction/foldStatus.js'
import { readSessionWorkers, type ConcourseWorkerRecordV1, markConcourseWorkerActivity } from '../concourse-workers/concourseWorkers.js'
import type { LooseRow } from '../../engine/rows/read.js'
import type { RunnerDoor } from '../runner-link/runnerConnection.js'
import type { RunnerChildSpec } from '../runner-link/headlessRun.js'
import type { TextPhase } from '../../engine/message-shapes/wire.js'
import type { SpawnSwitchKind } from '../switchboard/spawnSwitches.js'

export interface SeatRosterPort {
  door(short: string): RunnerDoor | undefined
  list(): ReadonlyArray<{
    short: string
    outcome?: string
    busy?: boolean
    turnActive?: boolean
    state?: string
    turnStartedAt?: number
    turnOpenedAt?: number
    ready?: boolean
    respawns?: number
    maxRespawns?: number
    spawnedAt?: number
    crashedAt?: number
    lastError?: string
  }>
  patchSeatModel(short: string, model: string): boolean
  patchSeatEffort(short: string, effort: string): boolean
  has?(short: string): { present: boolean }
  kill?(short: string): boolean
  registerLongLived?(short: string, spec: RunnerChildSpec): { ok: boolean; pid?: number; error?: string }
}

export interface SeatState {
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
  tailWithdrawn: string | null
  tailTimer: ReturnType<typeof setTimeout> | null
  tailDirty: boolean
  streamedThisTurn: boolean
  turnChars: number
  turnOutputTokens: number | null
  messageOutputTokens: number
  turnThinkingChars: number
  turnThinkingBlocks: number
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

export const seats = new Map<string, SeatState>()

export const seatGenerations = new Map<string, number>()

export function seatGenerationOf(short: string): number {
  return seats.get(short)?.generation ?? seatGenerations.get(short) ?? 0
}

export function seatOf(short: string): SeatState {
  let s = seats.get(short)
  if (!s) {
    s = { short, lastAnswer: null, generation: seatGenerations.get(short) ?? 0, debounce: null, workPoll: null, lastBusy: false, lastFactsAtMs: 0, sessionId: null, tail: null, tailMessageId: null, tailPhase: null, tailWithdrawn: null, tailTimer: null, tailDirty: false, streamedThisTurn: false, turnChars: 0, turnOutputTokens: null, messageOutputTokens: 0, turnThinkingChars: 0, turnThinkingBlocks: 0, firstByteAtMs: null, stateWord: null, waitingOnAgents: 0, fold: null, wait: null, progress: new Map(), progressTimer: null, progressDirty: false, lastModelSettle: null, heldModel: null, heldEffort: null, heldSpawnSwitches: {}, lastEventAtMs: null, streamBlock: null, blockSinceMs: null, livenessTimer: null, livenessDirty: false }
    seats.set(short, s)
  }
  return s
}

export type SeatRow = LooseRow

export function liveRecordByShort(short: string, dir?: string): ConcourseWorkerRecordV1 | undefined {
  const rec = readSessionWorkers(dir)[short]
  return rec && rec.endedAt === undefined ? rec : undefined
}

export function liveRecordBySession(sessionId: string, dir?: string): ConcourseWorkerRecordV1 | undefined {
  return Object.values(readSessionWorkers(dir)).find(r => r.sessionId === sessionId && r.endedAt === undefined)
}

export function seatTurnOpen(row: { outcome?: string; busy?: boolean; turnActive?: boolean } | undefined): boolean {
  if (row === undefined || row.outcome) return false
  if (row.turnActive === true) return true
  return row.busy === true
}

export function seatBusy(short: string, roster: SeatRosterPort): boolean {
  return seatTurnOpen(roster.list().find(j => j.short === short))
}

export function publishActivity(short: string, roster: SeatRosterPort | undefined, dir?: string, lastTurnAt?: number): void {
  const seat = seatOf(short)
  markConcourseWorkerActivity(short, {
    turnActive: roster !== undefined ? seatBusy(short, roster) : seat.lastBusy,
    work: seat.lastAnswer?.work,
    waitingOnAgents: seat.waitingOnAgents,
    ...(lastTurnAt !== undefined ? { lastTurnAt } : {}),
  }, dir)
}

export function switchAppliesWhileAgentsHold(turnOpen: boolean, stateWord: SeatState['stateWord']): boolean {
  if (!turnOpen) return true
  return stateWord === 'waiting-on-agents'
}

export function seatBusyForSwitch(short: string, roster: SeatRosterPort): boolean {
  return !switchAppliesWhileAgentsHold(seatBusy(short, roster), seatOf(short).stateWord)
}
