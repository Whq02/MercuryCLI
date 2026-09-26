#!/usr/bin/env bun
import { execSync, spawnSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join, basename } from 'node:path'
import { resolveCaptureDriver, vshotBudgetScale } from '../lib/captureDriver.ts'
import {
  argValue, claimJob, closeJobsRun, hasRefusals, jobsRunDir, openJobsRun, parseJobs, readJobList, readJobResult,
  refusedDir, runWorkers, timingLine, timingTable, vshotSlotsFor, workerHome, writeJobList, writeJobResult,
  type CaptureTiming, type JobsRun,
} from '../lib/captureJobs.ts'
import { seedFirstRun } from '../lib/firstRunSeed.ts'
import { HELM_BOTH_RAILS_MIN, HELM_HOME_MIN_COLS } from '../../src/utils/helmGeometry.ts'
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
  CaptureSpec, DEFAULT_MASKS, LIVE_DIR, RawGrid, SETTLE_LAW,
  VisualBaselineEntry, VisualManifest, canonicalizeCheckoutRows, cockpitReadyText, compactGrid, entryId, firstDivergence,
  gridDigest, liveDirs, readManifest, readStoredGrid, runCaptureAttempts, settleCaptureConfig, settleNeedles, settleWallMs,
  storedGridStands, styleDigest, StoredGrid,
} from './visualBaseline.ts'

const REPO = join(import.meta.dir, '..', '..')
const SCENE_SETTLE_NEEDLES: Record<string, string[]> = { help: ['/keybindings to customize'] }

const SIZES: Array<[number, number]> = [
  [60, 18], [80, 24], [97, 30], [99, 30], [100, 30], [101, 30], [120, 40],
  [149, 40], [150, 40], [151, 40], [160, 50], [269, 70],
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

function seedRunHome(spec: CaptureSpec, home: string): void {
  rmSync(home, { recursive: true, force: true })
  mkdirSync(home, { recursive: true })
  seedFirstRun(home, [REPO])
  writeFileSync(
    join(home, '.claude.json'),
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
    join(home, 'settings.json'),
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

type CaptureReceipt = RawGrid & {
  readyAt?: number | null
  endedAtTick?: number
  lastOutputTick?: number
  endReason?: string
  sendReceipts?: Array<{ atTick: number; ts: number }>
}

export function needlesSeenAt(receipt: { sendReceipts?: Array<{ atTick: number }> }, sendCount: number): number | null {
  const fired = receipt.sendReceipts ?? []
  return fired.length === sendCount && sendCount > 0 ? fired[sendCount - 1]!.atTick : null
}

export function sceneNeedles(spec: CaptureSpec, cfg: { readyText?: string | string[] }): string[] {
  return settleNeedles(cfg, cockpitReadyText(spec.cols, HELM_HOME_MIN_COLS, HELM_BOTH_RAILS_MIN), SCENE_SETTLE_NEEDLES[spec.scenario] ?? [])
}

function captureSpec(
  spec: CaptureSpec,
  mods: { scenarios: ScenarioModule; oracle: OracleModule },
  home: string,
  run: JobsRun,
  slot: number,
): { grid: StoredGrid; plainText: string; timing: CaptureTiming } {
  seedRunHome(spec, home)
  const id = entryId(spec)
  const cfg = mods.scenarios.scenario(spec.scenario, spec.cols, spec.rows)
  const gridPath = join(home, 'capture-grid.json')
  const cfgPath = join(home, 'capture-cfg.json')
  const needles = sceneNeedles(spec, cfg)
  const settled = settleCaptureConfig({ ...cfg, out: gridPath }, needles, cockpitReadyText(spec.cols, HELM_HOME_MIN_COLS, HELM_BOTH_RAILS_MIN))
  writeFileSync(cfgPath, JSON.stringify(settled))
  const judge = (raw: RawGrid): { ok: boolean; reason: string } =>
    spec.colorMode === 'none' ? { ok: true, reason: '' } : mods.oracle.evaluateCapture(raw, cfg.chromeMarkers)
  const started = Date.now()
  let receipt: CaptureReceipt | null = null
  let attemptsMade = 0
  const readReceipt = (): CaptureReceipt | null => {
    try {
      return JSON.parse(readFileSync(gridPath, 'utf8')) as CaptureReceipt
    } catch {
      return null
    }
  }
  const timing = (): CaptureTiming => ({
    slot,
    wallMs: Date.now() - started,
    readyAt: receipt === null ? null : needlesSeenAt(receipt, settled.sends.length),
    endedAtTick: receipt?.endedAtTick ?? null,
    lastOutputTick: receipt?.lastOutputTick ?? null,
    endReason: receipt?.endReason ?? null,
    attempts: attemptsMade,
  })
  try {
    const { grid, stdout } = runCaptureAttempts(id, attempt => {
      attemptsMade = attempt
      rmSync(gridPath, { force: true })
      const res = spawnSync(baselineDriverPython(), [join(import.meta.dir, 'vshot.py'), cfgPath], {
        encoding: 'utf-8',
        timeout: settleWallMs(SETTLE_LAW, vshotBudgetScale()),
        env: {
          ...process.env,
          MERCURY_CONFIG_DIR: home,
          MERCURY_AWAY_SUMMARY: '0',
          COLORFGBG: spec.theme.startsWith('light') ? '0;15' : '15;0',
          MERCURY_THEME_PIN: spec.theme,
          TERM_PROGRAM: 'kitty',
          MERCURY_CRITTER: DEFAULT_CRITTER_KEY,
          ...colorModeEnv(spec.colorMode),
        },
      })
      receipt = readReceipt()
      if (res.status !== 0) return { status: res.status, stderr: res.stderr, stdout: res.stdout }
      if (receipt === null) return { status: res.status, stderr: `${res.stderr}\nvshot exited 0 but wrote no grid at ${gridPath}`, stdout: res.stdout }
      return { status: 0, stderr: res.stderr, stdout: res.stdout, grid: receipt }
    }, judge, {
      log: line => console.log(`${line} [w${slot}]`),
      refused: (res, kind) => {
        const dir = refusedDir(run, id)
        if (existsSync(gridPath)) copyFileSync(gridPath, join(dir, 'last-frame.grid.json'))
        writeFileSync(join(dir, 'last-frame.txt'), res.stdout)
        writeFileSync(
          join(dir, 'refusal.log'),
          [
            `${id}: ${kind}`,
            `needles: ${JSON.stringify(needles)}`,
            `law: still ${SETTLE_LAW.stillTicks} ticks after the last needle · ceiling ${SETTLE_LAW.ceilingTicks} ticks (${(SETTLE_LAW.ceilingTicks * SETTLE_LAW.tickMs) / 1000}s) · budget scale ${vshotBudgetScale()}`,
            `receipt: ${JSON.stringify({ needlesSeenAt: receipt === null ? null : needlesSeenAt(receipt, settled.sends.length), sendsFired: receipt?.sendReceipts?.length ?? 0, sendsWanted: settled.sends.length, endedAtTick: receipt?.endedAtTick ?? null, lastOutputTick: receipt?.lastOutputTick ?? null, endReason: receipt?.endReason ?? null, status: res.status })}`,
            `cfg: ${cfgPath}`,
            '',
            res.stderr,
          ].join('\n'),
        )
        copyFileSync(cfgPath, join(dir, 'capture-cfg.json'))
        return dir
      },
    })
    return { grid: canonicalizeCheckoutRows(compactGrid(grid), recordingCheckout()), plainText: stdout, timing: timing() }
  } catch (err) {
    if (err instanceof Error) (err as Error & { timing?: CaptureTiming }).timing = timing()
    throw err
  } finally {
    mods.scenarios.cleanupScenario(spec.scenario)
  }
}

interface CaptureJob {
  spec: CaptureSpec
  masks: string[]
}

type JobResult =
  | { ok: true; grid: StoredGrid; plainText: string; timing: CaptureTiming }
  | { ok: false; error: string; timing: CaptureTiming | null }

async function runWorker(runDirPath: string, slot: number): Promise<number> {
  const run = openJobsRun(runDirPath)
  const home = workerHome(run, slot)
  rmSync(home, { recursive: true, force: true })
  mkdirSync(home, { recursive: true })
  process.env.MERCURY_CONFIG_DIR = home
  const scenarios = (await import('./renderScenarios.ts')) as unknown as ScenarioModule
  const oracle = (await import('./renderOracle.ts')) as unknown as OracleModule
  const mods = { scenarios, oracle }
  const jobs = readJobList<CaptureJob>(run)
  try {
    for (const job of jobs) {
      const id = entryId(job.spec)
      if (!claimJob(run, id)) continue
      try {
        const { grid, plainText, timing } = captureSpec({ ...job.spec, masks: job.masks }, mods, home, run, slot)
        writeJobResult<JobResult>(run, id, { ok: true, grid, plainText, timing })
        console.log(`· ${timingLine(id, timing)}`)
      } catch (err) {
        const timing = (err as { timing?: CaptureTiming }).timing ?? null
        writeJobResult<JobResult>(run, id, { ok: false, error: String(err), timing })
        console.log(`✗ ${id} — ${String(err)} [w${slot}]`)
      }
    }
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
  return 0
}

async function captureAll(jobsWanted: number, items: CaptureJob[]): Promise<{ results: Map<string, JobResult>; run: JobsRun }> {
  const run = jobsRunDir('mercury-vbl')
  writeJobList(run, items)
  const exits = await runWorkers(run, jobsWanted, items.length, (slot, _home) => ({
    script: import.meta.path,
    args: ['--worker', run.dir, '--slot', String(slot)],
    env: { VSHOT_SLOTS: vshotSlotsFor(jobsWanted) },
  }))
  const results = new Map<string, JobResult>()
  for (const item of items) {
    const id = entryId(item.spec)
    results.set(id, readJobResult<JobResult>(run, id) ?? { ok: false, error: `no worker captured it (worker exits: ${exits.join(', ')})`, timing: null })
  }
  return { results, run }
}

function printTimings(items: CaptureJob[], results: Map<string, JobResult>, jobsWanted: number, wallMs: number): void {
  const rows = items.flatMap(item => {
    const r = results.get(entryId(item.spec))
    return r?.timing ? [{ id: entryId(item.spec), timing: r.timing }] : []
  })
  console.log(`\nsettle law: every needle of the scene on screen, then the grid still for ${SETTLE_LAW.stillTicks} ticks (${(SETTLE_LAW.stillTicks * SETTLE_LAW.tickMs) / 1000}s); ceiling ${SETTLE_LAW.ceilingTicks} ticks (${(SETTLE_LAW.ceilingTicks * SETTLE_LAW.tickMs) / 1000}s) · jobs ${jobsWanted} · ${(wallMs / 1000).toFixed(1)}s wall`)
  for (const line of timingTable(rows)) console.log(line)
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

export function onlyFilter(only: string): (id: string) => boolean {
  const wanted = only.split(',').map(s => s.trim()).filter(Boolean)
  return id => wanted.length === 0 || wanted.some(w => id.includes(w))
}

async function main(): Promise<number> {
  const argv = process.argv.slice(2)
  const worker = argValue(argv, '--worker')
  if (worker !== undefined) return runWorker(worker, Number(argValue(argv, '--slot') ?? '1'))
  const only = argValue(argv, '--only') ?? ''
  const check = argv.includes('--check')
  const list = argv.includes('--list')
  const jobsWanted = parseJobs(argv)
  const live = liveDirs(argValue(argv, '--out') ?? LIVE_DIR)
  const keepRun = argv.includes('--keep-run')
  const wants = onlyFilter(only)

  let specs = matrix()
  if (only) specs = specs.filter(s => wants(entryId(s)))
  if (list) {
    for (const s of specs) console.log(entryId(s))
    console.log(`${specs.length} entries`)
    return 0
  }

  if (argv.includes('--redigest')) {
    const manifest = readManifest(live.liveDir)
    if (!manifest) { console.error('no manifest — generate first'); return 1 }
    for (const e of manifest.entries) {
      const grid = readStoredGrid(e, live.liveDir)
      e.masks = DEFAULT_MASKS
      e.gridDigest = gridDigest(grid, e.masks)
      e.styleDigest = styleDigest(grid, e.masks)
    }
    writeFileSync(live.manifestPath, JSON.stringify(manifest, null, 2))
    console.log(`✅ re-digested ${manifest.entries.length} entries with the current mask set`)
    return 0
  }

  const { sourceSha, buildDigest } = currentShas()
  const started = Date.now()

  if (check) {
    const manifest = readManifest(live.liveDir)
    if (!manifest) { console.error('no manifest — generate first'); return 1 }
    let failed = 0
    const targets = manifest.entries.filter(e => wants(e.id))
    const items: CaptureJob[] = targets.map(e => ({
      spec: { scenario: e.scenario, cols: e.cols, rows: e.rows, theme: e.theme, colorMode: e.colorMode, motion: e.motion },
      masks: e.masks,
    }))
    const { results, run } = await captureAll(jobsWanted, items)
    for (const e of targets) {
      const r = results.get(e.id)
      if (r === undefined || !r.ok) {
        failed++
        console.log(`✗ ${e.id} — ${r === undefined ? 'no result' : r.error}`)
        continue
      }
      const stored = readStoredGrid(e, live.liveDir)
      const div = firstDivergence(stored, r.grid, e.masks)
      if (div) {
        failed++
        console.log(`✗ ${e.id} — first divergence at row ${div.row} col ${div.col} (${div.kind})`)
        console.log(`    baseline: ${div.old}   fresh: ${div.new}`)
        console.log(`    baseline row: ${JSON.stringify(div.oldRow.trimEnd())}`)
        console.log(`    fresh row:    ${JSON.stringify(div.newRow.trimEnd())}`)
      } else {
        console.log(`✓ ${e.id}`)
      }
    }
    printTimings(items, results, jobsWanted, Date.now() - started)
    const refused = hasRefusals(run)
    if (refused) console.log(`refused captures kept what they saw under ${run.refused}`)
    closeJobsRun(run, keepRun || refused)
    console.log(failed === 0 ? `\n✅ ${targets.length} entries match the baseline` : `\n❌ ${failed}/${targets.length} diverged`)
    return failed === 0 ? 0 : 1
  }

  mkdirSync(live.gridsDir, { recursive: true })
  const held = readManifest(live.liveDir)
  const heldById = new Map<string, VisualBaselineEntry>((held?.entries ?? []).map(e => [e.id, e]))
  const prior = only ? held : null
  const entries = new Map<string, VisualBaselineEntry>(
    (prior?.entries ?? []).map(e => [e.id, e]),
  )
  const storedGridOf = (entry: VisualBaselineEntry): StoredGrid | null => {
    try {
      return readStoredGrid(entry, live.liveDir)
    } catch {
      return null
    }
  }
  const items: CaptureJob[] = specs.map(spec => ({ spec, masks: spec.masks ?? DEFAULT_MASKS }))
  const { results, run } = await captureAll(jobsWanted, items)
  let generated = 0
  let kept = 0
  let failedGen = 0
  for (const { spec, masks } of items) {
    const id = entryId(spec)
    const before = heldById.get(id)
    const r = results.get(id)
    if (r === undefined || !r.ok) {
      failedGen++
      if (before !== undefined) entries.set(id, before)
      console.log(`✗ ${id} — ${r === undefined ? 'no result' : r.error}${before !== undefined ? ' (the stored grid stands)' : ''}`)
      continue
    }
    const grid = r.grid
    if (before !== undefined && JSON.stringify(before.masks) === JSON.stringify(masks) && storedGridStands(storedGridOf(before), grid, masks)) {
      entries.set(id, before)
      kept++
      console.log(`= ${id} — unchanged, the stored grid stands`)
      continue
    }
    const gridPath = `grids/${id}.grid.json`
    writeFileSync(join(live.liveDir, gridPath), JSON.stringify(grid))
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
  }
  printTimings(items, results, jobsWanted, Date.now() - started)
  const refused = hasRefusals(run)
  if (refused) console.log(`refused captures kept what they saw under ${run.refused}`)
  closeJobsRun(run, keepRun || refused)
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
    console.log(`\n✅ ${kept} unchanged, nothing rewritten → ${live.manifestPath} stands`)
    return 0
  }
  writeFileSync(live.manifestPath, JSON.stringify(manifest, null, 2))
  console.log(`\n${failedGen === 0 ? '✅' : '❌'} ${generated} generated, ${kept} unchanged, ${failedGen} failed → ${live.manifestPath}`)
  return failedGen === 0 ? 0 : 1
}

if (import.meta.main) process.exit(await main())
