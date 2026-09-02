#!/usr/bin/env bun
// ============================================================================
//  scripts/health/prove-boot-spine-order.ts — the boot spine certifies ORDER
//  (FC-093). input-live used to stamp at the setup screens' raw-mode arm,
//  0.35–4.2 s BEFORE the deep-in-the-action runtime-entry stamp, so the
//  spine printed in reverse and a boot parked at an unanswered trust card
//  was certified ok. Two fixes under proof: the first rung stamps at the
//  ACTION'S ENTRY, and the doctor row blesses only an in-order spine.
//
//  Run: ~/.bun/bin/bun run scripts/health/prove-boot-spine-order.ts
// ============================================================================
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

// The REVERSED spine (the field's own boot shape): input-live before entry.
milestones.recordLaunchMilestone('input-live')
milestones.recordLaunchMilestone('runtime-entry')
milestones.recordLaunchMilestone('route-ready')
milestones.recordLaunchMilestone('first-frame')
{
  const row = await spineRow()
  check(
    'an out-of-order spine WARNS and names the order fault',
    row.status === 'warn' && row.evidence.includes('OUT OF ORDER'),
    `${row.status}: ${row.evidence}`,
  )
}

console.log('— the canonical order (a later boot, distinct pid, appended to the store) —')
{
  // The store groups one spine per pid, so the canonical boot appends as a
  // LATER pid directly in the store's own on-disk shape.
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
}

{
  const main = readFileSync(join(ROOT, 'src', 'main.tsx'), 'utf8')
  const entryAt = main.indexOf("recordLaunchMilestone('runtime-entry')")
  const actionAt = main.indexOf('async function defaultAction')
  const validationsAt = main.indexOf('── validations (each exits 1)')
  check(
    "runtime-entry stamps at the ACTION'S ENTRY (before the validations, screens and setup)",
    entryAt !== -1 && actionAt !== -1 && validationsAt !== -1 && actionAt < entryAt && entryAt < validationsAt,
    `action=${actionAt} entry=${entryAt} validations=${validationsAt}`,
  )
  check('the stamp exists exactly once', main.split("recordLaunchMilestone('runtime-entry')").length === 2)
}

rmSync(HOME, { recursive: true, force: true })
console.log(failures === 0 ? '\nprove-boot-spine-order: all green' : `\nprove-boot-spine-order: ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
