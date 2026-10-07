#!/usr/bin/env bun
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

if (process.argv[2] === '--stamp') {
  process.env.NODE_ENV = 'test'
  const milestones = await import('../../src/substrate/launchMilestones.js')
  const graph = await import('../../src/boot/launchGraph.js')
  const begin = (): void => (milestones as { markLaunchBegun?: () => void }).markLaunchBegun?.()
  const stamp = milestones.recordLaunchMilestone
  stamp('runtime-entry', { boot: 'interactive' })
  const scenario = process.argv[3]
  if (scenario === 'canonical' || scenario === 'late-route' || scenario === 'reset') begin()
  if (scenario === 'canonical') stamp('route-ready')
  if (scenario === 'reset') {
    milestones._resetLaunchMilestonesForTesting()
    stamp('runtime-entry', { boot: 'interactive' })
  }
  graph.signalInputLive()
  stamp('first-frame')
  begin()
  begin()
  stamp('first-frame')
  if (scenario !== 'setup-exit') stamp('route-ready')
  stamp('chat-flipped')
  process.exit(0)
}

const HOME = realpathSync(mkdtempSync(join(tmpdir(), 'spine-setup-')))
process.env.MERCURY_CONFIG_DIR = HOME
process.env.MERCURY_CREDENTIAL_STORE = 'file'
process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'
process.env.NODE_ENV = 'test'
delete process.env.MERCURY_HOME

const ROOT = join(import.meta.dir, '..', '..')
const STORE = join(HOME, 'launch-milestones.json')
const ORDER = 'runtime-entry → route-ready → first-frame → input-live'
const FIX = `The rungs must fire ${ORDER}; an inverted spine means a stamp moved — include \`mercury health --json\` when reporting.`
type Row = { schema: 1; pid: number; atMs: number; milestone: string; boot?: string; beforeLaunch?: unknown }
type Check = { id: string; status: string; evidence: string; fix?: string }
let failures = 0
const check = (label: string, cond: boolean, detail = ''): void => {
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ' — ' + detail : ''}`)
  if (!cond) failures++
}
const readRows = (): Row[] => JSON.parse(readFileSync(STORE, 'utf8')).rows as Row[]
const spineRow = async (): Promise<Check | undefined> => {
  const { runHealthReport } = await import('../../src/utils/healthReport.js')
  return (await runHealthReport({ depth: 'fast' })).sections.flatMap(section => section.checks).find(row => row.id === 'launch-spine')
}
const builtSpineRow = (): Check | undefined => {
  const child = spawnSync('node', [join(ROOT, 'dist', 'mercury.mjs'), 'health', '--json'], {
    cwd: HOME,
    env: { ...process.env, NODE_ENV: 'production' },
    encoding: 'utf8',
    timeout: 120_000,
  })
  check('the built health door returns a certificate', child.status === 0 || child.status === 3, `rc=${child.status} ${child.error?.message ?? ''}`)
  try {
    return (JSON.parse(child.stdout) as { sections: Array<{ checks: Check[] }> }).sections.flatMap(section => section.checks).find(row => row.id === 'launch-spine')
  } catch {
    check('the built certificate decodes', false, child.stdout.slice(-300))
    return undefined
  }
}

try {
  const cases: Array<{ name: string; rungs: string[]; fact?: unknown; factOn?: string; status: 'ok' | 'warn'; built?: boolean }> = [
    { name: 'a setup-screen first frame permits the late route mark', rungs: ['runtime-entry', 'first-frame', 'input-live', 'route-ready'], fact: true, status: 'ok', built: true },
    { name: 'the same marks without the fact still warn', rungs: ['runtime-entry', 'first-frame', 'input-live', 'route-ready'], status: 'warn', built: true },
    { name: 'a plain boot stays clean', rungs: ['runtime-entry', 'route-ready', 'first-frame', 'input-live'], status: 'ok', built: true },
    { name: 'input before the first frame still warns with the fact', rungs: ['runtime-entry', 'route-ready', 'input-live', 'first-frame'], fact: true, status: 'warn', built: true },
    { name: 'route before entry still warns with the fact', rungs: ['route-ready', 'runtime-entry', 'first-frame', 'input-live'], fact: true, status: 'warn' },
    { name: 'entry after the first frame still warns with the fact', rungs: ['first-frame', 'runtime-entry', 'input-live', 'route-ready'], fact: true, status: 'warn' },
    { name: 'duplicate route marks still warn with the fact', rungs: ['runtime-entry', 'first-frame', 'input-live', 'route-ready', 'route-ready'], fact: true, status: 'warn' },
    { name: 'a route settled between setup paint and input is clean', rungs: ['runtime-entry', 'first-frame', 'route-ready', 'input-live'], fact: true, status: 'ok' },
    { name: 'exiting at a setup screen stays clean', rungs: ['runtime-entry', 'first-frame', 'input-live'], fact: true, status: 'ok' },
    { name: 'a truncated setup boot still warns', rungs: ['runtime-entry', 'first-frame', 'route-ready'], fact: true, status: 'warn' },
    { name: 'a fact on another rung cannot excuse a late route', rungs: ['runtime-entry', 'first-frame', 'input-live', 'route-ready'], fact: true, factOn: 'route-ready', status: 'warn' },
    { name: 'a truthy non-boolean cannot excuse a late route', rungs: ['runtime-entry', 'first-frame', 'input-live', 'route-ready'], fact: 'true', status: 'warn' },
  ]
  for (const scenario of cases) {
    const rows: Row[] = scenario.rungs.map((milestone, index) => ({
      schema: 1,
      pid: 999991,
      atMs: Date.now() + index,
      milestone,
      ...(milestone === 'runtime-entry' ? { boot: 'interactive' } : {}),
      ...(milestone === (scenario.factOn ?? 'first-frame') && scenario.fact !== undefined ? { beforeLaunch: scenario.fact } : {}),
    }))
    writeFileSync(STORE, JSON.stringify({ version: 1, rows }))
    for (const [road, row] of [
      ['source', await spineRow()],
      ...(scenario.built ? [['built', builtSpineRow()] as const] : []),
    ] as const) {
      check(`${road}: ${scenario.name}`, row?.status === scenario.status, `${row?.status}: ${row?.evidence}`)
      check(`${road}: the row retains the actual recorded order`, row?.evidence.includes(scenario.rungs.join(' → ')) === true)
      if (scenario.status === 'warn' && scenario.rungs.includes('input-live')) {
        check(`${road}: the warning and fix wording are unchanged`, row?.evidence === `last boot's spine fired OUT OF ORDER: ${scenario.rungs.join(' → ')}` && row?.fix === FIX)
      }
    }
  }

  for (const scenario of ['setup', 'setup-exit', 'canonical', 'late-route', 'reset']) {
    writeFileSync(STORE, JSON.stringify({ version: 1, rows: [] }))
    const child = spawnSync(process.execPath, [import.meta.path, '--stamp', scenario], {
      cwd: ROOT,
      env: process.env,
      encoding: 'utf8',
      timeout: 120_000,
    })
    check(`${scenario}: the recorder child completed`, child.status === 0, `rc=${child.status} ${child.stderr.trim().slice(-300)}`)
    const rows = readRows()
    const expected = scenario === 'canonical'
      ? 'runtime-entry → route-ready → first-frame → input-live → chat-flipped'
      : scenario === 'setup-exit'
        ? 'runtime-entry → first-frame → input-live → chat-flipped'
        : scenario === 'reset'
          ? 'runtime-entry → runtime-entry → first-frame → input-live → route-ready → chat-flipped'
          : 'runtime-entry → first-frame → input-live → route-ready → chat-flipped'
    check(`${scenario}: the writer preserves mark order and one first frame`, rows.map(row => row.milestone).join(' → ') === expected)
    const marked = rows.filter(row => row.beforeLaunch !== undefined)
    const setup = scenario === 'setup' || scenario === 'setup-exit' || scenario === 'reset'
    check(`${scenario}: only the setup first frame carries the exact fact`, setup
      ? marked.length === 1 && marked[0]?.milestone === 'first-frame' && marked[0].beforeLaunch === true
      : marked.length === 0,
    JSON.stringify(rows.map(row => [row.milestone, row.beforeLaunch])))
    if (scenario !== 'reset') {
      const row = await spineRow()
      check(`${scenario}: the real recorder agrees with health`, row?.status === (scenario === 'late-route' ? 'warn' : 'ok'), `${row?.status}: ${row?.evidence}`)
    }
  }
} finally {
  rmSync(HOME, { recursive: true, force: true })
}

console.log(failures === 0 ? '\nprove-boot-spine-setup-screens: all green' : `\nprove-boot-spine-setup-screens: ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
