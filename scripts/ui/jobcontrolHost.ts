// scripts/ui/jobcontrolHost.ts — the bun side of jobcontrol-host.py: run a
// journey against the built bundle under a job-control shell in a PTY and
// read back the report (marks, process-state samples, mode events).
//
// Why a shell host: vshot execs the bundle straight into the PTY, which
// leaves it in an ORPHANED process group — the kernel discards default-action
// stop signals there and turns a background terminal read into EIO instead
// of a stop. A stop, a `fg`, and the terminal's foreground process group are
// only observable with a real job-control shell between the PTY and the
// bundle, exactly the operator's world.
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { vshotBudgetMs } from '../lib/captureDriver.ts'

export type HostStep = Record<string, unknown>

export type HostMark = { label: string; ms: number; teeOffset: number; grid: string }
export type HostSample = {
  ms: number
  label: string
  stat: string | null
  pgid: number | null
  tpgid: number | null
  foreground: boolean | null
  tree: Array<{ pid: number; ppid: number; pgid: number; tpgid: number; stat: string; cmd: string }>
}
export type HostModeEvent = { ms: number; mode: string; offset: number }
export type HostReport = {
  endReason: string
  bundlePid: number | null
  marks: HostMark[]
  samples: HostSample[]
  modeEvents: HostModeEvent[]
  shellLines: string[]
  finalGrid: string
  log: string[]
  rawBytes: number
}

export type HostRun = {
  report: HostReport | null
  /** The raw byte stream the PTY produced (the tee). */
  tee: Buffer
  status: number | null
  stderr: string
}

/** Run one journey. `argv` is the bundle's argv (the scenario's), typed at
 *  the shell prompt as a quoted command line. */
export function runJobControlHost(opts: {
  tag: string
  argv: string[]
  cwd: string
  cols: number
  rows: number
  steps: HostStep[]
  env: NodeJS.ProcessEnv
  budgetSeconds?: number
}): HostRun {
  const base = join(tmpdir(), `jobcontrol-${opts.tag}-${process.pid}`)
  const cfgPath = `${base}.cfg.json`
  const reportPath = `${base}.report.json`
  const teePath = `${base}.tee`
  for (const p of [cfgPath, reportPath, teePath]) rmSync(p, { force: true })
  const command = opts.argv.map(a => `'${a.replace(/'/g, `'\\''`)}'`).join(' ')
  writeFileSync(
    cfgPath,
    JSON.stringify({
      cols: opts.cols,
      rows: opts.rows,
      cwd: opts.cwd,
      command,
      steps: opts.steps,
      tee: teePath,
      budgetSeconds: opts.budgetSeconds ?? 150,
    }),
  )
  const res = spawnSync('/usr/bin/python3', [join(import.meta.dir, 'jobcontrol-host.py'), cfgPath, reportPath], {
    encoding: 'utf8',
    timeout: vshotBudgetMs(((opts.budgetSeconds ?? 150) + 30) * 1000),
    env: opts.env,
  })
  const report = existsSync(reportPath) ? (JSON.parse(readFileSync(reportPath, 'utf8')) as HostReport) : null
  const tee = existsSync(teePath) ? readFileSync(teePath) : Buffer.alloc(0)
  for (const p of [cfgPath, reportPath, teePath]) rmSync(p, { force: true })
  return { report, tee, status: res.status, stderr: res.stderr ?? '' }
}

export const mark = (r: HostReport, label: string): HostMark | undefined => r.marks.find(m => m.label === label)

/** Mode events whose byte offset falls in [from, to). */
export function modeEventsBetween(r: HostReport, from: number, to: number | null): HostModeEvent[] {
  return r.modeEvents.filter(e => e.offset >= from && (to === null || e.offset < to))
}

/** The LAST recorded state ('on' | 'off') of one mode family in a window,
 *  or null when the family never appeared. */
export function lastStateOf(events: HostModeEvent[], family: string): 'on' | 'off' | null {
  let last: 'on' | 'off' | null = null
  for (const e of events) {
    const [fam, state] = e.mode.split(':')
    if (fam === family) last = state as 'on' | 'off'
  }
  return last
}

export const MOUSE_FAMILIES = ['mouse-normal', 'mouse-button', 'mouse-any', 'mouse-sgr'] as const

/** Samples in a time window (ms since the host started). */
export function samplesBetween(r: HostReport, fromMs: number, toMs: number | null): HostSample[] {
  return r.samples.filter(s => s.ms >= fromMs && (toMs === null || s.ms < toMs))
}
