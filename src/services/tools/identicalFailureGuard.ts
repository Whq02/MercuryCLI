// ============================================================================
//  identicalFailureGuard — the mechanical repetition breaker
//
//
//  The class: a model in a trance repeats the SAME tool call with the SAME
//  input — "this doesn't work, let me try it again" → the same try; or a
//  read/status call that keeps returning the SAME bytes, called again and
//  again as though the next call could differ. The run kernel's progress
//  model + cycle lease govern substantive (mutating) runs at cycle
//  boundaries; nothing else governed the plain tool loop, and a nudge the
//  model ignores must not be the end of the story: every ignored round is
//  a billed provider call the operator watches spin.
//
//  THE LAW (small on purpose):
//    · identity = tool name + the progress model's attempt fingerprint
//      (digest equality — superficial input diffs never mint novelty; ONE
//      canonicalization vocabulary, never a second);
//    · the guard watches only STRICTLY CONSECUTIVE settlements of one
//      identity WITH one outcome: one record per query loop holding the LAST
//      call's identity, its outcome class and a digest of its result text.
//      Any different call, any different result, and any success after a
//      failure reset it — so a deliberate poll (check · wait · check), a
//      retry after intervening work, or a call whose output moves NEVER
//      trips the guard;
//    · FAILURE streak: two consecutive identical failures with the identical
//      error arm it; the NEXT identical call is refused with a strategy-
//      change nudge — ONCE per armed shape (the guard breaks the trance with
//      information, then stands down and a later identical attempt runs).
//      IDENTICAL_FAILURES_TO_STOP consecutive identical failures — the model
//      ran past the nudge — end the turn (the turn machine consults
//      takeRepetitionStop after the round) with an operator-visible notice;
//    · SUCCESS streak: three consecutive identical calls with the identical
//      result arm it (nothing new can come from a fourth); the next is
//      refused once with the same-result nudge; IDENTICAL_RESULTS_TO_STOP in
//      a row end the turn. The wait primitives (Sleep · Monitor) are exempt
//      from the success arm — waiting is their whole result;
//    · denial/interrupt results are NEUTRAL — they neither arm nor reset
//      (the denial ledger owns that class), and a call the harness refused
//      never counts as a settlement;
//    · the ROUND law: a repeating BATCH (two or more calls in one round) is
//      the same trance one level up — the per-call reset that protects polls
//      also disarmed the guard against it (A, B, A, B, … resets the one slot
//      forever). A parallel round record streaks on the SET of member
//      identities plus a digest over every member's result; same arm/stop
//      bounds by outcome class; single-call rounds, wait-carrying rounds and
//      rounds with denial/unsettled members stay under the per-call law's
//      exemptions. The whole round is refused once, then stops the turn.
//
//  State rides a WeakMap keyed by the query loop's AbortController — the one
//  object every iteration of one loop shares (the denial ledger's
//  context-scoped precedent without widening the ToolUseContext type); a new
//  submission starts clean, and GC follows the loop.
//
//  Proof: scripts/tools/prove-identical-failure-guard.ts (the unit laws) ·
//  scripts/repetition-guard/prove-hammer-breaker.ts (the loop, end to end).
// ============================================================================
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
  /** Consecutive settlements of this identity with this outcome AND this
   *  result digest. A refused call never counts. */
  consecutive: number
  nudgeSpent: boolean
  /** Set once the streak crossed its stop bound; consumed by the turn
   *  machine exactly once. */
  stop: RepetitionStop | null
}

export type RepetitionStop = {
  toolName: string
  outcome: RepetitionOutcome
  streak: number
  /** Calls per round when the stopped streak was a BATCH (≥2 calls repeating
   *  together); absent for the single-call streaks. */
  calls?: number
}

const records = new WeakMap<AbortController, LoopRecord>()

// ── the ROUND law (the batch blindness fix) ────────────────────────────────
// The per-call record above watches STRICTLY CONSECUTIVE settlements of ONE
// identity — correct for polls (check · wait · check must never trip), but
// structurally blind to a repeating BATCH: for a round of {A, B} the
// settlements arrive A, B, A, B, … and every one resets the single slot, so
// `consecutive` never leaves 1 for ANY batch size ≥ 2, for ANY number of
// rounds (the operator lived this as "the same message twice / the tool
// call twice", unbounded). The round record states the actual intent
// directly — "this turn is repeating itself" — by streaking on the round's
// own identity: the SET of member identities, with a result digest across
// every member. A,B,C cycles of any width are the same class.
//   · single-call rounds mint NO round identity (the per-call law owns them,
//     and the poll exemption stays exactly as it was);
//   · a round carrying a wait primitive is poll-shaped (check + wait): the
//     success arm exempts it, mirroring the per-call exemption;
//   · a denial member or an unsettled member (refused/aborted) makes the
//     round incomparable — NEUTRAL: it neither arms nor resets;
//   · outcome class is 'failure' only when EVERY member failed (the pure
//     trance-retry, tighter bounds); anything mixed streaks as 'success'
//     (nothing new is coming), and a moving result in ANY member resets.

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

/** One member call of a round, by the same identity vocabulary the per-call
 *  guard uses. */
export type RoundCall = { toolName: string; key: string }

/** One member's settled result; null when the member never settled (refused,
 *  aborted) — an unsettled member makes the whole round neutral. */
export type RoundSettlement = { key: string; resultText: string | null; isError: boolean } | null

/** Consecutive identical failures required to arm the refusal. */
export const IDENTICAL_FAILURES_TO_ARM = 2
/** Consecutive identical failures that end the turn (the nudge was ignored). */
export const IDENTICAL_FAILURES_TO_STOP = 5
/** Consecutive identical successful calls with the identical result required
 *  to arm the refusal. */
export const IDENTICAL_RESULTS_TO_ARM = 3
/** Consecutive identical results that end the turn. */
export const IDENTICAL_RESULTS_TO_STOP = 6

/** Tools whose identical consecutive results are their purpose — waiting. */
const SUCCESS_ARM_EXEMPT = new Set<string>([SLEEP_TOOL_NAME, MONITOR_TOOL_NAME])

/** The failure nudge (contract data — the refusal result's model-visible
 *  text). It names the mechanism, the remedy, and the honest bounds (fires
 *  once; an identical attempt after it will run; the streak that ends the
 *  turn). */
export const IDENTICAL_RETRY_NUDGE =
  'Refusing to run this exact call again: the identical input already failed ' +
  `${IDENTICAL_FAILURES_TO_ARM} times in a row with the identical error. ` +
  'Change something material — a different input, a different tool, or a different approach — ' +
  'or state the blocker and continue with other work. ' +
  'If repeating really is right (e.g. waiting on an external change), do a check or wait in between; ' +
  'this guard fires once, and a later identical attempt will run — ' +
  `but ${IDENTICAL_FAILURES_TO_STOP} identical failures in a row end the turn.`

/** The same-result nudge: the call ran, its result never moved, and the
 *  model keeps asking. */
export const IDENTICAL_RESULT_NUDGE =
  'Refusing to run this exact call again: the identical input already returned the identical result ' +
  `${IDENTICAL_RESULTS_TO_ARM} times in a row, so nothing has changed and repeating it yields nothing new. ` +
  'Act on the result you already have, change the input or the tool, ' +
  'or — if you are waiting for something external to change — wait first (Sleep or Monitor) and check once after. ' +
  `This guard fires once, and a later identical attempt will run — but ${IDENTICAL_RESULTS_TO_STOP} identical results in a row end the turn.`

/** The identity of a call for the guard: tool name + the progress model's
 *  fingerprint key (family · normalized target · salient-input digest). */
export function identityKeyFor(toolName: string, input: unknown, cwd: string): string {
  try {
    return `${toolName}\x00${fingerprintKey(makeAttemptFingerprint({ toolName, input, cwd }))}`
  } catch {
    // A fingerprint that cannot be minted never guards — fail open to run.
    return `${toolName}\x00unfingerprintable`
  }
}

function armedAt(record: LoopRecord): number {
  return record.outcome === 'failure' ? IDENTICAL_FAILURES_TO_ARM : IDENTICAL_RESULTS_TO_ARM
}

function stopAt(record: LoopRecord): number {
  return record.outcome === 'failure' ? IDENTICAL_FAILURES_TO_STOP : IDENTICAL_RESULTS_TO_STOP
}

/** The nudge a refused call carries, by the armed streak's outcome. */
export function repetitionNudgeFor(outcome: RepetitionOutcome): string {
  return outcome === 'failure' ? IDENTICAL_RETRY_NUDGE : IDENTICAL_RESULT_NUDGE
}

/** The nudge every member of a refused ROUND carries: the batch spelling of
 *  the same law (the model repeated the whole round, not one call). */
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

/** Consult BEFORE running a call. The armed streak's outcome ⇒ refuse this
 *  call with that outcome's nudge (and spend the one nudge for the armed
 *  shape); null ⇒ run it. */
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

/** The boolean form of the consult (the failure-guard vocabulary). True ⇒
 *  refuse this call. */
export function shouldRefuseIdenticalRetry(
  controller: AbortController,
  key: string,
): boolean {
  return consultRepetitionGuard(controller, key) !== null
}

/**
 * Record a call's settled outcome. A denial/interrupt result is neutral (the
 * call never ran or the operator spoke — neither arms nor resets). Otherwise
 * the identical identity + outcome class + result digest increments the
 * streak (crossing its stop bound stamps the stop verdict); anything else —
 * a different call, a different result, a success after a failure — starts
 * a fresh record. The wait primitives never start a success record.
 */
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

/** The round identity: the SET of member identity keys, digested. Null for
 *  rounds of fewer than two calls — the per-call law owns those, and the
 *  poll-consecutiveness exemption stays untouched. */
export function roundIdentityOf(calls: RoundCall[]): string | null {
  if (calls.length < 2) return null
  const members = calls.map(call => call.key).sort()
  return createHash('sha256').update(members.join('\x00')).digest('hex').slice(0, 16)
}

/** Consult BEFORE dispatching a MULTI-CALL round. The armed round's outcome ⇒
 *  refuse the whole round with that outcome's nudge (spending the one round
 *  nudge); null ⇒ dispatch it. */
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

/** The display spelling of a round's membership: distinct tool names in
 *  first-appearance order, duplicates as ×N (`Read ×2`, `Read + Glob`). */
function roundToolNamesOf(calls: RoundCall[]): string {
  const counts = new Map<string, number>()
  for (const call of calls) counts.set(call.toolName, (counts.get(call.toolName) ?? 0) + 1)
  return [...counts.entries()]
    .map(([name, count]) => (count > 1 ? `${name} ×${count}` : name))
    .join(' + ')
}

/**
 * Record a settled MULTI-CALL round. An unsettled member or a denial member
 * makes the round incomparable — neutral (no arm, no reset). The identical
 * round identity + outcome class + member-result digest increments the
 * streak (crossing its stop bound stamps the stop verdict); anything else
 * starts a fresh round record. A success-class round carrying a wait
 * primitive never streaks (poll-shaped — check + wait).
 */
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

/** The turn machine's consult after a tool round: the stop verdict when a
 *  streak — per-call or round — crossed its bound this round, consumed
 *  exactly once. */
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

/** The operator-visible line for a stopped turn (a 'warning' notice) and the
 *  cause the typed terminal carries. */
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

/** The synthesized refusal tool_result (mirrors the executor's error-result
 *  shape: the tool_use_error wrapper the transcript and model layers match). */
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

/** Extract THIS call's settled tool_result from a streamed update message:
 *  [text, isError], or null when the message is not its result. */
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

/** Proof seam. */
export function __resetIdenticalFailureGuardForTest(controller: AbortController): void {
  records.delete(controller)
  roundRecords.delete(controller)
}
