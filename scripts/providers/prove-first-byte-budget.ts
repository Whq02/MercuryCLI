#!/usr/bin/env bun
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
process.env.NODE_ENV = 'test'

import { mkdtempSync, writeFileSync } from 'node:fs'
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

delete process.env.MERCURY_STREAM_IDLE_TIMEOUT_MS
const home = mkdtempSync(join(tmpdir(), 'first-byte-budget-'))
process.env.MERCURY_CONFIG_DIR = home
writeFileSync(join(home, 'settings.json'), JSON.stringify({ guardrails: { mode: 'flow' } }))

const budget = await import('../../src/models/roads/streamIdleBudget.ts')
const { enableConfigs } = await import('../../src/platform/settings/config.ts')
enableConfigs()

console.log('============================================================')
console.log(' first-byte budget — one number for the request and the row')
console.log('============================================================')

section('B1 · the budget arithmetic')
{
  check('warm prefix: the idle budget itself (2 min default)', budget.firstByteBudgetMs({ cold: false, promptTokens: 26_000 }) === 120_000 && budget.streamIdleTimeoutMs() === 120_000, 'a warm prefix must get the idle budget: fix firstByteBudgetMs or streamIdleTimeoutMs in src/models/roads/streamIdleBudget.ts')
  check('cold prefix, 26k tokens on a 60 s idle budget: 60 s + 31.2 s = 91.2 s', budget.firstByteBudgetMs({ cold: true, promptTokens: 26_000, idleMs: 60_000 }) === 91_200, String(budget.firstByteBudgetMs({ cold: true, promptTokens: 26_000, idleMs: 60_000 })) + ' — fix the cold branch of firstByteBudgetMs in src/models/roads/streamIdleBudget.ts')
  check('cold prefix never sits below the idle budget (a tiny prompt)', budget.firstByteBudgetMs({ cold: true, promptTokens: 10, idleMs: 60_000 }) === 60_012 && budget.firstByteBudgetMs({ cold: true, promptTokens: 0, idleMs: 60_000 }) === 60_000, 'the cold budget must be idle plus the ingest allowance and never below idle: fix firstByteBudgetMs in src/models/roads/streamIdleBudget.ts')
  check('the ceiling: a 1M-token prompt caps at twice the idle budget or 300 s, the larger (300 s on a 60 s budget and on the 2 min default; 30 min on the 15 min road)', budget.firstByteBudgetMs({ cold: true, promptTokens: 1_000_000, idleMs: 60_000 }) === 300_000 && budget.firstByteBudgetMs({ cold: true, promptTokens: 1_000_000 }) === 300_000 && budget.firstByteBudgetMs({ cold: true, promptTokens: 1_000_000, idleMs: 900_000 }) === 1_800_000, `${budget.firstByteBudgetMs({ cold: true, promptTokens: 1_000_000, idleMs: 60_000 })} · ${budget.firstByteBudgetMs({ cold: true, promptTokens: 1_000_000 })} · ${budget.firstByteBudgetMs({ cold: true, promptTokens: 1_000_000, idleMs: 900_000 })} — fix the ceiling in firstByteBudgetMs in src/models/roads/streamIdleBudget.ts`)
  check('the allowance and the ceiling are the owner\'s constants (1,200 ms per 1k · 300,000 ms · twice the idle budget)', budget.COLD_INGEST_MS_PER_1K_TOKENS === 1_200 && budget.FIRST_BYTE_BUDGET_CEILING_MS === 300_000 && budget.FIRST_BYTE_BUDGET_CEILING_FACTOR === 2, 'restore the three constants COLD_INGEST_MS_PER_1K_TOKENS, FIRST_BYTE_BUDGET_CEILING_MS and FIRST_BYTE_BUDGET_CEILING_FACTOR in src/models/roads/streamIdleBudget.ts')
  check('the send-time estimate is the body\'s bytes, four to a token (never below one)', budget.estimateRequestTokens({ system: 'x'.repeat(4000) }) === Math.ceil(JSON.stringify({ system: 'x'.repeat(4000) }).length / 4) && budget.estimateRequestTokens(undefined) === 1, 'fix estimateRequestTokens in src/models/roads/streamIdleBudget.ts: bytes of the JSON body divided by four, rounded up, at least one')
}

section('B2 · the cold predicate')
{
  const user = { type: 'user', message: { role: 'user', content: 'hi' } }
  const opus = { type: 'assistant', message: { model: 'claude-opus-5', role: 'assistant', content: [] } }
  const fable = { type: 'assistant', message: { model: 'claude-fable-5-1', role: 'assistant', content: [] } }
  const boundary = { type: 'system', subtype: 'compact_boundary' }
  check('a fresh session (no response yet) is cold', budget.coldPrefixOf([user], 'claude-opus-5') === true, 'fix coldPrefixOf in src/models/roads/streamIdleBudget.ts: no assistant response yet must read cold')
  check('the same model answered last: warm', budget.coldPrefixOf([user, opus, user], 'claude-opus-5') === false, 'fix coldPrefixOf in src/models/roads/streamIdleBudget.ts: the same model answering last must read warm')
  check('another model answered last (the switch): cold', budget.coldPrefixOf([user, fable, user], 'claude-opus-5') === true, 'fix coldPrefixOf in src/models/roads/streamIdleBudget.ts: a different model answering last must read cold')
  check('a compaction boundary after the last response: cold', budget.coldPrefixOf([user, opus, boundary, user], 'claude-opus-5') === true, 'fix coldPrefixOf in src/models/roads/streamIdleBudget.ts: a compact_boundary after the last response must read cold')
  check('a synthetic stamp is transparent (the real response behind it decides)', budget.coldPrefixOf([user, opus, { type: 'assistant', message: { model: '<synthetic>' } }], 'claude-opus-5') === false, 'fix coldPrefixOf in src/models/roads/streamIdleBudget.ts: skip synthetic-stamped assistant messages when finding the last response')
}

section('B3 · the words')
{
  const cold = { kind: 'first-byte' as const, cold: true, promptTokens: 26_000, model: 'Opus 5', budgetMs: 91_200, sinceMs: 0, attempt: 1 }
  check('the cold wait names the prompt, the model and the limit — minutes at or above sixty seconds', budget.requestWaitLine(cold) === 'ingesting a 26k-token prompt on Opus 5 — gives up after 1m 31s', budget.requestWaitLine(cold) + ' — fix the cold first-byte branch of requestWaitLine in src/models/roads/streamIdleBudget.ts')
  check('a reissued attempt says which attempt', budget.requestWaitLine({ ...cold, attempt: 2 }).endsWith('(attempt 2)'), 'fix requestWaitLine in src/models/roads/streamIdleBudget.ts: a first-byte wait with attempt above 1 must end with (attempt N)')
  check('the warm wait names the model and the idle limit', budget.requestWaitLine({ ...cold, cold: false, promptTokens: 900, budgetMs: 60_000 }) === 'waiting for the first byte from Opus 5 — gives up after 1m', budget.requestWaitLine({ ...cold, cold: false, budgetMs: 60_000 }) + ' — fix the warm first-byte branch of requestWaitLine in src/models/roads/streamIdleBudget.ts')
  check('a budget under a minute keeps its seconds', budget.requestWaitLine({ ...cold, cold: false, promptTokens: 900, budgetMs: 45_000 }) === 'waiting for the first byte from Opus 5 — gives up after 45 s' && budget.requestWaitLine({ ...cold, budgetMs: 120_000 }) === 'ingesting a 26k-token prompt on Opus 5 — gives up after 2m', budget.requestWaitLine({ ...cold, budgetMs: 120_000 }) + ' — fix the duration words in requestWaitLine in src/models/roads/streamIdleBudget.ts')
  check('the compact form keeps the limit words', budget.requestWaitLine(cold, true) === 'ingesting prompt — gives up after 1m 31s' && budget.requestWaitLine({ ...cold, cold: false, budgetMs: 60_000 }, true) === 'waiting — gives up after 1m', budget.requestWaitLine(cold, true) + ' — fix the compact branch of requestWaitLine in src/models/roads/streamIdleBudget.ts')
  check('the retry wait names the attempt, the cause and the delay', budget.requestWaitLine({ kind: 'retry', attempt: 2, of: 10, reason: 'a 529', delayMs: 4_000, sinceMs: 0 }) === 'retrying — attempt 2 of 10 after a 529 · in 4 s', 'fix the retry branch of requestWaitLine in src/models/roads/streamIdleBudget.ts')
  check('the typed timeout line names the wait and its cause (cold)', budget.firstByteTimeoutLine(cold) === 'no first byte from Opus 5 after 1m 31s (a 26k-token prompt ingesting uncached)', budget.firstByteTimeoutLine(cold) + ' — fix firstByteTimeoutLine in src/models/roads/streamIdleBudget.ts')
  check('  and the warm cause', budget.firstByteTimeoutLine({ ...cold, cold: false, budgetMs: 60_000 }) === 'no first byte from Opus 5 after 1m (the request was accepted and nothing arrived)', 'fix the warm cause in firstByteTimeoutLine in src/models/roads/streamIdleBudget.ts')
  check('the retry cause words: a status, a first-byte timeout, a connection error', budget.retryReasonWords(529) === 'a 529' && budget.retryReasonWords(null, 'no first byte from Opus 5 after 91 s (…)') === 'a first-byte timeout' && budget.retryReasonWords(undefined, 'socket hang up') === 'a connection error', 'fix retryReasonWords in src/models/roads/streamIdleBudget.ts: a status gives a N, a first-byte timeout message gives a first-byte timeout, anything else a connection error')
}

section('B4 · the wire shape')
{
  const cold = { kind: 'first-byte', cold: true, promptTokens: 26_000, model: 'Opus 5', budgetMs: 91_200, sinceMs: 5, attempt: 1 }
  const retry = { kind: 'retry', attempt: 2, of: 10, reason: 'a 529', delayMs: 4_000, sinceMs: 7 }
  check('a first-byte wait round-trips', JSON.stringify(budget.decodeRequestWait(JSON.parse(JSON.stringify(cold)))) === JSON.stringify(cold), 'fix decodeRequestWait in src/models/roads/streamIdleBudget.ts: a first-byte wait must decode with every field intact')
  check('a retry wait round-trips', JSON.stringify(budget.decodeRequestWait(JSON.parse(JSON.stringify(retry)))) === JSON.stringify(retry), 'fix decodeRequestWait in src/models/roads/streamIdleBudget.ts: a retry wait must decode with every field intact')
  check('junk decodes to null, never a cast-through', budget.decodeRequestWait({ kind: 'first-byte' }) === null && budget.decodeRequestWait('x') === null && budget.decodeRequestWait(null) === null && budget.decodeRequestWait({ kind: 'retry', attempt: 'two' }) === null, 'fix decodeRequestWait in src/models/roads/streamIdleBudget.ts: malformed input must return null')
}

section('B5 · the wiring (structural)')
{
  const t = await import('../core-runtime/turnScenarios.ts')
  const firstByte = { kind: 'first-byte', cold: true, promptTokens: 26_000, model: 'Opus 5', budgetMs: 91_200, sinceMs: 5, attempt: 1 }
  const reissue = { kind: 'retry', attempt: 2, of: 10, reason: 'a 529', delayMs: 4_000, sinceMs: 7 }
  const frames: Array<Record<string, unknown>> = []
  await t.runScripted({
    before: rig => {
      rig.ctx.setSDKStatus = (status: Record<string, unknown>) => frames.push(status)
    },
    script: [[{ kind: 'do', fn: env => { for (const wait of [firstByte, reissue, null]) (env.options.onWait as (wait: unknown) => void)(wait) } }, ...t.fixtures.yields(t.fixtures.says('done.'))]],
  })
  const relayed = frames.filter(frame => 'wait' in frame)
  check(
    'the turn machine relays the wait on the runner\'s status frame',
    JSON.stringify(relayed) === JSON.stringify([{ wait: firstByte }, { wait: reissue }, { wait: null }]),
    `the model call (streamModel, src/engine/loop/turn/streamModel.ts) must hand the lane an options.onWait that passes each wait, and the null that clears it, to toolUseContext.setSDKStatus({ wait }); a lane that spoke a first-byte wait, a reissue and the clearing null reached the status frame as ${JSON.stringify(relayed)}`,
  )
  const { LivePart } = await import('../../src/engine/connector/daemon/live.ts')
  const { IDLE_LIVE } = await import('../../src/engine/connector/seatLive.ts')
  const liveWith = (over: Record<string, unknown> = {}): InstanceType<typeof LivePart> => new LivePart({ sessionId: () => 'proof', attached: () => false, factsBusy: () => true, work: () => [], factsTurnStartedAt: () => undefined, streamIdleTimeoutMs: () => undefined, model: () => 'the-model', anySendDelivered: () => false, redressQueuedSends: () => {}, transcriptLive: () => IDLE_LIVE, toolStartedAtMs: () => null, tailHeld: () => false, clearTail: () => {}, tailInterrupted: () => {}, tailInterruptUndone: () => {}, foldStillRuns: () => true, setLiveFold: () => {}, dropRunningFoldAtIdle: () => {}, stepTurnCompletion: () => false, syncFeedCadence: () => {}, probeCarrier: () => {}, ...over } as never)
  const tailOf = (says: Record<string, unknown>): never => ({ schema: 1, sessionId: 'proof', atMs: 1, text: null, ...says }) as never
  const shown = { title: 'the chat', projectLabel: 'proof', runner: null }
  const waiting = liveWith({ streamIdleTimeoutMs: () => 30_000 })
  waiting.recomputeLive()
  waiting.takeTail(tailOf({ wait: { kind: 'first-byte', cold: true, promptTokens: 1200, model: 'the-model', budgetMs: 90_000, sinceMs: 1, attempt: 1 } }))
  const outstanding = waiting.status(shown).watchdogMs
  waiting.takeTail(tailOf({}))
  const streaming = waiting.status(shown).watchdogMs
  const unbudgeted = liveWith()
  unbudgeted.recomputeLive()
  check("the connector's 'aborts at' reads the wait's budget while the first byte is outstanding", outstanding === 90_000 && streaming === 30_000 && unbudgeted.status(shown).watchdogMs === null, JSON.stringify({ outstanding, streaming, neither: unbudgeted.status(shown).watchdogMs }) + ' — fix the watchdogMs read in src/engine/connector/daemon/live.ts: it must use the outstanding first-byte wait budget until a tail without a wait arrives')
}

section('F · the status row drops whole parts on a narrow terminal — never a word cut in two')
{
  const { fitStatusLine, statusRowPlan } = await import('../../src/screen/chat/SwitchboardTagBar.tsx')
  const { truncateKeepingTail } = await import('../../src/platform/text/truncate.ts')
  const { stringWidth } = await import('../../src/screen/renderer/stringWidth.ts')
  const line = 'ingesting a 60k-token prompt on Opus 5 — gives up after 61 s'
  const fixedWidth = 2 + stringWidth('hello sol') + stringWidth(' · fixture-repo · ') + 2 + stringWidth('esc interrupts · ⇧← back')
  for (const columns of [100, 110, 120]) {
    const fitted = fitStatusLine(line, columns, fixedWidth)
    const budget = columns - fixedWidth
    check(`${columns} columns: the fitted words end with the limit clause, fit the row (${stringWidth(fitted)} ≤ ${budget}) and cut no word`, fitted.endsWith('— gives up after 61 s') && !fitted.includes('…') && stringWidth(fitted) <= budget, fitted + ' — fix fitStatusLine in src/screen/chat/SwitchboardTagBar.tsx and shortenRequestWaitLine in src/models/roads/streamIdleBudget.ts')
  }
  check('a wide row paints the whole line', fitStatusLine(line, 150, fixedWidth) === line, 'fix fitStatusLine in src/screen/chat/SwitchboardTagBar.tsx: a line that fits must come back unchanged')
  check('narrowing drops the model name first, then the token figure', fitStatusLine(line, 110, fixedWidth) === 'ingesting a 60k-token prompt — gives up after 61 s' && fitStatusLine(line, 100, fixedWidth) === 'ingesting prompt — gives up after 61 s', JSON.stringify([fitStatusLine(line, 110, fixedWidth), fitStatusLine(line, 100, fixedWidth)]) + ' — fix shortenRequestWaitLine in src/models/roads/streamIdleBudget.ts')
  const winCold = budget.requestWaitLine({ kind: 'first-byte', cold: true, promptTokens: 35_000, model: 'Sonnet 5.5', budgetMs: 402_000, sinceMs: 0, attempt: 1 })
  const winWarm = budget.requestWaitLine({ kind: 'first-byte', cold: false, promptTokens: 900, model: 'Sonnet 5.5', budgetMs: 360_000, sinceMs: 0, attempt: 1 })
  const winColdPlan = statusRowPlan({ columns: 120, head: 'Sonnet 5.5 · high', rest: winCold, samples: [], folder: 'proj', branch: 'master', backHint: 'esc interrupts · shift+← back' })
  const winWarmPlan = statusRowPlan({ columns: 120, head: 'Sonnet 5.5 · high', rest: winWarm, samples: [], folder: 'proj', branch: 'master', backHint: 'esc interrupts · shift+← back' })
  check('Windows 120 cols: cold and warm waits drop only the repeated model name, never cut a word', winColdPlan.rest === 'ingesting a 35k-token prompt — gives up after 6m 42s' && winWarmPlan.rest === 'waiting for the first byte — gives up after 6m', JSON.stringify([winColdPlan.rest, winWarmPlan.rest]) + ' — fix shortenRequestWaitLine in src/models/roads/streamIdleBudget.ts and fitStatusLine in src/screen/chat/SwitchboardTagBar.tsx')
  check('a line without a tail clause is left to the row (an end cut is honest there)', fitStatusLine('thinking for 12s', 30, 25) === 'thinking for 12s', 'fix fitStatusLine in src/screen/chat/SwitchboardTagBar.tsx: a line with no tail clause must be returned as is')
  check('truncateKeepingTail: a short line is untouched; a long one keeps the tail clause under the budget; a requested tail width keeps exactly that tail', truncateKeepingTail('a — b', 40) === 'a — b' && truncateKeepingTail('a very long head that overflows — kept', 20) === 'a very long… — kept' && truncateKeepingTail('abcdefghij', 6, 3) === 'ab…hij', JSON.stringify([truncateKeepingTail('a very long head that overflows — kept', 20), truncateKeepingTail('abcdefghij', 6, 3)]) + ' — fix truncateKeepingTail in src/platform/text/truncate.ts')
}

console.log(failures === 0 ? '\n ✅ FIRST-BYTE BUDGET — one number for the request and the row; the wait speaks; the notice tells the truth' : `\n ❌ ${failures} FAILED`)
process.exit(failures === 0 ? 0 : 1)
