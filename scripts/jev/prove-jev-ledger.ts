#!/usr/bin/env bun
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0', PACKAGE_URL: 'https://example.invalid/mercury' }

let failures = 0
let checks = 0
function check(label: string, cond: boolean, detail = ''): void {
  checks++
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
}
const near = (a: number, b: number, eps = 1e-12): boolean => Math.abs(a - b) <= eps

const contract = await import('../../src/services/jev/jevContract.js')
const ledger = await import('../../src/services/jev/jevLedger.js')
const { JEV_MAX_CALL_USD, JEV_USD_PER_INPUT_TOKEN, jevChargeUsd, jevRefusalNamesCredit, jevUsdLabel, jevWaitLabel, jevWireFailureKindForStatus } = contract
const {
  JEV_COOL_DOWN_BASE_MS,
  JEV_COOL_DOWN_CAP_MS,
  JEV_PACE_WINDOW_MS,
  jevAdmission,
  jevCoolDownWindowMs,
  jevLedgerSnapshot,
  noteJevAttempt,
  noteJevKeyChanged,
  noteJevWireFailure,
  resetJevLedger,
  settleJevCall,
  takeJevNotice,
} = ledger

const defaults = { enabled: true, allowanceUsd: 20, pacePerMinute: 10, requestCeiling: null, subagents: false }
const mid = (): number => 0.5
const T0 = 1_700_000_000_000

section('§1 the published rate, and the ceiling one call can cost')
check('$0.042 a million input tokens', near(JEV_USD_PER_INPUT_TOKEN, 0.000000042))
check('2,000 tokens cost $0.000084', near(jevChargeUsd(2000), 0.000084))
check('a 64k request is the ceiling: $0.002688', near(JEV_MAX_CALL_USD, 0.002688))
check('a negative token count charges nothing', jevChargeUsd(-5) === 0)
check('$20 is 7,440 worst-case calls', Math.floor(20 / JEV_MAX_CALL_USD) === 7440)
check('dollar labels: whole cents above a cent, honest fractions below', jevUsdLabel(0) === '$0.00' && jevUsdLabel(20) === '$20.00' && jevUsdLabel(0.000084) === '$0.000084' && jevUsdLabel(0.002688) === '$0.002688')
check('wait labels never understate', jevWaitLabel(1) === '1s' && jevWaitLabel(26_400) === '27s' && jevWaitLabel(250_000) === '4m 10s' && jevWaitLabel(120_000) === '2m')

section('§2 a fresh ledger')
resetJevLedger()
const zero = jevLedgerSnapshot(T0)
check('nothing spent, nothing counted, no wire record, no hold', zero.spendUsd === 0 && zero.calls === 0 && zero.attempts === 0 && zero.inputTokens === 0 && zero.unconfirmedCharges === 0 && zero.attemptsThisMinute === 0 && zero.lastWire === null && zero.holdUntil === 0 && zero.refusals === 0 && zero.lastAnsweredAt === null && zero.lastModel === null)
check('admitted under the defaults', jevAdmission(defaults, T0).ok === true)

section('§3 settle: the charge is the returned input tokens at the published rate')
noteJevAttempt(T0)
const charge = settleJevCall({ input_tokens: 2000, output_tokens: 20 }, 'jev-1.13.0', T0 + 400)
check('the charge is $0.000084', near(charge, 0.000084))
const afterOne = jevLedgerSnapshot(T0 + 400)
check('one call, one attempt, 2,000 tokens, the model that answered, the time it answered', afterOne.calls === 1 && afterOne.attempts === 1 && afterOne.inputTokens === 2000 && near(afterOne.spendUsd, 0.000084) && afterOne.lastModel === 'jev-1.13.0' && afterOne.lastAnsweredAt === T0 + 400)
check('output tokens are free and uncounted', afterOne.spendUsd === charge)

section('§4 the pace: attempts in the last minute against the setting')
resetJevLedger()
for (let i = 0; i < 10; i++) noteJevAttempt(T0 + i * 1000)
const paced = jevAdmission(defaults, T0 + 9500)
check('the tenth attempt inside a minute closes the door', paced.ok === false && paced.kind === 'pace-hit')
check('the pace refusal names the count, the setting and the wait', !paced.ok && /10 requests in the last minute/.test(paced.words) && /10 a minute/.test(paced.words) && /admitted in/.test(paced.words))
check('the wait is until the oldest attempt leaves the window', !paced.ok && paced.retryInMs === T0 + JEV_PACE_WINDOW_MS - (T0 + 9500))
check('a minute after the oldest attempt the door reopens', jevAdmission(defaults, T0 + JEV_PACE_WINDOW_MS + 1).ok === true)
check('attemptsThisMinute follows the window as the clock moves on', jevLedgerSnapshot(T0 + 65_500).attemptsThisMinute === 4)
resetJevLedger()
for (let i = 0; i < 3; i++) noteJevAttempt(T0 + i)
const paceThree = jevAdmission({ ...defaults, pacePerMinute: 3 }, T0 + 3)
check('a pace of 3 closes after three', paceThree.ok === false && paceThree.kind === 'pace-hit')

section('§5 the allowance: a runaway stop that reserves the per-call ceiling')
resetJevLedger()
noteJevAttempt(T0)
settleJevCall({ input_tokens: 64_000, output_tokens: 0 }, 'jev-1.13.0', T0)
const tight = jevAdmission({ ...defaults, allowanceUsd: 0.005 }, T0)
check('$0.002688 spent of a $0.005 allowance: one more ceiling call could pass it, so refused', tight.ok === false && tight.kind === 'allowance-hit')
check('the refusal is worded as Mercury\'s own count and names /clear', !tight.ok && /Mercury counts/.test(tight.words) && /\/clear/.test(tight.words))
check('a $0.01 allowance still admits', jevAdmission({ ...defaults, allowanceUsd: 0.01 }, T0).ok === true)
check('the $20 default is nowhere near', jevAdmission(defaults, T0).ok === true)
check('an allowance below one ceiling call refuses before any spend', (() => {
  resetJevLedger()
  const a = jevAdmission({ ...defaults, allowanceUsd: 0.001 }, T0)
  return a.ok === false && a.kind === 'allowance-hit'
})())

section('§6 the optional request ceiling counts attempts')
resetJevLedger()
noteJevAttempt(T0)
noteJevAttempt(T0 + 1)
const ceiling = jevAdmission({ ...defaults, requestCeiling: 2 }, T0 + 2)
check('two attempts against a ceiling of two: refused', ceiling.ok === false && ceiling.kind === 'ceiling-hit' && /2 of 2 requests/.test(ceiling.words))
check('a ceiling of three admits', jevAdmission({ ...defaults, requestCeiling: 3 }, T0 + 2).ok === true)
check('no ceiling admits', jevAdmission(defaults, T0 + 2).ok === true)

section('§7 the sub-agent budget: two calls each, on the same ledger')
resetJevLedger()
noteJevAttempt(T0, 'agent-a')
noteJevAttempt(T0 + 1, 'agent-a')
const agentA = jevAdmission(defaults, T0 + 2, 'agent-a')
check('agent-a used its two calls', agentA.ok === false && agentA.kind === 'subagent-budget-hit' && /2 JEV calls/.test(agentA.words))
check('agent-b still has its two', jevAdmission(defaults, T0 + 2, 'agent-b').ok === true)
check('the main model is not budgeted per agent', jevAdmission(defaults, T0 + 2).ok === true)
check('the attempts counted on the one ledger', jevLedgerSnapshot(T0 + 2).attempts === 2 && jevLedgerSnapshot(T0 + 2).subagentAttempts['agent-a'] === 2)

section('§8 wire failures: the hold ladder, the provider\'s wait, and what clears them')
resetJevLedger()
check('the ladder: 30s, 60s, 120s ... capped at 10m (jitter pinned to 1)', jevCoolDownWindowMs(1, mid) === JEV_COOL_DOWN_BASE_MS && jevCoolDownWindowMs(2, mid) === 60_000 && jevCoolDownWindowMs(3, mid) === 120_000 && jevCoolDownWindowMs(9, mid) === JEV_COOL_DOWN_CAP_MS && jevCoolDownWindowMs(0, mid) === JEV_COOL_DOWN_BASE_MS)
check('jitter stays within ±25%', (() => {
  const lo = jevCoolDownWindowMs(1, () => 0)
  const hi = jevCoolDownWindowMs(1, () => 0.999999)
  return lo === 22_500 && hi <= 37_500 && hi >= 37_499
})())
const w1 = noteJevWireFailure({ kind: 'rate-limited', status: 429, detail: 'Too Many Requests', retryAfterMs: 5_000 }, T0, mid)
check('a 429 with a 5s retry-after opens the 30s ladder window (the longer of the two)', w1 === 30_000 && jevLedgerSnapshot(T0).holdUntil === T0 + 30_000)
const s1 = jevLedgerSnapshot(T0)
check('the wire record carries the status, the words and the wait verbatim', s1.lastWire?.kind === 'rate-limited' && s1.lastWire.status === 429 && s1.lastWire.detail === 'Too Many Requests' && s1.lastWire.retryAfterMs === 5_000 && s1.lastWire.at === T0)
const w2 = noteJevWireFailure({ kind: 'rate-limited', status: 429, detail: 'Too Many Requests', retryAfterMs: 90_000 }, T0 + 1000, mid)
check('a second refusal doubles the ladder, and a longer provider wait wins', w2 === 90_000 && jevLedgerSnapshot(T0 + 1000).refusals === 2)
const w3 = noteJevWireFailure({ kind: 'provider-down', status: 529, detail: 'Overloaded' }, T0 + 2000, mid)
check('a 529 climbs the same ladder (third rung 120s)', w3 === 120_000)
noteJevAttempt(T0 + 3000)
settleJevCall({ input_tokens: 300, output_tokens: 10 }, 'jev-1.13.0', T0 + 3000)
const cleared = jevLedgerSnapshot(T0 + 3000)
check('an answer clears the record, the hold and the streak', cleared.lastWire === null && cleared.holdUntil === 0 && cleared.refusals === 0)
const w4 = noteJevWireFailure({ kind: 'provider-down', status: 529, detail: 'Overloaded' }, T0 + 4000, mid)
check('the next refusal starts the ladder again at 30s', w4 === 30_000)
check('a hold never exceeds a day even when the provider asks for more', noteJevWireFailure({ kind: 'rate-limited', status: 429, detail: 'x', retryAfterMs: 3 * 24 * 60 * 60_000 }, T0 + 5000, mid) === 24 * 60 * 60_000)

section('§9 the key: an invalid key holds until the key changes, never on a timer')
resetJevLedger()
const wk = noteJevWireFailure({ kind: 'invalid-key', status: 401, detail: 'Unauthorized' }, T0, mid)
check('no ladder window for a 401', wk === 0 && jevLedgerSnapshot(T0).holdUntil === 0)
check('the record stands', jevLedgerSnapshot(T0 + 60 * 60_000).lastWire?.kind === 'invalid-key')
noteJevKeyChanged()
check('a key change clears it', jevLedgerSnapshot(T0).lastWire === null)
check('a 422 opens no hold either (a malformed request is Mercury\'s to fix)', noteJevWireFailure({ kind: 'bad-request', status: 422, detail: 'questions.x.criteria' }, T0, mid) === 0 && jevLedgerSnapshot(T0).holdUntil === 0)

section('§10 unknown charges are charged, never refunded')
resetJevLedger()
noteJevAttempt(T0)
noteJevWireFailure({ kind: 'parse-failed', status: 200, detail: 'answers.x.confidence missing' }, T0, mid)
const p = jevLedgerSnapshot(T0)
check('a 200 Mercury could not read counts one unconfirmed charge at the per-call ceiling', p.unconfirmedCharges === 1 && near(p.spendUsd, JEV_MAX_CALL_USD))
check('and holds like an outage (the provider is not usable right now)', p.holdUntil === T0 + 30_000)
noteJevWireFailure({ kind: 'aborted', detail: 'aborted after send' }, T0 + 10, mid)
const a = jevLedgerSnapshot(T0 + 10)
check('an abort after send counts another unconfirmed charge', a.unconfirmedCharges === 2 && near(a.spendUsd, 2 * JEV_MAX_CALL_USD))
check('but opens no hold (the abort was ours)', a.holdUntil === T0 + 30_000 && a.refusals === 1)

section('§11 notify once per reason, until the ledger resets')
resetJevLedger()
check('the first notice of a reason is handed out', takeJevNotice('allowance-hit') === true)
check('the second is not', takeJevNotice('allowance-hit') === false)
check('another reason has its own notice', takeJevNotice('provider-down') === true)
check('the key notice, taken once', takeJevNotice('invalid-key') === true && takeJevNotice('invalid-key') === false)
noteJevKeyChanged()
check('a key change re-arms the key notices only', takeJevNotice('invalid-key') === true && takeJevNotice('allowance-hit') === false)
resetJevLedger()
check('a reset re-arms every notice', takeJevNotice('allowance-hit') === true)

section('§12 the wire status map and the credit phrase family')
check('401 and 403 are an invalid key', jevWireFailureKindForStatus(401) === 'invalid-key' && jevWireFailureKindForStatus(403) === 'invalid-key')
check('400 and 422 are a bad request', jevWireFailureKindForStatus(400) === 'bad-request' && jevWireFailureKindForStatus(422) === 'bad-request')
check('429 is rate limited', jevWireFailureKindForStatus(429) === 'rate-limited')
check('529 and every 5xx are the provider down', jevWireFailureKindForStatus(529) === 'provider-down' && jevWireFailureKindForStatus(500) === 'provider-down' && jevWireFailureKindForStatus(503) === 'provider-down')
check('any other refusal is recorded as a refusal, never guessed', jevWireFailureKindForStatus(402) === 'provider-refused' && jevWireFailureKindForStatus(404) === 'provider-refused' && jevWireFailureKindForStatus(418) === 'provider-refused')
check('a refusal that names credit is recognised by phrase family, not spelling', jevRefusalNamesCredit('insufficient credits') && jevRefusalNamesCredit('Your balance is 0') && jevRefusalNamesCredit('please top-up') && jevRefusalNamesCredit('Payment required'))
check('a refusal that does not name credit is not called credit', !jevRefusalNamesCredit('Not Found') && !jevRefusalNamesCredit('Overloaded') && !jevRefusalNamesCredit(''))

resetJevLedger()
console.log(`\n${checks - failures}/${checks} checks passed`)
process.exit(failures === 0 ? 0 : 1)
