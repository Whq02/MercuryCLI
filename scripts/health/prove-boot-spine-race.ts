#!/usr/bin/env bun
// gate-watch: src/substrate/launchMilestones.ts src/context/surfaceRoute.ts
import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const HOME = realpathSync(mkdtempSync(join(tmpdir(), 'spine-race-')))
process.env.MERCURY_CONFIG_DIR = HOME
process.env.NODE_ENV = 'test'
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

let failures = 0
const check = (label: string, cond: boolean, detail = ''): void => {
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ' — ' + detail : ''}`)
  if (!cond) failures++
}

const milestones = await import('../../src/substrate/launchMilestones.js')
const surfaceRoute = await import('../../src/context/surfaceRoute.js')

const scenarios: Array<{ name: string; env: NodeJS.ProcessEnv; expectReason: string }> = [
  { name: 'the plain world (concourse off, no menu)', env: {}, expectReason: 'concourse-off' },
  { name: 'an always policy', env: { MERCURY_CONCOURSE: 'always' }, expectReason: 'concourse-surface-unregistered' },
  { name: 'an auto policy', env: { MERCURY_CONCOURSE: 'auto' }, expectReason: 'auto-idle' },
]

for (const scenario of scenarios) {
  console.log(`— ${scenario.name} —`)
  milestones._resetLaunchMilestonesForTesting()
  surfaceRoute._resetSurfaceRouteForTesting()
  const baseline = milestones.readLaunchMilestones().length
  milestones.recordLaunchMilestone('runtime-entry', { boot: 'interactive' })
  const resolution = await surfaceRoute.resolveInitialSurface({ env: { ...process.env, ...scenario.env } })
  milestones.recordLaunchMilestone('first-frame')
  milestones.recordLaunchMilestone('input-live')
  const mine = milestones.readLaunchMilestones().slice(baseline).map(r => r.milestone)
  check(
    `route-ready is on the spine the moment the resolver settles (${scenario.expectReason})`,
    mine.join('→') === 'runtime-entry→route-ready→first-frame→input-live',
    `${resolution.reason}: ${mine.join('→')}`,
  )
  check(`the resolution is the expected arm (${scenario.expectReason})`, resolution.reason === scenario.expectReason, resolution.reason)
  await new Promise(resolvePromise => setTimeout(resolvePromise, 25))
  const settled = milestones.readLaunchMilestones().slice(baseline).map(r => r.milestone)
  check('after the microtask queue drains the spine is unchanged (no late append)', settled.join('→') === 'runtime-entry→route-ready→first-frame→input-live', settled.join('→'))
}

{
  milestones._resetLaunchMilestonesForTesting()
  const before = milestones.readLaunchMilestones().length
  await new Promise(resolvePromise => setTimeout(resolvePromise, 10))
  const after = milestones.readLaunchMilestones().length
  check('importing the route owner alone records no milestone', before === after, `${before}→${after}`)
}

rmSync(HOME, { recursive: true, force: true })
console.log(failures === 0 ? '\nprove-boot-spine-race: all green' : `\nprove-boot-spine-race: ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
