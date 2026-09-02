#!/usr/bin/env bun
// ============================================================================
//  scripts/ui/probe-overflow-matrix.ts — the NO-OVERFLOW probe.
//
//  Drives the render harness's scenarios at the documented minimum width
//  (100 columns) and 120, at 30 and 40 rows, and reads every captured frame
//  (the final grid and each mark) for the overflow class:
//    · BORDER INTEGRITY — a round shell whose top row reads ╭───╮ keeps '│'
//      at its left and right columns on every inner row and closes with ╰;
//      a wrapped label or an overwide child paints over the right edge;
//    · BLEED — a painted cell right of a shell's right border on an inner
//      row (a child wider than its box);
//    · CLIP — a shell whose bottom edge never arrives (the footer, and its
//      way out, are off screen);
//    · THE WAY OUT — an exit hint (esc · ← · q · ⇧←) on every frame;
//    · FOOTER ON ONE LINE — the shell's last inner row carries the hint and
//      the row above it is blank (a footer that wrapped fills that row).
//  Every frame's text is dumped under --out for the eyeball pass the
//  mechanical checks cannot make (a broken label reads wrong before it
//  breaks a border).
//
//  A probe, not a gate leg: minutes of PTY boots. Shard it with --scenarios
//  and --sizes. Captures run one at a time by default: the scenarios stage
//  their sessions under ONE per-process id and pin process.env for their
//  child, so two in flight in one process would swap each other's
//  transcript and home (--parallel N is there for a box that can afford the
//  races on layout-only scenes; never for a verdict).
//
//  Usage: bun scripts/ui/probe-overflow-matrix.ts [--scenarios a,b] \
//           [--sizes 100x30,100x40,120x30,120x40] [--out dir] [--parallel 1]
// ============================================================================
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CONFIG_HOME, RUNTIME_CWD, cleanupScenario, scenario } from './renderScenarios.ts'
import { resolveCaptureDriver, vshotBudgetMs } from '../lib/captureDriver.ts'
import { inspect, rowsOf, type Finding, type Grid } from './frameChecks.ts'

const REPO = join(import.meta.dir, '..', '..')
const BIN = join(REPO, 'dist', 'mercury.mjs')

function arg(flag: string, def: string): string {
  const i = process.argv.indexOf(flag)
  return i >= 0 ? process.argv[i + 1]! : def
}

/** The surfaces a release operator meets: command centres, pickers, the
 *  boot faces, the concourse, the cockpit frame. A scenario that closes its
 *  surface before the final frame carries the mark to read instead. */
const DEFAULT_SCENARIOS = [
  'sessions-manager',
  'resume-full-history',
  'model-picker-home',
  'help',
  'help-commands',
  'keys-escape',
  'settings-config',
  'settings-status-tab',
  'boot-face',
  'boot-settings',
  'concourse',
  'health',
  'accounts',
  'memory-files',
  'prompts-panel',
  'transcript-overlay',
  'login-card',
  'cockpit-wide',
  'resume-picker',
  'agents-studio-rich',
]
/** Marks that hold the OPEN surface where the final frame has closed it. */
const READ_MARK: Record<string, string> = { 'keys-escape': 'atlas-open', 'boot-face': 'face' }
/** ROOT screens own no exit — nothing stands beneath them to return to —
 *  so they owe their key-map row instead: the moves they do have, printed.
 *  A root that prints nothing is the fault; a root without 'esc' is not. */
// The face's ready line pads its separators ("↵ start  ·  m menu"): the
// needles read the words, never a spacing.
const ROOT_KEYMAP: Record<string, RegExp> = {
  'boot-face': /↵ start\s+·\s+m menu/,
  'boot-settings': /↵ start\s+·\s+m menu|esc back/,
  'cockpit-wide': /\? for shortcuts|shift\+tab to cycle|to cycle\)/,
  'resume-picker': /ctrl\+c to exit|esc/i,
}

const scenarios = arg('--scenarios', DEFAULT_SCENARIOS.join(',')).split(',').map(s => s.trim()).filter(Boolean)
const sizes = arg('--sizes', '100x30,100x40,120x30,120x40')
  .split(',')
  .map(s => s.trim())
  .filter(Boolean)
  .map(s => {
    const [c, r] = s.split('x').map(Number)
    return { cols: c!, rows: r! }
  })
const outDir = arg('--out', join(tmpdir(), `mercury-overflow-${process.pid}`))
const parallel = Math.max(1, Number(arg('--parallel', '1')) || 1)
mkdirSync(outDir, { recursive: true })

const driver = resolveCaptureDriver()
if (driver.kind !== 'posix-pty') {
  console.error(`no POSIX pty capture driver on this host (${driver.kind})`)
  process.exit(2)
}
if (!existsSync(BIN)) {
  console.error('dist/mercury.mjs missing — bun run build.ts first')
  process.exit(2)
}
// pyte lives in the user-site path python derives from HOME; a scenario that
// swaps HOME must not starve the engine of it (render-tui's pin).
const PYTE_PATH = (() => {
  try {
    return spawnSync(driver.python, ['-c', 'import pyte, os; print(os.path.dirname(os.path.dirname(pyte.__file__)))'], { encoding: 'utf8' }).stdout?.trim() || ''
  } catch {
    return ''
  }
})()

type Payload = { grid?: Grid; marks?: Array<{ label: string; grid: Grid }>; endReason?: string }

type Job = { name: string; cols: number; rows: number }
type Result = { job: Job; ok: boolean; findings: Finding[]; note: string }

function restoreEnv(saved: Record<string, string | undefined>): void {
  for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key]
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
}

async function capture(job: Job): Promise<Result> {
  const { name, cols, rows } = job
  const tag = `${name}-${cols}x${rows}`
  const gridPath = join(outDir, `${tag}.json`)
  const cfgPath = join(outDir, `${tag}.cfg.json`)
  // A scenario pins process.env for its child (some swap MERCURY_CONFIG_DIR
  // to a scratch home) and never restores it — one capture per process in
  // the render harness, so it never mattered there. Here every capture
  // snapshots the env, lets the scenario pin, takes the child's env, and
  // restores — synchronously, so no other capture can see the pins.
  const saved: Record<string, string | undefined> = { ...process.env }
  let cfg: Record<string, unknown>
  try {
    cfg = { ...scenario(name, cols, rows), out: gridPath }
  } catch (e) {
    restoreEnv(saved)
    return { job, ok: false, findings: [], note: `scenario refused: ${String(e).slice(0, 200)}` }
  }
  writeFileSync(cfgPath, JSON.stringify(cfg))
  const env = {
    ...process.env,
    ...(PYTE_PATH ? { PYTHONPATH: [PYTE_PATH, process.env.PYTHONPATH].filter(Boolean).join(':') } : {}),
    MERCURY_FULLSCREEN: '1',
    MERCURY_CONFIG_DIR: process.env.MERCURY_CONFIG_DIR || CONFIG_HOME,
  }
  restoreEnv(saved)
  const status = await new Promise<number | null>(resolve => {
    const child = spawn(driver.python, [join(import.meta.dir, 'vshot.py'), cfgPath], { cwd: RUNTIME_CWD, env, stdio: ['ignore', 'ignore', 'pipe'] })
    let stderr = ''
    child.stderr.on('data', d => (stderr += d))
    const killer = setTimeout(() => child.kill('SIGKILL'), vshotBudgetMs(120_000))
    child.on('exit', code => {
      clearTimeout(killer)
      if (code !== 0) writeFileSync(join(outDir, `${tag}.stderr.txt`), stderr)
      resolve(code)
    })
  })
  cleanupScenario(name)
  if (status !== 0 || !existsSync(gridPath)) {
    return { job, ok: false, findings: [], note: `vshot exit ${status} (stderr beside the grid)` }
  }
  const payload = JSON.parse(readFileSync(gridPath, 'utf8')) as Payload
  const frames: Array<[string, string[]]> = []
  const mark = READ_MARK[name]
  for (const m of payload.marks ?? []) frames.push([`mark:${m.label}`, rowsOf(m.grid)])
  frames.push(['final', rowsOf(payload.grid)])
  const dump: string[] = []
  const findings: Finding[] = []
  for (const [label, rows] of frames) {
    dump.push(`──── ${tag} · ${label} ────`, ...rows, '')
    // The open surface is read on its mark where the final frame has closed it.
    if (mark !== undefined && label !== `mark:${mark}`) continue
    for (const f of inspect(rows, cols, ROOT_KEYMAP[name])) findings.push({ kind: f.kind, detail: `${label}: ${f.detail}` })
  }
  writeFileSync(join(outDir, `${tag}.txt`), dump.join('\n'))
  return { job, ok: findings.length === 0, findings, note: payload.endReason ?? '' }
}

const jobs: Job[] = []
for (const name of scenarios) for (const { cols, rows } of sizes) jobs.push({ name, cols, rows })
console.log(`overflow matrix — ${jobs.length} captures (${scenarios.length} scenarios × ${sizes.length} sizes) → ${outDir}`)

const results: Result[] = []
let next = 0
async function worker(): Promise<void> {
  while (next < jobs.length) {
    const job = jobs[next++]!
    const r = await capture(job)
    results.push(r)
    const tag = `${job.name}@${job.cols}x${job.rows}`
    console.log(`  [${r.ok ? 'PASS' : 'FAIL'}] ${tag}${r.note ? ` (${r.note})` : ''}`)
    for (const f of r.findings) console.log(`         ${f.kind}: ${f.detail}`)
  }
}
await Promise.all(Array.from({ length: Math.min(parallel, jobs.length) }, () => worker()))

const failed = results.filter(r => !r.ok)
writeFileSync(join(outDir, 'report.json'), JSON.stringify(results, null, 2))
console.log(`\n${results.length - failed.length}/${results.length} clean · frames + report under ${outDir}`)
process.exit(failed.length === 0 ? 0 : 1)
