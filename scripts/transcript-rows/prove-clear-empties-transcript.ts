#!/usr/bin/env bun
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { vshotBudgetMs } from '../lib/captureDriver.ts'

const home = mkdtempSync(join(tmpdir(), 'clear-law-'))
process.env.MERCURY_CONFIG_DIR = home

const { scenario, cleanupScenario, writeSyntheticSession, SID } = await import('../ui/renderScenarios.ts')

let failures = 0
const t = (name: string, ok: boolean, detail = ''): void => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failures = 1
}

type Grid = { grid: { c: string }[][] }

function drive(tag: string, keyed: boolean): string[] | null {
  const cfg = scenario('resume-2turn', 120, 40)
  writeSyntheticSession('thinking', SID)
  const out = join(home, `${tag}.json`)
  const cfgPath = join(home, `${tag}-cfg.json`)
  writeFileSync(
    cfgPath,
    JSON.stringify({
      argv: cfg.argv,
      cwd: cfg.cwd,
      sends: [
        { atTick: 999, awaitText: '· ready', minTick: 10, awaitSettleTicks: 4, data: '/clear' },
        { afterPrevTicks: 4, data: '\r' },
      ],
      total: 220,
      cols: 120,
      rows: 40,
      out,
    }),
  )
  const env: Record<string, string | undefined> = { ...process.env, MERCURY_AWAY_SUMMARY: '0', MERCURY_CONFIG_DIR: home }
  if (keyed) env.ANTHROPIC_API_KEY = 'fixture-key-000'
  else delete env.ANTHROPIC_API_KEY
  const res = spawnSync('/usr/bin/python3', [join(import.meta.dir, '../ui/vshot.py'), cfgPath], {
    encoding: 'utf8',
    timeout: vshotBudgetMs(200_000),
    env,
  })
  t(`${tag}: the capture ran`, res.status === 0, res.stderr?.slice(-300) ?? '')
  if (res.status !== 0 || !existsSync(out)) return null
  const g = JSON.parse(readFileSync(out, 'utf8')) as Grid
  return g.grid.map(r => r.map(c => c.c || ' ').join(''))
}

try {
  {
    const rows = drive('clear-keyed', true)
    if (rows === null) failures = 1
    else {
      const paneHas = (s: string): boolean => rows.some(r => r.slice(24).includes(s))
      const has = (s: string): boolean => rows.some(r => r.includes(s))
      t('keyed: the cleared USER prompt is off the glass', !paneHas('why does the manifest pin zod?'))
      t('keyed: the cleared THINKING text is off the glass', !paneHas('The manifest'))
      t('keyed: the cleared REPLY text is off the glass', !paneHas('The pin keeps'))
      t('keyed: the fresh-session welcome returned (ready line)', paneHas('ready · type a prompt'))
      t('keyed: the BORN chat is the focused one (the new-session status row)', has('new session') && has('· ready'))
      t('keyed: POISON — the Boot face never took the frame', !has('New Session in '))
    }
    cleanupScenario('resume-2turn')
  }

  {
    const rows = drive('clear-keyless', false)
    if (rows === null) failures = 1
    else {
      const paneHas = (s: string): boolean => rows.some(r => r.slice(24).includes(s))
      const has = (s: string): boolean => rows.some(r => r.includes(s))
      console.log(`  [frame] keyless after /clear: ${rows.filter(r => r.trim() !== '').slice(-10).map(r => r.trim().slice(0, 100)).join(' | ')}`)
      t('keyless: the cleared USER prompt is off the glass (the old conversation parked, never kept on the glass)', !paneHas('why does the manifest pin zod?'))
      t('keyless: the fresh-session welcome returned (ready line)', paneHas('ready · type a prompt'))
      t('keyless: the BORN chat is the focused one (the new-session status row)', has('new session') && has('· ready'))
      t('keyless: POISON — the Boot face never took the frame', !has('New Session in '))
    }
    cleanupScenario('resume-2turn')
  }
} finally {
  rmSync(home, { recursive: true, force: true })
}

console.log(failures === 0 ? '✅ /clear empties the transcript' : '❌ /clear leaves conversation residue')
process.exit(failures)
