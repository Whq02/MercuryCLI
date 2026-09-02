#!/usr/bin/env bun
// render-config-divergence.ts — end-to-end proof of the P0 floor repair (PTY tier,
// runs under UI_RENDER=1 like every render-*.ts): the full verify-by-rendering
// pipeline must WORK under a divergent MERCURY_CONFIG_DIR (the live-Hermes
// condition), and the oracle must REJECT a real boot-error screen.
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

const tmp = mkdtempSync(join(tmpdir(), 'hermes-cfg-'))
// Seed the divergent dir through the ONE seeder (firstRunSeed.ts: onboarded +
// trust for the capture cwd) so the binary boots past onboarding/trust there
// — never a copy of a real home's config (another program's settings would
// ride into the capture).
seedFirstRun(tmp, [REPO])

// 1) Happy path: the full render pipeline under the divergent dir must pass —
// renderScenarios stages into tmp/projects and the spawned binary (inheriting
// MERCURY_CONFIG_DIR=tmp) must find the session and paint real chrome.
const png = join(tmp, 'divergent-80.png')
const res = spawnSync(process.execPath, ['run', join(REPO, 'scripts', 'ui', 'render-tui.ts'),
  '--scenario', 'resume-2turn', '--cols', '80', '--out', png,
], { encoding: 'utf-8', timeout: vshotBudgetMs(90000), env: { ...process.env, MERCURY_CONFIG_DIR: tmp } })
t('render pipeline passes under divergent MERCURY_CONFIG_DIR', res.status === 0 && existsSync(png),
  res.status === 0 ? png : (res.stderr || '').trim().slice(0, 200))

// 2) Error screen REJECTED: boot --resume with a session that does not exist in
// the divergent dir and assert the oracle fails the capture (acceptance #1:
// "an error-screen capture FAILS").
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
