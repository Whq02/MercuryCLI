#!/usr/bin/env bun
// gate-watch: src/substrate/launchMilestones.ts src/context/surfaceRoute.ts
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const HOME = realpathSync(mkdtempSync(join(tmpdir(), 'spine-race-')))
process.env.MERCURY_CONFIG_DIR = HOME
process.env.NODE_ENV = 'test'
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
const REPO = resolve(import.meta.dir, '..', '..')

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

const COLD_CHILD = `
process.env.NODE_ENV = 'test'
globalThis.MACRO = { VERSION: '1.0.0' }
const plan = JSON.parse(process.argv[2])
const surfaceRoute = await import(plan.surfaceRoute)
if (plan.registerBootFace) surfaceRoute.registerRouteSurface('boot-settings', { render: () => null })
const resolution = await surfaceRoute.resolveInitialSurface({ env: { ...process.env, ...plan.env } })
const { recordLaunchMilestone, readLaunchMilestones } = require(plan.launchMilestones)
recordLaunchMilestone('first-frame')
recordLaunchMilestone('input-live')
const spine = () => readLaunchMilestones().filter(row => row.pid === process.pid).map(row => row.milestone).join('→')
const atOnce = spine()
await new Promise(resolvePromise => setTimeout(resolvePromise, 200))
process.stdout.write(JSON.stringify({ reason: resolution.reason, atOnce, settled: spine() }))
`

type ColdScenario = { name: string; env: Record<string, string>; registerBootFace: boolean; expectReason: string }
const coldScenarios: ColdScenario[] = [
  { name: 'an always policy', env: { MERCURY_CONCOURSE: 'always' }, registerBootFace: false, expectReason: 'concourse-surface-unregistered' },
  { name: 'an auto policy', env: { MERCURY_CONCOURSE: 'auto' }, registerBootFace: false, expectReason: 'auto-idle' },
  { name: 'the boot-menu landing (the plain world, fullscreen, the Boot face registered)', env: { MERCURY_FULLSCREEN: '1' }, registerBootFace: true, expectReason: 'boot-menu-landing' },
  { name: 'the boot-menu landing through the auto road', env: { MERCURY_CONCOURSE: 'auto', MERCURY_FULLSCREEN: '1' }, registerBootFace: true, expectReason: 'boot-menu-landing' },
]

const childPath = join(HOME, 'cold-spine-child.ts')
writeFileSync(childPath, COLD_CHILD)
for (const scenario of coldScenarios) {
  console.log(`— cold: ${scenario.name} —`)
  const home = join(HOME, `cold-${coldScenarios.indexOf(scenario)}`)
  mkdirSync(home, { recursive: true })
  const plan = {
    surfaceRoute: join(REPO, 'src', 'context', 'surfaceRoute.ts'),
    launchMilestones: join(REPO, 'src', 'substrate', 'launchMilestones.ts'),
    env: scenario.env,
    registerBootFace: scenario.registerBootFace,
  }
  const env: Record<string, string | undefined> = { ...process.env, MERCURY_CONFIG_DIR: home, NODE_ENV: 'test' }
  for (const name of ['MERCURY_CONCOURSE', 'MERCURY_FULLSCREEN']) delete env[name]
  const child = Bun.spawnSync({ cmd: [process.execPath, 'run', childPath, JSON.stringify(plan)], cwd: REPO, env, stdout: 'pipe', stderr: 'pipe' })
  const out = child.stdout.toString()
  let answer: { reason?: string; atOnce?: string; settled?: string } = {}
  try {
    answer = JSON.parse(out.slice(out.lastIndexOf('{'))) as typeof answer
  } catch {
    check('the cold boot answered', false, `${out.slice(-200)} ${child.stderr.toString().slice(-300)}`)
    continue
  }
  const file = join(home, 'launch-milestones.json')
  let rows: Array<{ milestone: string }> = []
  try {
    rows = (JSON.parse(readFileSync(file, 'utf8')) as { rows: Array<{ milestone: string }> }).rows
  } catch {
    rows = []
  }
  check(`the resolution is the expected arm (${scenario.expectReason})`, answer.reason === scenario.expectReason, String(answer.reason))
  check(
    'with the milestone store cold, route-ready is on the spine before the first frame and input-live',
    answer.atOnce === 'route-ready→first-frame→input-live',
    String(answer.atOnce),
  )
  check('nothing is appended to the spine after the boot settles (no late route-ready)', answer.settled === answer.atOnce, `${String(answer.atOnce)} then ${String(answer.settled)}`)
  check('the store on disk reads the same spine', rows.map(r => r.milestone).join('→') === answer.settled, rows.map(r => r.milestone).join('→'))
}

rmSync(HOME, { recursive: true, force: true })
console.log(failures === 0 ? '\nprove-boot-spine-race: all green' : `\nprove-boot-spine-race: ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
