#!/usr/bin/env bun
// ============================================================================
//  scripts/substrate/prove-friction-stopwatch.ts
//  PROOF (telemetry-truth lane): the friction stopwatch's MECHANISMS — never
//  today's numbers (law 5). Pinned:
//    1. Classification: over = the LAST observation > its named budget
//       (relative samples around the budget, whatever the budget is).
//    2. Honest matching: an end without a pending start records NOTHING; a
//       start followed by an end records exactly one real duration; a
//       replaced start uses the latest mark.
//    3. Boot records ONCE (a /clear is not a boot).
//    4. Bounds: the per-transition ring stays bounded.
//    5. Coverage: every declared transition carries a positive finite named
//       budget (the budget VALUES are product intent — deliberately not
//       pinned).
//    6. One owner: the /trace FRICTION section derives from
//       frictionSnapshot() and reds on the `over` fact (structural).
//
//  Run:  ~/.bun/bin/bun run scripts/substrate/prove-friction-stopwatch.ts
// ============================================================================
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  FRICTION_BUDGETS_MS,
  frictionSnapshot,
  markTransitionEnd,
  markTransitionStart,
  recordBootInteractive,
  __resetFrictionStopwatchForTest,
  type FrictionTransition,
} from '../../src/utils/observability/frictionStopwatch.js'

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
  check('a sample under the budget classifies calm', row('screen-switch').over === false)
  markTransitionStart('screen-switch', 5_000)
  markTransitionEnd('screen-switch', 5_000 + budget + 1)
  check('a sample over the budget classifies over (renders red)', row('screen-switch').over === true)
  check('the LAST observation decides (worst alone never reds a recovered surface)', row('screen-switch').worstMs === budget + 1)
  markTransitionStart('screen-switch', 9_000)
  markTransitionEnd('screen-switch', 9_000 + 1)
  check('a recovered transition classifies calm again (last, not worst)', row('screen-switch').over === false && row('screen-switch').worstMs === budget + 1)
}

section('2 · honest matching — no invented durations')
{
  __resetFrictionStopwatchForTest()
  markTransitionEnd('picker-open', 2_000)
  check('an end with NO pending start records nothing', row('picker-open').samples === 0)
  markTransitionStart('picker-open', 1_000)
  markTransitionStart('picker-open', 3_000)
  markTransitionEnd('picker-open', 3_050)
  check('a replaced start uses the LATEST mark (one real sample)', row('picker-open').samples === 1 && row('picker-open').lastMs === 50)
  markTransitionEnd('picker-open', 9_000)
  check('the consumed start does not double-record', row('picker-open').samples === 1)
}

section('3 · boot records once')
{
  __resetFrictionStopwatchForTest()
  recordBootInteractive(1_234)
  recordBootInteractive(9_999)
  const boot = row('boot-interactive')
  check('exactly one boot sample; later calls no-op (a /clear is not a boot)', boot.samples === 1 && boot.lastMs === 1_234)
}

section('4 · the ring stays bounded')
{
  __resetFrictionStopwatchForTest()
  for (let i = 0; i < 200; i++) {
    markTransitionStart('screen-switch', i * 10)
    markTransitionEnd('screen-switch', i * 10 + 5)
  }
  check('samples stay bounded under sustained use', row('screen-switch').samples <= 50)
}

section('5 · every transition carries a positive named budget')
{
  const transitions = Object.keys(FRICTION_BUDGETS_MS) as FrictionTransition[]
  check(
    'budgets cover the whole transition vocabulary, each positive + finite',
    transitions.length >= 3 &&
      transitions.every(t => Number.isFinite(FRICTION_BUDGETS_MS[t]) && FRICTION_BUDGETS_MS[t] > 0),
  )
}

section('6 · structural — the surface derives from the one owner')
{
  const ROOT = join(import.meta.dir, '..', '..')
  const trace = readFileSync(join(ROOT, 'src/components/TraceView.tsx'), 'utf8')
  check('/trace FRICTION section reads frictionSnapshot()', /frictionSnapshot\(\)/.test(trace))
  check('the red is the `over` fact, via theme tokens (no literal color)', /r\.over \? tok\.failure/.test(trace))
  const repl = readFileSync(join(ROOT, 'src/screens/REPL.tsx'), 'utf8')
  check('boot→interactive records at the REPL mount', /recordBootInteractive\(\)/.test(repl))
  const psc = readFileSync(join(ROOT, 'src/utils/processUserInput/processSlashCommand.tsx'), 'utf8')
  check('the dispatch seam marks transition starts', /markTransitionStart\(/.test(psc))
  const cc = readFileSync(join(ROOT, 'src/components/mercury-ui/components.tsx'), 'utf8')
  check('the command-center mount marks the screen-switch end', /markTransitionEnd\('screen-switch'\)/.test(cc))
  const picker = readFileSync(join(ROOT, 'src/components/MercuryModelPicker.tsx'), 'utf8')
  check('the picker mount marks the picker-open end', /markTransitionEnd\('picker-open'\)/.test(picker))
}

console.log('\n' + '═'.repeat(76))
if (failures > 0) {
  console.log(`❌ ${failures} FRICTION-STOPWATCH PROOF(S) FAILED`)
  process.exit(1)
}
console.log('✅ ALL FRICTION-STOPWATCH PROOFS PASS')
console.log('═'.repeat(76))
