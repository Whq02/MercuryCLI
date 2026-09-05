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
const ROOT = join(import.meta.dir, '..', '..')

const spineRow = async (): Promise<{ status: string; evidence: string }> => {
  const report = await import('../../src/utils/healthReport.js')
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
  check('input-live signalled before the first frame is held, not written', !before.includes('input-live') && before.join('→') === 'runtime-entry→route-ready', before.join('→'))
}
milestones.recordLaunchMilestone('first-frame')
{
  const mine = milestones.readLaunchMilestones().filter(r => r.pid === process.pid).map(r => r.milestone)
  check('…and records right after first-frame, in the spine\'s order', mine.join('→') === 'runtime-entry→route-ready→first-frame→input-live', mine.join('→'))
  const row = await spineRow()
  check('the spine this process wrote reads ok', row.status === 'ok', `${row.status}: ${row.evidence}`)
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
    `${row.status}: ${row.evidence}`,
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
    `${row.status}: ${row.evidence}`,
  )
  const again = JSON.parse(readFileSync(storePath, 'utf8')) as { version: 1; rows: Array<Record<string, unknown>> }
  again.rows.push({ schema: 1, pid: canonPid, atMs: base + 10, milestone: 'chat-flipped' }, { schema: 1, pid: canonPid, atMs: base + 11, milestone: 'birth-landed' })
  writeFileSync(storePath, JSON.stringify(again))
  const withTelemetry = await spineRow()
  check('the chat flip and the birth riding the spine\'s pid leave it ok', withTelemetry.status === 'ok' && withTelemetry.evidence.includes('runtime-entry → route-ready → first-frame → input-live'), `${withTelemetry.status}: ${withTelemetry.evidence}`)
}

{
  const main = readFileSync(join(ROOT, 'src', 'main.tsx'), 'utf8')
  const entryAt = main.indexOf("recordLaunchMilestone('runtime-entry',")
  const actionAt = main.indexOf('async function defaultAction')
  const validationsAt = main.indexOf('── validations (each exits 1)')
  check(
    "runtime-entry stamps at the ACTION'S ENTRY (before the validations, screens and setup)",
    entryAt !== -1 && actionAt !== -1 && validationsAt !== -1 && actionAt < entryAt && entryAt < validationsAt,
    `action=${actionAt} entry=${entryAt} validations=${validationsAt}`,
  )
  check('the stamp exists exactly once', main.split("recordLaunchMilestone('runtime-entry',").length === 2)
  check("the entry rung carries the boot's kind — headless for -p, interactive otherwise", main.includes("recordLaunchMilestone('runtime-entry', { boot: opts.print ? 'headless' : 'interactive' })"))
}

console.log('— a headless run after the interactive boot (the doctor\'s own -p road) —')
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
    `${row.status}: ${row.evidence}`,
  )
  const spine = milestones.lastInteractiveBootSpine()
  check('the interactive spine reader skips the headless pid and hands the interactive boot\'s rows (its four rungs among them)', spine.length > 0 && spine.every(r => r.pid === 999999) && ['runtime-entry', 'route-ready', 'first-frame', 'input-live'].every(m => spine.some(r => r.milestone === m)), JSON.stringify(spine.map(r => `${r.pid}:${r.milestone}`)))
}

rmSync(HOME, { recursive: true, force: true })
console.log(failures === 0 ? '\nprove-boot-spine-order: all green' : `\nprove-boot-spine-order: ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
