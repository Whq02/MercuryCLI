#!/usr/bin/env bun
import { mkdtempSync, realpathSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const HOME = realpathSync(mkdtempSync(join(tmpdir(), 'spine-order-')))
process.env.MERCURY_CONFIG_DIR = HOME
process.env.NODE_ENV = 'test'
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

let failures = 0
const check = (label: string, cond: boolean, detail = ''): void => {
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ' — ' + detail : ''}`)
  if (!cond) failures++
}

const spineRow = async (): Promise<{ status: string; evidence: string }> => {
  const report = await import('../../src/services/health/healthReport.js')
  const cert = await report.runHealthReport({ depth: 'fast' })
  const row = cert.sections.flatMap(s => s.checks).find(c => c.id === 'launch-spine')
  return { status: String(row?.status), evidence: String(row?.evidence) }
}
const milestones = await import('../../src/substrate/launchMilestones.js')

milestones.recordLaunchMilestone('input-live')
milestones.recordLaunchMilestone('runtime-entry', { boot: 'interactive' })
milestones.recordLaunchMilestone('route-ready')
{
  const before = milestones.readLaunchMilestones().filter(r => r.pid === process.pid).map(r => r.milestone)
  check('input-live signalled before the first frame is held, not written', !before.includes('input-live') && before.join('→') === 'runtime-entry→route-ready', before.join('→') + ' — fix recordLaunchMilestone (RECORDS_AFTER / heldUntil) in src/substrate/launchMilestones.ts so input-live is held until first-frame is recorded')
}
milestones.recordLaunchMilestone('first-frame')
{
  const mine = milestones.readLaunchMilestones().filter(r => r.pid === process.pid).map(r => r.milestone)
  check('…and records right after first-frame, in the spine\'s order', mine.join('→') === 'runtime-entry→route-ready→first-frame→input-live', mine.join('→') + ' — fix recordLaunchMilestone in src/substrate/launchMilestones.ts so a held input-live is written right after first-frame')
  const row = await spineRow()
  check('the spine this process wrote reads ok', row.status === 'ok', `${row.status}: ${row.evidence}` + ' — the launch-spine check (launchSpineCheck in src/services/health/sections/crew/boot.ts) should read ok for the spine this process wrote; the order of rows is set by recordLaunchMilestone in src/substrate/launchMilestones.ts')
}

console.log('— the REVERSED spine in the store (an older build\'s shape): input-live before first-frame —')
{
  const storePath = join(HOME, 'launch-milestones.json')
  const store = JSON.parse(readFileSync(storePath, 'utf8')) as { version: 1; rows: Array<Record<string, unknown>> }
  const base = Date.now()
  for (const [i, milestone] of (['runtime-entry', 'route-ready', 'input-live', 'first-frame'] as const).entries()) {
    store.rows.push({ schema: 1, pid: 999997, atMs: base + i, milestone })
  }
  const { writeFileSync } = await import('node:fs')
  writeFileSync(storePath, JSON.stringify(store))
  const row = await spineRow()
  check(
    'an out-of-order spine WARNS and names the order fault',
    row.status === 'warn' && row.evidence.includes('OUT OF ORDER'),
    `${row.status}: ${row.evidence}` + ' — see launchSpineCheck in src/services/health/sections/crew/boot.ts (the launch-spine row) and lastInteractiveBootSpine in src/substrate/launchMilestones.ts',
  )
}

console.log('— the canonical order (a later boot, distinct pid, appended to the store) —')
{
  const storePath = join(HOME, 'launch-milestones.json')
  const store = JSON.parse(readFileSync(storePath, 'utf8')) as { version: 1; rows: Array<Record<string, unknown>> }
  const canonPid = 999999
  const base = Date.now()
  for (const [i, milestone] of (['runtime-entry', 'route-ready', 'first-frame', 'input-live'] as const).entries()) {
    store.rows.push({ schema: 1, pid: canonPid, atMs: base + i, milestone })
  }
  const { writeFileSync } = await import('node:fs')
  writeFileSync(storePath, JSON.stringify(store))
  const row = await spineRow()
  check(
    'the canonical spine reads ok with all four rungs in order',
    row.status === 'ok' && row.evidence.includes('runtime-entry → route-ready → first-frame → input-live'),
    `${row.status}: ${row.evidence}` + ' — see launchSpineCheck in src/services/health/sections/crew/boot.ts (the launch-spine row) and lastInteractiveBootSpine in src/substrate/launchMilestones.ts',
  )
  const again = JSON.parse(readFileSync(storePath, 'utf8')) as { version: 1; rows: Array<Record<string, unknown>> }
  again.rows.push({ schema: 1, pid: canonPid, atMs: base + 10, milestone: 'chat-flipped' }, { schema: 1, pid: canonPid, atMs: base + 11, milestone: 'birth-landed' })
  writeFileSync(storePath, JSON.stringify(again))
  const withTelemetry = await spineRow()
  check('the chat flip and the birth riding the spine\'s pid leave it ok', withTelemetry.status === 'ok' && withTelemetry.evidence.includes('runtime-entry → route-ready → first-frame → input-live'), `${withTelemetry.status}: ${withTelemetry.evidence}` + ' — see launchSpineCheck in src/services/health/sections/crew/boot.ts (the launch-spine row) and lastInteractiveBootSpine in src/substrate/launchMilestones.ts')
}


console.log('— a headless run after the interactive boot (/health\'s own run road) —')
{
  const storePath = join(HOME, 'launch-milestones.json')
  const store = JSON.parse(readFileSync(storePath, 'utf8')) as { version: 1; rows: Array<Record<string, unknown>> }
  store.rows.push({ schema: 1, pid: 999998, atMs: Date.now(), milestone: 'runtime-entry', boot: 'headless' })
  const { writeFileSync } = await import('node:fs')
  writeFileSync(storePath, JSON.stringify(store))
  const row = await spineRow()
  check(
    'a trailing headless run leaves the verdict on the last interactive boot (ok, all four rungs)',
    row.status === 'ok' && row.evidence.includes('runtime-entry → route-ready → first-frame → input-live'),
    `${row.status}: ${row.evidence}` + ' — see launchSpineCheck in src/services/health/sections/crew/boot.ts (the launch-spine row) and lastInteractiveBootSpine in src/substrate/launchMilestones.ts',
  )
  const spine = milestones.lastInteractiveBootSpine()
  check('the interactive spine reader skips the headless pid and hands the interactive boot\'s rows (its four rungs among them)', spine.length > 0 && spine.every(r => r.pid === 999999) && ['runtime-entry', 'route-ready', 'first-frame', 'input-live'].every(m => spine.some(r => r.milestone === m)), JSON.stringify(spine.map(r => `${r.pid}:${r.milestone}`)) + ' — lastInteractiveBootSpine in src/substrate/launchMilestones.ts must skip pids whose rows carry boot: headless and return the last interactive pid\'s rows')
}

rmSync(HOME, { recursive: true, force: true })
console.log(failures === 0 ? '\nprove-boot-spine-order: all green' : `\nprove-boot-spine-order: ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
