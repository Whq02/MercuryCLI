import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

export const JOBS_DEFAULT = 1

export function parseJobs(argv: readonly string[], fallback = JOBS_DEFAULT): number {
  let raw: string | undefined
  const i = argv.indexOf('--jobs')
  if (i >= 0) raw = argv[i + 1]
  const short = argv.find(a => /^-j\d+$/.test(a))
  if (raw === undefined && short !== undefined) raw = short.slice(2)
  if (raw === undefined) return fallback
  const n = Number(raw)
  if (!Number.isInteger(n) || n < 1) throw new Error(`--jobs wants a whole number of 1 or more, not ${JSON.stringify(raw)}`)
  return n
}

export function argValue(argv: readonly string[], flag: string): string | undefined {
  const i = argv.indexOf(flag)
  return i >= 0 ? argv[i + 1] : undefined
}

export interface JobsRun {
  dir: string
  claims: string
  results: string
  refused: string
}

export function jobsRunDir(name: string, root: string = tmpdir()): JobsRun {
  const dir = join(root, `${name}-${process.pid}`)
  return openJobsRun(dir)
}

export function openJobsRun(dir: string): JobsRun {
  const run = { dir, claims: join(dir, 'claims'), results: join(dir, 'results'), refused: join(dir, 'refused') }
  for (const d of [run.dir, run.claims, run.results, run.refused]) mkdirSync(d, { recursive: true })
  return run
}

export function workerHome(run: JobsRun, slot: number): string {
  return join(run.dir, `home-${slot}`)
}

export function writeJobList<T>(run: JobsRun, items: readonly T[]): void {
  writeFileSync(join(run.dir, 'jobs.json'), JSON.stringify(items))
}

export function readJobList<T>(run: JobsRun): T[] {
  return JSON.parse(readFileSync(join(run.dir, 'jobs.json'), 'utf8')) as T[]
}

export function claimJob(run: JobsRun, id: string): boolean {
  try {
    mkdirSync(join(run.claims, encodeURIComponent(id)))
    return true
  } catch {
    return false
  }
}

export function writeJobResult<R>(run: JobsRun, id: string, result: R): void {
  const path = join(run.results, `${encodeURIComponent(id)}.json`)
  writeFileSync(`${path}.part`, JSON.stringify(result))
  renameSync(`${path}.part`, path)
}

export function readJobResult<R>(run: JobsRun, id: string): R | null {
  const path = join(run.results, `${encodeURIComponent(id)}.json`)
  if (!existsSync(path)) return null
  return JSON.parse(readFileSync(path, 'utf8')) as R
}

export function refusedDir(run: JobsRun, id: string): string {
  const dir = join(run.refused, encodeURIComponent(id))
  mkdirSync(dir, { recursive: true })
  return dir
}

export function hasRefusals(run: JobsRun): boolean {
  return readdirSync(run.refused).length > 0
}

export function closeJobsRun(run: JobsRun, keep: boolean): void {
  if (keep) return
  rmSync(run.dir, { recursive: true, force: true })
}

export interface WorkerSpawn {
  script: string
  args: readonly string[]
  env?: NodeJS.ProcessEnv
  cwd?: string
}

export async function runWorkers(run: JobsRun, jobs: number, count: number, make: (slot: number, home: string) => WorkerSpawn): Promise<number[]> {
  const slots = Math.max(1, Math.min(jobs, count))
  const exits = await Promise.all(
    Array.from({ length: slots }, (_, k) => {
      const slot = k + 1
      const home = workerHome(run, slot)
      mkdirSync(home, { recursive: true })
      const w = make(slot, home)
      return new Promise<number>(resolve => {
        const child = spawn(process.execPath, ['run', w.script, ...w.args], {
          stdio: ['ignore', 'inherit', 'inherit'],
          cwd: w.cwd,
          env: { ...process.env, ...w.env, MERCURY_CONFIG_DIR: home, MERCURY_CAPTURE_JOB_SLOT: String(slot) },
        })
        child.on('exit', code => resolve(code ?? 1))
        child.on('error', () => resolve(1))
      })
    }),
  )
  return exits
}

export function vshotSlotsFor(jobs: number, env: NodeJS.ProcessEnv = process.env): string {
  const have = Number(env.VSHOT_SLOTS ?? '3')
  const base = Number.isFinite(have) && have > 0 ? have : 3
  return String(Math.max(base, jobs))
}

export interface CaptureTiming {
  slot: number
  wallMs: number
  readyAt: number | null
  endedAtTick: number | null
  lastOutputTick: number | null
  endReason: string | null
  attempts: number
}

export function timingLine(id: string, t: CaptureTiming): string {
  const ticks = t.endedAtTick === null ? '—' : `ended ${t.endedAtTick}`
  const ready = t.readyAt === null ? '' : ` · ready ${t.readyAt}`
  const tail = t.lastOutputTick === null ? '' : ` · last paint ${t.lastOutputTick}`
  return `${id} — ${ticks}${ready}${tail} · ${(t.wallMs / 1000).toFixed(1)}s [w${t.slot}]`
}

export function timingTable(rows: ReadonlyArray<{ id: string; timing: CaptureTiming }>): string[] {
  const head = 'entry'.padEnd(56) + 'ready'.padStart(6) + 'ended'.padStart(6) + 'paint'.padStart(6) + 'wall s'.padStart(8) + '  w'
  const lines = rows.map(({ id, timing: t }) =>
    id.padEnd(56) +
    String(t.readyAt ?? '—').padStart(6) +
    String(t.endedAtTick ?? '—').padStart(6) +
    String(t.lastOutputTick ?? '—').padStart(6) +
    (t.wallMs / 1000).toFixed(1).padStart(8) +
    `  ${t.slot}`,
  )
  return [head, ...lines]
}
