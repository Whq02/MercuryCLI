#!/usr/bin/env bun
// ============================================================================
//  prove-changeset-card — the aggregate inline change view on the
//  BUILT artifact, rendered at 80 + 120 columns across representative
//  states (the render-verify law — a broken layout only shows in a render):
//    · applied — mixed change/already-satisfied, counts, plan meta, and a
//      NAMED omitted-hunk cut;
//    · all-no-change — truthful zero-write card with the satisfied names;
//    · stale — attention tone + the ONE concise next action (visible even
//      collapsed);
//    · expanded (-detail) — per-file railed diff cards + plan digest/age.
// ============================================================================
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { vshotBudgetMs } from '../lib/captureDriver.ts'

const home = mkdtempSync(join(tmpdir(), 'fulcrum-card-'))
process.env.MERCURY_CONFIG_DIR = home

const { scenario, cleanupScenario } = await import('../ui/renderScenarios.ts')

let failures = 0
const t = (name: string, ok: boolean, detail = ''): void => {
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${name}${!ok && detail ? ` — ${detail}` : ''}`)
  if (!ok) failures = 1
}

type Grid = { grid: { c: string }[][] }
const textOf = (g: Grid): string => g.grid.map(r => r.map(c => c.c || ' ').join('')).join('\n')

function capture(name: string, cols: number): string {
  const cfg = scenario(name, cols, 44)
  const out = join(home, `${name}-${cols}.json`)
  const cfgPath = join(home, `${name}-${cols}-cfg.json`)
  writeFileSync(cfgPath, JSON.stringify({ argv: cfg.argv, cwd: cfg.cwd, sends: cfg.sends ?? [], total: cfg.total ?? 45, cols, rows: 44, out }))
  const res = spawnSync('/usr/bin/python3', [join(import.meta.dir, '../ui/vshot.py'), cfgPath], {
    encoding: 'utf8',
    timeout: vshotBudgetMs(200_000),
    env: { ...process.env, MERCURY_AWAY_SUMMARY: '0', MERCURY_CONFIG_DIR: home },
  })
  if (res.status !== 0) throw new Error(`vshot ${name} failed: ${res.stderr?.slice(-500)}`)
  return textOf(JSON.parse(readFileSync(out, 'utf8')) as Grid)
}

try {
  console.log('── collapsed at 120 ──')
  const collapsed = capture('changeset-card', 120)
  t('applied card: state word + file/hunk counts', collapsed.includes('changeset applied') && collapsed.includes('2 files') && collapsed.includes('3 hunks'))
  t('applied card: the already-satisfied count rides the summary', collapsed.includes('1 already satisfied'))
  t('no-change card: truthful state word', collapsed.includes('changeset no-change'))
  t('stale card: state word', collapsed.includes('changeset stale'))
  t('stale card: the next action is visible even collapsed', collapsed.includes('re-read src/api.ts, then op:"preview" again'))
  t('collapsed: no diff body painted', !collapsed.includes('client.get("/v2/rates")'))
  t('collapsed: expansion affordance named', collapsed.includes('ctrl+o expands'))

  console.log('── expanded at 120 ──')
  const detail = capture('changeset-card-detail', 120)
  t('expanded: per-file railed diff card (api.ts)', detail.includes('diff · api.ts'))
  t('expanded: second file card (model.ts)', detail.includes('diff · model.ts'))
  t('expanded: hunk body with the replacement visible', detail.includes('client.get("/v2/rates")'))
  t('expanded: the omitted-hunk cut is NAMED', detail.includes('+2 hunks not shown'))
  t('expanded: already-satisfied members named', detail.includes('already satisfied (not written): util.ts'))
  t('expanded: plan identity + digest + age line', detail.includes('plan cs-fixture0001') && detail.includes('digest abc123def456') && detail.includes('age 2m'))
  t('expanded: no-change card names both satisfied files', detail.includes('already satisfied (not written): api.ts, model.ts'))

  console.log('── expanded at 80 ──')
  const narrow = capture('changeset-card-detail', 80)
  t('80-col: file header + hunk survive', narrow.includes('src/api.ts') && narrow.includes('client.get("/v2/rates")'))
  t('80-col: the next action survives', narrow.includes('re-read src/api.ts'))
  t('80-col: plan meta survives', narrow.includes('plan cs-fixture0001'))
} finally {
  cleanupScenario('changeset-card')
}

console.log(failures === 0 ? '\nprove-changeset-card: GREEN' : '\nprove-changeset-card: FAILURE(S)')
process.exit(failures)
