import { logForDebugging } from '../../platform/logs/debugLog.js'
import { publishSessionTail, publishSessionProgress } from '../../engine/connector/seatProjections.js'
import type { RequestWaitV1 } from '../../models/roads/streamIdleBudget.js'
import type { TextPhase } from '../../engine/message-shapes/wire.js'
import type { SeatState, SeatRow } from './state.js'
import { startTimeout, stopTimeout } from '../../platform/async/timers.js'

const TAIL_PUBLISH_MS = 40

export function publishTailNow(seat: SeatState, dir?: string): void {
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
        ...(seat.turnThinkingBlocks > 0 ? { turnThinkingBlocks: seat.turnThinkingBlocks } : {}),
        ...(seat.firstByteAtMs !== null ? { firstByteAtMs: seat.firstByteAtMs } : {}),
        ...(seat.tailMessageId !== null ? { messageId: seat.tailMessageId } : {}),
        ...(seat.tailPhase !== null ? { phase: seat.tailPhase } : {}),
        ...(seat.tailWithdrawn !== null ? { withdrawn: seat.tailWithdrawn } : {}),
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

export function setSeatTail(seat: SeatState, text: string | null, dir?: string): void {
  seat.tail = text
  if (text !== null) seat.tailWithdrawn = null
  if (text === null) {
    if (seat.tailTimer !== null) {
      stopTimeout(seat.tailTimer)
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
  const t = startTimeout(() => {
    seat.tailTimer = null
    if (seat.tailDirty) publishTailNow(seat, dir)
  }, TAIL_PUBLISH_MS)
  t.unref?.()
  seat.tailTimer = t
}

const LIVENESS_PUBLISH_MS = 1000

export function noteSeatEvent(seat: SeatState, dir: string | undefined, opts?: { now?: boolean }): void {
  seat.lastEventAtMs = Date.now()
  if (opts?.now === true) {
    if (seat.livenessTimer !== null) {
      stopTimeout(seat.livenessTimer)
      seat.livenessTimer = null
    }
    publishTailNow(seat, dir)
    return
  }
  seat.livenessDirty = true
  if (seat.livenessTimer !== null) return
  const t = startTimeout(() => {
    seat.livenessTimer = null
    if (seat.livenessDirty) publishTailNow(seat, dir)
  }, LIVENESS_PUBLISH_MS)
  t.unref?.()
  seat.livenessTimer = t
}

function seatBlockOf(of: unknown): SeatState['streamBlock'] {
  if (of === 'reasoning') return 'thinking'
  if (of === 'text') return 'text'
  if (of === 'tool_call') return 'tool_use'
  return null
}

export function onSeatPartialRow(seat: SeatState, row: SeatRow, dir?: string): void {
  noteSeatEvent(seat, dir)
  const messageId = typeof row.message_id === 'string' && row.message_id !== '' ? row.message_id : null
  if (row.type === 'retracted') {
    seat.tailWithdrawn = messageId ?? seat.tailMessageId
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
    if (seat.streamBlock === 'thinking') seat.turnThinkingBlocks += 1
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

export function onSeatStepRow(seat: SeatState, row: SeatRow, dir?: string): void {
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

export function stampFirstByte(seat: SeatState, next: RequestWaitV1 | null): boolean {
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
  const t = startTimeout(() => {
    seat.progressTimer = null
    if (seat.progressDirty) publishProgressNow(seat, dir)
  }, PROGRESS_PUBLISH_MS)
  t.unref?.()
  seat.progressTimer = t
}

export function clearSeatProgress(seat: SeatState, dir?: string): void {
  if (seat.progress.size === 0) return
  seat.progress.clear()
  if (seat.progressTimer !== null) {
    stopTimeout(seat.progressTimer)
    seat.progressTimer = null
  }
  publishProgressNow(seat, dir)
}

export function onSeatToolUpdate(seat: SeatState, row: SeatRow, dir?: string): void {
  noteSeatEvent(seat, dir)
  if (typeof row.call_id !== 'string' || typeof row.tick !== 'number' || typeof row.source !== 'string') return
  const key = typeof row.parent_call_id === 'string' ? row.parent_call_id : row.call_id
  const prior = seat.progress.get(key)
  if (prior !== undefined && row.tick <= prior.seq) return
  const dataType = row.source === 'mcp' ? 'mcp_progress' : row.source === 'powershell' ? 'powershell_progress' : row.source === 'eval' ? 'eval_progress' : row.source === 'hook' ? 'hook_progress' : 'bash_progress'
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

export function onSeatTextRow(seat: SeatState, row: SeatRow, dir?: string): void {
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
