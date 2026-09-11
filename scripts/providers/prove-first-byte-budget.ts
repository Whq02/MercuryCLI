#!/usr/bin/env bun
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
process.env.NODE_ENV = 'test'

import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

let failures = 0
const check = (label: string, cond: boolean, detail = ''): void => {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}
const section = (t: string): void => {
  console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
}
const ROOT = join(import.meta.dir, '..', '..')
const src = (p: string): string => readFileSync(join(ROOT, p), 'utf8')

delete process.env.MERCURY_STREAM_IDLE_TIMEOUT_MS
const home = mkdtempSync(join(tmpdir(), 'first-byte-budget-'))
process.env.MERCURY_CONFIG_DIR = home
writeFileSync(join(home, 'settings.json'), JSON.stringify({ permissions: { defaultMode: 'flow' } }))

const budget = await import('../../src/services/providers/streamIdleBudget.ts')
const { enableConfigs } = await import('../../src/utils/config.ts')
enableConfigs()

console.log('============================================================')
console.log(' first-byte budget — one number for the request and the row')
console.log('============================================================')

section('B1 · the budget arithmetic')
{
  check('warm prefix: the idle budget itself (2 min default)', budget.firstByteBudgetMs({ cold: false, promptTokens: 26_000 }) === 120_000 && budget.streamIdleTimeoutMs() === 120_000)
  check('cold prefix, 26k tokens on a 60 s idle budget: 60 s + 31.2 s = 91.2 s', budget.firstByteBudgetMs({ cold: true, promptTokens: 26_000, idleMs: 60_000 }) === 91_200, String(budget.firstByteBudgetMs({ cold: true, promptTokens: 26_000, idleMs: 60_000 })))
  check('cold prefix never sits below the idle budget (a tiny prompt)', budget.firstByteBudgetMs({ cold: true, promptTokens: 10, idleMs: 60_000 }) === 60_012 && budget.firstByteBudgetMs({ cold: true, promptTokens: 0, idleMs: 60_000 }) === 60_000)
  check('the ceiling: a 1M-token prompt caps at twice the idle budget or 300 s, the larger (300 s on a 60 s budget and on the 2 min default; 30 min on the 15 min road)', budget.firstByteBudgetMs({ cold: true, promptTokens: 1_000_000, idleMs: 60_000 }) === 300_000 && budget.firstByteBudgetMs({ cold: true, promptTokens: 1_000_000 }) === 300_000 && budget.firstByteBudgetMs({ cold: true, promptTokens: 1_000_000, idleMs: 900_000 }) === 1_800_000, `${budget.firstByteBudgetMs({ cold: true, promptTokens: 1_000_000, idleMs: 60_000 })} · ${budget.firstByteBudgetMs({ cold: true, promptTokens: 1_000_000 })} · ${budget.firstByteBudgetMs({ cold: true, promptTokens: 1_000_000, idleMs: 900_000 })}`)
  check('the allowance and the ceiling are the owner\'s constants (1,200 ms per 1k · 300,000 ms · twice the idle budget)', budget.COLD_INGEST_MS_PER_1K_TOKENS === 1_200 && budget.FIRST_BYTE_BUDGET_CEILING_MS === 300_000 && budget.FIRST_BYTE_BUDGET_CEILING_FACTOR === 2)
  check('the send-time estimate is the body\'s bytes, four to a token (never below one)', budget.estimateRequestTokens({ system: 'x'.repeat(4000) }) === Math.ceil(JSON.stringify({ system: 'x'.repeat(4000) }).length / 4) && budget.estimateRequestTokens(undefined) === 1)
}

section('B2 · the cold predicate')
{
  const user = { type: 'user', message: { role: 'user', content: 'hi' } }
  const opus = { type: 'assistant', message: { model: 'claude-opus-5', role: 'assistant', content: [] } }
  const fable = { type: 'assistant', message: { model: 'claude-fable-5-1', role: 'assistant', content: [] } }
  const boundary = { type: 'system', subtype: 'compact_boundary' }
  check('a fresh session (no response yet) is cold', budget.coldPrefixOf([user], 'claude-opus-5') === true)
  check('the same model answered last: warm', budget.coldPrefixOf([user, opus, user], 'claude-opus-5') === false)
  check('another model answered last (the switch): cold', budget.coldPrefixOf([user, fable, user], 'claude-opus-5') === true)
  check('a compaction boundary after the last response: cold', budget.coldPrefixOf([user, opus, boundary, user], 'claude-opus-5') === true)
  check('a synthetic stamp is transparent (the real response behind it decides)', budget.coldPrefixOf([user, opus, { type: 'assistant', message: { model: '<synthetic>' } }], 'claude-opus-5') === false)
}

section('B3 · the words')
{
  const cold = { kind: 'first-byte' as const, cold: true, promptTokens: 26_000, model: 'Opus 5', budgetMs: 91_200, sinceMs: 0, attempt: 1 }
  check('the cold wait names the prompt, the model and the budget — minutes at or above sixty seconds', budget.requestWaitLine(cold) === 'ingesting a 26k-token prompt on Opus 5 — first byte expected within 1m 31s', budget.requestWaitLine(cold))
  check('a reissued attempt says which attempt', budget.requestWaitLine({ ...cold, attempt: 2 }).endsWith('(attempt 2)'))
  check('the warm wait names the model and the idle budget', budget.requestWaitLine({ ...cold, cold: false, promptTokens: 900, budgetMs: 60_000 }) === 'waiting for the first byte from Opus 5 — within 1m', budget.requestWaitLine({ ...cold, cold: false, budgetMs: 60_000 }))
  check('a budget under a minute keeps its seconds', budget.requestWaitLine({ ...cold, cold: false, promptTokens: 900, budgetMs: 45_000 }) === 'waiting for the first byte from Opus 5 — within 45 s' && budget.requestWaitLine({ ...cold, budgetMs: 120_000 }) === 'ingesting a 26k-token prompt on Opus 5 — first byte expected within 2m', budget.requestWaitLine({ ...cold, budgetMs: 120_000 }))
  check('the retry wait names the attempt, the cause and the delay', budget.requestWaitLine({ kind: 'retry', attempt: 2, of: 10, reason: 'a 529', delayMs: 4_000, sinceMs: 0 }) === 'retrying — attempt 2 of 10 after a 529 · in 4 s')
  check('the typed timeout line names the wait and its cause (cold)', budget.firstByteTimeoutLine(cold) === 'no first byte from Opus 5 after 1m 31s (a 26k-token prompt ingesting uncached)', budget.firstByteTimeoutLine(cold))
  check('  and the warm cause', budget.firstByteTimeoutLine({ ...cold, cold: false, budgetMs: 60_000 }) === 'no first byte from Opus 5 after 1m (the request was accepted and nothing arrived)')
  check('the retry cause words: a status, a first-byte timeout, a connection error', budget.retryReasonWords(529) === 'a 529' && budget.retryReasonWords(null, 'no first byte from Opus 5 after 91 s (…)') === 'a first-byte timeout' && budget.retryReasonWords(undefined, 'socket hang up') === 'a connection error')
}

section('B4 · the wire shape')
{
  const cold = { kind: 'first-byte', cold: true, promptTokens: 26_000, model: 'Opus 5', budgetMs: 91_200, sinceMs: 5, attempt: 1 }
  const retry = { kind: 'retry', attempt: 2, of: 10, reason: 'a 529', delayMs: 4_000, sinceMs: 7 }
  check('a first-byte wait round-trips', JSON.stringify(budget.decodeRequestWait(JSON.parse(JSON.stringify(cold)))) === JSON.stringify(cold))
  check('a retry wait round-trips', JSON.stringify(budget.decodeRequestWait(JSON.parse(JSON.stringify(retry)))) === JSON.stringify(retry))
  check('junk decodes to null, never a cast-through', budget.decodeRequestWait({ kind: 'first-byte' }) === null && budget.decodeRequestWait('x') === null && budget.decodeRequestWait(null) === null && budget.decodeRequestWait({ kind: 'retry', attempt: 'two' }) === null)
}

section('B5 · the wiring (structural)')
{
  const core = src('src/services/providers/anthropic/streamCore.ts')
  check('the streaming request\'s timeout IS the first-byte budget', /timeout: wait\.budgetMs,/.test(core) && /budgetMs: firstByteBudgetMs\(\{ cold, promptTokens, idleMs: streamIdleTimeoutMsForRoute\('anthropic'\) \}\)/.test(core))
  check('the budget\'s expiry becomes the typed line on the retry ladder (never the operator\'s own abort)', /if \(!signal\.aborted && isFirstByteTimeout\(sent\)\)[\s\S]{0,300}throw new APIConnectionTimeoutError\(\{ message: firstByteTimeoutLine\(wait\) \}\)/.test(core))
  check('the wait is spoken before the request and cleared at the first byte', /options\.onWait\?\.\(wait\)/.test(core) && /result = await dispatch\(\)[\s\S]{0,700}options\.onWait\?\.\(null\)/.test(core))
  check('every retry notice speaks a reissue on its way (attempt, cause, delay) beside the row it paints', /kind: 'retry',\s*\n\s*attempt: notice\.retryAttempt,\s*\n\s*of: notice\.maxRetries,/.test(core) && /options\.onWait\?\.\(retryWait\)/.test(core))
  check('the spinner\'s pulse carries the same words', /setPulsePhase\(getActivePulseTrace\(\)\?\.generation \?\? 0, 'waiting', \{ wait: requestWaitLine\(wait\) \}\)/.test(core))
  const machine = src('src/run-core/turn-machine.ts')
  check('the turn machine relays the wait on the runner\'s status frame', /onWait: wait => toolUseContext\.setSDKStatus\?\.\(\{ wait \}\)/.test(machine))
  const seat = src('src/daemon/sessionSeat.ts')
  check('the seat folds { wait } into the tail projection on its own key and clears it with the turn and a respawn', /'wait' in \(frame\.status as object\)/.test(seat) && /\.\.\.\(seat\.wait !== null \? \{ wait: seat\.wait \} : \{\}\)/.test(seat) && (seat.match(/seat\.wait = null/g) ?? []).length >= 2)
  const connector = src('src/services/engine-connector/daemonConnector.ts')
  check("the connector's 'aborts at' reads the wait's budget while the first byte is outstanding", /wait\?\.kind === 'first-byte' \? wait\.budgetMs : typeof this\.facts\?\.streamIdleTimeoutMs === 'number'/.test(connector))
  const row = src('src/components/SwitchboardTagBar.tsx')
  check('the status row speaks the wait, and past its budget says the lane is due', /if \(s\.wait !== null\) \{[\s\S]{0,600}requestWaitLine\(s\.wait, compact\)/.test(row) && /the budget is up; the lane reissues or aborts now/.test(row))
  const byline = src('src/components/Spinner/pulseByline.ts')
  check("the spinner's byline heads with the wait's words", /const waitHeads = detail\.wait \? \[verb \? `\$\{verb\} · \$\{detail\.wait\}` : detail\.wait\] : \[\]/.test(byline))
}

section('F · the status row keeps the budget word on a narrow terminal (100 · 110 · 120 columns)')
{
  const { fitStatusLine } = await import('../../src/components/SwitchboardTagBar.tsx')
  const { truncateKeepingTail } = await import('../../src/utils/truncate.ts')
  const { stringWidth } = await import('../../src/ink/stringWidth.ts')
  const line = 'ingesting a 60k-token prompt on Opus 5 — first byte expected within 61 s'
  const fixedWidth = 2 + stringWidth('hello sol') + stringWidth(' · fixture-repo · ') + 2 + stringWidth('esc interrupts · ⇧← back')
  for (const columns of [100, 110, 120]) {
    const fitted = fitStatusLine(line, columns, fixedWidth)
    const budget = columns - fixedWidth
    check(`${columns} columns: the fitted words end with the budget clause and fit the row (${stringWidth(fitted)} ≤ ${budget})`, fitted.endsWith('— first byte expected within 61 s') && stringWidth(fitted) <= budget, fitted)
  }
  check('a wide row paints the whole line', fitStatusLine(line, 150, fixedWidth) === line)
  check('the cut is in the middle: the head survives with an ellipsis, the clause follows whole — never an end cut', /^ingesting[^…]*… — first byte expected within 61 s$/.test(fitStatusLine(line, 100, fixedWidth)), fitStatusLine(line, 100, fixedWidth))
  check('a line without a tail clause is left to the row (an end cut is honest there)', fitStatusLine('thinking for 12s', 30, 25) === 'thinking for 12s')
  check('truncateKeepingTail: a short line is untouched; a long one keeps the tail clause under the budget; a requested tail width keeps exactly that tail', truncateKeepingTail('a — b', 40) === 'a — b' && truncateKeepingTail('a very long head that overflows — kept', 20) === 'a very long… — kept' && truncateKeepingTail('abcdefghij', 6, 3) === 'ab…hij', JSON.stringify([truncateKeepingTail('a very long head that overflows — kept', 20), truncateKeepingTail('abcdefghij', 6, 3)]))
}

section('N2 · the bell probe')
{
  const notifier = src('src/services/notifier.ts')
  check('a missing plist reader answers the probe closed with a debug line, never an error', /plist = \(await import\('plist'\)\) as typeof plist\s*\n\s*\} catch \(missing\) \{\s*\n\s*logForDebugging\(/.test(notifier) && /assuming the audible bell/.test(notifier))
}

console.log(failures === 0 ? '\n ✅ FIRST-BYTE BUDGET — one number for the request and the row; the wait speaks; the notice and the bell tell the truth' : `\n ❌ ${failures} FAILED`)
process.exit(failures === 0 ? 0 : 1)
