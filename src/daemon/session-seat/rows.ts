import { decodeRequestWait, type RequestWaitV1 } from '../../models/roads/streamIdleBudget.js'
import { decodeFoldStatus, type FoldStatusV1 } from '../../engine/compaction/foldStatus.js'
import { markConcourseWorkerActivity } from '../concourse-workers/concourseWorkers.js'
import { type SeatRow, seatOf, liveRecordByShort, publishActivity, type SeatRosterPort, type SeatState } from './state.js'
import { onSeatPartialRow, onSeatToolUpdate, noteSeatEvent, stampFirstByte, publishTailNow, onSeatStepRow, onSeatTextRow, setSeatTail, clearSeatProgress } from './stream.js'
import { requestSessionFacts } from './facts.js'

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
    case 'notice':
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
      if (row.type === 'compaction' && row.state === 'ended') requestSessionFacts(short, roster, undefined, dir)
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
      seat.turnThinkingBlocks = 0
      seat.firstByteAtMs = null
      seat.tailMessageId = null
      seat.tailPhase = null
      seat.tailWithdrawn = null
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
