#!/usr/bin/env bun
import {
  FRICTION_BUDGETS_MS,
  frictionSnapshot,
  markTransitionEnd,
  markTransitionStart,
  recordBootInteractive,
  __resetFrictionStopwatchForTest,
  type FrictionTransition,
} from '../../src/platform/observability/frictionStopwatch.js'

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
}
const row = (name: FrictionTransition) => frictionSnapshot().find(r => r.transition === name)!

console.log('============================================================')
console.log(' friction stopwatch — mechanisms, never numbers')
console.log('============================================================')

section('1 · over-budget classification is relative to the NAMED budget')
{
  __resetFrictionStopwatchForTest()
  const budget = FRICTION_BUDGETS_MS['screen-switch']
  markTransitionStart('screen-switch', 1_000)
  markTransitionEnd('screen-switch', 1_000 + budget - 1)
  check('a sample under the budget classifies calm', row('screen-switch').over === false,
    'frictionSnapshot in src/platform/observability/frictionStopwatch.ts must set over only when the last sample is greater than FRICTION_BUDGETS_MS for that transition')
  markTransitionStart('screen-switch', 5_000)
  markTransitionEnd('screen-switch', 5_000 + budget + 1)
  check('a sample over the budget classifies over (renders red)', row('screen-switch').over === true,
    'frictionSnapshot in src/platform/observability/frictionStopwatch.ts must set over when the last sample is greater than the named budget')
  check('the LAST observation decides (worst alone never reds a recovered surface)', row('screen-switch').worstMs === budget + 1,
    `worstMs=${row('screen-switch').worstMs}, expected ${budget + 1}; worstMs in frictionSnapshot (src/platform/observability/frictionStopwatch.ts) must be the maximum stored sample`)
  markTransitionStart('screen-switch', 9_000)
  markTransitionEnd('screen-switch', 9_000 + 1)
  check('a recovered transition classifies calm again (last, not worst)', row('screen-switch').over === false && row('screen-switch').worstMs === budget + 1,
    `over=${row('screen-switch').over}, worstMs=${row('screen-switch').worstMs}; over in frictionSnapshot (src/platform/observability/frictionStopwatch.ts) must follow the last sample, not the worst`)
}

section('2 · honest matching — no invented durations')
{
  __resetFrictionStopwatchForTest()
  markTransitionEnd('picker-open', 2_000)
  check('an end with NO pending start records nothing', row('picker-open').samples === 0,
    'markTransitionEnd in src/platform/observability/frictionStopwatch.ts must return when pendingStartMs is null')
  markTransitionStart('picker-open', 1_000)
  markTransitionStart('picker-open', 3_000)
  markTransitionEnd('picker-open', 3_050)
  check('a replaced start uses the LATEST mark (one real sample)', row('picker-open').samples === 1 && row('picker-open').lastMs === 50,
    `samples=${row('picker-open').samples}, lastMs=${row('picker-open').lastMs}; markTransitionStart in src/platform/observability/frictionStopwatch.ts must overwrite pendingStartMs with the latest mark`)
  markTransitionEnd('picker-open', 9_000)
  check('the consumed start does not double-record', row('picker-open').samples === 1,
    'markTransitionEnd in src/platform/observability/frictionStopwatch.ts must reset pendingStartMs to null after it records a sample')
}

section('3 · boot records once')
{
  __resetFrictionStopwatchForTest()
  recordBootInteractive(1_234)
  recordBootInteractive(9_999)
  const boot = row('boot-interactive')
  check('exactly one boot sample; later calls no-op (a /clear is not a boot)', boot.samples === 1 && boot.lastMs === 1_234,
    `samples=${boot.samples}, lastMs=${boot.lastMs}; recordBootInteractive in src/platform/observability/frictionStopwatch.ts must record only the first call (bootRecorded)`)
}

section('4 · the ring stays bounded')
{
  __resetFrictionStopwatchForTest()
  for (let i = 0; i < 200; i++) {
    markTransitionStart('screen-switch', i * 10)
    markTransitionEnd('screen-switch', i * 10 + 5)
  }
  check('samples stay bounded under sustained use', row('screen-switch').samples <= 50,
    `samples=${row('screen-switch').samples}; pushSample in src/platform/observability/frictionStopwatch.ts must trim the ring to MAX_SAMPLES`)
}

section('5 · every transition carries a positive named budget')
{
  const transitions = Object.keys(FRICTION_BUDGETS_MS) as FrictionTransition[]
  check(
    'budgets cover the whole transition vocabulary, each positive + finite',
    transitions.length >= 3 &&
      transitions.every(t => Number.isFinite(FRICTION_BUDGETS_MS[t]) && FRICTION_BUDGETS_MS[t] > 0),
    'FRICTION_BUDGETS_MS in src/platform/observability/frictionStopwatch.ts needs at least 3 transitions, each a positive finite number of milliseconds',
  )
}


console.log('\n' + '═'.repeat(76))
if (failures > 0) {
  console.log(`❌ ${failures} FRICTION-STOPWATCH PROOF(S) FAILED`)
  process.exit(1)
}
console.log('✅ ALL FRICTION-STOPWATCH PROOFS PASS')
console.log('═'.repeat(76))
