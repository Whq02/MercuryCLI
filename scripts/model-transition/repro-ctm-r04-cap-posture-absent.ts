#!/usr/bin/env bun
// ============================================================================
//  scripts/model-transition/repro-ctm-r04-cap-posture-absent.ts —
//  R04/R05/R06 expect-red driver (R5 cap survival: no failover posture
//  exists anywhere — a capped Anthropic window simply stops the work).
//
//  Mechanism under test: claudeAiLimits already models the whole cap truth
//  (claudeAiLimits.ts: QuotaStatus allowed|allowed_warning|rejected, typed
//  windows, early-warning tiers; rateLimitMocking.ts is the deterministic
//  fixture seam) — but NOTHING consumes it for provider continuity: the
//  boot menu has no cap-failover posture row, and no module in the tree
//  wires quota state to the model-transition owner. The ratified R5 design
//  (posture off/offer/auto, default NEVER switch; posture-symmetric
//  return; degradation honesty) has no substrate to stand on yet.
//
//    §A the limits truth exists (QuotaStatus vocabulary + mocking seam)
//    §B DEFECT: the boot menu carries no cap/failover posture row
//    §C DEFECT: zero modules consume BOTH the limits truth and the
//       transition owner — the cap→handoff wire does not exist
//
//  Exit 0 = defect REPRODUCED (the recorded red for R04's before-state).
//  Exit 1 = not reproduced. Not part of the green gate (repro-*, not prove-*).
// ============================================================================
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = join(import.meta.dir, '..', '..')

let failed = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failed++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ' — ' + detail : ''}`)
}

// §A — the limits substrate is real.
const limits = readFileSync(join(ROOT, 'src/services/claudeAiLimits.ts'), 'utf8')
check(
  '§A QuotaStatus vocabulary exists (allowed|allowed_warning|rejected)',
  limits.includes('allowed_warning') && limits.includes('rejected'),
)
check(
  '§A the deterministic mocking seam exists',
  execFileSync('git', ['ls-files', 'src/services/rateLimitMocking.ts'], {
    cwd: ROOT,
    encoding: 'utf8',
  }).trim().length > 0,
)

// §B — the boot menu has no cap-failover posture row.
const menu = readFileSync(join(ROOT, 'src/substrate/startupMenu.ts'), 'utf8')
check(
  '§B REPRODUCED: no cap/failover posture row in the boot menu',
  !/failover|cap.?survival|quota.?posture/i.test(menu),
)
check(
  '§B REPRODUCED: the boot menu never reads the limits truth',
  !menu.includes('claudeAiLimits'),
)

// §C — the wire does not exist: no module consumes BOTH the limits truth and
// the transition owner.
const limitConsumers = execFileSync(
  'git',
  ['grep', '-l', 'claudeAiLimits', '--', 'src/'],
  { cwd: ROOT, encoding: 'utf8' },
)
  .split('\n')
  .filter(Boolean)
const transitionConsumers = new Set(
  execFileSync('git', ['grep', '-l', 'modelTransition', '--', 'src/'], {
    cwd: ROOT,
    encoding: 'utf8',
  })
    .split('\n')
    .filter(Boolean),
)
const both = limitConsumers.filter(f => transitionConsumers.has(f))
check(
  '§C REPRODUCED: zero modules wire quota truth to the transition owner',
  both.length === 0,
  both.length ? `wired: ${both.join(', ')}` : 'no intersection',
)

console.log(
  failed === 0
    ? '\n REPRODUCED — R04 red recorded (cap truth modeled, never consumed for continuity)'
    : '\n NOT REPRODUCED',
)
process.exit(failed === 0 ? 0 : 1)
