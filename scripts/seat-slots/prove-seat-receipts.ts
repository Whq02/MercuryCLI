#!/usr/bin/env bun
import { mkdirSync, rmSync } from 'node:fs'

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ` — ${detail}` : ''}`)
}
function section(t: string): void { console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76)) }

console.log('============================================================')
console.log(' Seat receipts — observed-apply proof')
console.log('============================================================')

const ENV_KEYS = ['MERCURY_CONFIG_DIR', 'MERCURY_HOME'] as const
const stash: Record<string, string | undefined> = {}
for (const k of ENV_KEYS) { stash[k] = process.env[k]; delete process.env[k] }
const DIR = `/tmp/hermes-prove-seat-receipts-${process.pid}`
process.env.MERCURY_CONFIG_DIR = `${DIR}/home`
mkdirSync(`${DIR}/home`, { recursive: true })

const sr = (await import('../../src/utils/model/seatReceipts.js')) as typeof import('../../src/utils/model/seatReceipts.js')

section('(a) pure — matching + spellings')
check('model-only expectation matches on model alone', sr.expectationSatisfied({ model: 'claude-fable-5' }, { model: 'claude-fable-5', effort: 'high' }))
check('model mismatch ⇒ unsatisfied', !sr.expectationSatisfied({ model: 'claude-fable-5' }, { model: 'claude-sonnet-5' }))
check('both-axis expectation needs both', !sr.expectationSatisfied({ model: 'claude-fable-5', effort: 'max' }, { model: 'claude-fable-5', effort: 'high' }))
check('effort-only expectation ignores model', sr.expectationSatisfied({ effort: 'max' }, { model: 'anything', effort: 'max' }))
check('applied spelling', sr.composeAppliedReceipt({ role: 'implementer', model: 'claude-fable-5', effort: 'max' }) === '⇄ reslot applied — implementer → claude-fable-5 @max')
check('timeout spelling names the surface to check', /check \/daemon/.test(sr.composeTimeoutReceipt({ role: 'implementer', model: 'claude-fable-5' })))

section('(d) deadline — honest timeout receipt, never a silent drop')
{
  sr.__resetSeatReceiptsForTests()
  const seen: string[] = []
  const unsub = sr.subscribeSeatReceipts(r => seen.push(`${r.level}:${r.text}`))
  const realNow = Date.now
  Date.now = () => realNow() - 11 * 60_000
  sr.registerReslotExpectation({ role: 'implementer', model: 'claude-fable-5' })
  Date.now = realNow
  sr.__sweepDeadlinesForTests()
  check('timeout receipt fired as a WARNING', seen.length === 1 && /^warning:/.test(seen[0] ?? '') && /reslot pending — implementer/.test(seen[0] ?? ''), seen[0])
  check('timed-out expectation dropped', sr.__pendingExpectationsForTests().length === 0)
  unsub()
}

section('(c) queue-before-subscribe — pre-mount receipts drain on subscribe')
sr.__resetSeatReceiptsForTests()
sr.mintImmediateReceipt('⇄ reslot applied — scribe → claude-fable-5 @high')
const late: string[] = []
const unsub2 = sr.subscribeSeatReceipts(r => late.push(r.text))
check('queued receipt drained on subscribe', late.length === 1 && /scribe/.test(late[0] ?? ''))
unsub2()

sr.__resetSeatReceiptsForTests()
rmSync(DIR, { recursive: true, force: true })
for (const k of ENV_KEYS) { if (stash[k] !== undefined) process.env[k] = stash[k]; else delete process.env[k] }

console.log('\n' + '='.repeat(60))
if (failures > 0) { console.log(` FAIL — ${failures} check(s) failed`); process.exit(1) }
console.log(' ALL SEAT-RECEIPT PROOFS PASS')
