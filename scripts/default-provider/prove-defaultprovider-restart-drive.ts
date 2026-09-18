#!/usr/bin/env bun
import { execFile } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { vshotBudgetMs } from '../lib/captureDriver.ts'

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}

const ROOT = join(import.meta.dir, '..', '..')
const distArg = process.argv.indexOf('--dist')
const DIST = distArg !== -1 && process.argv[distArg + 1] !== undefined ? process.argv[distArg + 1]! : join(ROOT, 'dist', 'mercury.mjs')
const VSHOT = join(ROOT, 'scripts', 'ui', 'vshot.py')
if (!existsSync(DIST)) {
  console.log('  [SKIP] dist/mercury.mjs absent — build first (the gate prebuilds)')
  process.exit(0)
}

type Grid = Array<Array<{ c?: string }>>
async function capture(
  tag: string,
  cfg: Record<string, unknown>,
  env: Record<string, string>,
): Promise<{ text: string; marks: Record<string, string> }> {
  const dir = mkdtempSync(join(tmpdir(), `defaultprovider-drive-${tag}-`))
  const cfgPath = join(dir, 'cfg.json')
  const outPath = join(dir, 'grid.json')
  writeFileSync(cfgPath, JSON.stringify({ ...cfg, out: outPath }))
  await new Promise<void>((resolveRun, rejectRun) => {
    execFile(
      '/usr/bin/python3',
      [VSHOT, cfgPath],
      { env: { ...process.env, ...env }, timeout: vshotBudgetMs(240_000) },
      (error, _stdout, stderr) => {
        if (error) rejectRun(new Error(`${String(error)}\n${stderr}`))
        else resolveRun()
      },
    )
  })
  const payload = JSON.parse(readFileSync(outPath, 'utf8')) as {
    grid: Grid
    marks?: Array<{ label: string; grid: Grid }>
  }
  const gridText = (grid: Grid): string =>
    grid
      .map(row => row.map(c => (typeof c === 'object' && c !== null ? (c.c ?? ' ') : String(c))).join('').trimEnd())
      .join('\n')
  const marks: Record<string, string> = {}
  for (const m of payload.marks ?? []) marks[m.label] = gridText(m.grid)
  return { text: gridText(payload.grid), marks }
}

console.log('============================================================')
console.log(' /defaultprovider restart drive — set · restart · still the default')
console.log('============================================================')

const home = mkdtempSync(join(realpathSync(tmpdir()), 'defaultprovider-home-'))
const workspace = join(home, 'workspace')
mkdirSync(workspace, { recursive: true })
writeFileSync(
  join(home, '.config.json'),
  JSON.stringify({
    theme: 'dark',
    hasCompletedOnboarding: true,
    projects: { [workspace]: { hasTrustDialogAccepted: true, hasCompletedProjectOnboarding: true } },
  }),
)
const env: Record<string, string> = {
  MERCURY_CONFIG_DIR: home,
  MERCURY_DAEMON_DIR: join(home, 'daemon'),
  MERCURY_TEAMS_DIR: join(home, 'teams'),
  MERCURY_TABULA_DIR: join(home, 'tabula'),
  MERCURY_CREDENTIAL_STORE: 'file',
  MERCURY_LOCAL_PROBE_TARGETS: 'none',
  MERCURY_LIVE_GLYPHS: '0',
  MERCURY_CRITTER_GAZE: '0',
  ANTHROPIC_BASE_URL: 'http://127.0.0.1:9',
  BROWSER: 'true',
  ANTHROPIC_API_KEY: '',
  OPENAI_API_KEY: '',
  DEEPSEEK_API_KEY: 'fixture-deepseek-key-123',
  ZAI_API_KEY: 'fixture-zai-key-123',
}

const switchBoot = (tag: string, cols: number): Promise<{ text: string; marks: Record<string, string> }> =>
  capture(
    tag,
    {
      cols,
      rows: 40,
      total: 140,
      argv: ['node', DIST],
      cwd: workspace,
      sends: [
        { data: '', atTick: 999, awaitText: '↑↓ choose', requireAwait: true, minTick: 8, awaitSettleTicks: 3, mark: 'face1' },
        { data: '\r', afterPrevTicks: 2 },
        { data: '/defaultprovider deepseek\r', atTick: 999, awaitText: '? for shortcuts', requireAwait: true, minTick: 2, awaitSettleTicks: 3 },
        { data: '', atTick: 999, awaitText: 'Default provider set to DeepSeek', requireAwait: true, minTick: 2, awaitSettleTicks: 2, mark: 'receipt' },
      ],
      stableTicks: 4,
    },
    env,
  )
{
  const { marks } = await switchBoot('boot1', 100)
  const face1 = (marks.face1 ?? '').replace(/\s+/g, ' ')
  check('boot 1: two untimed env keys and no ledger — the registry order leads (the GLM lane), never DeepSeek, never "no sign-in yet"', !face1.includes('DeepSeek V4') && !face1.includes('deepseek-v4') && !face1.includes('no sign-in yet'), face1.slice(0, 160))
  const receiptRow = (marks.receipt ?? '').split('\n').find(row => row.includes('Default provider set to DeepSeek')) ?? ''
  check(
    'at 100 columns the receipt takes the hint row whole (the standing hints step aside for its moment): it leads the row, names the switch and the resolved default model id, and sheds only its tail',
    receiptRow.startsWith('Default provider set to DeepSeek — default model now deepseek-v4-pro') && !receiptRow.includes('? for shortcuts') && receiptRow.trimEnd().endsWith('…'),
    receiptRow.trim() || '(no receipt row)',
  )
  const wide = await switchBoot('boot1-wide', 140)
  const receipt = (wide.marks.receipt ?? '').replace(/\s+/g, ' ')
  check(
    'at 140 columns the receipt names the switch + the resolved default model',
    receipt.includes('Default provider set to DeepSeek') && receipt.includes('deepseek-v4-pro'),
    receipt.slice(-260) || '(no receipt frame)',
  )
  const ledger = JSON.parse(readFileSync(join(home, '.sign-ins.json'), 'utf8')) as {
    signIns?: Record<string, { kind?: string }>
  }
  check("the switch landed in the sign-in ledger ('deepseek', an operator switch) — no config field", ledger.signIns?.deepseek?.kind === 'operator-switch', JSON.stringify(ledger))
}

{
  const { marks } = await capture(
    'boot2',
    {
      cols: 100,
      rows: 50,
      total: 90,
      argv: ['node', DIST],
      cwd: workspace,
      sends: [
        { data: '', atTick: 999, awaitText: '↑↓ choose', requireAwait: true, minTick: 8, awaitSettleTicks: 4, mark: 'face' },
      ],
      stableTicks: 4,
    },
    env,
  )
  const face = (marks.face ?? '').replace(/\s+/g, ' ')
  check('boot 2: the face paints its strip at this geometry (the Model line exists on the frame)', /\bModel\s/.test(face), face.slice(-400))
  check(
    'boot 2: the face Model line names the DeepSeek default (the operator switch survived restart and outranks the untimed GLM key)',
    /Model\s+(DeepSeek V4 Pro|deepseek-v4-pro)/.test(face),
    face.slice(-400),
  )
}

console.log(
  failures === 0
    ? '\n✅ prove-defaultprovider-restart-drive — all checks pass'
    : '\n❌ prove-defaultprovider-restart-drive — check(s) failed',
)
process.exit(failures === 0 ? 0 : 1)
