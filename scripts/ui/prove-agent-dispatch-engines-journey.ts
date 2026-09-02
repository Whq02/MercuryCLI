#!/usr/bin/env bun
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, statSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { vshotBudgetMs } from '../lib/captureDriver.ts'

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}

const ROOT = join(import.meta.dir, '..', '..')
const DIST = join(ROOT, 'dist', 'mercury.mjs')
if (!existsSync(DIST)) {
  console.log('  [SKIP] dist/mercury.mjs absent — build first (the gate prebuilds)')
  process.exit(0)
}

const KEY = 'zai-journey-proof-key-123456'

interface CaptureResult {
  text: string
  flat: string
  sends: number
  receipts: number
  marks: Record<string, string>
}

function capture(cfg: Record<string, unknown>, env: Record<string, string>): CaptureResult {
  const dir = mkdtempSync(join(tmpdir(), 'orbit-journey-cfg-'))
  const cfgPath = join(dir, 'cfg.json')
  const outPath = join(dir, 'grid.json')
  writeFileSync(cfgPath, JSON.stringify({ ...cfg, out: outPath }))
  execFileSync('/usr/bin/python3', [join(ROOT, 'scripts', 'ui', 'vshot.py'), cfgPath], {
    env: { ...process.env, ...env },
    stdio: ['ignore', 'ignore', 'pipe'],
    timeout: vshotBudgetMs(180_000),
  })
  type Grid = Array<Array<{ c?: string }>>
  const payload = JSON.parse(readFileSync(outPath, 'utf8')) as {
    grid: Grid
    sendReceipts?: unknown[]
    marks?: Array<{ label: string; grid: Grid }>
  }
  const gridText = (grid: Grid): string =>
    grid
      .map(row => row.map(c => (typeof c === 'object' && c !== null ? (c.c ?? ' ') : String(c))).join('').trimEnd())
      .join('\n')
  const text = gridText(payload.grid)
  const marks: Record<string, string> = {}
  for (const m of payload.marks ?? []) marks[m.label] = gridText(m.grid).replace(/\s+/g, ' ')
  return {
    text,
    flat: text.replace(/\s+/g, ' '),
    marks,
    sends: Array.isArray(cfg.sends) ? cfg.sends.length : 0,
    receipts: Array.isArray(payload.sendReceipts) ? payload.sendReceipts.length : 0,
  }
}

function seedHome(): string {
  const home = mkdtempSync(join(tmpdir(), 'orbit-journey-home-'))
  writeFileSync(
    join(home, '.config.json'),
    JSON.stringify({
      theme: 'dark',
      hasCompletedOnboarding: true,
      projects: { [ROOT]: { hasTrustDialogAccepted: true, hasCompletedProjectOnboarding: true } },
      ...(process.env.ANTHROPIC_API_KEY
        ? { customApiKeyResponses: { approved: [process.env.ANTHROPIC_API_KEY.slice(-20)], rejected: [] } }
        : {}),
    }),
  )
  return home
}

function baseEnv(home: string): Record<string, string> {
  return {
    MERCURY_CONFIG_DIR: home,
    MERCURY_DAEMON_DIR: join(home, 'daemon'),
    MERCURY_TEAMS_DIR: join(home, 'teams'),
    MERCURY_TABULA_DIR: join(home, 'tabula'),
    MERCURY_LIVE_GLYPHS: '0',
    MERCURY_CRITTER_GAZE: '0',
    OPENAI_API_KEY: '',
  }
}

console.log('============================================================')
console.log(' engines setup journey (real PTY, hermetic)')
console.log('============================================================')

{
  const home = seedHome()
  const env = baseEnv(home)
  const { text, flat, sends, receipts, marks } = capture(
    {
      cols: 80,
      rows: 44,
      total: 200,
      argv: ['node', DIST],
      sends: [
        { data: '\r', atTick: 999, awaitText: '↵ start', requireAwait: true, minTick: 8, awaitSettleTicks: 3 },
        { data: '/router key\r', atTick: 999, awaitText: '? for shortcuts', requireAwait: true, minTick: 2, awaitSettleTicks: 3 },
        { data: KEY, atTick: 999, awaitText: 'Z.AI API key', requireAwait: true, minTick: 2, awaitSettleTicks: 2 },
        { data: '\r', afterPrevTicks: 4 },
        { data: '/router engines\r', atTick: 999, awaitText: 'Z.AI API key stored', requireAwait: true, minTick: 2, awaitSettleTicks: 3, mark: 'receipt' },
        { data: 'Q', atTick: 999, awaitText: 'every provider lane beside the home lane', requireAwait: true, minTick: 2, awaitSettleTicks: 3, mark: 'report' },
      ],
      readyText: ['every provider lane beside the home lane'],
      stableTicks: 6,
    },
    env,
  )
  console.log('\nsetup journey — default-on engines')
  check('first paint unregressed: every send became due (the composer painted its placeholder)', sends > 0 && receipts === sends)
  check('save receipt names the auth-scoped path', (marks.receipt ?? '').includes('Z.AI API key stored (auth-scoped, mode 600)'), (marks.receipt ?? '(no receipt frame)').slice(0, 200))
  check('the key VALUE never survives to the final grid', !text.includes(KEY))
  const report = marks.report ?? ''
  const reportFlat = report.replace(/\s+/g, ' ')
  check('engines receipt: the default-on header line', reportFlat.includes('engines — every provider lane beside the home lane'), report ? '' : '(no report frame)')
  check('zai AVAILABLE from the stored key (credential present, auth-scoped)', reportFlat.includes('zai: available (credential present)') && reportFlat.includes('Z.AI API key (stored, auth-scoped)'))
  check(
    'openai reports the DETERMINISTIC no-account code (native lane)',
    report.includes('no-account:openai'),
  )
  check(
    "openai row carries the native transport + official pins",
    report.includes('openai-responses'),
  )
  check('seats-stay-Anthropic line present', report.includes('party') && report.includes('seats stay Anthropic'))
  check('FIRST-KEY-KEPT: the post-receipt keypress landed in the composer', /❯ *Q/.test(text))

  const secretsPath = join(home, '.provider-secrets.json')
  check('stored file exists under the scratch auth scope', existsSync(secretsPath))
  if (existsSync(secretsPath)) {
    check('stored file mode 600', (statSync(secretsPath).mode & 0o777) === 0o600, (statSync(secretsPath).mode & 0o777).toString(8))
    check('stored file holds the key (round-trip)', readFileSync(secretsPath, 'utf8').includes(KEY))
  }
  if (failures > 0) {
    console.log('\n── the report frame (mark) ──')
    console.log(report ? report.slice(0, 1200) : '(no report frame)')
    console.log('\n── the final grid ──')
    for (const row of text.split('\n')) console.log(`│ ${row}`)
  }
}

console.log('\n' + '═'.repeat(76))
if (failures === 0) console.log('ENGINES JOURNEY GREEN')
else console.log(`${failures} ENGINES JOURNEY CHECK(S) FAILED`)
console.log('═'.repeat(76))
process.exit(failures === 0 ? 0 : 1)
