#!/usr/bin/env bun
// ============================================================================
//  prove-surface-crash-capture — A5's DRIVEN half: the surface crash card,
//  CAPTURED on the real artifact (the gate wants the card seen, not
//  assumed from source).
//
//  The arm: MERCURY_FAULT_INJECT_SURFACE=boot-settings (the registry row's
//  drive-only seam) — a plain interactive boot lands on the Boot face,
//  whose entry THROWS as the boundary's first child. The REAL
//  SurfaceErrorBoundary must:
//    · paint the honest card ("this screen (boot-settings) could not be
//      painted — everything beneath it is untouched") with the report
//      pointer and the true moves (the exit chord's one sentence);
//    · persist a 'surface'-origin crash report carrying B20's identity
//      fields (version · platform · surface — the two arms compose);
//    · leave the exit chord LIVE — ctrl+c ctrl+c closes Mercury cleanly
//      from the crashed screen (the recovery affordance is real).
//
//  PTY-classed suite: this drives vshot like its siblings; ~25s wall.
//  Run: ~/.bun/bin/bun run scripts/render-continuity/prove-surface-crash-capture.ts
// ============================================================================
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
const check = (label: string, cond: boolean, detail = ''): void => {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}

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
// The exit chord's byte, composed — never a raw control literal in source.
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
      // The card must stand before anything else is judged; the frame the
      // FIRST exit press lands on is the marked card.
      { atTick: 999, awaitText: 'could not be painted', minTick: 4, awaitSettleTicks: 2, data: CTRL_C, mark: 'card' },
      // The second press inside the chord window CLOSES Mercury — the
      // recovery affordance driven, not assumed. It is the LAST send on
      // purpose: the child exits on it, so a later send would sit
      // undelivered and vshot would (rightly) refuse the journey.
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
  ANTHROPIC_API_KEY: 'fixture-key-000',
  ANTHROPIC_BASE_URL: 'http://127.0.0.1:9',
}
const res = spawnSync('/usr/bin/python3', [VSHOT, cfgPath], { encoding: 'utf8', timeout: vshotBudgetMs(180_000), env })
check('the drive ran (vshot exit 0)', res.status === 0, (res.stderr ?? '').slice(-400))

const payload = JSON.parse(readFileSync(out, 'utf8')) as Grid
const markedLines = new Map<string, string[]>()
for (const m of payload.marks ?? []) markedLines.set(m.label, linesOf(m))
for (const [label, lines] of markedLines) {
  writeFileSync(join(OUT_DIR, `surface-crash-mark-${label}.txt`), lines.join('\n') + '\n')
}
const card = markedLines.get('card') ?? []
const text = card.join('\n')
check('the card names the screen and the containment', text.includes('this screen (boot-settings) could not be painted') && text.includes('everything beneath it is untouched'), card.find(l => l.includes('could not'))?.trim() ?? '(no card line)')
check('the card points at the report archive', text.includes('crash report:'))
check("the card's moves carry the exit chord's one sentence", text.includes('press ctrl+c twice to close Mercury'))

// The persisted report: origin 'surface', B20's identity riding it.
{
  const dir = join(scratch, 'crashes')
  const names = existsSync(dir) ? readdirSync(dir).filter(f => f.includes('-surface.json')) : []
  check("a 'surface'-origin crash report persisted", names.length >= 1, existsSync(dir) ? readdirSync(dir).join(',') : '(no crashes dir)')
  if (names.length >= 1) {
    const record = JSON.parse(readFileSync(join(dir, names[names.length - 1]!), 'utf8')) as Record<string, unknown>
    check('…naming the injection', String(record.message).includes("fault injection: surface 'boot-settings'"), String(record.message))
    check('…with B20 identity riding (version · platform · surface)', typeof record.version === 'string' && typeof record.platform === 'string' && 'surface' in record, JSON.stringify({ version: record.version, platform: record.platform, surface: record.surface }))
  }
}
console.log(`  captures kept: ${OUT_DIR}`)

rmSync(scratch, { recursive: true, force: true })
console.log(failures === 0 ? '\nprove-surface-crash-capture: ALL LAWS HOLD' : `\nprove-surface-crash-capture: ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
