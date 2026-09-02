#!/usr/bin/env bun
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = join(import.meta.dir, '..', '..')

let failed = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failed++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ' — ' + detail : ''}`)
}

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

const menu = readFileSync(join(ROOT, 'src/substrate/startupMenu.ts'), 'utf8')
check(
  '§B REPRODUCED: no cap/failover posture row in the boot menu',
  !/failover|cap.?survival|quota.?posture/i.test(menu),
)
check(
  '§B REPRODUCED: the boot menu never reads the limits truth',
  !menu.includes('claudeAiLimits'),
)

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
