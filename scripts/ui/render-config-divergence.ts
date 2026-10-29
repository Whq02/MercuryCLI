#!/usr/bin/env bun
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { evaluateCapture } from './renderOracle.ts'
import { seedFirstRun } from '../lib/firstRunSeed.ts'
import { vshotBudgetMs } from '../lib/captureDriver.ts'

const REPO = join(import.meta.dir, '..', '..')
const BIN = join(REPO, 'dist', 'mercury.mjs')
let fail = 0
const t = (name: string, ok: boolean, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
  if (!ok) fail = 1
}

const tmp = mkdtempSync(join(tmpdir(), 'mercury-cfg-'))
seedFirstRun(tmp, [REPO])

const png = join(tmp, 'divergent-80.png')
const res = spawnSync(process.execPath, ['run', join(REPO, 'scripts', 'ui', 'render-tui.ts'),
  '--scenario', 'resume-2turn', '--cols', '80', '--out', png,
], { encoding: 'utf-8', timeout: vshotBudgetMs(90000), env: { ...process.env, MERCURY_CONFIG_DIR: tmp } })
t('render pipeline passes under divergent MERCURY_CONFIG_DIR', res.status === 0 && existsSync(png),
  res.status === 0 ? png : (res.stderr || '').trim().slice(0, 200))

mkdirSync(join(tmp, 'projects'), { recursive: true })
const gridPath = join(tmp, 'err-grid.json')
writeFileSync(join(tmp, 'vshot.json'), JSON.stringify({
  argv: ['node', BIN, '--resume', 'ffffffff-dead-beef-aaaa-000000000000'],
  sends: [], total: 25, cols: 80, rows: 24, out: gridPath,
}))
const v = spawnSync('/usr/bin/python3', [join(import.meta.dir, 'vshot.py'), join(tmp, 'vshot.json')], {
  encoding: 'utf-8', timeout: vshotBudgetMs(30000),
  env: { ...process.env, MERCURY_CONFIG_DIR: tmp },
})
let rejected = false, reason = 'vshot did not produce a grid'
if (v.status === 0 && existsSync(gridPath)) {
  const verdict = evaluateCapture(JSON.parse(readFileSync(gridPath, 'utf8')))
  rejected = !verdict.ok
  reason = verdict.reason
}
t('boot-error capture is REJECTED by the oracle', rejected, reason)

rmSync(tmp, { recursive: true, force: true })
console.log(fail ? '❌ RENDER CONFIG-DIVERGENCE RED' : '✅ RENDER CONFIG-DIVERGENCE GREEN')
process.exit(fail)
