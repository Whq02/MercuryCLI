#!/usr/bin/env bun
// Visual proof driver: /model in the built binary at
// 100/120 columns in both reachable appearances (dark · true-black),
// asserting the current-generation rows paint whole with no retired scaffolding.
// Grids + PNGs land in the path CAPTURE_OUT names. Not part of any suite.
import { writeFileSync, mkdirSync, existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { sanitizePath } from '../../src/utils/sessionStoragePortable.ts'
import { resolveProofHome } from '../lib/proofHome.ts'
import { gridToPng } from './gridToPng.ts'
import { vshotBudgetMs } from '../lib/captureDriver.ts'

const RUNTIME_CWD = join(import.meta.dir, '..', '..')
const CONFIG_HOME = resolveProofHome([RUNTIME_CWD])
const PROJECTS = join(CONFIG_HOME, 'projects', sanitizePath(RUNTIME_CWD))
const VSHOT = new URL('./vshot.py', import.meta.url).pathname
const BIN = join(RUNTIME_CWD, 'dist', 'mercury.mjs')
const OUT = process.env.CAPTURE_OUT ?? '/tmp/model-picker-captures'
const SID = '00000000-aaaa-bbbb-cccc-00000000fmc1'.replace('fmc1', '0fc1')

mkdirSync(OUT, { recursive: true })
const line = {
  isSidechain: false, userType: 'external', entrypoint: 'cli', cwd: RUNTIME_CWD,
  sessionId: SID, version: '1.0.0-beta.1', gitBranch: 'main', parentUuid: null,
  type: 'user', message: { role: 'user', content: 'boot into the repl' },
  uuid: '00000000-0000-4000-8000-000000000001', timestamp: '2026-06-19T10:00:01.000Z',
}
if (!existsSync(PROJECTS)) mkdirSync(PROJECTS, { recursive: true })
writeFileSync(join(PROJECTS, `${SID}.jsonl`), JSON.stringify(line) + '\n')

function setTheme(theme: string): void {
  const cfgPath = join(CONFIG_HOME, '.mercury.json')
  let cfg: Record<string, unknown> = {}
  try { cfg = JSON.parse(readFileSync(cfgPath, 'utf8')) } catch { /* fresh */ }
  writeFileSync(cfgPath, JSON.stringify({ ...cfg, theme }, null, 1))
}

let failures = 0
const expect = (label: string, cond: boolean, detail = ''): void => {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}

for (const theme of ['dark', 'true-black'] as const) {
  setTheme(theme)
  for (const cols of [100, 120] as const) {
    const rows = 44
    const grid = join(OUT, `model-picker-${theme}-${cols}x${rows}.json`)
    const cfgPath = join(OUT, `vshot-${theme}-${cols}.json`)
    writeFileSync(cfgPath, JSON.stringify({
      argv: ['node', BIN, '--resume', SID],
      sends: [
        { atTick: 30, data: '/model', awaitText: '❯', minTick: 5 },
        { afterPrevTicks: 6, data: '\r' },
      ],
      total: 64, cols, rows, out: grid, title: `model-picker ${theme} @ ${cols}x${rows}`,
    }))
    const res = spawnSync('/usr/bin/python3', [VSHOT, cfgPath], {
      encoding: 'utf-8',
      env: { ...process.env, MERCURY_CONFIG_DIR: CONFIG_HOME },
      timeout: vshotBudgetMs(60000),
    })
    const scr = (res.stdout || '') + (res.stderr || '')
    console.log(`\n── ${theme} @ ${cols}×${rows} ──`)
    expect('the picker mounted', /Mercury — model/.test(scr))
    expect('the Sonnet 5 row paints', /Sonnet 5/.test(scr))
    expect('the Opus 5 row paints', /Opus 5/.test(scr))
    expect('the Fable row paints (frontier lane intact)', /Fable/.test(scr))
    expect('no coming-soon scaffolding anywhere', !/coming.soon/i.test(scr))
    const png = grid.replace(/\.json$/, '.png')
    try {
      await gridToPng(grid, png)
      console.log(`  [....] png: ${png}`)
    } catch (e) {
      console.log(`  [....] png skipped (${String(e).slice(0, 60)})`)
    }
  }
}
console.log(failures === 0 ? '\n✅ all captures verified' : `\n❌ ${failures} capture check(s) failed`)
process.exit(failures === 0 ? 0 : 1)
