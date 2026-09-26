#!/usr/bin/env bun
import { spawn } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { captureEngineEntry, resolveCaptureDriver, vshotBudgetScale } from '../lib/captureDriver.ts'
import { argValue, parseJobs, vshotSlotsFor } from '../lib/captureJobs.ts'
import { SETTLE_LAW, settleWallMs } from '../ui/visualBaseline.ts'

const REPO = resolve(import.meta.dir, '../..')
const OUT = argValue(process.argv, '--out') ?? join(import.meta.dir, 'baselines')
const SPLASH = join(REPO, 'assets/splash/mercury-splash.mjs')
const DRIVER = resolveCaptureDriver()
if (DRIVER.kind !== 'posix-pty') {
  const why = DRIVER.kind === 'unavailable' ? `${DRIVER.reason} — ${DRIVER.remedy}` : `driver '${DRIVER.kind}' cannot run the POSIX capture engine`
  console.error(`baseline-capture: ${why}`)
  process.exit(2)
}
const VSHOT = captureEngineEntry(DRIVER, REPO)
const BUN = process.env.BUN ?? join(process.env.HOME ?? '', '.bun/bin/bun')
const JOBS = parseJobs(process.argv)
const RUN = mkdtempSync(join(tmpdir(), 'contour-capture-'))
const REFUSED = join(RUN, 'refused')
mkdirSync(OUT, { recursive: true })

const only = argValue(process.argv, '--only') ?? null

const SIZES: Array<[number, number]> = [
  [45, 12],
  [60, 18],
  [80, 24],
  [100, 30],
  [120, 40],
  [150, 45],
]

const SPLASH_READY: Record<string, string> = { lockup: '↵ start', menu: 's launch', projects: '↑↓ choose' }
const SURFACE_NEEDLES: Record<string, string[]> = { 'model-picker-home': ['Mercury · model', 'closes'] }
const SURFACE_STILL_REGION: Record<string, (cols: number, rows: number) => [number, number, number, number]> = {
  'cockpit-mission': (cols, rows) => [0, 0, cols, rows - 2],
}

function makePopulatedHome(root: string): string {
  const home = join(root, 'home')
  for (const slug of ['proj-a', 'proj-b']) {
    const cwd = join(home, 'fixtures', slug)
    mkdirSync(cwd, { recursive: true })
    const pdir = join(home, 'projects', slug)
    mkdirSync(pdir, { recursive: true })
    writeFileSync(join(pdir, 'session.jsonl'), JSON.stringify({ cwd }) + '\n')
  }
  return home
}

interface Capture {
  name: string
  run: (scratch: string) => Promise<{ ok: boolean; log: string; grid: string | null; screen: string }>
}

function runChild(cmd: string, args: string[], opts: { cwd?: string; env: NodeJS.ProcessEnv; timeoutMs: number }): Promise<{ status: number | null; stdout: string; stderr: string; timedOut: boolean }> {
  return new Promise(resolvePromise => {
    const child = spawn(cmd, args, { cwd: opts.cwd, env: opts.env, stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    let timedOut = false
    child.stdout.on('data', d => (stdout += d))
    child.stderr.on('data', d => (stderr += d))
    const wall = setTimeout(() => {
      timedOut = true
      child.kill('SIGKILL')
    }, opts.timeoutMs)
    child.on('close', status => {
      clearTimeout(wall)
      resolvePromise({ status, stdout, stderr, timedOut })
    })
  })
}

function splashCapture(name: string, view: 'lockup' | 'menu' | 'projects', cols: number, rows: number, env: Record<string, string>): Capture {
  return {
    name,
    run: async scratch => {
      const home = makePopulatedHome(scratch)
      const cfgPath = join(scratch, 'cfg.json')
      const gridPath = join(scratch, 'grid.json')
      writeFileSync(
        cfgPath,
        JSON.stringify({ argv: ['node', SPLASH], cols, rows, readyText: SPLASH_READY[view], stableTicks: SETTLE_LAW.stillTicks, total: SETTLE_LAW.ceilingTicks, out: gridPath }),
      )
      const r = await runChild(DRIVER.python, [VSHOT, cfgPath], {
        env: { ...process.env, ...env, MERCURY_HOME: home, MERCURY_CONFIG_DIR: home, VSHOT_SLOTS: vshotSlotsFor(JOBS) },
        timeoutMs: settleWallMs(SETTLE_LAW, vshotBudgetScale()),
      })
      const ok = r.status === 0 && existsSync(gridPath)
      const log = r.timedOut ? `vshot wall (${settleWallMs(SETTLE_LAW, vshotBudgetScale())}ms) killed the capture` : r.stderr
      return { ok, log, grid: existsSync(gridPath) ? gridPath : null, screen: r.stdout }
    },
  }
}

function surfaceCapture(surface: string, cols: number, rows: number): Capture {
  return {
    name: `${surface}-${cols}x${rows}`,
    run: async scratch => {
      const gridPath = join(scratch, 'grid.json')
      const png = join(scratch, 'frame.png')
      const home = join(scratch, 'home')
      mkdirSync(home, { recursive: true })
      const args = ['run', 'scripts/ui/render-tui.ts', '--scenario', surface, '--cols', String(cols), '--rows', String(rows), '--out', png, '--grid', gridPath, '--settle']
      for (const needle of SURFACE_NEEDLES[surface] ?? []) args.push('--needle', needle)
      const region = SURFACE_STILL_REGION[surface]?.(cols, rows)
      if (region) args.push('--still-region', region.join(','))
      const r = await runChild(BUN, args, {
        cwd: REPO,
        env: { ...process.env, MERCURY_CONFIG_DIR: home, VSHOT_SLOTS: vshotSlotsFor(JOBS) },
        timeoutMs: settleWallMs(SETTLE_LAW, vshotBudgetScale()) * 2 + 30_000,
      })
      const ok = r.status === 0 && existsSync(gridPath)
      const grid = existsSync(gridPath) ? gridPath : null
      const screen = grid === null ? '' : screenOf(grid)
      return { ok, log: r.timedOut ? 'the render wall killed the capture' : String(r.stdout).slice(-2000) + String(r.stderr).slice(-2000), grid, screen }
    },
  }
}

function screenOf(gridPath: string): string {
  try {
    const g = JSON.parse(readFileSync(gridPath, 'utf8')) as { grid: Array<Array<{ c: string }>> }
    return g.grid.map(row => row.map(c => c.c).join('').trimEnd()).join('\n') + '\n'
  } catch {
    return ''
  }
}

function receiptOf(gridPath: string): string {
  try {
    const g = JSON.parse(readFileSync(gridPath, 'utf8')) as { readyAt?: number | null; endedAtTick?: number; endReason?: string; lastOutputTick?: number; sendReceipts?: Array<{ atTick: number }> }
    const seen = g.readyAt ?? g.sendReceipts?.slice(-1)[0]?.atTick ?? '—'
    return `ready ${seen} · ended ${g.endedAtTick ?? '—'} (${g.endReason ?? '—'}) · last paint ${g.lastOutputTick ?? '—'}`
  } catch {
    return 'no receipt'
  }
}

async function runPool(captures: Capture[], jobs: number): Promise<Map<string, { ok: boolean; line: string }>> {
  const results = new Map<string, { ok: boolean; line: string }>()
  let next = 0
  const worker = async (): Promise<void> => {
    while (next < captures.length) {
      const c = captures[next++]!
      const scratch = join(RUN, encodeURIComponent(c.name))
      mkdirSync(scratch, { recursive: true })
      const started = Date.now()
      const r = await c.run(scratch)
      const wall = ((Date.now() - started) / 1000).toFixed(1)
      if (r.ok && r.grid) {
        copyFileSync(r.grid, join(OUT, `${c.name}.json`))
        const line = `✅ ${c.name}.json — ${receiptOf(r.grid)} · ${wall}s`
        results.set(c.name, { ok: true, line })
        console.log(line)
        rmSync(scratch, { recursive: true, force: true })
      } else {
        const keep = join(REFUSED, encodeURIComponent(c.name))
        mkdirSync(keep, { recursive: true })
        if (r.grid) copyFileSync(r.grid, join(keep, 'last-frame.grid.json'))
        writeFileSync(join(keep, 'last-frame.txt'), r.screen)
        writeFileSync(join(keep, 'refusal.log'), `${c.name}\nlaw: ready needle on screen, then still ${SETTLE_LAW.stillTicks} ticks · ceiling ${SETTLE_LAW.ceilingTicks} ticks\n${r.grid ? receiptOf(r.grid) : 'no grid'}\n\n${r.log}`)
        const line = `❌ ${c.name}.json — ${r.log.trim().split('\n').slice(-1)[0] ?? 'refused'} · what it saw: ${keep} · ${wall}s`
        results.set(c.name, { ok: false, line })
        console.log(line)
      }
    }
  }
  await Promise.all(Array.from({ length: Math.max(1, Math.min(jobs, captures.length)) }, () => worker()))
  return results
}

const captures: Capture[] = []
const skipped: string[] = []

if (!only || only === 'splash') {
  const base: Record<string, string> = {
    MERCURY_SPLASH_ONESHOT: '1',
    TERM: 'xterm-256color',
    MERCURY_CRITTER_IDLE: '0',
    MERCURY_CRITTER_GAZE: '0',
    MERCURY_CRITTER_SLEEP: '0',
    MERCURY_LIVE_CLOCK: '0',
    MERCURY_LIVE_GLYPHS: '0',
  }
  const nPicker = 2

  for (const [cols, rows] of SIZES) {
    captures.push(splashCapture(`splash-lockup-${cols}x${rows}`, 'lockup', cols, rows, base))
    if (cols >= 64 && rows >= 13) {
      captures.push(splashCapture(`splash-menu-${cols}x${rows}`, 'menu', cols, rows, { ...base, MERCURY_SPLASH_VIEW: 'menu' }))
    } else skipped.push(`— splash-menu-${cols}x${rows}: menu cannot fit (needs cols≥64 ∧ rows≥13) — skipped by contract`)
    if (cols >= 64 && rows >= nPicker + 9) {
      captures.push(splashCapture(`splash-projects-${cols}x${rows}`, 'projects', cols, rows, { ...base, MERCURY_SPLASH_VIEW: 'projects' }))
    } else skipped.push(`— splash-projects-${cols}x${rows}: picker cannot fit (needs cols≥64 ∧ rows≥${nPicker + 9}) — skipped by contract`)
  }
  captures.push(splashCapture('splash-lockup-80x24-reduced-motion', 'lockup', 80, 24, { ...base, MERCURY_REDUCED_MOTION: '1' }))
  captures.push(splashCapture('splash-lockup-80x24-reduced-colour', 'lockup', 80, 24, { ...base, TERM: 'linux' }))
}

const APP_SURFACES = ['cockpit-mission', 'model-picker-home', 'thinking-row']
for (const surface of APP_SURFACES) {
  if (only && only !== surface && only !== 'app') continue
  for (const [cols, rows] of SIZES) captures.push(surfaceCapture(surface, cols, rows))
}

for (const line of skipped) console.log(line)
const started = Date.now()
const results = await runPool(captures, JOBS)
const fail = [...results.values()].filter(r => !r.ok).length
console.log(`\nsettle law: the view's ready text on screen, then still ${SETTLE_LAW.stillTicks} ticks (a oneshot splash settles by exiting); ceiling ${SETTLE_LAW.ceilingTicks} ticks (${(SETTLE_LAW.ceilingTicks * SETTLE_LAW.tickMs) / 1000}s) · jobs ${JOBS} · ${((Date.now() - started) / 1000).toFixed(1)}s wall`)
for (const c of captures) console.log(results.get(c.name)?.line ?? `❌ ${c.name}.json — no result`)
if (fail === 0) rmSync(RUN, { recursive: true, force: true })
else console.log(`refused captures kept what they saw under ${REFUSED}`)
console.log(fail === 0 ? '\n✅ contour BEFORE captures complete' : `\n❌ ${fail} capture(s) failed`)
process.exit(fail === 0 ? 0 : 1)
