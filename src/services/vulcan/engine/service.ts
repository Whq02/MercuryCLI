import { randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import * as path from 'node:path'
import { flagEnv } from '../../../substrate/flagRegistry.js'
import { availableCores } from '../../../utils/availableCores.js'
import type { ProcessTreeKillReceipt } from '../../../utils/processGroup.js'
import { describeGodotProcess, runningGodotProcesses, type GodotProcess } from '../godotProcessCensus.js'
import { resolveGodotExecutable } from '../portabilityDoctor.js'
import { engineConsoleSibling, engineImportArgv, engineSuiteArgv } from './argv.js'
import {
  describeAttribution,
  engineFileAttribution,
  engineTreeHashes,
  materializeEngineTree,
  removeEngineTree,
  type EngineTreeFacts,
  type EngineTreeSpec,
} from './frozenTree.js'
import { classCacheDigest, seedEngineTree, storeEngineCache } from './importCache.js'
import { engineFailLines, engineLogErrors, engineScriptErrorLines, type EngineLogError } from './logs.js'
import {
  IMPORT_SUITE_NAME,
  isCleanEngineLog,
  markerLineOf,
  readEngineManifest,
  resolveEngineSuites,
  suiteRelativeFile,
  uncleanRegExp,
  type EngineManifest,
  type EngineMarker,
  type EngineSuite,
} from './manifest.js'
import { engineChecksDir, engineRunPath, engineRunsDir, engineTreePath, engineTreesDir, engineUsersDir, ensureEngineEstate, isEnginePath } from './paths.js'
import { liveEngines, spawnEngine, sweepEngineOrphans, type EngineHandle, type EngineOrphanSweep } from './spawn.js'

export type EnginePriority = 'verifier' | 'fold-gate' | 'lane-gate' | 'profile'

export const ENGINE_PRIORITIES: readonly EnginePriority[] = ['verifier', 'fold-gate', 'lane-gate', 'profile']
export const ENGINE_DEFAULT_PRIORITY: EnginePriority = 'lane-gate'
export const ENGINE_WORKERS_FLAG = 'MERCURY_GODOT_WORKERS'
export const ENGINE_WORKERS_MAX = 16
export const ENGINE_RECENT_KEEP = 50
export const ENGINE_RESULT_FILE = 'result.json'

export interface EngineJobRequest {
  suites: string[]
  tree: EngineTreeSpec
  native: boolean
  capture: boolean
  priority: EnginePriority
  budgetMs: number | null
  displayShared: boolean
  keepTree: boolean
  label: string | null
}

export type EngineJobState = 'queued' | 'running' | 'done' | 'cancelled' | 'failed'

export interface EngineRowError extends EngineLogError {
  lastChange: string | null
}

export interface EngineResultRow {
  name: string
  ok: boolean
  exitCode: number | null
  signal: string | null
  timedOut: boolean
  spawnError: string | null
  clean: boolean
  marker: boolean
  seconds: number
  log: string
  markerLine: string | null
  failLines: string[]
  scriptErrorLines: string[]
  errors: EngineRowError[]
  argv: string[]
  startedAt: string
  endedAt: string
  cancelled: boolean
  userDir: string
}

export interface EngineSkippedRow {
  name: string
  skipped: true
  reason: string
}

export type EngineRecordRow = EngineResultRow | EngineSkippedRow

export interface EngineRunRecord {
  root: string
  executable: string
  results: EngineRecordRow[]
  complete: boolean
  allPass: boolean
  jobId: string
  label: string | null
  priority: EnginePriority
  native: boolean
  capture: boolean
  enginePath: string
  tree: { label: string; ref: string; commit: string; files: string[]; skipped: string[]; kept: boolean }
  selected: string[]
  importCache: { key: string; hit: boolean; ran: boolean; seededFrom: string | null; stored: boolean }
  classCache: string | null
  userDir: string
  startedAt: string
  endedAt: string | null
  cancelled: boolean
  budgetMs: number | null
  budgetExceeded: boolean
  error: string | null
}

export interface EngineJob {
  id: string
  request: EngineJobRequest
  state: EngineJobState
  seq: number
  queuedAt: string
  startedAt: string | null
  endedAt: string | null
  runDir: string
  treePath: string
  worker: number | null
  currentSuite: string | null
  record: EngineRunRecord | null
  error: string | null
  cancelRequested: boolean
  tree: EngineTreeFacts | null
}

export interface EngineJobSummary {
  id: string
  label: string | null
  state: EngineJobState
  priority: EnginePriority
  suites: string[]
  tree: string
  native: boolean
  queuedAt: string
  startedAt: string | null
  endedAt: string | null
  worker: number | null
  currentSuite: string | null
  allPass: boolean | null
  complete: boolean | null
  error: string | null
}

export interface EngineJobsSnapshot {
  root: string
  workers: { count: number; source: string; busy: number }
  display: { nativeJob: string | null }
  queued: EngineJobSummary[]
  running: EngineJobSummary[]
  recent: EngineJobSummary[]
  liveEngines: Array<{ pid: number; label: string; startedAt: string }>
  swept: EngineOrphanSweep[]
  staleTreesRemoved: string[]
  manifest: { file: string; found: boolean; suites: string[]; problems: string[] }
}

export interface EngineServiceOptions {
  workers?: number
  executable?: string | null
  census?: () => Promise<GodotProcess[]>
  now?: () => number
}

export function engineWorkerCount(): { count: number; source: 'flag' | 'cores' } {
  const raw = flagEnv(ENGINE_WORKERS_FLAG)
  const n = Number(raw)
  if (raw && raw.trim().length > 0 && Number.isInteger(n) && n >= 1 && n <= ENGINE_WORKERS_MAX) return { count: n, source: 'flag' }
  const cores = availableCores()
  return { count: Math.min(3, Math.max(1, Math.floor(cores / 2))), source: 'cores' }
}

export function priorityRank(p: EnginePriority): number {
  return ENGINE_PRIORITIES.indexOf(p)
}

export function newEngineJobId(now: number = Date.now()): string {
  return `${now}-${randomBytes(2).toString('hex')}`
}

export function readEngineRecord(projectRoot: string, jobId: string): EngineRunRecord | null {
  const file = path.join(engineRunPath(projectRoot, jobId), ENGINE_RESULT_FILE)
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as EngineRunRecord
  } catch {
    return null
  }
}

export function listEngineRunIds(projectRoot: string): string[] {
  try {
    return readdirSync(engineRunsDir(projectRoot))
      .filter(name => existsSync(path.join(engineRunsDir(projectRoot), name, ENGINE_RESULT_FILE)))
      .sort()
      .reverse()
  } catch {
    return []
  }
}

function summarize(job: EngineJob): EngineJobSummary {
  return {
    id: job.id,
    label: job.request.label,
    state: job.state,
    priority: job.request.priority,
    suites: job.request.suites,
    tree: job.request.tree.label,
    native: job.request.native,
    queuedAt: job.queuedAt,
    startedAt: job.startedAt,
    endedAt: job.endedAt,
    worker: job.worker,
    currentSuite: job.currentSuite,
    allPass: job.record ? job.record.allPass : null,
    complete: job.record ? job.record.complete : null,
    error: job.error,
  }
}

const SERVICES = new Map<string, EngineJobService>()

export class EngineJobService {
  readonly projectRoot: string
  readonly workers: number
  readonly workersSource: string
  private readonly queue: EngineJob[] = []
  private readonly running = new Map<string, EngineJob>()
  private readonly recent: EngineJob[] = []
  private readonly byId = new Map<string, EngineJob>()
  private readonly handles = new Map<string, EngineHandle>()
  private readonly waiters = new Map<string, Array<() => void>>()
  private readonly busyWorkers = new Set<number>()
  private readonly census: () => Promise<GodotProcess[]>
  private readonly executableOption: string | null
  private executableCache: { resolved: string; note: string } | null = null
  private nativeJob: string | null = null
  private seq = 0
  private swept: EngineOrphanSweep[] = []
  private staleTreesRemoved: string[] = []
  private readonly ready: Promise<void>

  constructor(projectRoot: string, opts: EngineServiceOptions = {}) {
    this.projectRoot = path.resolve(projectRoot)
    if (opts.workers !== undefined && Number.isInteger(opts.workers) && opts.workers >= 1) {
      this.workers = Math.min(ENGINE_WORKERS_MAX, opts.workers)
      this.workersSource = 'option'
    } else {
      const w = engineWorkerCount()
      this.workers = w.count
      this.workersSource = w.source === 'flag' ? ENGINE_WORKERS_FLAG : 'cores'
    }
    this.census = opts.census ?? (() => runningGodotProcesses())
    this.executableOption = opts.executable ?? null
    this.ready = this.startup()
  }

  static for(projectRoot: string, opts: EngineServiceOptions = {}): EngineJobService {
    const key = path.resolve(projectRoot)
    let service = SERVICES.get(key)
    if (!service) {
      service = new EngineJobService(key, opts)
      SERVICES.set(key, service)
    }
    return service
  }

  static forget(projectRoot: string): void {
    SERVICES.delete(path.resolve(projectRoot))
  }

  private async startup(): Promise<void> {
    try {
      this.swept = await sweepEngineOrphans(this.projectRoot, await this.census())
    } catch {
      this.swept = []
    }
    for (const dir of [engineTreesDir(this.projectRoot), engineChecksDir(this.projectRoot)]) {
      let names: string[] = []
      try {
        names = readdirSync(dir)
      } catch {
        continue
      }
      for (const name of names) {
        rmSync(path.join(dir, name), { recursive: true, force: true })
        this.staleTreesRemoved.push(path.join(dir, name))
      }
    }
  }

  manifest(): EngineManifest {
    return readEngineManifest(this.projectRoot)
  }

  async executable(): Promise<{ resolved: string; note: string } | { error: string }> {
    if (this.executableCache) return this.executableCache
    const fromManifest = this.manifest().executable ?? this.executableOption
    if (fromManifest) {
      this.executableCache = { resolved: fromManifest, note: 'named by the manifest' }
      return this.executableCache
    }
    const census = await this.census().catch(() => [] as GodotProcess[])
    const receipt = await resolveGodotExecutable({ census, projectRoot: this.projectRoot })
    if (!receipt.resolved) return { error: receipt.note }
    const resolved = engineConsoleSibling(receipt.resolved, process.platform, p => existsSync(p))
    this.executableCache = { resolved, note: resolved === receipt.resolved ? receipt.note : `${receipt.note}; its console sibling carries the output` }
    return this.executableCache
  }

  async submit(request: EngineJobRequest): Promise<EngineJob | { refused: string }> {
    await this.ready
    const manifest = this.manifest()
    const selection = resolveEngineSuites(manifest, request.suites)
    if (selection.unknown.length > 0) {
      const known = manifest.suites.map(s => s.name)
      return {
        refused: `Unknown suite: ${selection.unknown.join(', ')}${known.length > 0 ? ` — registered: ${known.join(', ')}` : ''}${manifest.teaching ? `; ${manifest.teaching}` : ''}`,
      }
    }
    if (selection.entries.length === 0) {
      return { refused: manifest.teaching ?? `no suites selected — registered: ${manifest.suites.map(s => s.name).join(', ')}` }
    }
    if (request.capture && !request.native) return { refused: '--capture requires --native; headless runs do not prove appearance (pass native:true with capture:true)' }
    const nativeOnly = selection.entries.filter(e => e.kind === 'suite' && e.suite.nativeOnly).map(e => (e.kind === 'suite' ? e.suite.name : ''))
    if (nativeOnly.length > 0 && !request.native) return { refused: `${nativeOnly.join(', ')} ${nativeOnly.length === 1 ? 'is' : 'are'} native-only: pass native:true (a display run, one at a time)` }
    const executable = await this.executable()
    if ('error' in executable) return { refused: `no Godot executable to run the engine: ${executable.error}` }
    ensureEngineEstate(this.projectRoot)
    const id = newEngineJobId()
    const job: EngineJob = {
      id,
      request,
      state: 'queued',
      seq: this.seq++,
      queuedAt: new Date().toISOString(),
      startedAt: null,
      endedAt: null,
      runDir: engineRunPath(this.projectRoot, id),
      treePath: engineTreePath(this.projectRoot, id),
      worker: null,
      currentSuite: null,
      record: null,
      error: null,
      cancelRequested: false,
      tree: null,
    }
    this.byId.set(id, job)
    mkdirSync(job.runDir, { recursive: true })
    const facts = await materializeEngineTree(this.projectRoot, request.tree, job.treePath)
    if ('error' in facts) {
      job.state = 'failed'
      job.error = facts.error
      job.endedAt = new Date().toISOString()
      job.record = this.baseRecord(job, executable.resolved, selection.entries.map(e => (e.kind === 'import' ? IMPORT_SUITE_NAME : e.suite.name)))
      job.record.error = facts.error
      job.record.endedAt = job.endedAt
      this.writeRecord(job)
      removeEngineTree(job.treePath)
      this.remember(job)
      return job
    }
    job.tree = facts
    this.queue.push(job)
    this.pump()
    return job
  }

  private baseRecord(job: EngineJob, executable: string, selected: string[]): EngineRunRecord {
    return {
      root: this.projectRoot,
      executable,
      results: [],
      complete: false,
      allPass: false,
      jobId: job.id,
      label: job.request.label,
      priority: job.request.priority,
      native: job.request.native,
      capture: job.request.capture,
      enginePath: job.treePath,
      tree: {
        label: job.request.tree.label,
        ref: job.request.tree.ref,
        commit: job.tree?.commit ?? '',
        files: job.tree?.files ?? [],
        skipped: job.tree?.skipped ?? [],
        kept: job.request.keepTree,
      },
      selected,
      importCache: { key: '', hit: false, ran: false, seededFrom: null, stored: false },
      classCache: null,
      userDir: path.join(job.runDir, 'user'),
      startedAt: job.startedAt ?? job.queuedAt,
      endedAt: null,
      cancelled: false,
      budgetMs: job.request.budgetMs,
      budgetExceeded: false,
      error: null,
    }
  }

  private writeRecord(job: EngineJob): void {
    if (!job.record) return
    try {
      mkdirSync(job.runDir, { recursive: true })
      writeFileSync(path.join(job.runDir, ENGINE_RESULT_FILE), JSON.stringify(job.record, null, 2))
    } catch {
      return
    }
  }

  private remember(job: EngineJob): void {
    this.recent.unshift(job)
    while (this.recent.length > ENGINE_RECENT_KEEP) {
      const dropped = this.recent.pop()
      if (dropped) this.byId.delete(dropped.id)
    }
    const waiters = this.waiters.get(job.id) ?? []
    this.waiters.delete(job.id)
    for (const w of waiters) w()
  }

  private pickNext(): EngineJob | null {
    const ordered = [...this.queue].sort((a, b) => priorityRank(a.request.priority) - priorityRank(b.request.priority) || a.seq - b.seq)
    for (const job of ordered) {
      if (job.request.native && this.nativeJob !== null) continue
      return job
    }
    return null
  }

  private pump(): void {
    while (this.running.size < this.workers) {
      const next = this.pickNext()
      if (!next) return
      this.queue.splice(this.queue.indexOf(next), 1)
      let worker = 0
      while (this.busyWorkers.has(worker)) worker++
      this.busyWorkers.add(worker)
      this.running.set(next.id, next)
      if (next.request.native) this.nativeJob = next.id
      void this.runJob(next, worker)
    }
  }

  private async displayHolder(): Promise<string | null> {
    let processes: GodotProcess[] = []
    try {
      processes = await this.census()
    } catch {
      return null
    }
    const holder = processes.find(p => !p.headless && !(p.project !== undefined && isEnginePath(this.projectRoot, p.project)))
    return holder ? describeGodotProcess(holder) : null
  }

  private userDirFor(job: EngineJob, suite: EngineSuite | null): string {
    const dir = suite && suite.userDir === 'keep' ? path.join(engineUsersDir(this.projectRoot), suite.name.replace(/[\\/]/g, '__')) : path.join(job.runDir, 'user')
    mkdirSync(dir, { recursive: true })
    return dir
  }

  private async runOne(
    job: EngineJob,
    executable: string,
    name: string,
    argv: string[],
    timeoutMs: number,
    marker: EngineMarker | null,
    userDir: string,
    unclean: RegExp,
  ): Promise<EngineResultRow> {
    const handle = spawnEngine({ executable, args: argv, cwd: job.treePath, userDir, timeoutMs, label: `${job.id}:${name}` })
    this.handles.set(job.id, handle)
    job.currentSuite = name
    const out = await handle.done
    this.handles.delete(job.id)
    job.currentSuite = null
    const logFile = path.join(job.runDir, `${name}.log`)
    try {
      mkdirSync(path.dirname(logFile), { recursive: true })
      writeFileSync(logFile, out.output)
    } catch {
      void 0
    }
    const clean = isCleanEngineLog(out.output, unclean)
    const markerLine = marker ? markerLineOf(marker, out.output) : null
    const markerHit = marker === null || markerLine !== null
    const ok = out.exitCode === 0 && !out.signal && !out.timedOut && !out.spawnError && clean && markerHit
    const errors: EngineRowError[] = []
    for (const e of engineLogErrors(out.output)) {
      let lastChange: string | null = null
      if (e.file && e.file.startsWith('res://') && job.tree) {
        lastChange = describeAttribution(await engineFileAttribution(this.projectRoot, job.tree, e.file))
      }
      errors.push({ ...e, lastChange })
    }
    return {
      name,
      ok,
      exitCode: out.exitCode,
      signal: out.signal,
      timedOut: out.timedOut,
      spawnError: out.spawnError,
      clean,
      marker: markerHit,
      seconds: out.seconds,
      log: logFile,
      markerLine,
      failLines: engineFailLines(out.output),
      scriptErrorLines: engineScriptErrorLines(out.output),
      errors,
      argv,
      startedAt: out.startedAt,
      endedAt: out.endedAt,
      cancelled: out.killed === 'cancel',
      userDir,
    }
  }

  private async runJob(job: EngineJob, worker: number): Promise<void> {
    job.state = 'running'
    job.worker = worker
    job.startedAt = new Date().toISOString()
    const manifest = this.manifest()
    const selection = resolveEngineSuites(manifest, job.request.suites)
    const selected = selection.entries.map(e => (e.kind === 'import' ? IMPORT_SUITE_NAME : e.suite.name))
    const exe = await this.executable()
    const record = this.baseRecord(job, 'error' in exe ? '' : exe.resolved, selected)
    job.record = record
    this.writeRecord(job)
    const unclean = uncleanRegExp(manifest.uncleanSource, manifest.uncleanFlags)
    const deadline = job.request.budgetMs !== null ? Date.now() + job.request.budgetMs : null
    const budgetLeft = (): number => (deadline === null ? Number.POSITIVE_INFINITY : deadline - Date.now())
    try {
      if ('error' in exe) throw new Error(`no Godot executable: ${exe.error}`)
      if (!job.tree) throw new Error('the frozen tree was not materialised')
      if (job.request.native && !job.request.displayShared) {
        const holder = await this.displayHolder()
        if (holder) throw new Error(`native run refused: the display is held by ${holder} — pass displayShared:true to run beside it`)
      }
      const hashes = engineTreeHashes(job.tree)
      const seed = seedEngineTree(this.projectRoot, job.treePath, hashes.key)
      record.importCache = { key: hashes.key, hit: seed.hit, ran: false, seededFrom: seed.seededFrom, stored: false }
      const explicitImport = selection.entries.some(e => e.kind === 'import')
      if (!seed.hit || explicitImport) {
        const timeout = Math.max(1, Math.min(manifest.defaults.importTimeoutMs, budgetLeft()))
        const row = await this.runOne(job, exe.resolved, IMPORT_SUITE_NAME, engineImportArgv(job.treePath), timeout, null, this.userDirFor(job, null), unclean)
        record.results.push(row)
        record.importCache.ran = true
        if (row.ok) record.importCache.stored = storeEngineCache(this.projectRoot, job.treePath, hashes.key).stored
        this.writeRecord(job)
      }
      record.classCache = classCacheDigest(job.treePath)
      for (const entry of selection.entries) {
        if (entry.kind === 'import') continue
        if (job.cancelRequested) break
        if (budgetLeft() <= 0) {
          record.budgetExceeded = true
          break
        }
        const suite = entry.suite
        const file = suiteRelativeFile(suite, manifest.defaults)
        if (suite.local && !existsSync(path.join(job.treePath, file))) {
          record.results.push({ name: suite.name, skipped: true, reason: `local draft, ${file} absent` })
          this.writeRecord(job)
          continue
        }
        const argv = engineSuiteArgv(job.treePath, suite, manifest.defaults, { native: job.request.native, capture: job.request.capture })
        const timeout = Math.max(1, Math.min(suite.timeoutMs, budgetLeft()))
        const row = await this.runOne(job, exe.resolved, suite.name, argv, timeout, suite.marker, this.userDirFor(job, suite), unclean)
        if (row.timedOut && deadline !== null && Date.now() >= deadline) record.budgetExceeded = true
        record.results.push(row)
        this.writeRecord(job)
      }
      record.cancelled = job.cancelRequested
      const named = new Set(record.results.map(r => r.name))
      record.complete = selected.every(name => named.has(name))
      const ran = record.results.filter((r): r is EngineResultRow => !('skipped' in r) && r.name !== IMPORT_SUITE_NAME)
      const importRows = record.results.filter((r): r is EngineResultRow => !('skipped' in r) && r.name === IMPORT_SUITE_NAME)
      record.allPass = !record.cancelled && !record.budgetExceeded && record.complete && ran.length > 0 && ran.every(r => r.ok) && importRows.every(r => r.ok)
      job.state = job.cancelRequested ? 'cancelled' : 'done'
    } catch (e) {
      record.error = (e as Error).message
      job.error = record.error
      job.state = job.cancelRequested ? 'cancelled' : 'failed'
    } finally {
      job.endedAt = new Date().toISOString()
      record.endedAt = job.endedAt
      record.cancelled = record.cancelled || job.cancelRequested
      if (!job.request.keepTree) removeEngineTree(job.treePath)
      record.tree.kept = job.request.keepTree && existsSync(job.treePath)
      this.writeRecord(job)
      this.running.delete(job.id)
      this.busyWorkers.delete(worker)
      if (this.nativeJob === job.id) this.nativeJob = null
      this.remember(job)
      this.pump()
    }
  }

  async cancel(id: string): Promise<{ id: string; state: EngineJobState; receipt: ProcessTreeKillReceipt | null } | { error: string }> {
    const job = this.byId.get(id)
    if (!job) return { error: `no engine job ${id} in this session — op:"engine_jobs" lists them; a finished run is read with op:"engine_result"` }
    if (job.state === 'queued') {
      const at = this.queue.indexOf(job)
      if (at >= 0) this.queue.splice(at, 1)
      job.cancelRequested = true
      job.state = 'cancelled'
      job.endedAt = new Date().toISOString()
      job.record = this.baseRecord(job, '', job.request.suites)
      job.record.cancelled = true
      job.record.endedAt = job.endedAt
      this.writeRecord(job)
      removeEngineTree(job.treePath)
      this.remember(job)
      this.pump()
      return { id, state: job.state, receipt: null }
    }
    if (job.state === 'running') {
      job.cancelRequested = true
      const handle = this.handles.get(id)
      const receipt = handle ? await handle.kill('cancel') : null
      await this.wait(id, 15_000)
      return { id, state: job.state, receipt }
    }
    return { id, state: job.state, receipt: null }
  }

  async wait(id: string, ms: number): Promise<EngineJob | null> {
    const job = this.byId.get(id)
    if (!job) return null
    if (job.state !== 'queued' && job.state !== 'running') return job
    await new Promise<void>(resolve => {
      const list = this.waiters.get(id) ?? []
      let timer: NodeJS.Timeout | null = null
      const done = (): void => {
        if (timer) clearTimeout(timer)
        resolve()
      }
      list.push(done)
      this.waiters.set(id, list)
      if (ms > 0 && Number.isFinite(ms)) timer = setTimeout(done, ms)
    })
    return job
  }

  job(id: string): EngineJob | null {
    return this.byId.get(id) ?? null
  }

  result(id: string): EngineRunRecord | null {
    return this.byId.get(id)?.record ?? readEngineRecord(this.projectRoot, id)
  }

  jobs(): EngineJobsSnapshot {
    const manifest = this.manifest()
    return {
      root: this.projectRoot,
      workers: { count: this.workers, source: this.workersSource, busy: this.running.size },
      display: { nativeJob: this.nativeJob },
      queued: [...this.queue].sort((a, b) => priorityRank(a.request.priority) - priorityRank(b.request.priority) || a.seq - b.seq).map(summarize),
      running: [...this.running.values()].map(summarize),
      recent: this.recent.slice(0, 20).map(summarize),
      liveEngines: liveEngines(),
      swept: this.swept,
      staleTreesRemoved: this.staleTreesRemoved,
      manifest: { file: manifest.file, found: manifest.found, suites: manifest.suites.map(s => s.name), problems: manifest.problems },
    }
  }

  async shutdown(): Promise<void> {
    for (const job of [...this.queue]) await this.cancel(job.id)
    for (const id of [...this.running.keys()]) await this.cancel(id)
  }
}
