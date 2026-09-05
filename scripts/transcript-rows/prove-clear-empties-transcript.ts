#!/usr/bin/env bun
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
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

  {
    const { startFixtureApi } = await import('../lib/fixtureApi.ts')
    const { getTaskPath } = await import('../../src/utils/tasks.ts')
    const OLD_VERB = 'Reviewing the planning doc'
    const homeTurn = mkdtempSync(join(tmpdir(), 'clear-then-turn-'))
    writeSyntheticSession('thinking', SID)
    const { cpSync } = await import('node:fs')
    cpSync(home, homeTurn, { recursive: true, filter: source => !/[\\/]daemon[^\\/]*$/.test(source) && !/[\\/]daemon[\\/]/.test(source) && !/-cfg\.json$|clear-(keyed|keyless)\.json$/.test(source) })
    process.env.MERCURY_CONFIG_DIR = homeTurn
    const seed = getTaskPath(SID, 'seed-1')
    mkdirSync(dirname(seed), { recursive: true })
    writeFileSync(seed, JSON.stringify({ id: 'seed-1', subject: 'review next session planning doc', description: '', activeForm: OLD_VERB, status: 'in_progress', blocks: [], blockedBy: [] }))
    const fixture = await startFixtureApi([
      { kind: 'tool_use', name: 'Bash', input: { command: 'sleep 6' } },
      { kind: 'text', text: 'CLEARED-TURN-DONE' },
    ])
    try {
      const cfg = scenario('resume-2turn', 120, 40)
      const out = join(homeTurn, 'clear-then-turn.json')
      const cfgPath = join(homeTurn, 'clear-then-turn-cfg.json')
      writeFileSync(
        cfgPath,
        JSON.stringify({
          argv: cfg.argv,
          cwd: cfg.cwd,
          sends: [
            { atTick: 999, awaitText: '· ready', minTick: 10, awaitSettleTicks: 4, data: '/clear' },
            { afterPrevTicks: 4, data: '\r' },
            { data: 'after the clear: run it\r', awaitText: 'new session', requireAwait: true, minTick: 4, awaitSettleTicks: 4 },
            { data: '', afterPrevTicks: 14, mark: 'mid-turn' },
            { data: '', afterPrevTicks: 30, mark: 'later' },
          ],
          total: 220,
          cols: 120,
          rows: 40,
          out,
        }),
      )
      const env: Record<string, string | undefined> = {
        ...process.env,
        MERCURY_AWAY_SUMMARY: '0',
        MERCURY_CONFIG_DIR: homeTurn,
        ANTHROPIC_API_KEY: 'fixture-key-000',
        ANTHROPIC_BASE_URL: fixture.url,
        MERCURY_CRITTER_IDLE: '0',
        MERCURY_CRITTER_GAZE: '0',
        MERCURY_CRITTER_SLEEP: '0',
        MERCURY_LIVE_CLOCK: '0',
        MERCURY_LIVE_GLYPHS: '0',
      }
      const res = spawnSync('/usr/bin/python3', [join(import.meta.dir, '../ui/vshot.py'), cfgPath], { encoding: 'utf8', timeout: vshotBudgetMs(240_000), env })
      t('clear-then-turn: the capture ran', res.status === 0, res.stderr?.slice(-300) ?? '')
      console.log(`  [fixture] ${fixture.messageRequests().length} message request(s) reached the loopback fixture`)
      if (existsSync(out)) {
        type Cells = Array<Array<{ c?: string } | string>>
        const payload = JSON.parse(readFileSync(out, 'utf8')) as { grid?: Cells; marks?: Array<{ label: string; grid: Cells }> }
        const rowsOf = (grid: Cells | undefined): string[] => (grid ?? []).map(row => row.map(c => (typeof c === 'object' && c !== null ? (c.c ?? ' ') : String(c))).join('').trimEnd())
        const mid = rowsOf(payload.marks?.find(m => m.label === 'mid-turn')?.grid)
        const after = rowsOf(payload.marks?.find(m => m.label === 'later')?.grid)
        console.log(`  [frame] mid-turn: ${mid.filter(r => r.trim() !== '').slice(-8).map(r => r.trim().slice(0, 100)).join(' | ')}`)
        const last = rowsOf(payload.grid)
        console.log(`  [frame] final: ${last.filter(r => r.trim() !== '').slice(-10).map(r => r.trim().slice(0, 110)).join(' | ')}`)
        t("clear-then-turn: mid-turn, the strip never narrates the OLD session's task", mid.length > 0 && !mid.some(r => r.includes(OLD_VERB)), mid.filter(r => r.includes(OLD_VERB)).join(' | '))
        t("clear-then-turn: later in the turn, the old task's words are still nowhere", after.length > 0 && !after.some(r => r.includes(OLD_VERB)))
        t("clear-then-turn: mid-turn, the born session's own turn is on the glass and the strip narrates it in the product's own words (a request phase or a tool), never a task", /ingesting|first byte|thinking|Bash|running|sleep/.test(mid.join('\n')), mid.filter(r => r.trim() !== '').slice(-6).join(' | '))
      }
    } finally {
      await fixture.close()
      process.env.MERCURY_CONFIG_DIR = home
      rmSync(homeTurn, { recursive: true, force: true })
    }
  }
} finally {
  rmSync(home, { recursive: true, force: true })
}

console.log(failures === 0 ? '✅ /clear empties the transcript' : '❌ /clear leaves conversation residue')
process.exit(failures)
