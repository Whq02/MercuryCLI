#!/usr/bin/env bun
import { spawnSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  cleanupScenario,
  CONFIG_HOME,
  scenario,
  SID_ERRORED,
  writeSyntheticSession,
} from './renderScenarios.ts'
import { vshotBudgetMs } from '../lib/captureDriver.ts'

let failures = 0
const t = (name: string, ok: boolean, detail = ''): void => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failures = 1
}

type GridCell = { c: string }
type Grid = { grid: GridCell[][] }
const text = (g: Grid): string =>
  g.grid.map(row => row.map(c => c.c || ' ').join('')).join('\n')

const cfg = scenario('resume-2turn', 120, 44)
writeSyntheticSession('errors', SID_ERRORED)

type Send = {
  atTick: number
  data: string
  awaitText?: string
  minTick?: number
  awaitSettleTicks?: number
  afterPrevTicks?: number
}

let lastReceipts: unknown = null

function capture(tag: string, sends: Send[], total: number): Grid {
  const out = `/tmp/sessiontab-switch-${tag}-${process.pid}.json`
  const cfgPath = `/tmp/sessiontab-switch-${tag}-cfg-${process.pid}.json`
  writeFileSync(cfgPath, JSON.stringify({ argv: cfg.argv, sends, total, cols: 120, rows: 44, out }))
  const res = spawnSync('/usr/bin/python3', [join(import.meta.dir, 'vshot.py'), cfgPath], {
    encoding: 'utf8',
    timeout: vshotBudgetMs(150_000),
    env: {
      ...process.env,
      MERCURY_AWAY_SUMMARY: '0',
      MERCURY_CONFIG_DIR: CONFIG_HOME,
    },
  })
  if (res.status !== 0) throw new Error(`vshot failed: ${res.stderr?.slice(0, 300)}`)
  const payload = JSON.parse(readFileSync(out, 'utf8')) as Grid & { sendReceipts?: unknown }
  lastReceipts = payload.sendReceipts ?? null
  return payload
}

try {
  const before = text(capture('before', [], 45))
  t("baseline shows fixture A ('first task')", before.includes('first task'))
  t('baseline does NOT show fixture B', !before.includes('apply the manifest edit'))

  const after = text(
    capture(
      'after',
      [
        { atTick: 95, data: `/sessiontab ${SID_ERRORED}`, awaitText: '❯', minTick: 8, awaitSettleTicks: 3 },
        { atTick: 100, data: '\r', afterPrevTicks: 3 },
      ],
      130,
    ),
  )
  const switched =
    after.includes('apply the manifest edit') || after.includes('API Error')
  t('after /sessiontab <id>: fixture B transcript is on screen', switched)
  if (!switched) {
    console.log(`  … sendReceipts: ${JSON.stringify(lastReceipts)}`)
    console.log('  … final grid rows 0-24 (first 80 cols):')
    after
      .split('\n')
      .slice(0, 25)
      .forEach((l, i) => console.log(`  ${String(i).padStart(2)}│${l.slice(0, 80).trimEnd()}`))
  }
  t(
    'the mid-turn refusal notification did NOT fire on an idle switch',
    !after.includes('Run in flight'),
  )
} finally {
  cleanupScenario('resume-2turn')
}

console.log(failures === 0 ? '✅ sessiontab-switch contract holds' : '❌ sessiontab-switch BROKEN')
process.exit(failures)
