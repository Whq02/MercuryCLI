#!/usr/bin/env bun
import { execSync, spawnSync } from 'node:child_process'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { resolveCaptureDriver, vshotBudgetMs, vshotBudgetScale } from '../lib/captureDriver.ts'
import { seedFirstRun } from '../lib/firstRunSeed.ts'
import { HELM_HOME_MIN_COLS } from '../../src/utils/helmGeometry.ts'
import { DEFAULT_CRITTER_KEY } from '../../src/utils/cockpit/critterData.ts'

function baselineDriverPython(): string {
  const driver = resolveCaptureDriver()
  if (driver.kind !== 'posix-pty') {
    const why = driver.kind === 'unavailable' ? `${driver.reason} — ${driver.remedy}` : `driver '${driver.kind}' cannot run vshot.py`
    console.error(`generate-visual-baseline: ${why}`)
    process.exit(2)
  }
  return driver.python
}
import {
  CaptureSpec, DEFAULT_MASKS, GRIDS_DIR, LIVE_DIR, MANIFEST_PATH, RawGrid,
  VisualBaselineEntry, VisualManifest, canonicalizeCheckoutRows, compactGrid, entryId, firstDivergence,
  gridDigest, readManifest, readStoredGrid, runCaptureAttempts, storedGridStands, styleDigest, StoredGrid,
} from './visualBaseline.ts'

const REPO = join(import.meta.dir, '..', '..')
const RUN_HOME = join(tmpdir(), `mercury-vbl-${process.pid}`)
const RAIL_SCAN_SETTLE_MARK = 'RECENT'
const RAIL_SCAN_LANDED_MARK = '○ '

const SIZES: Array<[number, number]> = [
  [60, 18], [80, 24], [97, 30], [99, 30], [100, 30], [101, 30], [120, 40],
  [149, 40], [150, 40], [151, 40], [160, 50],
]
const CORE_AT_EVERY_SIZE = ['frame', 'resume-2turn']
const WIDE_BOARDS = ['cockpit-wide', 'sessions', 'help', 'tool-cards']
const THEME_FAMILIES = ['light', 'light-daltonized', 'dark-daltonized', 'light-ansi', 'dark-ansi']
const THEME_SCREENS = ['frame', 'resume-2turn', 'sessions']

export function matrix(): CaptureSpec[] {
  const specs: CaptureSpec[] = []
  for (const [cols, rows] of SIZES) {
    for (const s of CORE_AT_EVERY_SIZE) {
      specs.push({ scenario: s, cols, rows, theme: 'dark', colorMode: 'truecolor', motion: 'full' })
    }
  }
  for (const s of WIDE_BOARDS) {
    specs.push({ scenario: s, cols: 120, rows: 40, theme: 'dark', colorMode: 'truecolor', motion: 'full' })
  }
  for (const theme of THEME_FAMILIES) {
    for (const s of THEME_SCREENS) {
      specs.push({ scenario: s, cols: 120, rows: 40, theme, colorMode: 'truecolor', motion: 'full' })
    }
  }
  for (const colorMode of ['256', 'ansi', 'none'] as const) {
    for (const s of CORE_AT_EVERY_SIZE) {
      specs.push({ scenario: s, cols: 120, rows: 40, theme: 'dark', colorMode, motion: 'full' })
    }
  }
  specs.push({ scenario: 'frame', cols: 120, rows: 40, theme: 'dark', colorMode: 'truecolor', motion: 'reduced' })
  return specs
}

const DESCOPED = [
  'mouse on/off: identical static grids — pointer semantics live in the interaction journeys (S4–S6)',
  'provider screens: covered by the agent-dispatch journey provers, not the static baseline',
  'splash + boot menu: separate capture harness (scripts/splash/) — joins the manifest in S14',
  'diff + health: read the LIVE repo (tree diff · commit/age/verdict probes) — join on the owned fixture repo; covered behaviorally by scripts/diffws + scripts/health',
  'the away-summary recap card: content-sized box over the live git/health row — pinned OFF (MERCURY_AWAY_SUMMARY=0) until the owned fixture repo lands',
  'action IDs / hit regions / focus owner per cell: staged on the S4–S6 interaction kernel instrumentation',
  'terminal profiles beyond pyte-xterm: byte/capability profiles staged for S18 (manual emulator checklist)',
  'scenario long-tail (party/tabula/workflows/…): joins per-slice as those surfaces are touched',
]

function colorModeEnv(mode: CaptureSpec['colorMode']): Record<string, string> {
  switch (mode) {
    case 'truecolor':
      return { COLORTERM: 'truecolor' }
    case '256':
      return { MERCURY_TRUECOLOR: '0', FORCE_COLOR: '2' }
    case 'ansi':
      return { MERCURY_TRUECOLOR: '0', FORCE_COLOR: '1' }
    case 'none':
      return { MERCURY_TRUECOLOR: '0', NO_COLOR: '1', FORCE_COLOR: '0' }
  }
}

function seedRunHome(spec: CaptureSpec): void {
  rmSync(RUN_HOME, { recursive: true, force: true })
  mkdirSync(RUN_HOME, { recursive: true })
  seedFirstRun(RUN_HOME, [REPO])
  writeFileSync(
    join(RUN_HOME, '.claude.json'),
    JSON.stringify({
      hasCompletedOnboarding: true,
      lastOnboardingVersion: '99.0.0',
      numStartups: 10,
      theme: spec.theme,
      projects: { [REPO]: { hasTrustDialogAccepted: true } },
      ...(process.env.ANTHROPIC_API_KEY
        ? { customApiKeyResponses: { approved: [process.env.ANTHROPIC_API_KEY.slice(-20)], rejected: [] } }
        : {}),
    }),
  )
  writeFileSync(
    join(RUN_HOME, 'settings.json'),
    JSON.stringify(spec.motion === 'reduced' ? { prefersReducedMotion: true } : {}),
  )
}

interface ScenarioModule {
  scenario: (name: string, cols: number, rows: number) => {
    argv: string[]
    sends: unknown[]
    total: number
    cols: number
    rows: number
    chromeMarkers?: string[]
  }
  cleanupScenario: (name: string) => void
}
interface OracleModule {
  evaluateCapture: (grid: RawGrid, markers?: string[]) => { ok: boolean; reason: string }
}

function captureSpec(
  spec: CaptureSpec,
  mods: { scenarios: ScenarioModule; oracle: OracleModule },
): { grid: StoredGrid; plainText: string } {
  seedRunHome(spec)
  const cfg = mods.scenarios.scenario(spec.scenario, spec.cols, spec.rows)
  const gridPath = join(RUN_HOME, 'capture-grid.json')
  const cfgPath = join(RUN_HOME, 'capture-cfg.json')
  const railSettle = spec.cols >= HELM_HOME_MIN_COLS ? { readyText: [RAIL_SCAN_SETTLE_MARK, RAIL_SCAN_LANDED_MARK], stableTicks: 8 } : {}
  writeFileSync(cfgPath, JSON.stringify({ ...cfg, ...railSettle, out: gridPath }))
  const judge = (raw: RawGrid): { ok: boolean; reason: string } =>
    spec.colorMode === 'none' ? { ok: true, reason: '' } : mods.oracle.evaluateCapture(raw, cfg.chromeMarkers)
  try {
    const { grid, stdout } = runCaptureAttempts(entryId(spec), (_attempt, budgetScale) => {
      const scaled = { ...process.env, MERCURY_VSHOT_BUDGET_SCALE: String(budgetScale) }
      const res = spawnSync(baselineDriverPython(), [join(import.meta.dir, 'vshot.py'), cfgPath], {
        encoding: 'utf-8',
        timeout: vshotBudgetMs(90_000, scaled),
        env: {
          ...scaled,
          MERCURY_CONFIG_DIR: RUN_HOME,
          MERCURY_AWAY_SUMMARY: '0',
          COLORFGBG: spec.theme.startsWith('light') ? '0;15' : '15;0',
          MERCURY_THEME_PIN: spec.theme,
          TERM_PROGRAM: 'kitty',
          MERCURY_CRITTER: DEFAULT_CRITTER_KEY,
          ...colorModeEnv(spec.colorMode),
        },
      })
      if (res.status !== 0) return { status: res.status, stderr: res.stderr, stdout: res.stdout }
      return { status: 0, stderr: res.stderr, stdout: res.stdout, grid: JSON.parse(readFileSync(gridPath, 'utf8')) as RawGrid }
    }, judge, { baseScale: vshotBudgetScale(), log: line => console.log(line) })
    return { grid: canonicalizeCheckoutRows(compactGrid(grid), recordingCheckout()), plainText: stdout }
  } finally {
    mods.scenarios.cleanupScenario(spec.scenario)
  }
}

function recordingCheckout(): { basename: string; branch: string } {
  let branch = 'HEAD'
  try {
    branch = execSync('git rev-parse --abbrev-ref HEAD', { cwd: REPO, encoding: 'utf8' }).trim() || 'HEAD'
  } catch {
  }
  return { basename: basename(REPO), branch }
}

function currentShas(): { sourceSha: string; buildDigest: string } {
  const sourceSha = execSync('git rev-parse HEAD:src', { cwd: REPO, encoding: 'utf8' }).trim()
  const dist = JSON.parse(readFileSync(join(REPO, 'dist', 'manifest.json'), 'utf8')) as { buildTree: string }
  return { sourceSha, buildDigest: dist.buildTree }
}

async function main(): Promise<number> {
  const argv = process.argv.slice(2)
  const only = argv.includes('--only') ? argv[argv.indexOf('--only') + 1] : ''
  const check = argv.includes('--check')
  const list = argv.includes('--list')

  let specs = matrix()
  if (only) specs = specs.filter(s => entryId(s).includes(only))
  if (list) {
    for (const s of specs) console.log(entryId(s))
    console.log(`${specs.length} entries`)
    return 0
  }

  if (argv.includes('--redigest')) {
    const manifest = readManifest()
    if (!manifest) { console.error('no manifest — generate first'); return 1 }
    for (const e of manifest.entries) {
      const grid = readStoredGrid(e)
      e.masks = DEFAULT_MASKS
      e.gridDigest = gridDigest(grid, e.masks)
      e.styleDigest = styleDigest(grid, e.masks)
    }
    writeFileSync(MANIFEST_PATH, JSON.stringify(manifest, null, 2))
    console.log(`✅ re-digested ${manifest.entries.length} entries with the current mask set`)
    return 0
  }

  rmSync(RUN_HOME, { recursive: true, force: true })
  mkdirSync(RUN_HOME, { recursive: true })
  process.env.MERCURY_CONFIG_DIR = RUN_HOME
  const scenarios = (await import('./renderScenarios.ts')) as unknown as ScenarioModule
  const oracle = (await import('./renderOracle.ts')) as unknown as OracleModule
  const mods = { scenarios, oracle }

  try {
    const { sourceSha, buildDigest } = currentShas()

    if (check) {
      const manifest = readManifest()
      if (!manifest) { console.error('no manifest — generate first'); return 1 }
      let failed = 0
      const targets = manifest.entries.filter(e => !only || e.id.includes(only))
      for (const e of targets) {
        const spec: CaptureSpec = {
          scenario: e.scenario, cols: e.cols, rows: e.rows,
          theme: e.theme, colorMode: e.colorMode, motion: e.motion, masks: e.masks,
        }
        try {
          const { grid } = captureSpec(spec, mods)
          const stored = readStoredGrid(e)
          const div = firstDivergence(stored, grid, e.masks)
          if (div) {
            failed++
            console.log(`✗ ${e.id} — first divergence at row ${div.row} col ${div.col} (${div.kind})`)
            console.log(`    baseline: ${div.old}   fresh: ${div.new}`)
            console.log(`    baseline row: ${JSON.stringify(div.oldRow.trimEnd())}`)
            console.log(`    fresh row:    ${JSON.stringify(div.newRow.trimEnd())}`)
          } else {
            console.log(`✓ ${e.id}`)
          }
        } catch (err) {
          failed++
          console.log(`✗ ${e.id} — ${String(err)}`)
        }
      }
      console.log(failed === 0 ? `\n✅ ${targets.length} entries match the baseline` : `\n❌ ${failed}/${targets.length} diverged`)
      return failed === 0 ? 0 : 1
    }

    mkdirSync(GRIDS_DIR, { recursive: true })
    const held = readManifest()
    const heldById = new Map<string, VisualBaselineEntry>((held?.entries ?? []).map(e => [e.id, e]))
    const prior = only ? held : null
    const entries = new Map<string, VisualBaselineEntry>(
      (prior?.entries ?? []).map(e => [e.id, e]),
    )
    const storedGridOf = (entry: VisualBaselineEntry): StoredGrid | null => {
      try {
        return readStoredGrid(entry)
      } catch {
        return null
      }
    }
    let generated = 0
    let kept = 0
    let failedGen = 0
    for (const spec of specs) {
      const id = entryId(spec)
      const masks = spec.masks ?? DEFAULT_MASKS
      const before = heldById.get(id)
      try {
        const { grid } = captureSpec({ ...spec, masks }, mods)
        if (before !== undefined && JSON.stringify(before.masks) === JSON.stringify(masks) && storedGridStands(storedGridOf(before), grid, masks)) {
          entries.set(id, before)
          kept++
          console.log(`= ${id} — unchanged, the stored grid stands`)
          continue
        }
        const gridPath = `grids/${id}.grid.json`
        writeFileSync(join(LIVE_DIR, gridPath), JSON.stringify(grid))
        entries.set(id, {
          id, sourceSha, buildDigest,
          scenario: spec.scenario, cols: spec.cols, rows: spec.rows,
          theme: spec.theme, colorMode: spec.colorMode, motion: spec.motion,
          mouse: 'on', stateFixture: spec.scenario, terminalProfile: 'pyte-xterm',
          gridPath, gridDigest: gridDigest(grid, masks), styleDigest: styleDigest(grid, masks),
          masks, generatedAt: new Date().toISOString(),
        })
        generated++
        console.log(`✓ ${id}`)
      } catch (err) {
        failedGen++
        if (before !== undefined) entries.set(id, before)
        console.log(`✗ ${id} — ${String(err)}${before !== undefined ? ' (the stored grid stands)' : ''}`)
      }
    }
    const manifest: VisualManifest = {
      schema: 1,
      generator: 'scripts/ui/generate-visual-baseline.ts',
      sourceSha, buildDigest,
      generatedAt: new Date().toISOString(),
      descoped: DESCOPED,
      entries: [...entries.values()].sort((a, b) => a.id.localeCompare(b.id)),
    }
    const stands =
      held !== null && generated === 0 && failedGen === 0 && held.sourceSha === sourceSha && held.buildDigest === buildDigest &&
      JSON.stringify(held.entries.map(e => e.id)) === JSON.stringify(manifest.entries.map(e => e.id))
    if (stands) {
      console.log(`\n✅ ${kept} unchanged, nothing rewritten → ${MANIFEST_PATH} stands`)
      return 0
    }
    writeFileSync(MANIFEST_PATH, JSON.stringify(manifest, null, 2))
    console.log(`\n${failedGen === 0 ? '✅' : '❌'} ${generated} generated, ${kept} unchanged, ${failedGen} failed → ${MANIFEST_PATH}`)
    return failedGen === 0 ? 0 : 1
  } finally {
    rmSync(RUN_HOME, { recursive: true, force: true })
  }
}

process.exit(await main())
