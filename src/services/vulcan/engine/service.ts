import { createHash, randomBytes } from 'node:crypto'
import { VULCAN_ADDON_DIGEST } from '../addonFiles.generated.js'
import { injectVulcanWorkerScript, installVulcanWorkerAddon } from '../addonInstaller.js'
import { listVulcanInstances, prepareVulcanInstance, type VulcanInstance } from '../instances.js'
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
import { engineRunPath, engineRunsDir, engineTreePath, engineUsersDir, ensureEngineEstate, isEnginePath } from './paths.js'
import { liveEngines, removeDeadEngineTrees, spawnEngine, sweepEngineOrphans, type EngineHandle, type EngineOrphanSweep } from './spawn.js'
import { engineMediaCensus, finishEngineProfileBaseline, newEngineMediaRecord, readEngineMediaBoot, type EngineMediaRecord, type EngineMediaRequest } from './media.js'
import { ENGINE_MEDIA_MARKER, writeEngineMediaDriver } from './mediaDriver.js'
import { GodotDebuggerProfile } from './debuggerProfile.js'
import { writeEngineContactSheet } from './frames.js'
import { startEngineHeartbeat } from './liveness.js'
import { engineLeaseRefusal, projectLeaseHolder, type LeaseHolder } from './leases.js'
import { engineLogDrift, proofTreeFingerprint, sourceProofDrift, type ProofDriftRow } from './proofDrift.js'

export type EnginePriority = 'verifier' | 'fold-gate' | 'lane-gate' | 'profile'

export const ENGINE_PRIORITIES: readonly EnginePriority[] = ['verifier', 'fold-gate', 'lane-gate', 'profile']
export const ENGINE_DEFAULT_PRIORITY: EnginePriority = 'lane-gate'
export const ENGINE_WORKERS_FLAG = 'MERCURY_GODOT_WORKERS'
export const ENGINE_WORKERS_MAX = 16
export const ENGINE_RECENT_KEEP = 50
export const ENGINE_RESULT_FILE = 'result.json'
export const ENGINE_QUIET_SAMPLE_MS = 1000

export interface EngineJobRequest {
  holder?: LeaseHolder
  suites: string[]
  tree: EngineTreeSpec
  native: boolean
  capture: boolean
  priority: EnginePriority
  budgetMs: number | null
  displayShared: boolean
  keepTree: boolean
  label: string | null
  media?: EngineMediaRequest
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
  instance: VulcanInstance | null
  drift: ProofDriftRow[]
}

export interface EngineSkippedRow {
  name: string
  skipped: true
  reason: string
}

export type EngineRecordRow = EngineResultRow | EngineSkippedRow

export interface EngineRunRecord {
  proofTreeFingerprint: string
  drift: ProofDriftRow[]
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
  media?: EngineMediaRecord
  frames?: EngineMediaRecord['frames']
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
  liveEngines: ReturnType<typeof liveEngines>
  instances: VulcanInstance[]
  swept: EngineOrphanSweep[]
  sweepError: string | null
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

function freezeEngineRequest<T>(value: T, seen = new WeakSet<object>()): T {
  if (value !== null && typeof value === 'object' && !seen.has(value)) {
    seen.add(value)
    for (const nested of Object.values(value)) freezeEngineRequest(nested, seen)
    Object.freeze(value)
  }
  return value
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
const ACTIVE_SERVICES = new Set<EngineJobService>()
let NATIVE_JOB: string | null = null

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
  private readonly heartbeats = new Map<string, () => void>()
  private readonly census: () => Promise<GodotProcess[]>
  private readonly mediaCensus: () => Promise<GodotProcess[]>
  private readonly executableOption: string | null
  private executableCache: { resolved: string; note: string } | null = null
  private seq = 0
  private swept: EngineOrphanSweep[] = []
  private sweepError: string | null = null
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
    this.mediaCensus = opts.census ?? engineMediaCensus
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
    let processes: GodotProcess[]
    try {
      processes = await this.mediaCensus()
      this.swept = await sweepEngineOrphans(this.projectRoot, processes)
    } catch (e) {
      this.swept = []
      this.sweepError = `the orphan sweep did not run: ${(e as Error).message}`
      return
    }
    this.staleTreesRemoved = removeDeadEngineTrees(this.projectRoot, processes, this.swept)
  }

  private stopHeartbeat(id: string): void {
    this.heartbeats.get(id)?.()
    this.heartbeats.delete(id)
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
    request = structuredClone(request)
    if (request.media) request = { ...request, native: request.media.route === 'display', capture: false, suites: [] }
    request = freezeEngineRequest(request)
    await this.ready
    if (request.media) {
      if (request.media!.route === 'hidden') return { refused: 'hidden run refused: stock Godot shows its native bootstrap window before scripts initialize; no verified hidden bootstrap is available. Use headless project Image capture, or explicitly request route:"display".' }
      if (request.media!.kind === 'profile' && request.media!.quiet === 'refuse') {
        const workers = await this.otherEngineWorkers()
        if (workers.length) return { refused: `quiet-machine guard refused profile: other engine workers are alive or the census is unavailable — ${workers.join('; ')}` }
      }
    }
    const manifest = this.manifest()
    const selection = request.media ? { entries: [], unknown: [] } : resolveEngineSuites(manifest, request.suites)
    if (selection.unknown.length > 0) {
      const known = manifest.suites.map(s => s.name)
      return {
        refused: `Unknown suite: ${selection.unknown.join(', ')}${known.length > 0 ? ` — registered: ${known.join(', ')}` : ''}${manifest.teaching ? `; ${manifest.teaching}` : ''}`,
      }
    }
    if (!request.media && selection.entries.length === 0) {
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
    Object.defineProperty(job, 'request', { value: request, enumerable: true, writable: false, configurable: false })
    mkdirSync(job.runDir, { recursive: true })
    this.byId.set(id, job)
    this.heartbeats.set(id, startEngineHeartbeat(job.runDir))
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
      this.stopHeartbeat(id)
      this.remember(job)
      return job
    }
    job.tree = facts
    const refusal = await this.leaseRefusal(job)
    if (refusal) {
      removeEngineTree(job.treePath)
      this.stopHeartbeat(id)
      rmSync(job.runDir, { recursive: true, force: true })
      this.byId.delete(id)
      return { refused: refusal }
    }
    this.queue.push(job)
    this.pump()
    return job
  }

  private async leaseRefusal(job: EngineJob): Promise<string | null> {
    if (!job.tree) return null
    try {
      return await engineLeaseRefusal(this.projectRoot, job.tree, job.request.holder ?? projectLeaseHolder())
    } catch (e) {
      return `cannot check the leases on the changed files: ${(e as Error).message}`
    }
  }

  private baseRecord(job: EngineJob, executable: string, selected: string[]): EngineRunRecord {
    return {
      proofTreeFingerprint: job.tree ? proofTreeFingerprint(job.tree) : '',
      drift: [],
      root: this.projectRoot,
      executable,
      results: [],
      complete: false,
      allPass: false,
      jobId: job.id,
      label: job.request.label,
      priority: job.request.priority,
      native: job.request.native,
      capture: job.request.media?.kind === 'capture' || job.request.capture,
      enginePath: job.treePath,
      tree: {
        label: job.request.tree.label,
        ref: job.request.tree.ref,
        commit: job.tree?.commit ?? '',
        files: job.tree?.files ?? [],
        skipped: job.tree?.skipped ?? [],
        kept: job.request.keepTree,
      },
      ...(job.request.media ? { media: newEngineMediaRecord(job.request.media) } : {}),
      selected: job.request.media ? this.mediaNames(job.request.media) : selected,
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
      if (job.request.native && NATIVE_JOB !== null) continue
      return job
    }
    return null
  }

  private pump(): void {
    if (this.queue.length === 0 && this.running.size === 0) {
      ACTIVE_SERVICES.delete(this)
      return
    }
    ACTIVE_SERVICES.add(this)
    while (this.running.size < this.workers) {
      const next = this.pickNext()
      if (!next) return
      this.queue.splice(this.queue.indexOf(next), 1)
      let worker = 0
      while (this.busyWorkers.has(worker)) worker++
      this.busyWorkers.add(worker)
      this.running.set(next.id, next)
      if (next.request.native) NATIVE_JOB = next.id
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
    if (job.cancelRequested) throw new Error('engine job cancelled before launch')
    const scriptIndex = argv.indexOf('--script')
    const script = scriptIndex >= 0 ? argv[scriptIndex + 1] : undefined
    const bridged = !job.request.media && !argv.includes('--check-only') && (script === undefined || script.startsWith('res://'))
    const instrumented = bridged && script ? injectVulcanWorkerScript(job.treePath, script) : bridged
    const bridge = instrumented ? await prepareVulcanInstance(job.treePath, name === IMPORT_SUITE_NAME ? 'agent-editor' : job.request.native ? 'native-worker' : 'headless-worker') : undefined
    const handle = spawnEngine({ executable, args: argv, cwd: job.treePath, userDir, timeoutMs, label: `${job.id}:${name}`, ...(bridge ? { bridge } : {}) })
    this.handles.set(job.id, handle)
    job.currentSuite = name
    const out = await handle.done
    if (bridge) rmSync(path.join(job.treePath, '.godot', 'mercury-vulcan', bridge.id), { recursive: true, force: true })
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
    const drift = engineLogDrift(out.output, name, job.id)
    job.record?.drift.push(...drift)
    const ok = out.exitCode === 0 && !out.signal && !out.timedOut && !out.spawnError && clean && markerHit && drift.length === 0
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
      instance: handle.bridge,
      drift,
    }
  }

  private mediaNames(request: EngineMediaRequest): string[] {
    return request.kind === 'profile' ? ['profile'] : request.pair ? ['capture-a', 'capture-b'] : ['capture-single']
  }

  private async otherEngineWorkers(job?: EngineJob): Promise<string[]> {
    const workers = new Set<string>()
    for (const service of ACTIVE_SERVICES) {
      for (const active of service.running.values()) if (active !== job) workers.add(`engine job ${active.id} on ${service.projectRoot}`)
    }
    const ownPid = job ? this.handles.get(job.id)?.pid : null
    for (const engine of liveEngines()) {
      if (job && engine.label.startsWith(`${job.id}:`)) continue
      workers.add(`pid ${engine.pid} ${engine.label}`)
    }
    try {
      for (const engine of await this.mediaCensus()) {
        if (job && (engine.pid === ownPid || (engine.project !== undefined && path.resolve(engine.project) === path.resolve(job.treePath)))) continue
        workers.add(describeGodotProcess(engine))
      }
    } catch (e) {
      workers.add(`census unavailable: ${(e as Error).message}`)
    }
    return [...workers]
  }

  private async observeProfileQuiet(job: EngineJob, stage: string, refuse: boolean): Promise<void> {
    const media = job.record?.media
    if (!media || media.kind !== 'profile') return
    const workers = await this.otherEngineWorkers(job)
    const contaminatedBefore = media.quiet.contaminated
    if (workers.length) media.quiet.contaminated = true
    if (workers.length || media.quiet.observations.length < 1024) media.quiet.observations.push({ at: new Date().toISOString(), stage, workers })
    if (media.quiet.contaminated !== contaminatedBefore) this.writeRecord(job)
    if (refuse && workers.length && media.quiet.policy === 'refuse') throw new Error(`quiet-machine guard refused profile: other engine workers are alive or the census is unavailable — ${workers.join('; ')}`)
  }

  private async runMedia(job: EngineJob, executable: string, timeoutMs: number, budgetLeft: () => number, unclean: RegExp): Promise<void> {
    const request = job.request.media
    const record = job.record
    const media = record?.media
    if (!request || !record || !media || !job.tree) throw new Error('media job is missing its frozen request or run record')
    const variants = request.kind === 'capture' && request.pair ? ['a', 'b'] : ['single']
    for (const variant of variants) {
      if (job.cancelRequested) return
      if (budgetLeft() <= 0) {
        record.budgetExceeded = true
        return
      }
      if (request.kind === 'profile') await this.observeProfileQuiet(job, 'before-measurement-boot', true)
      if (job.cancelRequested) return
      if (budgetLeft() <= 0) {
        record.budgetExceeded = true
        return
      }
      const debuggerProfile = request.kind === 'profile' && request.source !== 'project' ? new GodotDebuggerProfile(request, path.join(job.runDir, 'media', variant, 'driver.gd')) : null
      try {
        if (debuggerProfile) await debuggerProfile.transport.listen()
        if (job.cancelRequested) return
        if (budgetLeft() <= 0) { record.budgetExceeded = true; return }
        const connection = debuggerProfile ? { port: debuggerProfile.transport.port, token: debuggerProfile.transport.token } : undefined
        const boot = writeEngineMediaDriver(job.runDir, job.treePath, request, variant, connection)
        const userDir = path.join(job.runDir, 'media', variant, 'user')
        mkdirSync(userDir, { recursive: true })
        let timer: ReturnType<typeof setInterval> | null = null
        let observing: Promise<void> | null = null
        if (request.kind === 'profile') {
          timer = setInterval(() => {
            if (observing) return
            observing = this.observeProfileQuiet(job, 'measurement-boot', false).finally(() => { observing = null })
          }, ENGINE_QUIET_SAMPLE_MS)
        }
        let row: EngineResultRow
        try {
          media.boots++
          row = await this.runOne(job, executable, request.kind === 'profile' ? 'profile' : `capture-${variant}`, boot.argv, Math.max(1, Math.min(timeoutMs, budgetLeft())), { kind: 'line', text: ENGINE_MEDIA_MARKER }, userDir, unclean)
        } finally {
          if (timer) clearInterval(timer)
          if (observing) await observing
        }
        record.results.push(row)
        if (row.timedOut && budgetLeft() <= 0) record.budgetExceeded = true
        if (request.kind === 'profile') await this.observeProfileQuiet(job, 'after-measurement-boot', false)
        this.writeRecord(job)
        if (debuggerProfile) media.evidence.push(debuggerProfile.evidence())
        if (debuggerProfile?.transport.error && row.signal === null) throw new Error(debuggerProfile.transport.error)
        if (!row.ok || job.cancelRequested) return
        if (debuggerProfile?.transport.accepted && !debuggerProfile.finished) throw new Error('Godot debugger connected but did not finish the profile; no project fallback is claimed')
        if (request.source === 'engine' && !debuggerProfile?.finished) throw new Error('The game never connected to the engine debugger; source "engine" takes no project tables in its place (source "auto" falls back to them)')
        const out = readEngineMediaBoot(boot.resultFile, request, variant, boot.outputDir)
        if (request.kind === 'profile') media.evidence.unshift({ variant, ...out.evidence, source: 'project', phases: out.phases })
        else media.evidence.push({ variant, ...out.evidence })
        media.frames.push(...out.frames)
        if (request.kind === 'capture') {
          record.frames = media.frames
          media.phases.push(...out.phases)
        } else {
          media.selectedSource = debuggerProfile?.finished ? 'engine' : 'project'
          media.sources = ['project', ...(debuggerProfile?.finished ? ['engine debugger'] : [])]
          media.fallbackReason = debuggerProfile && !debuggerProfile.finished ? 'The game never connected to the engine debugger; the project source is selected.' : null
          media.phases.push(...(debuggerProfile?.finished ? debuggerProfile.phases : out.phases))
        }
        this.writeRecord(job)
      } finally {
        await debuggerProfile?.transport.close()
      }
    }
    if (budgetLeft() <= 0) record.budgetExceeded = true
    if (job.cancelRequested || record.budgetExceeded) return
    if (request.kind === 'capture') media.contactSheet = await writeEngineContactSheet(media.frames.map(frame => frame.path), path.join(job.runDir, 'media', 'contact-sheet.png'))
    this.writeRecord(job)
  }

  private async runJob(job: EngineJob, worker: number): Promise<void> {
    job.state = 'running'
    job.worker = worker
    job.startedAt = new Date().toISOString()
    const manifest = this.manifest()
    const selection = job.request.media ? { entries: [], unknown: [] } : resolveEngineSuites(manifest, job.request.suites)
    const selected = job.request.media ? this.mediaNames(job.request.media) : selection.entries.map(e => (e.kind === 'import' ? IMPORT_SUITE_NAME : e.suite.name))
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
      if (record.media?.kind === 'profile') await this.observeProfileQuiet(job, 'before-import', true)
      if (job.cancelRequested) throw new Error('engine job cancelled before import')
      const refusal = await this.leaseRefusal(job)
      if (refusal) throw new Error(refusal)
      record.drift = await sourceProofDrift(this.projectRoot, job.treePath, job.tree, manifest.suites.map(suite => suiteRelativeFile(suite, manifest.defaults)))
      if (job.request.native && !job.request.displayShared) {
        const holder = await this.displayHolder()
        if (job.cancelRequested) throw new Error('engine job cancelled while checking the display')
        if (holder) throw new Error(`native run refused: the display is held by ${holder} — pass displayShared:true to run beside it`)
      }
      const bridged = !job.request.media
      if (bridged) await installVulcanWorkerAddon(job.treePath)
      const hashes = engineTreeHashes(job.tree)
      if (bridged) hashes.key = createHash('sha256').update(hashes.key).update(VULCAN_ADDON_DIGEST).digest('hex')
      const seed = seedEngineTree(this.projectRoot, job.treePath, hashes.key)
      rmSync(path.join(job.treePath, '.godot', 'mercury-vulcan'), { recursive: true, force: true })
      record.importCache = { key: hashes.key, hit: seed.hit, ran: false, seededFrom: seed.seededFrom, stored: false }
      const explicitImport = selection.entries.some(e => e.kind === 'import')
      if (!seed.hit || explicitImport) {
        const timeout = Math.max(1, Math.min(manifest.defaults.importTimeoutMs, budgetLeft()))
        const row = await this.runOne(job, exe.resolved, IMPORT_SUITE_NAME, engineImportArgv(job.treePath), timeout, null, this.userDirFor(job, null), unclean)
        record.results.push(row)
        record.importCache.ran = true
        if (row.ok) record.importCache.stored = storeEngineCache(this.projectRoot, job.treePath, hashes.key).stored
        if (row.timedOut && budgetLeft() <= 0) record.budgetExceeded = true
        this.writeRecord(job)
        if (job.request.media && !row.ok) throw new Error('media import failed; no capture or measurement boot was started')
      }
      record.classCache = classCacheDigest(job.treePath)
      if (job.request.media) {
        await this.runMedia(job, exe.resolved, manifest.defaults.timeoutMs, budgetLeft, unclean)
        if (budgetLeft() <= 0) record.budgetExceeded = true
      }
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
      record.allPass = record.drift.length === 0 && !record.cancelled && !record.budgetExceeded && record.complete && ran.length > 0 && ran.every(r => r.ok) && importRows.every(r => r.ok)
      if (record.media?.quiet.contaminated && record.media.quiet.policy === 'refuse') {
        record.allPass = false
        record.error = 'quiet-machine guard flagged contamination during the profile boot; timings are retained but are not a quiet comparison'
        job.error = record.error
      }
      job.state = job.cancelRequested ? 'cancelled' : 'done'
    } catch (e) {
      record.error = (e as Error).message
      job.error = record.error
      job.state = job.cancelRequested ? 'cancelled' : 'failed'
    } finally {
      record.cancelled = record.cancelled || job.cancelRequested
      if (!job.request.keepTree) removeEngineTree(job.treePath)
      record.tree.kept = job.request.keepTree && existsSync(job.treePath)
      if (!record.tree.kept) this.stopHeartbeat(job.id)
      if (job.request.media && budgetLeft() <= 0) record.budgetExceeded = true
      if (record.cancelled || record.budgetExceeded || record.error !== null) record.allPass = false
      job.endedAt = new Date().toISOString()
      record.endedAt = job.endedAt
      const media = record.media
      if (media?.kind === 'profile' && (media.request.baseline.save || media.request.baseline.compare)) {
        if (job.state === 'done' && record.allPass && !media.quiet.contaminated && job.tree) {
          try {
            finishEngineProfileBaseline(this.projectRoot, job.tree.commit, [...job.tree.overlay].some(([file, blob]) => blob !== job.tree!.baseBlobs.get(file)), record.executable, media)
          } catch (e) {
            media.baseline.reason = `Cannot finish baseline: ${(e as Error).message}`
          }
        } else {
          media.baseline.reason = 'Baseline save and comparison require a successful quiet profile without cancellation, errors, or an exceeded budget.'
        }
      }
      this.writeRecord(job)
      this.running.delete(job.id)
      this.busyWorkers.delete(worker)
      if (NATIVE_JOB === job.id) NATIVE_JOB = null
      this.remember(job)
      for (const service of ACTIVE_SERVICES) service.pump()
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
      this.stopHeartbeat(id)
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
      display: { nativeJob: NATIVE_JOB },
      queued: [...this.queue].sort((a, b) => priorityRank(a.request.priority) - priorityRank(b.request.priority) || a.seq - b.seq).map(summarize),
      running: [...this.running.values()].map(summarize),
      recent: this.recent.slice(0, 20).map(summarize),
      liveEngines: liveEngines(),
      instances: listVulcanInstances(this.projectRoot),
      swept: this.swept,
      sweepError: this.sweepError,
      staleTreesRemoved: this.staleTreesRemoved,
      manifest: { file: manifest.file, found: manifest.found, suites: manifest.suites.map(s => s.name), problems: manifest.problems },
    }
  }

  async shutdown(): Promise<void> {
    for (const job of [...this.queue]) await this.cancel(job.id)
    for (const id of [...this.running.keys()]) await this.cancel(id)
    for (const id of [...this.heartbeats.keys()]) this.stopHeartbeat(id)
    ACTIVE_SERVICES.delete(this)
  }
}
