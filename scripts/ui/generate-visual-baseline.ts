#!/usr/bin/env bun
// scripts/ui/generate-visual-baseline.ts — generate/verify the real-binary
// visual baseline. The matrix below is the RATIFIED v1 coverage;
// what it does not yet cover is named in manifest.descoped — never implied.
//
//   bun run scripts/ui/generate-visual-baseline.ts            # full v1 matrix
//   bun run scripts/ui/generate-visual-baseline.ts --only frame--120
//   bun run scripts/ui/generate-visual-baseline.ts --check    # re-capture + first-divergence
//   bun run scripts/ui/generate-visual-baseline.ts --redigest # recompute masks+digests from stored grids (no PTY)
//   bun run scripts/ui/generate-visual-baseline.ts --list
//
// Requires a fresh dist (bun run build.ts) — the manifest records the exact
// buildTree that painted every grid. Serialized by the machine-wide vshot
// slot semaphore; do not run beside a pooled gate.
//
// HERMETICITY (the §2.F class): captures never ride the operator's real
// ~/.claude. This process owns ONE scratch config home for its whole run —
// pinned into MERCURY_CONFIG_DIR *before* renderScenarios is imported (its
// CONFIG_HOME is a module-load snapshot), reseeded per entry (theme + motion +
// onboarding + project trust), and deleted at exit.
import { execSync, spawnSync } from 'node:child_process'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { resolveCaptureDriver, vshotBudgetMs } from '../lib/captureDriver.ts'

// W6-C: one resolved interpreter for every capture in this run — the
// baseline generator is a POSIX-PTY consumer; any other driver refuses.
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
  VisualBaselineEntry, VisualManifest, compactGrid, entryId, firstDivergence,
  gridDigest, readManifest, readStoredGrid, styleDigest, StoredGrid,
} from './visualBaseline.ts'

const REPO = join(import.meta.dir, '..', '..')
const RUN_HOME = join(tmpdir(), `mercury-vbl-${process.pid}`)

const SIZES: Array<[number, number]> = [
  // HZ0 widened the ratified v1 set with the breakpoint NEIGHBORS
  // (99/101 around the 100-col cockpit gate, 151 beside the 150 dual-rail
  // gate) — boundary sizes are named review points, so the baseline must
  // pin the tier on BOTH sides of each threshold, not just the threshold.
  [60, 18], [80, 24], [97, 30], [99, 30], [100, 30], [101, 30], [120, 40],
  [149, 40], [150, 40], [151, 40], [160, 50],
]
const CORE_AT_EVERY_SIZE = ['frame', 'resume-2turn']
// `diff` and `health` are EXCLUDED from v1: both surfaces read the LIVE repo
// (git diff HEAD file lists; the health report's commit/age/verdict probes) —
// unmaskable whole-grid nondeterminism. They join the manifest on the
// owned-fixture-repo follow-up; their own suites
// (scripts/diffws, scripts/health) cover them behaviorally today.
const WIDE_BOARDS = ['cockpit-wide', 'sessions', 'help', 'tool-cards']
const THEME_FAMILIES = ['light', 'light-daltonized', 'dark-daltonized', 'light-ansi', 'dark-ansi']
const THEME_SCREENS = ['frame', 'resume-2turn', 'sessions']

export function matrix(): CaptureSpec[] {
  const specs: CaptureSpec[] = []
  // 1. The default dark journey at EVERY size (§3: every size gets the dark journey).
  for (const [cols, rows] of SIZES) {
    for (const s of CORE_AT_EVERY_SIZE) {
      specs.push({ scenario: s, cols, rows, theme: 'dark', colorMode: 'truecolor', motion: 'full' })
    }
  }
  // 2. The board/workspace estate at the canonical wide size.
  for (const s of WIDE_BOARDS) {
    specs.push({ scenario: s, cols: 120, rows: 40, theme: 'dark', colorMode: 'truecolor', motion: 'full' })
  }
  // 3. Every non-default theme family over the core journey (§3: every family
  //    gets home/transcript/board/diff).
  for (const theme of THEME_FAMILIES) {
    for (const s of THEME_SCREENS) {
      specs.push({ scenario: s, cols: 120, rows: 40, theme, colorMode: 'truecolor', motion: 'full' })
    }
  }
  // 4. Constrained color modes over home + transcript.
  for (const colorMode of ['256', 'ansi', 'none'] as const) {
    for (const s of CORE_AT_EVERY_SIZE) {
      specs.push({ scenario: s, cols: 120, rows: 40, theme: 'dark', colorMode, motion: 'full' })
    }
  }
  // 5. Reduced motion (frame-0 static grid must equal the pinned-glyph form).
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
      // The binary's own default path (MERCURY_TRUECOLOR default-ON boosts
      // chalk 2→3 in a PTY) — matches every earlier capture's env exactly.
      return {}
    case '256':
      return { MERCURY_TRUECOLOR: '0', FORCE_COLOR: '2' }
    case 'ansi':
      return { MERCURY_TRUECOLOR: '0', FORCE_COLOR: '1' }
    case 'none':
      return { MERCURY_TRUECOLOR: '0', NO_COLOR: '1', FORCE_COLOR: '0' }
  }
}

// Reseed the run home for one entry: onboarding done, THIS repo trusted, the
// requested theme; settings.json carries the motion posture.
function seedRunHome(spec: CaptureSpec): void {
  mkdirSync(RUN_HOME, { recursive: true })
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
  writeFileSync(cfgPath, JSON.stringify({ ...cfg, out: gridPath }))
  try {
    let lastReason = 'capture never ran'
    for (let attempt = 1; attempt <= 2; attempt++) {
      // W6-C: interpreter from the ONE capture-driver contract (the
      // POSIX PTY engine — this generator is a posix-pty consumer).
      const res = spawnSync(baselineDriverPython(), [join(import.meta.dir, 'vshot.py'), cfgPath], {
        encoding: 'utf-8',
        timeout: vshotBudgetMs(90_000),
        env: {
          ...process.env,
          MERCURY_CONFIG_DIR: RUN_HOME,
          // The away-summary recap card sizes to its LIVE git/health row — a
          // content-sized box whose border moves with the operator's tree
          // state (no mask can hide moved borders on neighbor rows). Pinned
          // OFF for baseline captures (the established capture-pin pattern);
          // it rejoins on the owned fixture repo (the owned-fixture-repo follow-up).
          MERCURY_AWAY_SUMMARY: '0',
          // Deterministic terminal-theme guess (proof hygiene: environment
          // pinned per invocation): the adaptive tokens race the async
          // OSC 11 background reply — a light capture sometimes settled on
          // the dark first-paint value (the 71807b/666666 flap). COLORFGBG
          // resolves the guess SYNCHRONOUSLY at boot, per the spec's theme.
          COLORFGBG: spec.theme.startsWith('light') ? '0;15' : '15;0',
          // The CONFIG theme has the same two-phase boot: the first paint can
          // resolve before the config latch serves the seeded theme, so an
          // overlay family (light-daltonized) sometimes captured the plain
          // family's semantic inks (the 2c7a39/006699 seat-dot flap under a
          // loaded regen sweep). MERCURY_THEME_PIN is the owned render-matrix
          // seam (ThemeProvider resolves it synchronously at first render) —
          // the same pin prove-spectral-depth drives the families with.
          MERCURY_THEME_PIN: spec.theme,
          // The composer's newline hint keys on the terminal IDENTITY (a
          // listed terminal ⇒ 'shift + ↵ for a new line'; unknown ⇒ the
          // backslash fallback). The ambient TERM_PROGRAM leaked into the
          // captures — a darwin box under a listed terminal froze 'shift + ↵'
          // while a runner with no TERM_PROGRAM painted the fallback — so the
          // identity is pinned to one listed terminal on every host.
          TERM_PROGRAM: 'kitty',
          ...colorModeEnv(spec.colorMode),
        },
      })
      if (res.status !== 0) {
        lastReason = res.stderr || `vshot failed (status ${res.status ?? 'timeout'})`
        continue
      }
      const raw = JSON.parse(readFileSync(gridPath, 'utf8')) as RawGrid
      const verdict = mods.oracle.evaluateCapture(raw, cfg.chromeMarkers)
      if (!verdict.ok && spec.colorMode !== 'none') {
        // no-color captures may legitimately miss color-carried chrome markers;
        // text markers still guard those. Other modes hold the strict oracle.
        lastReason = verdict.reason
        continue
      }
      return { grid: compactGrid(raw), plainText: res.stdout }
    }
    throw new Error(`[${entryId(spec)}] capture rejected: ${lastReason}`)
  } finally {
    mods.scenarios.cleanupScenario(spec.scenario)
  }
}

function currentShas(): { sourceSha: string; buildDigest: string } {
  // the src tree object, not a commit: a tree is content-addressed, so the
  // same sources name the same object in any clone, whatever its history
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

  // --redigest: masks changed → recompute every entry's masks+digests from its
  // STORED grid (grids hold real cells; digests are derived). No PTY, no
  // recapture — keeps one uniform mask vocabulary across the manifest.
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

  // Pin the run home BEFORE renderScenarios computes its module-load
  // CONFIG_HOME — the fixture writer and the dist child must resolve ONE home.
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
    // A FULL run is authoritative — the manifest becomes exactly this run's
    // entries. Prior entries merge in only under --only (incremental refresh).
    const prior = only ? readManifest() : null
    const entries = new Map<string, VisualBaselineEntry>(
      (prior?.entries ?? []).map(e => [e.id, e]),
    )
    let generated = 0
    let failedGen = 0
    for (const spec of specs) {
      const id = entryId(spec)
      const masks = spec.masks ?? DEFAULT_MASKS
      try {
        const { grid } = captureSpec({ ...spec, masks }, mods)
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
        console.log(`✗ ${id} — ${String(err)}`)
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
    writeFileSync(MANIFEST_PATH, JSON.stringify(manifest, null, 2))
    console.log(`\n${failedGen === 0 ? '✅' : '❌'} ${generated} generated, ${failedGen} failed → ${MANIFEST_PATH}`)
    return failedGen === 0 ? 0 : 1
  } finally {
    rmSync(RUN_HOME, { recursive: true, force: true })
  }
}

process.exit(await main())
