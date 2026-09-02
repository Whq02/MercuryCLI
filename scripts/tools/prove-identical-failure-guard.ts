#!/usr/bin/env bun
// ============================================================================
//  prove-identical-failure-guard — the repeated-identical-failure breaker
//
//
//  The laws under proof:
//    §1 identity — digest equality via the progress model's ONE vocabulary:
//       superficial input diffs (description/label/key order) never mint
//       novelty; material diffs always do; the tool name is part of identity.
//    §2 arming — two consecutive identical failures with the identical error
//       arm the guard; the next identical call is refused EXACTLY ONCE, then
//       the guard stands down for that shape (a later identical retry runs).
//    §3 resets — any success resets; a different identity replaces; a
//       DIFFERENT error text on the same identity restarts the count.
//    §4 neutrality — denial/interrupt results neither arm nor reset (the
//       poll-with-checks and consent flows never fight the guard).
//    §5 wiring — runTools consults the guard BEFORE marking in-progress /
//       executing, in both the serial and concurrent branches (structural).
//    §6 the success arm — identical successful calls with the IDENTICAL
//       result arm at IDENTICAL_RESULTS_TO_ARM and refuse once with the
//       same-result nudge; a moving result never arms; the wait primitives
//       (Sleep · Monitor) never arm; a failure after a success streak starts
//       a fresh record.
//    §7 the stop bound — a streak that runs past its nudge to
//       IDENTICAL_FAILURES_TO_STOP / IDENTICAL_RESULTS_TO_STOP stamps the
//       stop verdict, consumed exactly once; a refused call never counts;
//       the notice names the tool, the streak and the outcome class.
// ============================================================================
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = join(import.meta.dir, '..', '..')

const {
  identityKeyFor,
  shouldRefuseIdenticalRetry,
  consultRepetitionGuard,
  recordToolOutcome,
  takeRepetitionStop,
  repetitionStopNotice,
  identicalRetryRefusalMessage,
  IDENTICAL_FAILURES_TO_ARM,
  IDENTICAL_FAILURES_TO_STOP,
  IDENTICAL_RESULTS_TO_ARM,
  IDENTICAL_RESULTS_TO_STOP,
  IDENTICAL_RETRY_NUDGE,
  IDENTICAL_RESULT_NUDGE,
  roundIdentityOf,
  consultRoundRepetitionGuard,
  recordRoundOutcome,
} = await import('../../src/services/tools/identicalFailureGuard.ts')

let failures = 0
const check = (label: string, ok: boolean, detail = ''): void => {
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${!ok && detail ? ` — ${detail}` : ''}`)
  if (!ok) failures++
}
const section = (t: string): void => console.log('\n' + '─'.repeat(72) + '\n' + t)

const CWD = '/tmp/guard-proof'

section('§1 identity — one digest vocabulary, superficial diffs never mint novelty')
{
  const a = identityKeyFor('Bash', { command: 'false', description: 'try it' }, CWD)
  const b = identityKeyFor('Bash', { description: 'second try', command: 'false' }, CWD)
  check('same salient input + reordered/volatile keys ⇒ SAME identity', a === b)
  const c = identityKeyFor('Bash', { command: 'false || true' }, CWD)
  check('a materially different command ⇒ different identity', a !== c)
  const d = identityKeyFor('mcp__x__poke', {}, CWD)
  const e = identityKeyFor('mcp__y__poke', {}, CWD)
  check('same empty input on DIFFERENT tools ⇒ different identity', d !== e)
}

section('§2 arming + refuse-once')
{
  const loop = new AbortController()
  const key = identityKeyFor('Bash', { command: 'false' }, CWD)
  check('fresh loop ⇒ no refusal', shouldRefuseIdenticalRetry(loop, key) === false)
  recordToolOutcome(loop, key, 'exit 1', true)
  check('one failure ⇒ still no refusal', shouldRefuseIdenticalRetry(loop, key) === false)
  recordToolOutcome(loop, key, 'exit 1', true)
  check(
    `${IDENTICAL_FAILURES_TO_ARM} identical failures ⇒ the NEXT identical call is refused`,
    shouldRefuseIdenticalRetry(loop, key) === true,
  )
  check('…exactly once — the nudge is spent', shouldRefuseIdenticalRetry(loop, key) === false)
  check('the nudge names the mechanism and the bound', IDENTICAL_RETRY_NUDGE.includes('once') && IDENTICAL_RETRY_NUDGE.includes('identical'))
}

section('§3 resets')
{
  const loop = new AbortController()
  const key = identityKeyFor('Bash', { command: 'false' }, CWD)
  recordToolOutcome(loop, key, 'exit 1', true)
  recordToolOutcome(loop, key, 'exit 1', true)
  // An intervening SUCCESS of any call resets the run.
  recordToolOutcome(loop, identityKeyFor('Read', { file_path: '/x' }, CWD), 'ok', false)
  check('an intervening success resets the run', shouldRefuseIdenticalRetry(loop, key) === false)

  const loop2 = new AbortController()
  recordToolOutcome(loop2, key, 'exit 1', true)
  // A different identity FAILING replaces the record (consecutiveness).
  recordToolOutcome(loop2, identityKeyFor('Bash', { command: 'other' }, CWD), 'boom', true)
  recordToolOutcome(loop2, key, 'exit 1', true)
  check('non-consecutive identical failures never arm (poll shapes are safe)', shouldRefuseIdenticalRetry(loop2, key) === false)

  const loop3 = new AbortController()
  recordToolOutcome(loop3, key, 'exit 1', true)
  recordToolOutcome(loop3, key, 'a DIFFERENT error', true)
  check('a different error text restarts the count', shouldRefuseIdenticalRetry(loop3, key) === false)
}

section('§4 denial/interrupt neutrality')
{
  const loop = new AbortController()
  const key = identityKeyFor('Bash', { command: 'false' }, CWD)
  recordToolOutcome(loop, key, 'exit 1', true)
  recordToolOutcome(loop, key, 'exit 1', true)
  // A denial in between (e.g. the operator declined an unrelated ask) is
  // neutral: it neither arms further nor resets the armed shape.
  recordToolOutcome(
    loop,
    identityKeyFor('Edit', { file_path: '/x', old_string: 'a', new_string: 'b' }, CWD),
    '[Request interrupted by user]',
    true,
  )
  check('an interrupt/denial result is neutral (armed shape survives)', shouldRefuseIdenticalRetry(loop, key) === true)
}

section('§5 wiring — runTools consults before execution (structural)')
{
  const src = readFileSync(join(ROOT, 'src/services/tools/toolOrchestration.ts'), 'utf8')
  check('both branches consult consultRepetitionGuard', (src.match(/consultRepetitionGuard\(/g) ?? []).length === 2)
  const serial = src.indexOf('consultRepetitionGuard(context.abortController')
  const serialRun = src.indexOf('runToolUse(block, parent, canUseTool, context)')
  check('serial branch: the consult precedes execution', serial !== -1 && serialRun !== -1 && serial < serialRun)
  check('outcomes recorded from the settled results', (src.match(/recordToolOutcome\(/g) ?? []).length === 2)
  check('the refusal carries the armed streak\'s own nudge', (src.match(/identicalRetryRefusalMessage\(block\.id, parent\.uuid as string, armed\)/g) ?? []).length === 2)
  const machine = readFileSync(join(ROOT, 'src/run-core/turn-machine.ts'), 'utf8')
  const consult = machine.indexOf('takeRepetitionStop(toolUseContext.abortController)')
  const drain = machine.indexOf('// ── the steering drain')
  check('the turn machine consults the stop verdict after the round, before the steering drain', consult !== -1 && drain !== -1 && consult < drain)
  check("…and ends the run typed ('repetition_breaker') with a warning notice", machine.includes("reason: 'repetition_breaker'") && machine.includes("createSystemMessage(cause, 'warning')"))
}

section('§6 the success arm — identical results arm; moving results, waits and mixed outcomes never do')
{
  const loop = new AbortController()
  const key = identityKeyFor('Read', { file_path: '/x' }, CWD)
  for (let i = 0; i < IDENTICAL_RESULTS_TO_ARM - 1; i++) recordToolOutcome(loop, key, 'same bytes', false)
  check(`${IDENTICAL_RESULTS_TO_ARM - 1} identical results ⇒ still runs`, consultRepetitionGuard(loop, key) === null)
  recordToolOutcome(loop, key, 'same bytes', false)
  check(`${IDENTICAL_RESULTS_TO_ARM} identical results ⇒ the next identical call is refused with the SUCCESS outcome`, consultRepetitionGuard(loop, key) === 'success')
  check('…exactly once', consultRepetitionGuard(loop, key) === null)
  check('the same-result nudge names the mechanism, the wait remedy and the stop bound', IDENTICAL_RESULT_NUDGE.includes('identical result') && IDENTICAL_RESULT_NUDGE.includes('Sleep') && IDENTICAL_RESULT_NUDGE.includes(String(IDENTICAL_RESULTS_TO_STOP)))
  const refusal = identicalRetryRefusalMessage('tu_1', 'uuid_1', 'success') as { message: { content: Array<{ content?: string; is_error?: boolean }> } }
  check('the success refusal is an is_error tool_result carrying the same-result nudge', refusal.message.content[0]?.is_error === true && String(refusal.message.content[0]?.content).includes(IDENTICAL_RESULT_NUDGE))
  const failureRefusal = identicalRetryRefusalMessage('tu_2', 'uuid_2') as { message: { content: Array<{ content?: string }> } }
  check('the default refusal stays the failure nudge', String(failureRefusal.message.content[0]?.content).includes(IDENTICAL_RETRY_NUDGE))

  const moving = new AbortController()
  const clock = identityKeyFor('Bash', { command: 'date' }, CWD)
  recordToolOutcome(moving, clock, 't=1', false)
  recordToolOutcome(moving, clock, 't=2', false)
  recordToolOutcome(moving, clock, 't=3', false)
  recordToolOutcome(moving, clock, 't=4', false)
  check('a moving result never arms (each call brings new bytes)', consultRepetitionGuard(moving, clock) === null)

  for (const wait of ['Sleep', 'Monitor']) {
    const w = new AbortController()
    const k = identityKeyFor(wait, { seconds: 5 }, CWD)
    for (let i = 0; i < IDENTICAL_RESULTS_TO_STOP + 2; i++) recordToolOutcome(w, k, 'waited', false)
    check(`${wait}: identical waits never arm and never stop`, consultRepetitionGuard(w, k) === null && takeRepetitionStop(w) === null)
  }

  const mixed = new AbortController()
  const k2 = identityKeyFor('Bash', { command: 'flaky' }, CWD)
  recordToolOutcome(mixed, k2, 'ok', false)
  recordToolOutcome(mixed, k2, 'ok', false)
  recordToolOutcome(mixed, k2, 'boom', true)
  check('a failure after a success streak starts a fresh record (no cross-outcome arming)', consultRepetitionGuard(mixed, k2) === null)
  recordToolOutcome(mixed, k2, 'boom', true)
  check('…and the failure streak arms on its own count', consultRepetitionGuard(mixed, k2) === 'failure')
}

section('§7 the stop bound — running past the nudge ends the turn, once, typed')
{
  const loop = new AbortController()
  const key = identityKeyFor('Bash', { command: 'false' }, CWD)
  recordToolOutcome(loop, key, 'exit 1', true)
  recordToolOutcome(loop, key, 'exit 1', true)
  check('below the stop bound: no verdict', takeRepetitionStop(loop) === null)
  check('the third identical call is refused (the nudge)', consultRepetitionGuard(loop, key) === 'failure')
  // The refused call never counts; the model runs the shape again.
  for (let i = IDENTICAL_FAILURES_TO_ARM; i < IDENTICAL_FAILURES_TO_STOP - 1; i++) recordToolOutcome(loop, key, 'exit 1', true)
  check(`${IDENTICAL_FAILURES_TO_STOP - 1} identical failures: still no verdict`, takeRepetitionStop(loop) === null)
  recordToolOutcome(loop, key, 'exit 1', true)
  const stop = takeRepetitionStop(loop)
  check(`${IDENTICAL_FAILURES_TO_STOP} identical failures ⇒ the stop verdict names the tool, the streak and the outcome`, stop !== null && stop.toolName === 'Bash' && stop.streak === IDENTICAL_FAILURES_TO_STOP && stop.outcome === 'failure', JSON.stringify(stop))
  check('the verdict is consumed exactly once', takeRepetitionStop(loop) === null)
  check('a consumed verdict leaves a clean loop (the next identical call runs)', consultRepetitionGuard(loop, key) === null)
  const notice = stop ? repetitionStopNotice(stop) : ''
  check('the notice names the tool, the count and what to do next', notice.includes('Bash') && notice.includes(`${IDENTICAL_FAILURES_TO_STOP} times`) && notice.includes('identical error') && notice.includes('new prompt'))

  const success = new AbortController()
  const k = identityKeyFor('Glob', { pattern: '**/*.ts' }, CWD)
  for (let i = 0; i < IDENTICAL_RESULTS_TO_STOP; i++) recordToolOutcome(success, k, 'a.ts\nb.ts', false)
  const s = takeRepetitionStop(success)
  check(`${IDENTICAL_RESULTS_TO_STOP} identical results ⇒ the success stop verdict`, s !== null && s.outcome === 'success' && s.streak === IDENTICAL_RESULTS_TO_STOP && s.toolName === 'Glob', JSON.stringify(s))
  check('the success notice says "identical result"', s !== null && repetitionStopNotice(s).includes('identical result'))

  const reset = new AbortController()
  for (let i = 0; i < IDENTICAL_FAILURES_TO_STOP - 1; i++) recordToolOutcome(reset, key, 'exit 1', true)
  recordToolOutcome(reset, identityKeyFor('Read', { file_path: '/y' }, CWD), 'fresh', false)
  recordToolOutcome(reset, key, 'exit 1', true)
  check('an intervening different call keeps the stop bound honest (the streak restarted)', takeRepetitionStop(reset) === null)
}

section('§8 the ROUND law — a repeating BATCH of two or more calls arms and stops (the operator sighting: per-call streaks reset A,B,A,B… forever, so the breaker was structurally blind to every batch)')
{
  const hasRoundLaw =
    typeof roundIdentityOf === 'function' &&
    typeof consultRoundRepetitionGuard === 'function' &&
    typeof recordRoundOutcome === 'function'
  check('the round-level guard mechanism exists', hasRoundLaw)
  if (hasRoundLaw) {
    const keyA = identityKeyFor('Read', { file_path: '/a.md' }, CWD)
    const keyB = identityKeyFor('Read', { file_path: '/b.txt' }, CWD)
    const calls = [
      { toolName: 'Read', key: keyA },
      { toolName: 'Read', key: keyB },
    ]
    const roundKey = roundIdentityOf(calls)
    check('a two-call round mints a round identity', typeof roundKey === 'string' && roundKey !== null)
    check('a single-call round mints NO round identity (per-call law owns it)', roundIdentityOf([{ toolName: 'Read', key: keyA }]) === null)
    check('round identity is order-independent (a set, not a sequence)', roundIdentityOf([calls[1]!, calls[0]!]) === roundKey)
    const otherKey = roundIdentityOf([calls[0]!, { toolName: 'Glob', key: identityKeyFor('Glob', { pattern: '*.md' }, CWD) }])
    check('a different membership is a different round identity', otherKey !== roundKey)

    // The operator's `loop` arm: the identical {Read A, Read B} round, with
    // identical per-call results, round after round. Per-call streaks reset
    // on every alternation (§3's consecutiveness law — correct for polls);
    // the ROUND streak is what must arm and stop.
    const loop = new AbortController()
    const settle = () =>
      recordRoundOutcome(loop, roundKey as string, calls, [
        { key: keyA, resultText: 'bytes of A', isError: false },
        { key: keyB, resultText: 'bytes of B', isError: false },
      ])
    for (let i = 0; i < IDENTICAL_RESULTS_TO_ARM - 1; i++) settle()
    check(`${IDENTICAL_RESULTS_TO_ARM - 1} identical rounds ⇒ the round still runs`, consultRoundRepetitionGuard(loop, roundKey as string) === null)
    settle()
    check('the per-call guard stays blind across the alternation (poll-safe law intact)', consultRepetitionGuard(loop, keyA) === null && consultRepetitionGuard(loop, keyB) === null)
    check(`${IDENTICAL_RESULTS_TO_ARM} identical rounds ⇒ the NEXT identical round is refused with the SUCCESS outcome`, consultRoundRepetitionGuard(loop, roundKey as string) === 'success')
    check('…exactly once — the round nudge is spent', consultRoundRepetitionGuard(loop, roundKey as string) === null)
    for (let i = IDENTICAL_RESULTS_TO_ARM; i < IDENTICAL_RESULTS_TO_STOP; i++) settle()
    const stop = takeRepetitionStop(loop)
    check(
      `${IDENTICAL_RESULTS_TO_STOP} identical rounds ⇒ the stop verdict, naming the batch`,
      stop !== null && stop.outcome === 'success' && stop.streak === IDENTICAL_RESULTS_TO_STOP && (stop.calls ?? 0) === 2,
      JSON.stringify(stop),
    )
    check('the round stop notice reads as a batch, not a single call', stop !== null && repetitionStopNotice(stop).includes('2 tool calls'))
    check('the verdict is consumed exactly once', takeRepetitionStop(loop) === null)

    // A moving result in ANY member resets the round streak.
    const moving = new AbortController()
    for (let i = 0; i < IDENTICAL_RESULTS_TO_STOP + 2; i++) {
      recordRoundOutcome(moving, roundKey as string, calls, [
        { key: keyA, resultText: 'bytes of A', isError: false },
        { key: keyB, resultText: `t=${i}`, isError: false },
      ])
    }
    check('a round whose any member result moves never arms', consultRoundRepetitionGuard(moving, roundKey as string) === null && takeRepetitionStop(moving) === null)

    // A round with a wait primitive is poll-shaped: the success arm exempts it.
    const pollish = new AbortController()
    const waitKey = identityKeyFor('Monitor', { until: 'built' }, CWD)
    const pollCalls = [calls[0]!, { toolName: 'Monitor', key: waitKey }]
    const pollRound = roundIdentityOf(pollCalls) as string
    for (let i = 0; i < IDENTICAL_RESULTS_TO_STOP + 2; i++) {
      recordRoundOutcome(pollish, pollRound, pollCalls, [
        { key: keyA, resultText: 'bytes of A', isError: false },
        { key: waitKey, resultText: 'still waiting', isError: false },
      ])
    }
    check('a round carrying a wait primitive (check + wait) never success-arms', consultRoundRepetitionGuard(pollish, pollRound) === null && takeRepetitionStop(pollish) === null)

    // A denial member is neutral — the round neither arms nor resets.
    const denial = new AbortController()
    for (let i = 0; i < IDENTICAL_RESULTS_TO_ARM; i++) settleInto(denial)
    function settleInto(c: AbortController): void {
      recordRoundOutcome(c, roundKey as string, calls, [
        { key: keyA, resultText: 'bytes of A', isError: false },
        { key: keyB, resultText: 'bytes of B', isError: false },
      ])
    }
    recordRoundOutcome(denial, roundKey as string, calls, [
      { key: keyA, resultText: 'bytes of A', isError: false },
      { key: keyB, resultText: '[Request interrupted by user]', isError: true },
    ])
    check('a denial member is neutral (armed round survives, uncounted)', consultRoundRepetitionGuard(denial, roundKey as string) === 'success')

    // An unsettled member (refused / aborted mid-round) is incomparable — neutral.
    const partial = new AbortController()
    for (let i = 0; i < IDENTICAL_RESULTS_TO_ARM - 1; i++) settleInto(partial)
    recordRoundOutcome(partial, roundKey as string, calls, [
      { key: keyA, resultText: 'bytes of A', isError: false },
      null,
    ])
    check('a round with an unsettled member neither arms nor resets', consultRoundRepetitionGuard(partial, roundKey as string) === null)
    settleInto(partial)
    check('…and the streak it left standing completes on the next full round', consultRoundRepetitionGuard(partial, roundKey as string) === 'success')

    // ALL-failure rounds arm on the tighter failure bounds.
    const failing = new AbortController()
    const failRound = () =>
      recordRoundOutcome(failing, roundKey as string, calls, [
        { key: keyA, resultText: 'ENOENT', isError: true },
        { key: keyB, resultText: 'ENOENT', isError: true },
      ])
    for (let i = 0; i < IDENTICAL_FAILURES_TO_ARM; i++) failRound()
    check(`${IDENTICAL_FAILURES_TO_ARM} identical ALL-FAILURE rounds ⇒ refused with the FAILURE outcome`, consultRoundRepetitionGuard(failing, roundKey as string) === 'failure')
  }
}

section('§9 round wiring — runTools consults the round guard before dispatch and records the round after it drains (structural)')
{
  const src = readFileSync(join(ROOT, 'src/services/tools/toolOrchestration.ts'), 'utf8')
  check('runTools mints the round identity', src.includes('roundIdentityOf('))
  check('runTools consults the round guard', src.includes('consultRoundRepetitionGuard('))
  check('runTools records the round outcome', src.includes('recordRoundOutcome('))
  const consult = src.indexOf('consultRoundRepetitionGuard(')
  const batchLoop = src.indexOf('for (const batch of batches)')
  check('the round consult precedes the batch loop (whole-round refusal)', consult !== -1 && batchLoop !== -1 && consult < batchLoop)
  const record = src.indexOf('recordRoundOutcome(')
  check('the round outcome records after the batch loop drains', record !== -1 && batchLoop !== -1 && record > batchLoop)
}

console.log(failures === 0 ? '\n ✅ REPETITION BREAKER — armed, honest, poll-safe, bounded' : `\n ❌ ${failures} FAILED`)
process.exit(failures === 0 ? 0 : 1)
