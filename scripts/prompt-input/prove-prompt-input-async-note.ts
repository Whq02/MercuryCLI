#!/usr/bin/env bun
import { spawnSync } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { vshotBudgetMs } from '../lib/captureDriver.ts'

const home = mkdtempSync(join(tmpdir(), 'kinetic-note-'))
process.env.MERCURY_CONFIG_DIR = home
const stubDir = join(home, 'bin')
mkdirSync(stubDir)
const fireLog = join(home, 'gh-fires.log')
writeFileSync(join(stubDir, 'gh'), `#!/bin/bash\necho "$(date +%s) $*" >> ${fireLog}\nsleep 4\nexit 1\n`)
chmodSync(join(stubDir, 'gh'), 0o755)

const { scenario, cleanupScenario } = await import('../ui/renderScenarios.ts')
const cfg = scenario('resume-2turn', 120, 40)

let failures = 0
const t = (name: string, ok: boolean, detail = ''): void => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failures = 1
}

type Grid = { grid: { c: string }[][]; sendReceipts?: unknown }
const rowsOf = (g: Grid): string[] => g.grid.map(r => r.map(c => c.c || ' ').join(''))

function capture(tag: string, sends: unknown[], total: number): string[] {
  const out = join(home, `${tag}.json`)
  const cfgPath = join(home, `${tag}-cfg.json`)
  writeFileSync(cfgPath, JSON.stringify({ argv: cfg.argv, cwd: cfg.cwd, sends, total, cols: 120, rows: 40, out }))
  const res = spawnSync('/usr/bin/python3', [join(import.meta.dir, '../ui/vshot.py'), cfgPath], {
    encoding: 'utf8',
    timeout: vshotBudgetMs(200_000),
    env: {
      ...process.env,
      PATH: `${stubDir}:${process.env.PATH}`,
      MERCURY_AWAY_SUMMARY: '0',
      MERCURY_CONFIG_DIR: home,
    },
  })
  if (res.status !== 0) throw new Error(`vshot ${tag} failed: ${res.stderr?.slice(-500)}`)
  return rowsOf(JSON.parse(readFileSync(out, 'utf8')) as Grid)
}

const ESC = '\u001b'
const sends = [
  { atTick: 40, awaitText: '? for shortcuts', minTick: 5, awaitSettleTicks: 3, data: '/realms\r' },
  { requireAwait: true, awaitText: 'Trusted realms', awaitSettleTicks: 1, data: 'g' },
  { afterPrevTicks: 1, data: ESC },
]

try {
  const mid = capture('mid', sends, 52)
  t('esc closes /realms while the auth probe is still running',
    !mid.some(r => r.includes('Trusted realms')))
  const fires = existsSync(fireLog) ? readFileSync(fireLog, 'utf8').trim().split('\n').filter(Boolean) : []
  const probeFires = fires.filter(l => l.includes('auth status'))
  t('the probe actually ran (gh auth status fired exactly once)', probeFires.length === 1,
    `probe fires=${probeFires.length} of ${fires.length} gh call(s): [${fires.map(l => l.split(' ').slice(1).join(' ')).join(' | ')}]`)
} finally {
  cleanupScenario('resume-2turn')
}

console.log(failures === 0 ? '✅ kinetic async-note law holds' : '❌ kinetic async-note BROKEN')
process.exit(failures)
