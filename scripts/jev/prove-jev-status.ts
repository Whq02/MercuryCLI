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

const contract = await import('../../src/services/jev/jevContract.js')
const ledger = await import('../../src/services/jev/jevLedger.js')
const status = await import('../../src/services/jev/jevStatus.js')
const { JEV_STATUS_KINDS } = contract
const { jevAdmission: _admission, jevLedgerSnapshot, noteJevAttempt, noteJevWireFailure, resetJevLedger, settleJevCall } = ledger
const { JEV_STATUS_HEADWORDS, jevStatusIsFinalForSession, jevStatusLine, resolveJevStatus } = status
void _admission

type Snapshot = ReturnType<typeof jevLedgerSnapshot>
const T0 = 1_700_000_000_000
const mid = (): number => 0.5
const on = { enabled: true, allowanceUsd: 20, pacePerMinute: 10, requestCeiling: null, subagents: false }
const stored = { present: true, source: 'stored' } as const
const absent = { present: false } as const
const emptyLedger = (): Snapshot => {
  resetJevLedger()
  return jevLedgerSnapshot(T0)
}
const wired = (failure: Parameters<typeof noteJevWireFailure>[0], at = T0): Snapshot => {
  resetJevLedger()
  noteJevWireFailure(failure, at, mid)
  return jevLedgerSnapshot(at)
}

section('§1 every reason is reachable, and each speaks its own words')
const seen = new Map<string, string>()
const record = (label: string, s: { kind: string; words: string }, expect: string): void => {
  check(`${label} ⇒ ${expect}`, s.kind === expect, `${s.kind}: ${s.words}`)
  check(`  words open with the headword "${JEV_STATUS_HEADWORDS[expect as keyof typeof JEV_STATUS_HEADWORDS]}"`, s.words.startsWith(JEV_STATUS_HEADWORDS[expect as keyof typeof JEV_STATUS_HEADWORDS]), s.words)
  seen.set(expect, s.words)
}
record('switch off', resolveJevStatus({ settings: { ...on, enabled: false }, key: stored, ledger: emptyLedger(), now: T0 }), 'off')
record('on, no key', resolveJevStatus({ settings: on, key: absent, ledger: emptyLedger(), now: T0 }), 'no-key')
record('on, key, a 401 on record', resolveJevStatus({ settings: on, key: stored, ledger: wired({ kind: 'invalid-key', status: 401, detail: 'Unauthorized' }), now: T0 }), 'invalid-key')
record('on, key, allowance spent', resolveJevStatus({ settings: { ...on, allowanceUsd: 0.001 }, key: stored, ledger: emptyLedger(), now: T0 }), 'allowance-hit')
resetJevLedger()
for (let i = 0; i < 10; i++) noteJevAttempt(T0 + i)
record('on, key, ten attempts this minute', resolveJevStatus({ settings: on, key: stored, ledger: jevLedgerSnapshot(T0 + 10), now: T0 + 10 }), 'pace-hit')
resetJevLedger()
noteJevAttempt(T0)
record('on, key, a ceiling of one reached', resolveJevStatus({ settings: { ...on, requestCeiling: 1 }, key: stored, ledger: jevLedgerSnapshot(T0 + 1), now: T0 + 1 }), 'ceiling-hit')
resetJevLedger()
noteJevAttempt(T0, 'a1')
noteJevAttempt(T0, 'a1')
record('sub-agent a1 after two calls', resolveJevStatus({ settings: { ...on, subagents: true }, key: stored, ledger: jevLedgerSnapshot(T0), now: T0, agent: { id: 'a1', subagent: true } }), 'subagent-budget-hit')
record('a 429 on record inside its hold', resolveJevStatus({ settings: on, key: stored, ledger: wired({ kind: 'rate-limited', status: 429, detail: 'Too Many Requests', retryAfterMs: 4000 }), now: T0 + 1000 }), 'rate-limited')
record('a 529 on record inside its hold', resolveJevStatus({ settings: on, key: stored, ledger: wired({ kind: 'provider-down', status: 529, detail: 'Overloaded' }), now: T0 + 1000 }), 'provider-down')
record('a refusal naming credit', resolveJevStatus({ settings: on, key: stored, ledger: wired({ kind: 'provider-refused', status: 402, detail: 'insufficient credits' }), now: T0 + 1000 }), 'provider-credit')
record('a refusal naming nothing known', resolveJevStatus({ settings: on, key: stored, ledger: wired({ kind: 'provider-refused', status: 418, detail: 'I am a teapot' }), now: T0 + 1000 }), 'provider-refused')
record('on, key, nothing on record', resolveJevStatus({ settings: on, key: stored, ledger: emptyLedger(), now: T0 }), 'ready')
check('all twelve kinds were reached', seen.size === JEV_STATUS_KINDS.length && JEV_STATUS_KINDS.every(k => seen.has(k)), [...seen.keys()].join(','))
check('no two kinds share their words', new Set(seen.values()).size === seen.size)
check('no two headwords collide', new Set(Object.values(JEV_STATUS_HEADWORDS)).size === JEV_STATUS_KINDS.length)
check('no state ever calls itself experimental', ![...seen.values()].some(w => /experimental/i.test(w)))

section('§2 the order of reasons: the earlier truth wins')
check('off beats no key', resolveJevStatus({ settings: { ...on, enabled: false }, key: absent, ledger: emptyLedger(), now: T0 }).kind === 'off')
check('no key beats a 401 on record', resolveJevStatus({ settings: on, key: absent, ledger: wired({ kind: 'invalid-key', status: 401, detail: 'x' }), now: T0 }).kind === 'no-key')
check('a 401 beats the allowance', resolveJevStatus({ settings: { ...on, allowanceUsd: 0.001 }, key: stored, ledger: wired({ kind: 'invalid-key', status: 401, detail: 'x' }), now: T0 }).kind === 'invalid-key')
check('the allowance beats a hold', resolveJevStatus({ settings: { ...on, allowanceUsd: 0.001 }, key: stored, ledger: wired({ kind: 'provider-down', status: 529, detail: 'x' }), now: T0 + 1 }).kind === 'allowance-hit')
check('a hold that has expired reads ready', resolveJevStatus({ settings: on, key: stored, ledger: wired({ kind: 'provider-down', status: 529, detail: 'x' }), now: T0 + 31_000 }).kind === 'ready')
check('a 422 on record is not a hold: ready', resolveJevStatus({ settings: on, key: stored, ledger: wired({ kind: 'bad-request', status: 422, detail: 'questions.q.criteria' }), now: T0 + 1 }).kind === 'ready')
resetJevLedger()
noteJevWireFailure({ kind: 'provider-down', status: 529, detail: 'x' }, T0, mid)
noteJevAttempt(T0 + 5)
settleJevCall({ input_tokens: 100, output_tokens: 1 }, 'jev-1.13.0', T0 + 5)
check('an answer after an outage reads ready', resolveJevStatus({ settings: on, key: stored, ledger: jevLedgerSnapshot(T0 + 6), now: T0 + 6 }).kind === 'ready')

section('§3 sub-agents: off until the setting says so, then the same truth as the main model')
const subOff = resolveJevStatus({ settings: on, key: stored, ledger: emptyLedger(), now: T0, agent: { id: 'a1', subagent: true } })
check('a sub-agent with the setting off reads off, and the words say why', subOff.kind === 'off' && /sub-agents/.test(subOff.words))
check('a sub-agent with the setting on reads ready', resolveJevStatus({ settings: { ...on, subagents: true }, key: stored, ledger: emptyLedger(), now: T0, agent: { id: 'a1', subagent: true } }).kind === 'ready')
check('the main model is never budgeted as a sub-agent', resolveJevStatus({ settings: on, key: stored, ledger: emptyLedger(), now: T0, agent: { id: 'main', subagent: false } }).kind === 'ready')

section('§4 the words never invent a wait, a cause or a balance')
const noWait = resolveJevStatus({ settings: on, key: stored, ledger: wired({ kind: 'rate-limited', status: 429, detail: 'Too Many Requests' }), now: T0 + 1 })
check('a 429 with no retry-after says the provider named no wait', /named no wait/.test(noWait.words) && !/asked for/.test(noWait.words))
const withWait = resolveJevStatus({ settings: on, key: stored, ledger: wired({ kind: 'rate-limited', status: 429, detail: 'Too Many Requests', retryAfterMs: 4000 }), now: T0 + 1 })
check('a 429 with a retry-after quotes it', /asked for 4s/.test(withWait.words))
check('a hold always says when the next attempt is admitted, from the ledger clock', /admitted in \d+[sm]/.test(withWait.words) && withWait.retryInMs === T0 + 30_000 - (T0 + 1))
const refused = resolveJevStatus({ settings: on, key: stored, ledger: wired({ kind: 'provider-refused', status: 418, detail: 'I am a teapot' }), now: T0 + 1 })
check('a refusal quotes the wire verbatim, with its status', /418 "I am a teapot"/.test(refused.words))
const credit = resolveJevStatus({ settings: on, key: stored, ledger: wired({ kind: 'provider-refused', status: 402, detail: 'Insufficient balance on this account' }), now: T0 + 1 })
check('a credit refusal quotes the wire and never states a balance figure', /said "Insufficient balance on this account"/.test(credit.words) && !/\$\d/.test(credit.words))
check('a credit refusal names no wait: it ends when the conversation resets or the key changes', credit.retryInMs === undefined && /\/clear or a new key/.test(credit.words))
check('a credit refusal still holds a year later', resolveJevStatus({ settings: on, key: stored, ledger: wired({ kind: 'provider-refused', status: 402, detail: 'insufficient credits' }), now: T0 + 365 * 24 * 60 * 60_000 }).kind === 'provider-credit')
const parse = resolveJevStatus({ settings: on, key: stored, ledger: wired({ kind: 'parse-failed', status: 200, detail: 'answers.q.confidence missing' }), now: T0 + 1 })
check('an unreadable 200 is the provider down with the reason named, never an answer', parse.kind === 'provider-down' && /could not read/.test(parse.words))
const long = resolveJevStatus({ settings: on, key: stored, ledger: wired({ kind: 'provider-refused', status: 500, detail: 'x'.repeat(400) }), now: T0 + 1 })
check('a long wire body is clipped in the words', long.words.length < 300)
check('the allowance words say the count is Mercury\'s', /Mercury counts/.test(resolveJevStatus({ settings: { ...on, allowanceUsd: 0.001 }, key: stored, ledger: emptyLedger(), now: T0 }).words))
check('the no-key words say Mercury ships no key', /ships none/.test(resolveJevStatus({ settings: on, key: absent, ledger: emptyLedger(), now: T0 }).words))

section('§5 which reasons are final for the session (the model stops calling) and which are a wait')
check('off, no key, invalid key, allowance, ceiling, sub-agent budget and credit are final', ['off', 'no-key', 'invalid-key', 'allowance-hit', 'ceiling-hit', 'subagent-budget-hit', 'provider-credit'].every(k => jevStatusIsFinalForSession(k as never)))
check('pace, rate limit, outage and an unknown refusal are waits', ['pace-hit', 'rate-limited', 'provider-down', 'provider-refused', 'ready'].every(k => !jevStatusIsFinalForSession(k as never)))
check('the status line is one line beginning JEV', jevStatusLine({ kind: 'ready', words: 'ready' }) === 'JEV ready' && !jevStatusLine(resolveJevStatus({ settings: on, key: absent, ledger: emptyLedger(), now: T0 })).includes('\n'))

resetJevLedger()
console.log(`\n${checks - failures}/${checks} checks passed`)
process.exit(failures === 0 ? 0 : 1)
