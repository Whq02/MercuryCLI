#!/usr/bin/env bun
// ============================================================================
//  scripts/daemon/prove-loop-cadence.ts — PROOF: /loop schedules the cadence
//  the operator typed. A bare interval (`/loop 30s`, `/loop every 2 minutes`)
//  runs the default loop at THAT cadence — never the 10m fallback — and the
//  derivation follows the rules the model is taught for a prompted
//  invocation: seconds round up to a minute, minute counts move to the
//  nearest divisor of 60, hour counts to the nearest divisor of 24, days fire
//  at midnight; a rounding is named in the clock line, never silent.
//
//  Run: ~/.bun/bin/bun run scripts/daemon/prove-loop-cadence.ts
// ============================================================================
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.MERCURY_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'loop-cadence-'))
// Fixed pacing, default prompt on: the bare-interval path under proof.
process.env.MERCURY_LOOP_DYNAMIC = '0'
delete process.env.MERCURY_LOOP_PROMPT

const { cadenceForInterval, loopPromptForInput } = await import('../../src/skills/bundled/loop.ts')

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
}

section('§1 the derivation — the taught rules, as code')
const table: Array<[string, string | null, string?]> = [
  ['30s', '* * * * *', 'every minute'],
  ['90s', '*/2 * * * *', 'every 2 minutes'],
  ['5m', '*/5 * * * *', 'every 5 minutes'],
  ['7m', '*/6 * * * *', 'every 6 minutes'],
  ['10m', '*/10 * * * *', 'every 10 minutes'],
  ['60m', '0 */1 * * *', 'every hour'],
  ['2h', '0 */2 * * *', 'every 2 hours'],
  ['5h', '0 */4 * * *', 'every 4 hours'],
  ['1d', '0 0 */1 * *', 'every day at midnight'],
  ['every 2 minutes', '*/2 * * * *', 'every 2 minutes'],
  ['every 30 seconds', '* * * * *', 'every minute'],
  ['check every PR', null],
  ['', null],
  ['0m', null],
]
for (const [input, cron, spoken] of table) {
  const c = cadenceForInterval(input)
  check(`'${input}' → ${cron ?? 'not an interval'}`, c === null ? cron === null : c.cron === cron && c.spoken === spoken, JSON.stringify(c))
}

section('§2 the prompt — a bare interval runs the default loop at its own cadence')
{
  const thirty = loopPromptForInput('30s')
  check('/loop 30s schedules "* * * * *" (every minute), not the 10m fallback', thirty.includes('`cron` = "* * * * *" (every minute') && !thirty.includes('*/10 * * * *'))
  check('…and names the rounding from the 30s typed', thirty.includes('rounded from the 30s you typed'))
  check('…as the default loop (sentinel scheduled, tick one now)', thirty.includes('Schedule the SENTINEL') && thirty.includes('run tick one now'))
  const five = loopPromptForInput('5m')
  check('/loop 5m schedules "*/5 * * * *" with no rounding note', five.includes('`cron` = "*/5 * * * *" (every 5 minutes)') && !five.includes('rounded from'))
  const every = loopPromptForInput('every 2 minutes')
  check('/loop every 2 minutes schedules "*/2 * * * *"', every.includes('`cron` = "*/2 * * * *" (every 2 minutes)'))
  const empty = loopPromptForInput('')
  check('/loop with nothing keeps the 10m default cadence', empty.includes('`cron` = "*/10 * * * *" (every 10 minutes)'))
  const prompted = loopPromptForInput('30s check the deploy')
  check('a prompted invocation still teaches the model the rules (the fixed-interval path)', prompted.includes('seconds round UP to one minute') && prompted.includes('check the deploy'))
}

rmSync(process.env.MERCURY_CONFIG_DIR!, { recursive: true, force: true })
console.log('\n' + '═'.repeat(76))
if (failures > 0) {
  console.log(`❌ ${failures} LOOP-CADENCE PROOF(S) FAILED`)
  process.exit(1)
}
console.log('✅ LOOP CADENCE PROOF PASSES')
