#!/usr/bin/env bun
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { vshotBudgetMs } from '../lib/captureDriver.ts'

const REPO = join(import.meta.dir, '..', '..')
const BIN = join(REPO, 'dist', 'mercury.mjs')
const VSHOT = join(REPO, 'scripts', 'ui', 'vshot.py')
if (!existsSync(BIN)) {
  console.error('✗ dist/mercury.mjs missing — run `bun run build.ts` first')
  process.exit(1)
}

let failures = 0
const check = (label: string, cond: boolean, detail = '', hint = ''): void => {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}${!cond && hint ? ` | fix: ${hint}` : ''}`)
}
const cardFix = 'change SurfaceCrashCard in src/screen/routes/SurfaceRouter.tsx, which paints the card; its fault is injected by SurfaceFaultInjection when MERCURY_FAULT_INJECT_SURFACE names the screen; the card text is in the marked capture file under the captures folder printed below'
const reportFix = 'change persistCrashReport in src/platform/logs/crashReport.ts (it writes crash-<time>-surface.json under the config home crashes folder; SurfaceRouter.tsx calls it with origin surface)'

const { seedFirstRun } = await import('../lib/firstRunSeed.ts')

const scratch = join(tmpdir(), `surface-crash-${process.pid}`)
rmSync(scratch, { recursive: true, force: true })
seedFirstRun(scratch, [REPO])

const OUT_DIR = process.env.SURFACE_CRASH_CAPTURE_DIR ?? join(tmpdir(), `surface-crash-captures-${process.pid}`)
mkdirSync(OUT_DIR, { recursive: true })

type Grid = { grid: { c: string }[][]; marks?: ({ label: string } & { grid: { c: string }[][] })[] }
const linesOf = (g: { grid: { c: string }[][] }): string[] => g.grid.map(r => r.map(c => c.c || ' ').join(''))

const out = join(OUT_DIR, 'surface-crash-120x40.json')
const cfgPath = join(scratch, 'capture-cfg.json')
const CTRL_C = String.fromCharCode(3)
writeFileSync(
  cfgPath,
  JSON.stringify({
    argv: ['node', BIN],
    cwd: REPO,
    cols: 120,
    rows: 40,
    out,
    total: 34,
    sends: [
      { atTick: 999, awaitText: 'could not be painted', minTick: 4, awaitSettleTicks: 2, data: CTRL_C, mark: 'card' },
      { afterPrevTicks: 4, data: CTRL_C, mark: 'armed' },
    ],
  }),
)
const env: Record<string, string> = {
  ...(process.env as Record<string, string>),
  MERCURY_CONFIG_DIR: scratch,
  MERCURY_HOME: '',
  MERCURY_DAEMON_DIR: join(scratch, 'daemon'),
  MERCURY_FAULT_INJECT_SURFACE: 'boot-settings',
  MERCURY_AWAY_SUMMARY: '0',
  MERCURY_CRITTER_IDLE: '0',    MERCURY_CRITTER_GAZE: '0',
  MERCURY_CRITTER_SLEEP: '0',   MERCURY_LIVE_CLOCK: '0',
  MERCURY_LIVE_GLYPHS: '0',
  ANTHROPIC_API_KEY: 'fixture-key-000',
  ANTHROPIC_BASE_URL: 'http://127.0.0.1:9',
}
const res = spawnSync('/usr/bin/python3', [VSHOT, cfgPath], { encoding: 'utf8', timeout: vshotBudgetMs(180_000), env })
check('the drive ran (vshot exit 0)', res.status === 0, (res.stderr ?? '').slice(-400), 'run scripts/ui/vshot.py with the config this test wrote (capture-cfg.json in its scratch folder) and read its stderr; dist/mercury.mjs may be stale, rebuild with bun run build.ts')

const payload = JSON.parse(readFileSync(out, 'utf8')) as Grid
const markedLines = new Map<string, string[]>()
for (const m of payload.marks ?? []) markedLines.set(m.label, linesOf(m))
for (const [label, lines] of markedLines) {
  writeFileSync(join(OUT_DIR, `surface-crash-mark-${label}.txt`), lines.join('\n') + '\n')
}
const card = markedLines.get('card') ?? []
const text = card.join('\n')
check('the card names the screen and the containment', text.includes('this screen (boot-settings) could not be painted') && text.includes('everything beneath it is untouched'), card.find(l => l.includes('could not'))?.trim() ?? '(no card line)', cardFix)
check('the card points at the report archive', text.includes('crash report:'), 'the card lacks the crash report line', cardFix)
check("the card's moves carry the exit chord's one sentence", text.includes('press ctrl+c twice to close Mercury'), 'the card lacks the exit chord sentence', 'SurfaceCrashCard in src/screen/routes/SurfaceRouter.tsx builds its moves line from exitChordNoticeText in src/screen/composer/ExitChordNotice.tsx')

{
  const dir = join(scratch, 'crashes')
  const names = existsSync(dir) ? readdirSync(dir).filter(f => f.includes('-surface.json')) : []
  check("a 'surface'-origin crash report persisted", names.length >= 1, existsSync(dir) ? readdirSync(dir).join(',') : '(no crashes dir)', reportFix)
  if (names.length >= 1) {
    const record = JSON.parse(readFileSync(join(dir, names[names.length - 1]!), 'utf8')) as Record<string, unknown>
    check('…naming the injection', String(record.message).includes("fault injection: surface 'boot-settings'"), String(record.message), 'SurfaceFaultInjection in src/screen/routes/SurfaceRouter.tsx throws this message; ' + reportFix)
    check('…with B20 identity riding (version · platform · surface)', typeof record.version === 'string' && typeof record.platform === 'string' && 'surface' in record, JSON.stringify({ version: record.version, platform: record.platform, surface: record.surface }), 'crashIdentity in src/platform/logs/crashReport.ts supplies version, platform and surface to the report that persistCrashReport writes')
  }
}
console.log(`  captures kept: ${OUT_DIR}`)

rmSync(scratch, { recursive: true, force: true })
console.log(failures === 0 ? '\nprove-surface-crash-capture: ALL LAWS HOLD' : `\nprove-surface-crash-capture: ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
