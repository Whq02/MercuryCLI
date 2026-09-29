#!/usr/bin/env bun
import { execFile } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { vshotBudgetMs } from '../lib/captureDriver.ts'
import { FIRST_WARNING_PCT } from '../../src/services/providers/usageTiers.ts'

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}

const ROOT = join(import.meta.dir, '..', '..')
const DIST = join(ROOT, 'dist', 'mercury.mjs')
const VSHOT = join(ROOT, 'scripts', 'ui', 'vshot.py')
if (!existsSync(DIST)) {
  console.log('  [SKIP] dist/mercury.mjs absent — build first (the gate prebuilds)')
  process.exit(0)
}
const SHOT_DIR = process.env.MOCK_LIMITS_SHOT_DIR
if (SHOT_DIR) mkdirSync(SHOT_DIR, { recursive: true })

type Send = {
  data: string
  atTick?: number
  minTick?: number
  awaitText?: string
  awaitSettleTicks?: number
  awaitStableTicks?: number
  requireAwait?: boolean
  mark?: string
}

interface CaptureResult {
  text: string
  sends: number
  receipts: number
  marks: Record<string, string>
}

async function capture(tag: string, cfg: Record<string, unknown>, env: Record<string, string>): Promise<CaptureResult> {
  const dir = mkdtempSync(join(tmpdir(), `mock-limits-shot-${tag}-`))
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
  for (const m of payload.marks ?? []) marks[m.label] = gridText(m.grid)
  if (SHOT_DIR) {
    copyFileSync(outPath, join(SHOT_DIR, `${tag}.grid.json`))
    for (const [label, frame] of Object.entries(marks)) writeFileSync(join(SHOT_DIR, `${tag}.${label}.txt`), frame)
    writeFileSync(join(SHOT_DIR, `${tag}.final.txt`), text)
  }
  return {
    text,
    marks,
    sends: Array.isArray(cfg.sends) ? (cfg.sends as unknown[]).length : 0,
    receipts: Array.isArray(payload.sendReceipts) ? payload.sendReceipts.length : 0,
  }
}

function seedHome(model: string): { home: string; workspace: string } {
  const home = mkdtempSync(join(realpathSync(tmpdir()), 'mock-limits-per-model-home-'))
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
  writeFileSync(join(home, 'settings.json'), JSON.stringify({ model }))
  writeFileSync(
    join(home, '.credentials.json'),
    JSON.stringify({
      claudeAiOauth: {
        accessToken: 'fixture-access-token',
        refreshToken: 'fixture-refresh-token',
        expiresAt: Date.now() + 7 * 24 * 3600 * 1000,
        scopes: ['user:inference', 'user:profile'],
        subscriptionType: 'max',
      },
    }),
  )
  return { home, workspace }
}

function baseEnv(home: string): Record<string, string> {
  return {
    MERCURY_CONFIG_DIR: home,
    MERCURY_DAEMON_DIR: join(home, 'daemon'),
    MERCURY_CREWS_DIR: join(home, 'crews'),
    MERCURY_CREDENTIAL_STORE: 'file',
    MERCURY_LOCAL_PROBE_TARGETS: 'none',
    MERCURY_LIVE_GLYPHS: '0',
    MERCURY_LIVE_CLOCK: '0',
    MERCURY_CRITTER_GAZE: '0',
    MERCURY_CRITTER_IDLE: '0',
    MERCURY_CRITTER_SLEEP: '0',
    MERCURY_OPERATOR: 'sam',
    ANTHROPIC_BASE_URL: 'http://127.0.0.1:9',
    MERCURY_CUSTOM_OAUTH_URL: 'http://127.0.0.1:9',
    BROWSER: 'true',
    ANTHROPIC_API_KEY: '',
    OPENAI_API_KEY: '',
    OPENROUTER_API_KEY: '',
    MERCURY_MOCK_LIMITS: '1',
    MERCURY_MOCK_USAGE_PAYLOAD: '',
  }
}

const FACE_THEN_COMPOSER: Send[] = [
  { data: '\r', atTick: 999, awaitText: 'New Session', requireAwait: true, minTick: 8, awaitSettleTicks: 4, awaitStableTicks: 3 },
]

const LEGS = [
  { tag: 'opus', model: 'claude-opus-5-5', scenario: 'opus-warning', words: 'of the Opus limit used', foreign: ['of the Sonnet limit used', 'of the weekly limit used'] },
  { tag: 'sonnet', model: 'claude-sonnet-5', scenario: 'sonnet-warning', words: 'of the Sonnet limit used', foreign: ['of the Opus limit used', 'of the weekly limit used'] },
] as const

console.log('============================================================')
console.log(' per-model warning scenarios — each seat renders its own pool\'s words on the built TUI')
console.log('============================================================')

const RED = 'RED WHERE THE PER-MODEL SCENARIO PAINTS NO STRIP'

for (const leg of LEGS) {
  const { home, workspace } = seedHome(leg.model)
  let result: CaptureResult | null = null
  let refusal = ''
  try {
    result = await capture(
      leg.tag,
      {
        cols: 120,
        rows: 40,
        total: 220,
        argv: ['node', DIST],
        cwd: workspace,
        sends: [
          ...FACE_THEN_COMPOSER,
          { data: `/mock-limits ${leg.scenario}\r`, atTick: 999, awaitText: 'ready · ', requireAwait: true, minTick: 2, awaitSettleTicks: 3 },
          { data: '', atTick: 999, awaitText: leg.words, requireAwait: true, minTick: 2, awaitSettleTicks: 2, mark: 'warning' },
        ],
        readyText: ['? for shortcuts'],
        stableTicks: 4,
      },
      baseEnv(home),
    )
  } catch (error) {
    const lines = String(error).split('\n')
    refusal = lines.find(l => l.includes('UNDELIVERED-SENDS')) ?? lines[0] ?? ''
  }
  console.log(`\nthe ${leg.tag} seat (${leg.model}) · /mock-limits ${leg.scenario}`)
  check(`${RED}: every send became due — the strip painted "${leg.words}" after the scenario armed`, result !== null && result.sends > 0 && result.receipts === result.sends, refusal.slice(0, 240) || `${result?.receipts ?? 0}/${result?.sends ?? 0}`)
  const warning = result?.marks.warning ?? ''
  const rows = warning.split('\n').filter(l => /limit used/.test(l))
  check(`the strip names the seat's OWN pool at the first tier — "${FIRST_WARNING_PCT}% ${leg.words}"`, new RegExp(`${FIRST_WARNING_PCT}% ${leg.words}`).test(warning), rows.join(' | ') || '(no warning frame)')
  check('…and no other pool\'s words nor the shared weekly words', leg.foreign.every(f => !warning.includes(f)), rows.join(' | '))
}

console.log(failures === 0 ? '\n✅ prove-mock-limits-per-model-captures — all checks pass' : '\n❌ prove-mock-limits-per-model-captures — check(s) failed')
process.exit(failures === 0 ? 0 : 1)
