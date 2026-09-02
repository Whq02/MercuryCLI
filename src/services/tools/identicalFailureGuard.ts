import { createHash } from 'node:crypto'
import type { Message } from '../../types/message.js'
import { createUserMessage } from '../../utils/messages.js'
import { isDenialResultText } from '../../utils/messages/rejectionText.js'
import {
  fingerprintKey,
  makeAttemptFingerprint,
} from '../run/progressModel.js'
import { SLEEP_TOOL_NAME } from '../../tools/SleepTool/prompt.js'
import { MONITOR_TOOL_NAME } from '../../tools/MonitorTool/constants.js'

export type RepetitionOutcome = 'failure' | 'success'

type LoopRecord = {
  key: string
  toolName: string
  outcome: RepetitionOutcome
  resultDigest: string
  consecutive: number
  nudgeSpent: boolean
  stop: RepetitionStop | null
}

export type RepetitionStop = {
  toolName: string
  outcome: RepetitionOutcome
  streak: number
  calls?: number
}

const records = new WeakMap<AbortController, LoopRecord>()


type RoundRecord = {
  roundKey: string
  toolNames: string
  callCount: number
  outcome: RepetitionOutcome
  resultDigest: string
  consecutive: number
  nudgeSpent: boolean
  stop: RepetitionStop | null
}

const roundRecords = new WeakMap<AbortController, RoundRecord>()

export type RoundCall = { toolName: string; key: string }

export type RoundSettlement = { key: string; resultText: string | null; isError: boolean } | null

export const IDENTICAL_FAILURES_TO_ARM = 2
export const IDENTICAL_FAILURES_TO_STOP = 5
export const IDENTICAL_RESULTS_TO_ARM = 3
export const IDENTICAL_RESULTS_TO_STOP = 6

const SUCCESS_ARM_EXEMPT = new Set<string>([SLEEP_TOOL_NAME, MONITOR_TOOL_NAME])

export const IDENTICAL_RETRY_NUDGE =
  'Refusing to run this exact call again: the identical input already failed ' +
  `${IDENTICAL_FAILURES_TO_ARM} times in a row with the identical error. ` +
  'Change something material — a different input, a different tool, or a different approach — ' +
  'or state the blocker and continue with other work. ' +
  'If repeating really is right (e.g. waiting on an external change), do a check or wait in between; ' +
  'this guard fires once, and a later identical attempt will run — ' +
  `but ${IDENTICAL_FAILURES_TO_STOP} identical failures in a row end the turn.`

export const IDENTICAL_RESULT_NUDGE =
  'Refusing to run this exact call again: the identical input already returned the identical result ' +
  `${IDENTICAL_RESULTS_TO_ARM} times in a row, so nothing has changed and repeating it yields nothing new. ` +
  'Act on the result you already have, change the input or the tool, ' +
  'or — if you are waiting for something external to change — wait first (Sleep or Monitor) and check once after. ' +
  `This guard fires once, and a later identical attempt will run — but ${IDENTICAL_RESULTS_TO_STOP} identical results in a row end the turn.`

export function identityKeyFor(toolName: string, input: unknown, cwd: string): string {
  try {
    return `${toolName}\x00${fingerprintKey(makeAttemptFingerprint({ toolName, input, cwd }))}`
  } catch {
    return `${toolName}\x00unfingerprintable`
  }
}

function armedAt(record: LoopRecord): number {
  return record.outcome === 'failure' ? IDENTICAL_FAILURES_TO_ARM : IDENTICAL_RESULTS_TO_ARM
}

function stopAt(record: LoopRecord): number {
  return record.outcome === 'failure' ? IDENTICAL_FAILURES_TO_STOP : IDENTICAL_RESULTS_TO_STOP
}

export function repetitionNudgeFor(outcome: RepetitionOutcome): string {
  return outcome === 'failure' ? IDENTICAL_RETRY_NUDGE : IDENTICAL_RESULT_NUDGE
}

export function repetitionRoundNudgeFor(outcome: RepetitionOutcome, callCount: number): string {
  const streakWord =
    outcome === 'failure'
      ? `already failed ${IDENTICAL_FAILURES_TO_ARM} rounds in a row with the identical errors`
      : `already returned the identical results ${IDENTICAL_RESULTS_TO_ARM} rounds in a row`
  const stopBound = outcome === 'failure' ? IDENTICAL_FAILURES_TO_STOP : IDENTICAL_RESULTS_TO_STOP
  return (
    `Refusing to run this exact batch of ${callCount} tool calls again: the identical round ` +
    `${streakWord}, so repeating it yields nothing new. ` +
    'Change something material — different inputs, different tools, or a different approach — ' +
    'or act on the results you already have. ' +
    'If repeating really is right (e.g. waiting on an external change), wait first (Sleep or Monitor) and check once after; ' +
    `this guard fires once, and a later identical round will run — but ${stopBound} identical rounds in a row end the turn.`
  )
}

export function consultRepetitionGuard(
  controller: AbortController,
  key: string,
): RepetitionOutcome | null {
  const record = records.get(controller)
  if (
    !record ||
    record.key !== key ||
    record.nudgeSpent ||
    record.consecutive < armedAt(record)
  ) {
    return null
  }
  record.nudgeSpent = true
  return record.outcome
}

export function shouldRefuseIdenticalRetry(
  controller: AbortController,
  key: string,
): boolean {
  return consultRepetitionGuard(controller, key) !== null
}

export function recordToolOutcome(
  controller: AbortController,
  key: string,
  resultText: string | null,
  isError: boolean,
): void {
  if (resultText !== null && isDenialResultText(resultText)) return
  const outcome: RepetitionOutcome = isError ? 'failure' : 'success'
  const toolName = key.split('\x00')[0] ?? ''
  if (outcome === 'success' && SUCCESS_ARM_EXEMPT.has(toolName)) {
    records.delete(controller)
    return
  }
  const resultDigest = createHash('sha256')
    .update(resultText ?? '')
    .digest('hex')
    .slice(0, 16)
  const record = records.get(controller)
  if (
    record &&
    record.key === key &&
    record.outcome === outcome &&
    record.resultDigest === resultDigest
  ) {
    record.consecutive += 1
    if (record.consecutive >= stopAt(record) && record.stop === null) {
      record.stop = { toolName, outcome, streak: record.consecutive }
    }
    return
  }
  records.set(controller, {
    key,
    toolName,
    outcome,
    resultDigest,
    consecutive: 1,
    nudgeSpent: false,
    stop: null,
  })
}

export function roundIdentityOf(calls: RoundCall[]): string | null {
  if (calls.length < 2) return null
  const members = calls.map(call => call.key).sort()
  return createHash('sha256').update(members.join('\x00')).digest('hex').slice(0, 16)
}

export function consultRoundRepetitionGuard(
  controller: AbortController,
  roundKey: string,
): RepetitionOutcome | null {
  const record = roundRecords.get(controller)
  if (
    !record ||
    record.roundKey !== roundKey ||
    record.nudgeSpent ||
    record.consecutive < (record.outcome === 'failure' ? IDENTICAL_FAILURES_TO_ARM : IDENTICAL_RESULTS_TO_ARM)
  ) {
    return null
  }
  record.nudgeSpent = true
  return record.outcome
}

function roundToolNamesOf(calls: RoundCall[]): string {
  const counts = new Map<string, number>()
  for (const call of calls) counts.set(call.toolName, (counts.get(call.toolName) ?? 0) + 1)
  return [...counts.entries()]
    .map(([name, count]) => (count > 1 ? `${name} ×${count}` : name))
    .join(' + ')
}

export function recordRoundOutcome(
  controller: AbortController,
  roundKey: string,
  calls: RoundCall[],
  settlements: RoundSettlement[],
): void {
  if (calls.length < 2) return
  for (const settlement of settlements) {
    if (settlement === null) return
    if (settlement.resultText !== null && isDenialResultText(settlement.resultText)) return
  }
  const settled = settlements as Array<NonNullable<RoundSettlement>>
  const outcome: RepetitionOutcome = settled.every(s => s.isError) ? 'failure' : 'success'
  if (outcome === 'success' && calls.some(call => SUCCESS_ARM_EXEMPT.has(call.toolName))) {
    roundRecords.delete(controller)
    return
  }
  const resultDigest = createHash('sha256')
    .update(
      settled
        .map(s => `${s.key}\x01${s.isError ? 'e' : 'ok'}\x01${s.resultText ?? ''}`)
        .sort()
        .join('\x00'),
    )
    .digest('hex')
    .slice(0, 16)
  const record = roundRecords.get(controller)
  if (
    record &&
    record.roundKey === roundKey &&
    record.outcome === outcome &&
    record.resultDigest === resultDigest
  ) {
    record.consecutive += 1
    const bound = outcome === 'failure' ? IDENTICAL_FAILURES_TO_STOP : IDENTICAL_RESULTS_TO_STOP
    if (record.consecutive >= bound && record.stop === null) {
      record.stop = {
        toolName: record.toolNames,
        outcome,
        streak: record.consecutive,
        calls: record.callCount,
      }
    }
    return
  }
  roundRecords.set(controller, {
    roundKey,
    toolNames: roundToolNamesOf(calls),
    callCount: calls.length,
    outcome,
    resultDigest,
    consecutive: 1,
    nudgeSpent: false,
    stop: null,
  })
}

export function takeRepetitionStop(controller: AbortController): RepetitionStop | null {
  const record = records.get(controller)
  if (record && record.stop !== null) {
    const stop = record.stop
    records.delete(controller)
    return stop
  }
  const round = roundRecords.get(controller)
  if (round && round.stop !== null) {
    const stop = round.stop
    roundRecords.delete(controller)
    return stop
  }
  return null
}

export function repetitionStopNotice(stop: RepetitionStop): string {
  const what = stop.outcome === 'failure' ? 'error' : 'result'
  const shape =
    stop.calls !== undefined && stop.calls > 1
      ? `the identical batch of ${stop.calls} tool calls (${stop.toolName}) ${stop.streak} rounds in a row`
      : `the identical ${stop.toolName} call ${stop.streak} times in a row`
  return (
    `Stopped this turn: the model ran ${shape} ` +
    `with the identical ${what}, past the harness correction. ` +
    'Send a new prompt with a different approach or the missing fact to continue.'
  )
}

export function identicalRetryRefusalMessage(
  toolUseID: string,
  sourceToolAssistantUUID: string,
  outcome: RepetitionOutcome = 'failure',
  nudgeOverride?: string,
): Message {
  const nudge = nudgeOverride ?? repetitionNudgeFor(outcome)
  return createUserMessage({
    content: [
      {
        type: 'tool_result',
        content: `<tool_use_error>${nudge}</tool_use_error>`,
        is_error: true,
        tool_use_id: toolUseID,
      },
    ] as never,
    toolUseResult: nudge,
    sourceToolAssistantUUID: sourceToolAssistantUUID as never,
  })
}

export function toolResultOf(
  message: Message | undefined,
  toolUseID: string,
): [string, boolean] | null {
  if (!message || message.type !== 'user') return null
  const content = message.message.content
  if (!Array.isArray(content)) return null
  for (const block of content) {
    if (block.type !== 'tool_result' || block.tool_use_id !== toolUseID) continue
    const isError = (block as { is_error?: boolean }).is_error === true
    const raw = (block as { content?: unknown }).content
    const text =
      typeof raw === 'string'
        ? raw
        : Array.isArray(raw)
          ? raw
              .map(entry =>
                entry && typeof entry === 'object' && (entry as { type?: string }).type === 'text'
                  ? String((entry as { text?: string }).text ?? '')
                  : '',
              )
              .join('\n')
          : ''
    return [text, isError]
  }
  return null
}

export function __resetIdenticalFailureGuardForTest(controller: AbortController): void {
  records.delete(controller)
  roundRecords.delete(controller)
}
