#!/usr/bin/env bun
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

process.chdir(resolve(import.meta.dir, '..', '..'))
process.env.MERCURY_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'recovery-budget-home-'))
delete process.env.MERCURY_HOME
delete process.env.MERCURY_RECOVERY_BUDGET_MINUTES
delete process.env.NODE_ENV

const budget = await import('../../src/services/api/recoveryBudget.js')
const retry = await import('../../src/services/api/withRetry.js')
const retryAfter = await import('../../src/services/api/retryAfter.js')

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
}

const notice = (args: { retryInMs?: number; recoveryTimeoutMs?: number; status?: number; headers?: Record<string, string>; message?: string; attempt?: number; of?: number }): unknown => {
  const error = Object.assign(new Error(args.message ?? 'API Error'), {
    ...(args.status !== undefined ? { status: args.status } : {}),
    ...(args.headers !== undefined ? { headers: args.headers } : {}),
  })
  return {
    type: 'system',
    subtype: 'api_error',
    error,
    errorDetail: { name: 'Error', message: error.message, ...(args.status !== undefined ? { status: args.status } : {}) },
    retryInMs: args.retryInMs ?? 0,
    ...(args.recoveryTimeoutMs !== undefined ? { recoveryTimeoutMs: args.recoveryTimeoutMs } : {}),
    retryAttempt: args.attempt ?? 1,
    maxRetries: args.of ?? 10,
  }
}
const factsOf = (m: unknown): NonNullable<ReturnType<typeof budget.recoveryNoticeFacts>> => {
  const f = budget.recoveryNoticeFacts(m)
  if (f === null) throw new Error('not a notice')
  return f
}

section('S1 — the classes: refusals spend, faults and recoveries are honoured whole')
{
  const busy = factsOf(notice({ retryInMs: 2_000, status: 429 }))
  check('a 429 is a refusal: throttle class, provider busy', busy.kind === 'throttle' && busy.cause === 'provider busy (HTTP 429)' && busy.providerDeclared === false, JSON.stringify(busy))
  const asked = factsOf(notice({ retryInMs: 2_000, status: 429, headers: { 'retry-after': '2' } }))
  check('a 429 with Retry-After is the provider asking', asked.kind === 'throttle' && asked.providerDeclared === true, JSON.stringify(asked))
  const over = factsOf(notice({ retryInMs: 500, status: 529 }))
  check('a 529 is a refusal: provider overloaded', over.kind === 'throttle' && over.cause === 'provider overloaded (HTTP 529)', JSON.stringify(over))
  const marker = factsOf(notice({ retryInMs: 500, message: 'API Error: {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}' }))
  check('the overload marker in a status-less body is the same refusal', marker.kind === 'throttle' && marker.cause === 'provider overloaded (HTTP 529)', JSON.stringify(marker))
  const wait503 = factsOf(notice({ retryInMs: 600_000, status: 503, headers: { 'retry-after': '600' } }))
  check('a 503 carrying Retry-After is a wait the provider asked for', wait503.kind === 'throttle' && wait503.providerDeclared && wait503.cause === 'provider asked for a wait (HTTP 503)', JSON.stringify(wait503))
  const bare503 = factsOf(notice({ retryInMs: 1_000, status: 503 }))
  check('a bare 503 is a fault, never a refusal', bare503.kind === 'fault' && bare503.cause === 'provider error (HTTP 503)', JSON.stringify(bare503))
  check('a 500 is a fault', factsOf(notice({ retryInMs: 1_000, status: 500 })).kind === 'fault')
  check('a 408 is a timeout fault', factsOf(notice({ retryInMs: 1_000, status: 408 })).cause === 'the request timed out (HTTP 408)')
  check('a 409 is a fault', factsOf(notice({ retryInMs: 1_000, status: 409 })).kind === 'fault')
  const firstByte = factsOf(notice({ retryInMs: 1_000, message: 'no first byte from Opus 5 after 90 s (the request was accepted and nothing arrived)' }))
  check('a first-byte timeout is a fault named as such', firstByte.kind === 'fault' && firstByte.cause === 'no first byte', JSON.stringify(firstByte))
  const conn = factsOf(notice({ retryInMs: 1_000, message: 'Connection error.' }))
  check('a status-less connection error is a fault: connection lost', conn.kind === 'fault' && conn.cause === 'connection lost', JSON.stringify(conn))
  const reissue = factsOf(notice({ retryInMs: 0, recoveryTimeoutMs: 90_000, message: 'no stream events within 90s of dispatch — the request was accepted and the wait is provider-side; reissuing the stream' }))
  check('the stream-idle reissue is a recovery: the stream went quiet', reissue.kind === 'recovery' && reissue.cause === 'the stream went quiet' && reissue.declaredMs === 90_000, JSON.stringify(reissue))
  const fallback = factsOf(notice({ retryInMs: 0, recoveryTimeoutMs: 300_000, message: 'stream idle watchdog fired after 90s of mid-stream silence — waiting up to 300s for ONE non-streamed completion' }))
  check('the non-streamed fallback after silence is a recovery', fallback.kind === 'recovery' && fallback.cause === 'the stream went quiet', JSON.stringify(fallback))
  const dropped = factsOf(notice({ retryInMs: 0, recoveryTimeoutMs: 300_000, message: 'Premature close' }))
  check('the fallback after a broken stream is a recovery: the stream dropped', dropped.kind === 'recovery' && dropped.cause === 'the stream dropped', JSON.stringify(dropped))
  const door = factsOf(notice({ retryInMs: 0, recoveryTimeoutMs: 300_000, status: 404, message: 'Not Found' }))
  check('the 404 fallback names the door', door.kind === 'recovery' && door.cause === 'the streaming door refused (HTTP 404)', JSON.stringify(door))
}

section('S2 — the arithmetic: only refusals move the budget')
{
  const b = budget.makeRecoveryBudget(6_000)
  const one = budget.honourRecoveryWait(b, factsOf(notice({ retryInMs: 2_000, status: 429, attempt: 1 })))
  check('a 2 s refusal inside a 6 s budget is honoured whole and charged', one.honoredMs === 2_000 && one.charged && !one.spent && b.spentMs === 2_000 && b.waits === 1, JSON.stringify(one))
  const fault = budget.honourRecoveryWait(b, factsOf(notice({ retryInMs: 300_000, status: 503, attempt: 2 })))
  check('a 300 s fault is honoured whole and charged nothing', fault.honoredMs === 300_000 && !fault.charged && !fault.spent && b.spentMs === 2_000 && b.waits === 1, JSON.stringify(fault))
  const recovery = budget.honourRecoveryWait(b, factsOf(notice({ retryInMs: 0, recoveryTimeoutMs: 300_000, message: 'Premature close' })))
  check('a 300 s recovery ceiling is honoured whole and charged nothing', recovery.honoredMs === 300_000 && !recovery.charged && b.spentMs === 2_000, JSON.stringify(recovery))
  const two = budget.honourRecoveryWait(b, factsOf(notice({ retryInMs: 2_000, status: 429, attempt: 2 })))
  const three = budget.honourRecoveryWait(b, factsOf(notice({ retryInMs: 2_000, status: 429, attempt: 3 })))
  check('the third refusal spends the budget exactly', two.spent === false && three.honoredMs === 2_000 && three.spent === true && budget.recoveryBudgetRemainingMs(b) === 0 && b.waits === 3, JSON.stringify([two, three]))
  const none = budget.honourRecoveryWait(b, factsOf(notice({ retryInMs: 2_000, status: 429, attempt: 4 })))
  check('a spent budget honours no further refusal', none.honoredMs === 0 && none.spent && none.charged, JSON.stringify(none))
  const past = budget.makeRecoveryBudget(6_000)
  budget.honourRecoveryWait(past, factsOf(notice({ retryInMs: 2_000, status: 429 })))
  const long = budget.honourRecoveryWait(past, factsOf(notice({ retryInMs: 600_000, status: 429, headers: { 'retry-after': '600' } })))
  check('a refusal past the remainder is honoured up to it and spends the budget', long.honoredMs === 4_000 && long.spent && budget.recoveryBudgetRemainingMs(past) === 0, JSON.stringify(long))
  const off = budget.makeRecoveryBudget(Infinity)
  const whole = budget.honourRecoveryWait(off, factsOf(notice({ retryInMs: 3_600_000, status: 429 })))
  check('a budget that is off honours every refusal whole', whole.honoredMs === 3_600_000 && !whole.spent && whole.charged, JSON.stringify(whole))
}

section('S3 — the refill: the provider answered, the stretch is over')
{
  const b = budget.makeRecoveryBudget(6_000)
  budget.honourRecoveryWait(b, factsOf(notice({ retryInMs: 2_000, status: 429 })))
  budget.honourRecoveryWait(b, factsOf(notice({ retryInMs: 2_000, status: 429 })))
  check('a progress row is not an answer', budget.recoveryAnswerRefills({ type: 'progress' }) === false)
  check('an API-error assistant row is not an answer', budget.recoveryAnswerRefills({ type: 'assistant', isApiErrorMessage: true, message: { content: [] } }) === false)
  check('the next request starting is not an answer', budget.recoveryAnswerRefills({ type: 'stream_request_start' }) === false)
  check('a message_start is the answer', budget.recoveryAnswerRefills({ type: 'stream_event', event: { type: 'message_start' } }) === true)
  check('a real assistant row is the answer', budget.recoveryAnswerRefills({ type: 'assistant', message: { content: [{ type: 'text', text: 'hi' }] } }) === true)
  budget.refillRecoveryBudget(b)
  check('the refill: nothing spent, no waits counted, the whole budget back', b.spentMs === 0 && b.waits === 0 && budget.recoveryBudgetRemainingMs(b) === 6_000, JSON.stringify(b))
  const again = budget.honourRecoveryWait(b, factsOf(notice({ retryInMs: 2_000, status: 429 })))
  check('after the refill a refusal is honoured whole again', again.honoredMs === 2_000 && !again.spent, JSON.stringify(again))
}

section('S4 — per seat: two budgets never share a spend')
{
  const a = budget.makeRecoveryBudget(6_000)
  const b = budget.makeRecoveryBudget(6_000)
  budget.honourRecoveryWait(a, factsOf(notice({ retryInMs: 6_000, status: 429 })))
  check("one seat's spent budget leaves the other whole", budget.recoveryBudgetRemainingMs(a) === 0 && budget.recoveryBudgetRemainingMs(b) === 6_000 && b.waits === 0)
}

section('S5 — Retry-After: both spellings name the wait')
{
  check('the seconds form', retry.getRetryDelay(3, '2') === 2_000, String(retry.getRetryDelay(3, '2')))
  const now = Math.floor(Date.now() / 1000) * 1000
  const date = new Date(now + 30_000).toUTCString()
  const dated = retry.getRetryDelay(3, date)
  check('the HTTP-date form: the wait until that instant', dated >= 27_000 && dated <= 31_000, `${date} → ${dated}`)
  const past = retry.getRetryDelay(3, new Date(now - 30_000).toUTCString())
  check('an HTTP date already past falls through to the ladder', past >= 2_000 && past <= 2_500, String(past))
  const junk = retry.getRetryDelay(3, 'soon')
  check('junk falls through to the ladder (attempt 3: 2 s plus jitter)', junk >= 2_000 && junk <= 2_500, String(junk))
  check('the six-hour ceiling holds', retry.getRetryDelay(1, String(48 * 3600)) === 6 * 3600 * 1000)
  check('retryAfterHeaderMs reads both forms and refuses junk', retryAfter.retryAfterHeaderMs('5', now) === 5_000 && retryAfter.retryAfterHeaderMs(new Date(now + 10_000).toUTCString(), now) === 10_000 && retryAfter.retryAfterHeaderMs('soon', now) === undefined && retryAfter.retryAfterHeaderMs(undefined, now) === undefined && retryAfter.retryAfterHeaderMs('0', now) === undefined)
  check('retryAfterOf reads the header off an error, either spelling', retryAfter.retryAfterOf({ headers: { 'Retry-After': '7' } }) === '7' && retryAfter.retryAfterOf({ headers: new Headers({ 'retry-after': '9' }) }) === '9' && retryAfter.retryAfterOf({}) === undefined && retryAfter.retryAfterOf(null) === undefined)
}

section('S6 — the words name the answer and the wait')
{
  const b = budget.makeRecoveryBudget(6_000)
  const first = factsOf(notice({ retryInMs: 2_000, status: 429, attempt: 1, of: 10 }))
  const honoured = budget.honourRecoveryWait(b, first)
  const w1 = budget.retryWaitWords({ facts: first, honoredMs: honoured.honoredMs, budget: b })
  check('a refusal: the answer, the wait, the ladder, the budget left', w1 === 'provider busy (HTTP 429) — waiting 2 s before retry 1 of 10; 4 s of the 6s retry budget left', w1)
  const over = factsOf(notice({ retryInMs: 8_000, status: 529, attempt: 4, of: 10 }))
  const overHonoured = budget.honourRecoveryWait(b, over)
  const w2 = budget.retryWaitWords({ facts: over, honoredMs: overHonoured.honoredMs, budget: b })
  check("an overload past the remainder: the budget's end inside the wait", w2 === 'provider overloaded (HTTP 529) — waiting 8 s before retry 4 of 10; the 6s retry budget ends this wait after 4 s', w2)
  const c = budget.makeRecoveryBudget(6_000)
  budget.honourRecoveryWait(c, factsOf(notice({ retryInMs: 4_000, status: 429 })))
  const asked = factsOf(notice({ retryInMs: 600_000, status: 429, headers: { 'retry-after': '600' }, attempt: 2, of: 10 }))
  const askedHonoured = budget.honourRecoveryWait(c, asked)
  const w3 = budget.retryWaitWords({ facts: asked, honoredMs: askedHonoured.honoredMs, budget: c })
  check("the provider's own ask past the remainder names the ask", w3 === 'provider busy (HTTP 429) — the provider asked for 10m; the 6s retry budget ends this wait after 2 s', w3)
  const exact = budget.makeRecoveryBudget(6_000)
  const last = factsOf(notice({ retryInMs: 6_000, status: 429, attempt: 1, of: 10 }))
  const lastHonoured = budget.honourRecoveryWait(exact, last)
  const w4 = budget.retryWaitWords({ facts: last, honoredMs: lastHonoured.honoredMs, budget: exact })
  check('a refusal that ends the budget exactly says so', w4 === 'provider busy (HTTP 429) — waiting 6 s before retry 1 of 10; the 6s retry budget ends with this wait', w4)
  const fault = factsOf(notice({ retryInMs: 1_000, status: 503, attempt: 2, of: 10 }))
  const w5 = budget.retryWaitWords({ facts: fault, honoredMs: 1_000, budget: b })
  check('a fault: the answer and the wait, no budget words', w5 === 'provider error (HTTP 503) — waiting 1 s before retry 2 of 10', w5)
  const conn = factsOf(notice({ retryInMs: 1_000, message: 'Connection error.', attempt: 3, of: 10 }))
  check('a connection fault', budget.retryWaitWords({ facts: conn, honoredMs: 1_000, budget: b }) === 'connection lost — waiting 1 s before retry 3 of 10')
  const reissue = factsOf(notice({ retryInMs: 0, recoveryTimeoutMs: 90_000, message: 'no stream events within 90s of dispatch; reissuing the stream' }))
  check('the reissue', budget.retryWaitWords({ facts: reissue, honoredMs: 90_000, budget: b }) === 'the stream went quiet — reissuing the stream, up to 1m 30s')
  const fallback = factsOf(notice({ retryInMs: 0, recoveryTimeoutMs: 300_000, message: 'Premature close' }))
  check('the fallback', budget.retryWaitWords({ facts: fallback, honoredMs: 300_000, budget: b }) === 'the stream dropped — one non-streamed answer, up to 5m')
  const off = budget.makeRecoveryBudget(Infinity)
  const free = budget.retryWaitWords({ facts: first, honoredMs: 2_000, budget: off })
  check('a budget that is off names no budget', free === 'provider busy (HTTP 429) — waiting 2 s before retry 1 of 10', free)
  const spent = budget.makeRecoveryBudget(6_000)
  for (let i = 0; i < 3; i++) budget.honourRecoveryWait(spent, factsOf(notice({ retryInMs: 2_000, status: 429 })))
  const line = budget.recoveryBudgetSpentLine(spent)
  check('the spent line names the refusals, the answer, the budget and the way out', line === 'the provider refused 3 times in a row (HTTP 429, busy) — the 6s retry budget is spent and the agent stopped; retry when it clears, or raise MERCURY_RECOVERY_BUDGET_MINUTES', line)
  const spent529 = budget.makeRecoveryBudget(6_000)
  budget.honourRecoveryWait(spent529, factsOf(notice({ retryInMs: 6_000, status: 529 })))
  check('one overload that spends it', budget.recoveryBudgetSpentLine(spent529) === 'the provider refused 1 time in a row (HTTP 529, overloaded) — the 6s retry budget is spent and the agent stopped; retry when it clears, or raise MERCURY_RECOVERY_BUDGET_MINUTES', budget.recoveryBudgetSpentLine(spent529))
  check('the spent-line predicate: the line yes, other prose no', budget.isRecoveryBudgetSpentLine(line) && !budget.isRecoveryBudgetSpentLine('API Error: 529 overloaded_error') && !budget.isRecoveryBudgetSpentLine('Prompt is too long'))
  check('the knob: unset ⇒ 5 minutes', budget.recoveryBudgetMs() === 5 * 60_000)
  process.env.MERCURY_RECOVERY_BUDGET_MINUTES = '0.1'
  check('the knob: 0.1 ⇒ six seconds', budget.recoveryBudgetMs() === 6_000)
  delete process.env.MERCURY_RECOVERY_BUDGET_MINUTES
}

section('S7 — the notice reader')
{
  const real = factsOf(notice({ retryInMs: 40_000, recoveryTimeoutMs: 300_000, status: 429, attempt: 2, of: 10 }))
  check('a real delay outranks a ceiling; the ladder rides along', real.declaredMs === 40_000 && real.attempt === 2 && real.of === 10 && real.status === 429, JSON.stringify(real))
  check('a plain row is no notice', budget.recoveryNoticeFacts({ type: 'assistant' }) === null && budget.recoveryNoticeFacts({ type: 'system', subtype: 'api_error', retryInMs: 0 }) === null)
}

console.log(failures === 0 ? '\nprove-recovery-budget: all green' : `\nprove-recovery-budget: ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
