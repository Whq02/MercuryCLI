#!/usr/bin/env bun
// ============================================================================
//  scripts/helm-console/prove-console-store.ts
//  PROOF: the Helm console's module store (utils/cockpit/helmConsole.ts) —
//  the state machine that makes the mini-REPL trustworthy:
//    · USAGE HONESTY — the injected runner fires EXACTLY once per explicit
//      submit and NEVER on compose/edit/history ops (idle costs zero);
//    · compose lifecycle + the helm-focus suspension (leaving the telemetry
//      pane suspends compose, the draft survives);
//    · cursor-safe edit ops (codepoint-based — astral chars never split);
//    · readline history recall with a live-draft stash;
//    · one-in-flight ask, entry settle, stale-settle immunity after abort;
//    · abort rewinds (entry removed, question handed back to the buffer);
//    · clear wipes everything and aborts an in-flight ask;
//    · caps: buffer, entries ring, ask counter survives trimming.
//  Run:  ~/.bun/bin/bun run scripts/helm-console/prove-console-store.ts
// ============================================================================
;(globalThis as Record<string, unknown>)['MACRO'] = { VERSION: '1.0.0' }
delete process.env.MERCURY_HELM_CONSOLE
// M6 made the ask lifecycle mint conversation records — the
// proof world must own its store home (the ambient-state law; unscratched,
// these asks would land in the OPERATOR'S real crew inbox).
{
  const { mkdtempSync, mkdirSync } = require('node:fs') as typeof import('node:fs')
  const { tmpdir } = require('node:os') as typeof import('node:os')
  const { join } = require('node:path') as typeof import('node:path')
  const home = mkdtempSync(join(tmpdir(), 'helm-console-home-'))
  mkdirSync(home, { recursive: true })
  process.env.MERCURY_CONFIG_DIR = home
}

import {
  beginConsoleCompose,
  consoleAbortAsk,
  consoleAsk,
  consoleBackspace,
  consoleClear,
  consoleCursorEnd,
  consoleCursorHome,
  consoleDeleteForward,
  consoleEnabled,
  consoleHistoryMove,
  consoleInsert,
  consoleKillLine,
  consoleKillWord,
  consoleMoveCursor,
  consoleSubmitBuffer,
  exitConsoleCompose,
  getConsoleAskCount,
  getConsoleBuffer,
  getConsoleCursor,
  getConsoleEntries,
  getConsolePending,
  getConsoleVersion,
  isConsoleComposing,
  resetConsoleForTest,
  CONSOLE_COMPACT_TRUTH,
  type ConsoleRunner,
  type ConsoleRunnerResult,
} from '../../src/utils/cockpit/helmConsole.js'
import {
  resetHelmFocusForTest,
  setHelmFocus,
} from '../../src/utils/cockpit/helmFocus.js'

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ` — ${detail}` : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
}
const tick = () => new Promise(r => setTimeout(r, 0))

// A controllable fake runner: counts invocations, settles on command.
let calls = 0
let lastQuestion = ''
let lastController: AbortController | null = null
let settle: ((r: ConsoleRunnerResult) => void) | null = null
let reject: ((e: unknown) => void) | null = null
const runner: ConsoleRunner = (q, ctrl) => {
  calls++
  lastQuestion = q
  lastController = ctrl
  return new Promise<ConsoleRunnerResult>((res, rej) => {
    settle = res
    reject = rej
  })
}
function fullReset(): void {
  resetConsoleForTest()
  resetHelmFocusForTest()
  calls = 0
  lastQuestion = ''
  lastController = null
  settle = null
  reject = null
}

console.log('============================================================')
console.log(' helm console store — state machine + usage honesty')
console.log('============================================================')

section('gate')
check('enabled under stamp sim (unset flag)', consoleEnabled() === true)
process.env.MERCURY_HELM_CONSOLE = '0'
check("MERCURY_HELM_CONSOLE=0 kills (live re-read)", consoleEnabled() === false)
delete process.env.MERCURY_HELM_CONSOLE
check('unset re-enables (no caching)', consoleEnabled() === true)

section('usage honesty — edits NEVER invoke the runner')
fullReset()
setHelmFocus('telemetry')
beginConsoleCompose()
check('compose entered', isConsoleComposing())
consoleInsert('what model is this')
consoleBackspace()
consoleMoveCursor(-3)
consoleDeleteForward()
consoleCursorHome()
consoleCursorEnd()
consoleKillWord()
consoleHistoryMove(-1)
check('zero runner calls across every edit/history op', calls === 0, `calls=${calls}`)
check('version moved with edits', getConsoleVersion() > 0)

section('submit — exactly one runner call per ↵')
fullReset()
setHelmFocus('telemetry')
beginConsoleCompose()
consoleInsert('   ')
check('whitespace-only submit refused', consoleSubmitBuffer(runner) === false && calls === 0)
consoleKillLine()
consoleInsert('first question')
check('submit accepted', consoleSubmitBuffer(runner) === true)
check('runner called once', calls === 1)
check('question trimmed through', lastQuestion === 'first question')
check('buffer cleared on submit', getConsoleBuffer() === '')
check('pending visible', getConsolePending()?.question === 'first question')
check('entry created', getConsoleEntries().length === 1 && getConsoleEntries()[0]?.question === 'first question')
check('second submit while pending refused', consoleSubmitBuffer(runner) === false && calls === 1)
settle!({ response: 'the answer', usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 1000, cache_creation_input_tokens: 0 } })
await tick()
check('settled: answer landed', getConsoleEntries()[0]?.answer === 'the answer')
check('settled: usage normalized', getConsoleEntries()[0]?.usage?.cacheRead === 1000)
check('settled: duration stamped', typeof getConsoleEntries()[0]?.durationMs === 'number')
check('pending cleared', getConsolePending() === null)
check('ask count = 1', getConsoleAskCount() === 1)

section('error + empty-response settles')
fullReset()
consoleAsk('boom', runner)
reject!(new Error('network sad'))
await tick()
check('error surfaced on the entry', /network sad/.test(getConsoleEntries()[0]?.error ?? ''))
consoleAsk('empty', runner)
settle!({ response: null })
await tick()
check('null response → honest error', getConsoleEntries()[1]?.error === 'No response received')

section('abort — rewind + stale-settle immunity + REAL fork cancel')
fullReset()
setHelmFocus('telemetry')
beginConsoleCompose()
consoleInsert('slow question')
consoleSubmitBuffer(runner)
check('in flight', getConsolePending() !== null && calls === 1)
const ctrlRef = lastController!
const preAbortSettle = settle!
check('abort returns true', consoleAbortAsk() === true)
check('fork controller actually aborted', ctrlRef.signal.aborted === true)
check('entry removed', getConsoleEntries().length === 0)
check('question handed back to buffer', getConsoleBuffer() === 'slow question')
check('compose re-armed', isConsoleComposing())
preAbortSettle({ response: 'too late' })
await tick()
check('stale settle ignored (no zombie entry)', getConsoleEntries().length === 0)

section('focus suspension — leaving telemetry suspends compose')
fullReset()
setHelmFocus('telemetry')
beginConsoleCompose()
consoleInsert('draft text')
setHelmFocus('prompt')
check('compose suspended on focus loss', isConsoleComposing() === false)
check('draft survives suspension', getConsoleBuffer() === 'draft text')
setHelmFocus('telemetry')
beginConsoleCompose()
check('resume keeps the draft', isConsoleComposing() && getConsoleBuffer() === 'draft text')

section('cursor ops — codepoint-safe (astral char)')
fullReset()
setHelmFocus('telemetry')
beginConsoleCompose()
consoleInsert('a𝕏b')
check('length counted in codepoints', getConsoleCursor() === 3)
consoleMoveCursor(-1)
consoleBackspace() // deletes the astral char whole
check('astral char removed whole', getConsoleBuffer() === 'ab')
consoleCursorHome()
consoleDeleteForward()
check('delete-forward at home', getConsoleBuffer() === 'b')

section('paste normalization + buffer cap')
fullReset()
setHelmFocus('telemetry')
beginConsoleCompose()
consoleInsert('line1\nline2\tendx')
check('newlines/tabs → spaces, controls stripped', getConsoleBuffer() === 'line1 line2 endx')
consoleKillLine()
consoleInsert('x'.repeat(2500))
check('buffer capped at 2000', getConsoleBuffer().length === 2000)

section('history recall — readline semantics')
fullReset()
setHelmFocus('telemetry')
consoleAsk('q one', runner)
settle!({ response: 'a1' })
await tick()
consoleAsk('q two', runner)
settle!({ response: 'a2' })
await tick()
beginConsoleCompose()
consoleInsert('live draft')
consoleHistoryMove(-1)
check('↑ recalls newest question', getConsoleBuffer() === 'q two')
consoleHistoryMove(-1)
check('↑↑ walks older', getConsoleBuffer() === 'q one')
consoleHistoryMove(-1)
check('clamped at oldest', getConsoleBuffer() === 'q one')
consoleHistoryMove(1)
consoleHistoryMove(1)
check('↓ returns the live draft', getConsoleBuffer() === 'live draft')

section('clear — wipes + aborts')
fullReset()
setHelmFocus('telemetry')
consoleAsk('will be cleared', runner)
const clearedCtrl = lastController!
check('clear returns true when there was state', consoleClear() === true)
check('clear aborted the in-flight fork', clearedCtrl.signal.aborted === true)
check('entries wiped', getConsoleEntries().length === 0)
check('ask count reset', getConsoleAskCount() === 0)
beginConsoleCompose()
consoleHistoryMove(-1)
check('history wiped (recall is a no-op)', getConsoleBuffer() === '')
check('clear on empty returns false', consoleClear() === false)

section('entries ring cap + ask counter survival')
fullReset()
for (let i = 0; i < 30; i++) {
  consoleAsk(`q${i}`, runner)
  settle!({ response: `a${i}` })
  await tick()
}
check('entries capped at 24', getConsoleEntries().length === 24)
check('oldest trimmed (q6 first)', getConsoleEntries()[0]?.question === 'q6')
check('ask count survives trimming (30)', getConsoleAskCount() === 30)

section('relief verbs (chat-relief) — /clear rides the one owner; /compact answers the truth, spending nothing')
fullReset()
setHelmFocus('telemetry')
consoleAsk('warm the shelf', runner)
settle!({ response: 'warmed' })
await tick()
{
  const billedBefore = getConsoleAskCount()
  const callsBefore = calls
  check('/compact is consumed by the store', consoleAsk('/compact', runner) === true)
  const row = getConsoleEntries()[getConsoleEntries().length - 1]
  check('…settling locally with the truth about where the context lives', row?.question === '/compact' && row.answer === CONSOLE_COMPACT_TRUTH, JSON.stringify(row))
  check('…zero runner invocations, zero billed asks, nothing pending', calls === callsBefore && getConsoleAskCount() === billedBefore && getConsolePending() === null)
  check('/clear is consumed too', consoleAsk('/clear', runner) === true)
  check('…and empties the shelf through the ONE clear owner (count reset, the ctrl+l door)', getConsoleEntries().length === 0 && getConsoleAskCount() === 0)
  check('…with no runner invocation', calls === callsBefore)
}

fullReset()
console.log('')
if (failures > 0) {
  console.log(`❌ prove-console-store: ${failures} FAILURE(S)`)
  process.exit(1)
}
console.log('✅ prove-console-store: ALL GREEN')
