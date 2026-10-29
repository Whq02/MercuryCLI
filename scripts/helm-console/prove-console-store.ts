#!/usr/bin/env bun
;(globalThis as Record<string, unknown>)['MACRO'] = { VERSION: '1.0.0' }
delete process.env.MERCURY_HELM_CONSOLE
{
  const { mkdtempSync, mkdirSync } = require('node:fs') as typeof import('node:fs')
  const { tmpdir } = require('node:os') as typeof import('node:os')
  const { join } = require('node:path') as typeof import('node:path')
  const home = mkdtempSync(join(tmpdir(), 'helm-console-home-'))
  mkdirSync(home, { recursive: true })
  process.env.MERCURY_CONFIG_DIR = home
}

import {
  consoleAsk,
  consoleClear,
  consoleEnabled,
  getConsoleEntries,
  getConsolePending,
  getConsoleVersion,
  resetConsoleForTest,
  CONSOLE_COMPACT_TRUTH,
  type ConsoleRunner,
  type ConsoleRunnerResult,
} from '../../src/utils/cockpit/helmConsole.js'

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ` — ${detail}` : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
}
const tick = () => new Promise(r => setTimeout(r, 0))

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

section('ask — exactly one runner call per ↵')
fullReset()
check('whitespace-only ask refused', consoleAsk('   ', runner) === false && calls === 0)
check('version untouched by a refused ask', getConsoleVersion() === 0)
check('ask accepted', consoleAsk('  first question  ', runner) === true)
check('runner called once', calls === 1)
check('question trimmed through', lastQuestion === 'first question')
check('pending visible', getConsolePending()?.question === 'first question')
check('entry created', getConsoleEntries().length === 1 && getConsoleEntries()[0]?.question === 'first question')
check('second ask while pending refused', consoleAsk('again', runner) === false && calls === 1)
check('version moved with the ask', getConsoleVersion() > 0)
settle!({ response: 'the answer', usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 1000, cache_creation_input_tokens: 0 } })
await tick()
check('settled: answer landed', getConsoleEntries()[0]?.answer === 'the answer')
check('settled: usage normalized', getConsoleEntries()[0]?.usage?.cacheRead === 1000)
check('settled: duration stamped', typeof getConsoleEntries()[0]?.durationMs === 'number')
check('pending cleared', getConsolePending() === null)

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

section('stale-settle immunity + REAL fork cancel')
fullReset()
consoleAsk('slow question', runner)
check('in flight', getConsolePending() !== null && calls === 1)
const ctrlRef = lastController!
const preClearSettle = settle!
check('clear returns true while an ask is in flight', consoleClear() === true)
check('fork controller actually aborted', ctrlRef.signal.aborted === true)
check('entry removed', getConsoleEntries().length === 0)
preClearSettle({ response: 'too late' })
await tick()
check('stale settle ignored (no zombie entry)', getConsoleEntries().length === 0)

section('clear — wipes + aborts')
fullReset()
consoleAsk('will be cleared', runner)
const clearedCtrl = lastController!
check('clear returns true when there was state', consoleClear() === true)
check('clear aborted the in-flight fork', clearedCtrl.signal.aborted === true)
check('entries wiped', getConsoleEntries().length === 0)
check('pending cleared', getConsolePending() === null)
check('clear on empty returns false', consoleClear() === false)

section('entries ring cap')
fullReset()
for (let i = 0; i < 30; i++) {
  consoleAsk(`q${i}`, runner)
  settle!({ response: `a${i}` })
  await tick()
}
check('entries capped at 24', getConsoleEntries().length === 24)
check('oldest trimmed (q6 first)', getConsoleEntries()[0]?.question === 'q6')

section('relief verbs (chat-relief) — /clear rides the one owner; /compact answers the truth, spending nothing')
fullReset()
consoleAsk('warm the shelf', runner)
settle!({ response: 'warmed' })
await tick()
{
  const callsBefore = calls
  check('/compact is consumed by the store', consoleAsk('/compact', runner) === true)
  const row = getConsoleEntries()[getConsoleEntries().length - 1]
  check('…settling locally with the truth about where the context lives', row?.question === '/compact' && row.answer === CONSOLE_COMPACT_TRUTH, JSON.stringify(row))
  check('…zero runner invocations, nothing pending', calls === callsBefore && getConsolePending() === null)
  check('/clear is consumed too', consoleAsk('/clear', runner) === true)
  check('…and empties the shelf through the ONE clear owner (the ctrl+l door)', getConsoleEntries().length === 0)
  check('…with no runner invocation', calls === callsBefore)
}

fullReset()
console.log('')
if (failures > 0) {
  console.log(`❌ prove-console-store: ${failures} FAILURE(S)`)
  process.exit(1)
}
console.log('✅ prove-console-store: ALL GREEN')
