#!/usr/bin/env bun
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CONFIG_HOME, RUNTIME_CWD, cleanupScenario, scenario } from './renderScenarios.ts'
import { resolveCaptureDriver, vshotBudgetMs } from '../lib/captureDriver.ts'

const REPO = join(import.meta.dir, '..', '..')
const BIN = join(REPO, 'dist', 'mercury.mjs')

function arg(flag: string, def: string): string {
  const i = process.argv.indexOf(flag)
  return i >= 0 ? process.argv[i + 1]! : def
}

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
const READ_MARK: Record<string, string> = { 'keys-escape': 'atlas-open', 'boot-face': 'face' }

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
const parallel = Math.max(1, Number(arg('--parallel', '2')) || 1)
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
const PYTE_PATH = (() => {
  try {
    return spawnSync(driver.python, ['-c', 'import pyte, os; print(os.path.dirname(os.path.dirname(pyte.__file__)))'], { encoding: 'utf8' }).stdout?.trim() || ''
  } catch {
    return ''
  }
})()

type Cell = { c?: string }
type Grid = Cell[][]
type Payload = { grid?: Grid; marks?: Array<{ label: string; grid: Grid }>; endReason?: string }
const rowsOf = (g: Grid | undefined): string[] => (Array.isArray(g) ? g.map(row => row.map(cell => cell.c ?? ' ').join('')) : [])

const BOX = new Set(['╭', '╮', '╰', '╯', '│', '─', '├', '┤', '┬', '┴', '┼', '┌', '┐', '└', '┘'])
const EXIT_HINT = /\besc\b|←|\bq quits\b|⇧←|shift\+←|\bctrl\+d\b/i

type Finding = { kind: 'broken-border' | 'bleed' | 'clip' | 'no-exit' | 'footer-wrapped'; detail: string }

function inspect(rows: string[], cols: number): Finding[] {
  const out: Finding[] = []
  const cell = (y: number, x: number): string => rows[y]?.[x] ?? ' '
  for (let y = 0; y < rows.length; y++) {
    const line = rows[y]!
    for (let x0 = line.indexOf('╭'); x0 >= 0; x0 = line.indexOf('╭', x0 + 1)) {
      const x1 = line.indexOf('╮', x0 + 1)
      if (x1 < 0) {
        out.push({ kind: 'broken-border', detail: `row ${y}: ╭ at ${x0} has no ╮ (the top edge is cut or overwritten)` })
        continue
      }
      let closed = false
      let lastInner = y
      for (let yy = y + 1; yy < rows.length; yy++) {
        const l = cell(yy, x0)
        const r = cell(yy, x1)
        if (l === '╰') {
          closed = true
          if (r !== '╯') out.push({ kind: 'broken-border', detail: `row ${yy}: bottom edge ╰ at ${x0} but ${JSON.stringify(r)} at ${x1}` })
          break
        }
        lastInner = yy
        if (!(l === '│' || l === '├')) {
          out.push({ kind: 'broken-border', detail: `row ${yy}: left edge at ${x0} reads ${JSON.stringify(l)}` })
          break
        }
        if (!(r === '│' || r === '┤')) {
          out.push({ kind: 'broken-border', detail: `row ${yy}: right edge at ${x1} reads ${JSON.stringify(r)} — "${rows[yy]!.slice(Math.max(0, x1 - 30), x1 + 2).trim()}"` })
          break
        }
        const after = cell(yy, x1 + 1)
        if (x1 + 1 < cols && after !== ' ' && !BOX.has(after)) {
          out.push({ kind: 'bleed', detail: `row ${yy}: ${JSON.stringify(after)} painted right of the border at ${x1 + 1}` })
        }
      }
      if (!closed) {
        if (lastInner >= rows.length - 1 && y < rows.length - 4) {
          out.push({ kind: 'clip', detail: `shell opened at row ${y} (x ${x0}..${x1}) never closes — its footer is off screen` })
        }
        continue
      }
      if (x1 - x0 > cols / 2 && lastInner - y >= 3) {
        const inner = (yy: number): string => rows[yy]!.slice(x0 + 1, x1).trim()
        const footer = inner(lastInner)
        const above = inner(lastInner - 1)
        if (EXIT_HINT.test(footer) && above !== '' && !EXIT_HINT.test(above)) {
          if (/^[a-z]/.test(above) && above.includes('·')) {
            out.push({ kind: 'footer-wrapped', detail: `rows ${lastInner - 1}-${lastInner}: "${above}" / "${footer}"` })
          }
        }
      }
    }
  }
  const whole = rows.join('\n')
  if (!EXIT_HINT.test(whole)) out.push({ kind: 'no-exit', detail: 'no esc / ← / q / ⇧← hint anywhere on the frame' })
  return out
}

type Job = { name: string; cols: number; rows: number }
type Result = { job: Job; ok: boolean; findings: Finding[]; note: string }

async function capture(job: Job): Promise<Result> {
  const { name, cols, rows } = job
  const tag = `${name}-${cols}x${rows}`
  const gridPath = join(outDir, `${tag}.json`)
  const cfgPath = join(outDir, `${tag}.cfg.json`)
  let cfg: Record<string, unknown>
  try {
    cfg = { ...scenario(name, cols, rows), out: gridPath }
  } catch (e) {
    return { job, ok: false, findings: [], note: `scenario refused: ${String(e).slice(0, 200)}` }
  }
  writeFileSync(cfgPath, JSON.stringify(cfg))
  const env = {
    ...process.env,
    ...(PYTE_PATH ? { PYTHONPATH: [PYTE_PATH, process.env.PYTHONPATH].filter(Boolean).join(':') } : {}),
    MERCURY_FULLSCREEN: '1',
    MERCURY_CONFIG_DIR: process.env.MERCURY_CONFIG_DIR || CONFIG_HOME,
  }
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
    if (mark !== undefined && label !== `mark:${mark}`) continue
    for (const f of inspect(rows, cols)) findings.push({ kind: f.kind, detail: `${label}: ${f.detail}` })
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
