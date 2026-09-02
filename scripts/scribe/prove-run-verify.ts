#!/usr/bin/env bun

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { resolveAppliedEffort, modelSupportsXHighEffort, modelSupportsMaxEffort } from '../../src/utils/effort.js'
import { buildStreamJsonInvocation } from '../../src/daemon/headlessRun.js'
import { LONG_LIVED_FEEDS_SHARED_BREAKER } from '../../src/daemon/longLivedSupervisor.js'
import {
  IMPLEMENTER_SEAT_DEFAULTS,
  SCRIBE_SEAT_DEFAULT_EFFORT,
  SCRIBE_SEAT_DEFAULT_MODEL,
} from '../../src/utils/model/seatSlots.js'

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ` — ${detail}` : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
}
const src = (...p: string[]) => readFileSync(join(import.meta.dir, '..', '..', 'src', ...p), 'utf-8')
const argVal = (argv: string[], flag: string) => argv[argv.indexOf(flag) + 1]

const IMPL = {
  model: IMPLEMENTER_SEAT_DEFAULTS.model, effort: IMPLEMENTER_SEAT_DEFAULTS.effort, appendSystemPrompt: '',
  role: 'MERCURY_IMPLEMENTER' as const, agentName: 'implementer', agentId: 'implementer@scribe', teamName: 'scribe',
}
const SCRIBE = {
  model: SCRIBE_SEAT_DEFAULT_MODEL, effort: SCRIBE_SEAT_DEFAULT_EFFORT, appendSystemPrompt: '',
  role: 'MERCURY_SCRIBE' as const, agentName: 'scribe', agentId: 'scribe@scribe', teamName: 'scribe',
}

console.log('============================================================')
console.log(' PHASE-4 HARD GATE — Task 4.3 run-verify')
console.log('============================================================')

section('(a) MAX effort is NOT downgraded inside the Implementer (the executor earns max)')
process.env.MERCURY_EFFORT_LEVEL = 'max'
check('resolveAppliedEffort(implementer seat model, undefined) === max (NOT clamped)', resolveAppliedEffort(IMPLEMENTER_SEAT_DEFAULTS.model, undefined) === 'max')
check('modelSupportsMaxEffort(implementer seat model) === true', modelSupportsMaxEffort(IMPLEMENTER_SEAT_DEFAULTS.model) === true)
check('modelSupportsXHighEffort(scribe seat model) === true (the Scribe floor also holds)', modelSupportsXHighEffort(SCRIBE_SEAT_DEFAULT_MODEL) === true)
check('the explicit-override target opus-4-8[1m] still serves max (claude-4: selectable, not default)', modelSupportsMaxEffort('claude-opus-4-8[1m]') === true && resolveAppliedEffort('claude-opus-4-8[1m]', undefined) === 'max')
check('CONTRAST: an effort-less model (3-5-sonnet) sends NO effort param at all (wire omits it)', resolveAppliedEffort('claude-3-5-sonnet-20241022', undefined) === undefined)
delete process.env.MERCURY_EFFORT_LEVEL

section('(b) BOTH spawns carry the CURRENT seat defaults (env-swappable); Implementer @max, Scribe @xhigh')
check('seat defaults are the Claude-5 pins: Implementer claude-opus-5@max · Scribe claude-fable-5[1m]@xhigh',
  IMPLEMENTER_SEAT_DEFAULTS.model === 'claude-opus-5' && IMPLEMENTER_SEAT_DEFAULTS.effort === 'max'
  && SCRIBE_SEAT_DEFAULT_MODEL === 'claude-fable-5[1m]' && SCRIBE_SEAT_DEFAULT_EFFORT === 'xhigh')
const impl = buildStreamJsonInvocation(IMPL)
const scribe = buildStreamJsonInvocation(SCRIBE)
check(`Implementer --model === ${IMPL.model}`, argVal(impl.argv, '--model') === IMPL.model)
check(`Implementer env.ANTHROPIC_MODEL === ${IMPL.model}`, impl.env.ANTHROPIC_MODEL === IMPL.model)
check('Implementer env.MERCURY_EFFORT_LEVEL === max', impl.env.MERCURY_EFFORT_LEVEL === 'max')
check('Implementer env.MERCURY_IMPLEMENTER === 1', impl.env.MERCURY_IMPLEMENTER === '1')
check(`Scribe --model === ${SCRIBE.model}`, argVal(scribe.argv, '--model') === SCRIBE.model)
check(`Scribe env.ANTHROPIC_MODEL === ${SCRIBE.model}`, String(scribe.env.ANTHROPIC_MODEL) === SCRIBE.model)
check('Scribe env.MERCURY_SCRIBE === 1', scribe.env.MERCURY_SCRIBE === '1')
check('Scribe effort floor is xhigh', scribe.env.MERCURY_EFFORT_LEVEL === 'xhigh')
const swap = buildStreamJsonInvocation({ ...IMPL, model: 'claude-opus-4-8[1m]' })
check('explicit opus-4-8[1m] override carries through --model + ANTHROPIC_MODEL',
  argVal(swap.argv, '--model') === 'claude-opus-4-8[1m]' && swap.env.ANTHROPIC_MODEL === 'claude-opus-4-8[1m]')

section('(c) respawn reuses the SAME --agent-name (drains the SAME inbox)')
check('Implementer --agent-name === implementer', argVal(impl.argv, '--agent-name') === 'implementer')
const impl2 = buildStreamJsonInvocation(IMPL)
check('invocation is deterministic (respawn argv identical → same inbox)', JSON.stringify(impl.argv) === JSON.stringify(impl2.argv))
console.log('  (LIVE kill→respawn drain: see prove-supervise.ts crash→respawn-with-new-pid)')

section('(d) long-lived respawns are EXEMPT from the shared breaker')
check('LONG_LIVED_FEEDS_SHARED_BREAKER === false (cron path stays open)', LONG_LIVED_FEEDS_SHARED_BREAKER === false)
console.log('  (LIVE: prove-supervise.ts asserts the breaker is never fed across crash+respawn+ceiling)')

section('daemon spawn wiring (main.ts, structural)')
const main = src('daemon', 'main.ts')
check('spawn is gated by isImplementerSpawnEnabled()', /isImplementerSpawnEnabled\(\)/.test(main))
check("registers 'implementer' as long-lived", /registerLongLived\(\s*'implementer'/.test(main))
const seatSlotsSrc = src('utils', 'model', 'seatSlots.ts')
check('spawns claude-opus-5 @ max (env-swappable, seat-slot validated default)', /const seat = resolveImplementerSeat\(\)/.test(main) && /IMPLEMENTER_SEAT_DEFAULTS: SeatSpec = \{\s*\n\s*model: 'claude-opus-5',\s*\n\s*effort: 'max',/.test(seatSlotsSrc))
check('appendSystemPrompt is empty (pack from role-env splice, no double-append)', /appendSystemPrompt:\s*''/.test(main))
check('reaps live rostered workers on shutdown', /for \(const j of roster\.list\(\)\) \{[\s\S]{0,500}roster\.kill\(j\.short\)/.test(main))

console.log('\n' + '═'.repeat(76))
if (failures === 0) console.log('✅ ALL PHASE-4 RUN-VERIFY CHECKS PASS')
else console.log(`❌ ${failures} RUN-VERIFY CHECK(S) FAILED`)
console.log('═'.repeat(76))
process.exit(failures === 0 ? 0 : 1)
