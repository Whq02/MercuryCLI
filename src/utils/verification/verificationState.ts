
import { adoptiveProjectPath } from '../projectStoreAdoption.js'
import { getMercuryHome } from '../envUtils.js'
import { sanitizePath } from '../sessionStoragePortable.js'
import { execFile, execFileSync, spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { gitExe, markGitTreeSuspect } from '../git.js'
import { subprocessEnv } from '../subprocessEnv.js'
import { logForDebugging } from '../debug.js'
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, mkdtempSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { durableAtomicPublishSync } from '../../substrate/durablePublish.js'
import * as path from 'node:path'
import type { OwnerKey } from '../../services/run/ownerKey.js'
import { registerOwnerScopedStore } from '../../services/run/ownerLifecycle.js'
import { OwnerScopedStore } from '../../services/run/ownerScopedStore.js'
import { processMainOwner } from '../../services/run/resolveOwner.js'
import { flagEnv } from '../../substrate/flagRegistry.js'
import { loadDeclaredGates, matchDeclaredGate } from './projectGates.js'

export type VerificationScope =
  | 'full-gate'
  | 'typecheck'
  | 'suite'
  | 'proof'
  | 'build'
  | 'artifact-smoke'
  | 'fast'
  | 'test'
  | 'lint'
  | 'check'
  | 'read-back'

export interface EvidenceRecord {
  command: string
  ok: boolean
  scope: VerificationScope
  coverage: string
  ranAt: number
  treeDigest: string | null
  seq: number
  gateId?: string
  minRuns?: number
}

export type VerificationStateWord = 'verified' | 'stale' | 'failed' | 'unverified'

export interface VerificationSnapshot {
  state: VerificationStateWord
  detail: string
  lastEvidence: EvidenceRecord | null
  mutationsSinceEvidence: number
  lastMutationAt: number | null
}

const EVIDENCE_SCHEMA = 1
const MAX_RECORDS = 20

interface OwnerVerificationState {
  mutationSeq: number
  lastMutationAt: number | null
  sessionRecords: EvidenceRecord[]
  persistedLoaded: boolean
  pendingReadBack: Set<string>
  pendingUnknownMutation: boolean
  evidenceDemands: number
}

const ownerStates = new OwnerScopedStore<OwnerVerificationState>({
  name: 'verification',
  create: () => ({
    mutationSeq: 0,
    lastMutationAt: null,
    sessionRecords: [],
    persistedLoaded: false,
    pendingReadBack: new Set(),
    pendingUnknownMutation: false,
    evidenceDemands: 0,
  }),
})
registerOwnerScopedStore(ownerStates)

function effectiveOwner(owner?: OwnerKey): OwnerKey {
  return owner ?? processMainOwner()
}

const subscribers = new Set<() => void>()

function notify(): void {
  for (const cb of subscribers) {
    try {
      cb()
    } catch {
    }
  }
}

export function subscribeVerification(cb: () => void): () => void {
  subscribers.add(cb)
  return () => {
    subscribers.delete(cb)
  }
}

export function _resetVerificationStateForTesting(): void {
  ownerStates.clearAllForShutdown()
  digestCache.clear()
  treeScanRecords.clear()
}

export function disposeVerificationOwner(owner: OwnerKey): void {
  ownerStates.dispose(owner)
}

export function _verificationOwnerCountForTesting(): number {
  return ownerStates.size
}

const digestCache = new Map<string, { digest: string | null; at: number }>()

const HARNESS_DIRS = ['.claude', '.mercury'] as const
const EXCLUDE_HARNESS = HARNESS_DIRS.map(d => `:(exclude,glob)**/${d}/**`)
const SLOW_SCAN_MS = 2_000
const SCAN_INTERVAL_FLOOR_MS = 30_000
const SCAN_INTERVAL_CAP_MS = 600_000
const DEFAULT_SCAN_CEILING = 100_000
const DEFAULT_SCAN_TIMEOUT_MS = 30_000
const STALE_INDEX_LOCK_MS = 60_000
const MAX_GIT_OUTPUT = 16 * 1024 * 1024
const SHAPE_PROBE = ['rev-parse', '--show-prefix', '--git-path', 'objects', '--absolute-git-dir']
const REPOSITORY_WATCH_MS = 250
const COUNT_PROBE = ['ls-files', '-z', '-c', '-o', '--exclude-standard', '--', '.']

export type TreeScanFault = { kind: 'timeout' | 'error'; detail: string; at: number }

export interface TreeScanRecord {
  prefix: string
  indexFile: string
  objectsDir: string
  repoObjects: string
  gitDir: string
  repoToken: string
  fileCount: number
  aboveCeiling: boolean
  scans: number
  lastScanAt: number
  lastScanMs: number
  minIntervalMs: number
  lastDigest: string | null | undefined
  fault: TreeScanFault | null
  notice: string | null
  road: 'exclude' | 'reset'
}

const treeScanRecords = new Map<string, TreeScanRecord | null>()
const digestInFlight = new Map<string, Promise<string | null>>()

function scanCeiling(): number {
  const raw = Number(flagEnv('MERCURY_TREE_SCAN_CEILING'))
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : DEFAULT_SCAN_CEILING
}

function scanTimeoutMs(): number {
  const raw = Number(flagEnv('MERCURY_TREE_SCAN_TIMEOUT_MS'))
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : DEFAULT_SCAN_TIMEOUT_MS
}

function verifyStoreDir(cwd: string): string {
  return path.join(getMercuryHome(), 'verify', sanitizePath(cwd))
}

function fmtCount(n: number): string {
  return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ',')
}

function fmtInterval(ms: number): string {
  return ms >= 60_000 ? `${Math.round(ms / 60_000)} min` : `${Math.round(ms / 1000)} s`
}

class GitStepError extends Error {
  constructor(
    readonly step: string,
    readonly stderr: string,
    readonly timedOut: boolean,
  ) {
    super(`git ${step}: ${timedOut ? 'timed out' : stderr.trim() || 'failed'}`)
  }
}

function stepError(step: string, err: unknown): GitStepError {
  const e = err as { stderr?: unknown; killed?: boolean; signal?: string | null; code?: unknown; message?: string }
  const stderr = typeof e?.stderr === 'string' ? e.stderr : Buffer.isBuffer(e?.stderr) ? e.stderr.toString('utf8') : ''
  const timedOut = Boolean(e?.killed) || e?.code === 'ETIMEDOUT' || e?.signal === 'SIGTERM'
  return new GitStepError(step, stderr || String(e?.message ?? ''), timedOut)
}

function isIndexBusy(err: unknown): boolean {
  return err instanceof GitStepError && !err.timedOut && /index\.lock/.test(err.stderr)
}

class RepositoryGoneError extends Error {
  constructor(readonly step: string) {
    super(`git ${step}: the repository is gone`)
  }
}

const activeChildren = new Map<string, Set<ChildProcess>>()
const goneChildren = new WeakSet<ChildProcess>()

type RepositoryWatch = { cwd: string; gitDir: string }

function repoTokenOf(gitDir: string): string {
  const st = statSync(gitDir)
  return `${st.dev}:${st.ino}${st.birthtimeMs > 0 ? `:${Math.round(st.birthtimeMs)}` : ''}`
}

function repositoryStillThere(rec: TreeScanRecord): boolean {
  try {
    return repoTokenOf(rec.gitDir) === rec.repoToken
  } catch {
    return false
  }
}

function forgetRepository(cwd: string): void {
  treeScanRecords.delete(cwd)
  digestCache.delete(cwd)
}

export function _treeScanChildrenForTesting(cwd: string): number {
  return activeChildren.get(cwd)?.size ?? 0
}

export async function invalidateTreeScans(cwd: string): Promise<void> {
  const children = [...(activeChildren.get(cwd) ?? [])]
  const inFlight = digestInFlight.get(cwd)
  for (const child of children) goneChildren.add(child)
  await Promise.all(
    children.map(
      child =>
        new Promise<void>(done => {
          if (child.exitCode !== null || child.signalCode !== null) {
            done()
            return
          }
          child.once('close', () => done())
          try {
            child.kill()
          } catch {
            done()
          }
        }),
    ),
  )
  if (inFlight) await inFlight.catch(() => null)
  activeChildren.delete(cwd)
  forgetRepository(cwd)
}

function gitTextSync(cwd: string, env: NodeJS.ProcessEnv, args: string[]): string {
  try {
    return execFileSync(gitExe(), args, {
      windowsHide: true,
      cwd,
      env,
      stdio: 'pipe',
      timeout: scanTimeoutMs(),
      maxBuffer: MAX_GIT_OUTPUT,
      encoding: 'utf8',
    })
  } catch (err) {
    throw stepError(args[0] ?? 'git', err)
  }
}

function gitTextAsync(cwd: string, env: NodeJS.ProcessEnv, args: string[], watch?: RepositoryWatch): Promise<string> {
  return new Promise((resolve, reject) => {
    let unregister = (): void => {}
    const child = execFile(gitExe(), args, { windowsHide: true, cwd, env, timeout: scanTimeoutMs(), maxBuffer: MAX_GIT_OUTPUT }, (err, stdout) => {
      unregister()
      if (goneChildren.has(child)) reject(new RepositoryGoneError(args[0] ?? 'git'))
      else if (err) reject(stepError(args[0] ?? 'git', err))
      else resolve(stdout)
    })
    if (!watch) return
    const children = activeChildren.get(watch.cwd) ?? new Set<ChildProcess>()
    children.add(child)
    activeChildren.set(watch.cwd, children)
    const timer = setInterval(() => {
      if (existsSync(watch.gitDir)) return
      goneChildren.add(child)
      try {
        child.kill()
      } catch {
      }
    }, REPOSITORY_WATCH_MS)
    timer.unref?.()
    unregister = () => {
      clearInterval(timer)
      children.delete(child)
      if (children.size === 0 && activeChildren.get(watch.cwd) === children) activeChildren.delete(watch.cwd)
    }
  })
}

interface RepositoryShape {
  prefix: string
  repoObjects: string
  gitDir: string
}

function parseShapeProbe(cwd: string, out: string): RepositoryShape | null {
  const [prefixLine = '', objectsLine = '', gitDirLine = ''] = out.split(/\r?\n/)
  const objects = objectsLine.trim()
  const gitDir = gitDirLine.trim()
  if (objects === '' || gitDir === '') return null
  return { prefix: prefixLine.trim(), repoObjects: path.resolve(cwd, objects), gitDir: path.resolve(cwd, gitDir) }
}

function countNul(buf: Buffer | string | undefined): number {
  if (!buf) return 0
  let n = 0
  if (typeof buf === 'string') {
    for (let i = 0; i < buf.length; i++) if (buf.charCodeAt(i) === 0) n++
    return n
  }
  for (let i = 0; i < buf.length; i++) if (buf[i] === 0) n++
  return n
}

function mintRecord(cwd: string, shape: RepositoryShape, count: { files: number; above: boolean }): TreeScanRecord {
  const store = verifyStoreDir(cwd)
  return {
    prefix: shape.prefix,
    indexFile: path.join(store, 'index'),
    objectsDir: path.join(store, 'objects'),
    repoObjects: shape.repoObjects,
    gitDir: shape.gitDir,
    repoToken: repoTokenOf(shape.gitDir),
    fileCount: count.files,
    aboveCeiling: count.above,
    scans: 0,
    lastScanAt: 0,
    lastScanMs: 0,
    minIntervalMs: 0,
    lastDigest: undefined,
    fault: null,
    notice: null,
    road: 'exclude',
  }
}

function scanRecordSync(cwd: string): TreeScanRecord | null {
  const known = treeScanRecords.get(cwd)
  if (known !== undefined) return known
  let rec: TreeScanRecord | null = null
  try {
    const env = subprocessEnv()
    const shape = parseShapeProbe(cwd, gitTextSync(cwd, env, SHAPE_PROBE))
    if (shape) {
      const ceiling = scanCeiling()
      const res = spawnSync(gitExe(), COUNT_PROBE, {
        windowsHide: true,
        cwd,
        env,
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: scanTimeoutMs(),
        maxBuffer: ceiling * 128,
      })
      const overflowed = (res.error as NodeJS.ErrnoException | undefined)?.code === 'ENOBUFS' || res.signal !== null
      const files = countNul(res.stdout)
      rec = mintRecord(cwd, shape, { files: overflowed ? Math.max(files, ceiling + 1) : files, above: overflowed || files > ceiling })
    }
  } catch {
    rec = null
  }
  treeScanRecords.set(cwd, rec)
  return rec
}

function countFilesAsync(cwd: string, env: NodeJS.ProcessEnv, ceiling: number): Promise<{ files: number; above: boolean }> {
  return new Promise(resolve => {
    let files = 0
    let done = false
    const finish = (r: { files: number; above: boolean }): void => {
      if (done) return
      done = true
      resolve(r)
    }
    let child: ReturnType<typeof spawn>
    try {
      child = spawn(gitExe(), COUNT_PROBE, { windowsHide: true, cwd, env, stdio: ['ignore', 'pipe', 'ignore'] })
    } catch {
      finish({ files: 0, above: false })
      return
    }
    const stop = (): void => {
      try {
        child.kill()
      } catch {
      }
    }
    const timer = setTimeout(() => {
      stop()
      finish({ files: Math.max(files, ceiling + 1), above: true })
    }, scanTimeoutMs())
    child.stdout?.on('data', (chunk: Buffer) => {
      files += countNul(chunk)
      if (files > ceiling) {
        clearTimeout(timer)
        stop()
        finish({ files, above: true })
      }
    })
    child.on('error', () => {
      clearTimeout(timer)
      finish({ files: 0, above: false })
    })
    child.on('close', () => {
      clearTimeout(timer)
      finish({ files, above: files > ceiling })
    })
  })
}

async function scanRecordAsync(cwd: string): Promise<TreeScanRecord | null> {
  const known = treeScanRecords.get(cwd)
  if (known !== undefined) return known
  let rec: TreeScanRecord | null = null
  try {
    const env = subprocessEnv()
    const shape = parseShapeProbe(cwd, await gitTextAsync(cwd, env, SHAPE_PROBE))
    if (shape) rec = mintRecord(cwd, shape, await countFilesAsync(cwd, env, scanCeiling()))
  } catch {
    rec = null
  }
  treeScanRecords.set(cwd, rec)
  return rec
}

function scanEnv(rec: TreeScanRecord): NodeJS.ProcessEnv {
  return {
    ...subprocessEnv(),
    GIT_INDEX_FILE: rec.indexFile,
    GIT_OBJECT_DIRECTORY: rec.objectsDir,
    GIT_ALTERNATE_OBJECT_DIRECTORIES: rec.repoObjects,
  }
}

function prefixArg(rec: TreeScanRecord): string[] {
  return rec.prefix ? [`--prefix=${rec.prefix}`] : []
}

function prepareStore(rec: TreeScanRecord): void {
  mkdirSync(path.dirname(rec.indexFile), { recursive: true })
  mkdirSync(rec.objectsDir, { recursive: true })
  const lock = `${rec.indexFile}.lock`
  try {
    if (Date.now() - statSync(lock).mtimeMs > STALE_INDEX_LOCK_MS) rmSync(lock, { force: true })
  } catch {
  }
}

function sweepObjects(rec: TreeScanRecord): void {
  rmSync(rec.objectsDir, { recursive: true, force: true })
}

function scanTreeSync(cwd: string, rec: TreeScanRecord): string | null {
  const env = scanEnv(rec)
  prepareStore(rec)
  if (!existsSync(rec.indexFile)) gitTextSync(cwd, env, ['read-tree', 'HEAD'])
  stageSync(cwd, env, rec)
  const tree = gitTextSync(cwd, env, ['write-tree', '--missing-ok', ...prefixArg(rec)]).trim()
  sweepObjects(rec)
  return tree || null
}

function stageSync(cwd: string, env: NodeJS.ProcessEnv, rec: TreeScanRecord): void {
  if (rec.road === 'exclude') {
    try {
      gitTextSync(cwd, env, ['add', '-A', '--', '.', ...EXCLUDE_HARNESS])
      return
    } catch (err) {
      if (isIndexBusy(err) || (err instanceof GitStepError && err.timedOut)) throw err
      rec.road = 'reset'
    }
  }
  gitTextSync(cwd, env, ['add', '-A', '--', '.'])
  gitTextSync(cwd, env, ['reset', '-q', '--', ...HARNESS_DIRS])
}

async function stageAsync(cwd: string, env: NodeJS.ProcessEnv, rec: TreeScanRecord, watch: RepositoryWatch): Promise<void> {
  if (rec.road === 'exclude') {
    try {
      await gitTextAsync(cwd, env, ['add', '-A', '--', '.', ...EXCLUDE_HARNESS], watch)
      return
    } catch (err) {
      if (isIndexBusy(err) || err instanceof RepositoryGoneError || (err instanceof GitStepError && err.timedOut)) throw err
      rec.road = 'reset'
    }
  }
  await gitTextAsync(cwd, env, ['add', '-A', '--', '.'], watch)
  await gitTextAsync(cwd, env, ['reset', '-q', '--', ...HARNESS_DIRS], watch)
}

async function scanTreeAsync(cwd: string, rec: TreeScanRecord): Promise<string | null> {
  const env = scanEnv(rec)
  const watch: RepositoryWatch = { cwd, gitDir: rec.gitDir }
  prepareStore(rec)
  if (!existsSync(rec.indexFile)) await gitTextAsync(cwd, env, ['read-tree', 'HEAD'], watch)
  await stageAsync(cwd, env, rec, watch)
  const tree = (await gitTextAsync(cwd, env, ['write-tree', '--missing-ok', ...prefixArg(rec)], watch)).trim()
  sweepObjects(rec)
  return tree || null
}

function scanTreePrivateSync(cwd: string, rec: TreeScanRecord): string | null {
  const idxDir = mkdtempSync(path.join(tmpdir(), 'verify-tree-'))
  try {
    const env = {
      ...subprocessEnv(),
      GIT_INDEX_FILE: path.join(idxDir, 'index'),
      GIT_OBJECT_DIRECTORY: path.join(idxDir, 'objects'),
      GIT_ALTERNATE_OBJECT_DIRECTORIES: rec.repoObjects,
    }
    gitTextSync(cwd, env, ['read-tree', 'HEAD'])
    stageSync(cwd, env, rec)
    return gitTextSync(cwd, env, ['write-tree', '--missing-ok', ...prefixArg(rec)]).trim() || null
  } catch {
    return null
  } finally {
    rmSync(idxDir, { recursive: true, force: true })
  }
}

function noticeOnce(rec: TreeScanRecord, text: string): void {
  if (rec.notice !== null) return
  rec.notice = text
  logForDebugging(`[verify] ${text}`, { level: 'warn' })
  notify()
}

function accountScan(rec: TreeScanRecord, ms: number, digest: string | null): void {
  rec.scans++
  rec.lastScanAt = Date.now()
  rec.lastScanMs = ms
  rec.lastDigest = digest
  rec.fault = null
  if (ms > SLOW_SCAN_MS && rec.scans > 1) {
    rec.minIntervalMs = Math.min(SCAN_INTERVAL_CAP_MS, Math.max(SCAN_INTERVAL_FLOOR_MS, rec.minIntervalMs * 2))
    noticeOnce(rec, `tree scan took ${fmtCount(ms)} ms over ${fmtCount(rec.fileCount)} files — the fingerprint now refreshes at most every ${fmtInterval(rec.minIntervalMs)}`)
  }
}

function recordFault(rec: TreeScanRecord, err: unknown): void {
  const e = err instanceof GitStepError ? err : new GitStepError('scan', String(err), false)
  const seconds = scanTimeoutMs() / 1000
  const detail = e.timedOut
    ? `the scan timed out after ${seconds < 1 ? seconds.toFixed(1) : Math.round(seconds)} s over ${fmtCount(rec.fileCount)} files (git ${e.step})`
    : e.message.slice(0, 160)
  rec.fault = { kind: e.timedOut ? 'timeout' : 'error', detail, at: Date.now() }
  rec.lastScanAt = Date.now()
  rec.lastDigest = null
  rec.minIntervalMs = Math.min(SCAN_INTERVAL_CAP_MS, Math.max(SCAN_INTERVAL_FLOOR_MS, rec.minIntervalMs * 2))
  if (!e.timedOut) rmSync(rec.indexFile, { force: true })
  noticeOnce(rec, `tree unmeasured — ${detail}`)
}

function noticeCeiling(rec: TreeScanRecord): void {
  noticeOnce(rec, `tree unmeasured — ${fmtCount(rec.fileCount)}+ files, above the ${fmtCount(scanCeiling())}-file scan ceiling`)
}

function withinBudget(rec: TreeScanRecord): boolean {
  return rec.minIntervalMs > 0 && rec.lastDigest !== undefined && Date.now() - rec.lastScanAt < rec.minIntervalMs
}

export type TreeScanStatus =
  | { state: 'unknown' }
  | { state: 'measured'; fileCount: number; scans: number; lastScanMs: number; minIntervalMs: number; notice: string | null }
  | { state: 'unmeasured'; reason: 'ceiling' | 'timeout' | 'error'; detail: string; fileCount: number; notice: string | null }

export function treeScanStatus(cwd: string): TreeScanStatus {
  const rec = treeScanRecords.get(cwd)
  if (!rec) return { state: 'unknown' }
  if (rec.aboveCeiling) {
    return { state: 'unmeasured', reason: 'ceiling', detail: `${fmtCount(rec.fileCount)}+ files, above the ${fmtCount(scanCeiling())}-file scan ceiling`, fileCount: rec.fileCount, notice: rec.notice }
  }
  if (rec.fault) return { state: 'unmeasured', reason: rec.fault.kind, detail: rec.fault.detail, fileCount: rec.fileCount, notice: rec.notice }
  if (rec.scans === 0) return { state: 'unknown' }
  return { state: 'measured', fileCount: rec.fileCount, scans: rec.scans, lastScanMs: rec.lastScanMs, minIntervalMs: rec.minIntervalMs, notice: rec.notice }
}

export function treeScanNote(cwd: string): string | null {
  const s = treeScanStatus(cwd)
  if (s.state === 'unmeasured') return `tree unmeasured — ${s.detail}`
  if (s.state === 'measured' && s.notice !== null) return s.notice
  return null
}

export function markTreeSuspectAfterTurn(): void {
  digestCache.clear()
  for (const [cwd, rec] of treeScanRecords) if (rec === null) treeScanRecords.delete(cwd)
  markGitTreeSuspect('tree')
}

export function computeWorkingTreeDigest(cwd: string, opts?: { fresh?: boolean }): string | null {
  const cached = digestCache.get(cwd)
  if (cached && !opts?.fresh) return cached.digest
  const rec = scanRecordSync(cwd)
  if (rec === null) {
    digestCache.set(cwd, { digest: null, at: Date.now() })
    return null
  }
  if (!repositoryStillThere(rec)) {
    forgetRepository(cwd)
    return null
  }
  if (rec.aboveCeiling) {
    noticeCeiling(rec)
    digestCache.set(cwd, { digest: null, at: Date.now() })
    return null
  }
  if (!opts?.fresh && withinBudget(rec)) return rec.lastDigest ?? null
  if (digestInFlight.has(cwd)) return opts?.fresh ? scanTreePrivateSync(cwd, rec) : (rec.lastDigest ?? null)
  const t0 = Date.now()
  let digest: string | null
  try {
    digest = scanTreeSync(cwd, rec)
    accountScan(rec, Date.now() - t0, digest)
  } catch (err) {
    if (isIndexBusy(err)) return opts?.fresh ? scanTreePrivateSync(cwd, rec) : (rec.lastDigest ?? null)
    digest = null
    recordFault(rec, err)
  }
  digestCache.set(cwd, { digest, at: Date.now() })
  return digest
}

export function computeWorkingTreeDigestAsync(cwd: string, opts?: { fresh?: boolean }): Promise<string | null> {
  const cached = digestCache.get(cwd)
  if (cached && !opts?.fresh) return Promise.resolve(cached.digest)
  const inFlight = digestInFlight.get(cwd)
  if (inFlight) return inFlight
  const build = (async (): Promise<string | null> => {
    try {
      const rec = await scanRecordAsync(cwd)
      if (rec === null) {
        digestCache.set(cwd, { digest: null, at: Date.now() })
        return null
      }
      if (!repositoryStillThere(rec)) {
        forgetRepository(cwd)
        return null
      }
      if (rec.aboveCeiling) {
        noticeCeiling(rec)
        digestCache.set(cwd, { digest: null, at: Date.now() })
        return null
      }
      if (!opts?.fresh && withinBudget(rec)) return rec.lastDigest ?? null
      const t0 = Date.now()
      let digest: string | null
      try {
        digest = await scanTreeAsync(cwd, rec)
        accountScan(rec, Date.now() - t0, digest)
      } catch (err) {
        if (err instanceof RepositoryGoneError) {
          forgetRepository(cwd)
          return null
        }
        if (isIndexBusy(err)) return rec.lastDigest ?? null
        digest = null
        recordFault(rec, err)
      }
      digestCache.set(cwd, { digest, at: Date.now() })
      return digest
    } finally {
      digestInFlight.delete(cwd)
    }
  })()
  digestInFlight.set(cwd, build)
  return build
}

function evidencePath(cwd: string): string {
  return path.join(verifyStoreDir(cwd), 'evidence.json')
}
function workspaceEvidencePath(cwd: string): string {
  return path.join(adoptiveProjectPath(cwd, 'verify'), 'evidence.json')
}
function workspaceEvidenceOptIn(): boolean {
  const v = flagEnv('MERCURY_WORKSPACE_EVIDENCE')
  return v === '1' || v === 'true'
}

function loadPersisted(cwd: string, state: OwnerVerificationState): void {
  if (state.persistedLoaded) return
  state.persistedLoaded = true
  try {
    let raw: string
    try {
      raw = readFileSync(evidencePath(cwd), 'utf8')
    } catch {
      raw = readFileSync(workspaceEvidencePath(cwd), 'utf8')
    }
    const parsed = JSON.parse(raw) as { schema?: number; records?: EvidenceRecord[] }
    if (parsed.schema === EVIDENCE_SCHEMA && Array.isArray(parsed.records)) {
      state.sessionRecords = parsed.records.slice(-MAX_RECORDS).map(r => ({ ...r, seq: 0 }))
    }
  } catch {
  }
}

function persist(cwd: string, state: OwnerVerificationState): void {
  try {
    const payload = JSON.stringify({ schema: EVIDENCE_SCHEMA, records: state.sessionRecords.slice(-MAX_RECORDS) }, null, 2)
    durableAtomicPublishSync(evidencePath(cwd), payload)
    if (workspaceEvidenceOptIn()) {
      durableAtomicPublishSync(workspaceEvidencePath(cwd), payload)
    }
  } catch {
  }
}

const MUTATION_TOOLS = new Set(['Edit', 'Write', 'NotebookEdit', 'MultiEdit'])

export function isMutationToolCall(toolName: string, _input: unknown): boolean {
  return MUTATION_TOOLS.has(toolName)
}

export function canonicalEvidencePath(p: string): string {
  const resolved = path.resolve(p)
  try {
    return realpathSync(resolved)
  } catch {
    return resolved
  }
}

export function markMutation(
  owner?: OwnerKey,
  changedPaths?: readonly string[],
  cwd?: string,
  opts?: {
    digestReceipted?: boolean
  },
): void {
  const state = ownerStates.get(effectiveOwner(owner))
  state.mutationSeq++
  state.lastMutationAt = Date.now()
  if (changedPaths && changedPaths.length > 0) {
    if (!opts?.digestReceipted) {
      for (const p of changedPaths) state.pendingReadBack.add(canonicalEvidencePath(p))
    }
  } else {
    state.pendingUnknownMutation = true
  }
  state.evidenceDemands = 0
  if (cwd !== undefined) digestCache.delete(cwd)
  else digestCache.clear()
  if (cwd !== undefined && treeScanRecords.get(cwd) === null) treeScanRecords.delete(cwd)
  if (cwd !== undefined) verifiableCache.delete(cwd)
  else verifiableCache.clear()
  markGitTreeSuspect('tree')
  notify()
}

export function verifyEvidenceEnabled(): boolean {
  return flagEnv('MERCURY_VERIFY_EVIDENCE') !== '0'
}

export function observeCompletedToolCall(
  toolName: string,
  input: unknown,
  ok: boolean,
  cwd: string,
  owner?: OwnerKey,
  lifecycle?: 'terminal' | 'launch',
): void {
  try {
    if (!verifyEvidenceEnabled()) return
    if (ok && isMutationToolCall(toolName, input)) {
      const p = (input as { file_path?: unknown; notebook_path?: unknown } | undefined)
      const filePath = typeof p?.file_path === 'string' ? p.file_path : typeof p?.notebook_path === 'string' ? p.notebook_path : null
      markMutation(owner, filePath ? [filePath] : undefined, cwd)
      return
    }
    if (ok && toolName === 'Read') {
      const inp = input as { file_path?: unknown; offset?: unknown; limit?: unknown } | undefined
      if (typeof inp?.file_path === 'string' && inp.offset === undefined && inp.limit === undefined) {
        noteReadBack(cwd, inp.file_path, owner)
      }
      return
    }
    if (toolName === 'Bash' || toolName === 'PowerShell') {
      if (lifecycle === 'launch') return
      const command = String((input as { command?: unknown } | undefined)?.command ?? '')
      if (ok && /(^|[\s;&|(])git\s/.test(command)) markGitTreeSuspect('git')
      const cls = classifyVerificationCommand(command, cwd)
      if (cls) recordEvidence(cwd, { command, ok, ...cls }, owner)
    }
  } catch {
  }
}


const verifiableCache = new Map<string, { verdict: boolean; at: number }>()
const VERIFIABLE_TTL_MS = 60_000
const VERIFIABLE_NEGATIVE_TTL_MS = 5_000

export function workspaceVerifiable(cwd: string, owner?: OwnerKey): boolean {
  const state = ownerStates.peek(effectiveOwner(owner))
  if (state?.sessionRecords.some(r => r.scope !== 'read-back')) return true
  const cached = verifiableCache.get(cwd)
  if (
    cached &&
    Date.now() - cached.at <
      (cached.verdict ? VERIFIABLE_TTL_MS : VERIFIABLE_NEGATIVE_TTL_MS)
  ) {
    return cached.verdict
  }
  let verdict = false
  try {
    const has = (rel: string): boolean => {
      try {
        return existsSync(path.join(cwd, rel))
      } catch {
        return false
      }
    }
    if (has('scripts/run-all-suites.sh')) verdict = true
    if (!verdict && loadDeclaredGates(cwd).length > 0) verdict = true
    if (!verdict && has('project.godot')) verdict = true
    if (!verdict && has('package.json')) {
      try {
        const pkg = JSON.parse(readFileSync(path.join(cwd, 'package.json'), 'utf8')) as {
          scripts?: Record<string, unknown>
        }
        const s = pkg.scripts ?? {}
        verdict = ['test', 'typecheck', 'verify', 'check', 'lint'].some(k => typeof s[k] === 'string')
      } catch {
      }
    }
    if (!verdict) {
      verdict = ['vitest.config.ts', 'vitest.config.js', 'jest.config.ts', 'jest.config.js', 'Makefile'].some(has)
    }
    if (!verdict && has('scripts')) {
      try {
        verdict = readdirSync(path.join(cwd, 'scripts'), { withFileTypes: true }).some(
          d => d.isDirectory() && existsSync(path.join(cwd, 'scripts', d.name, 'run-all.sh')),
        )
      } catch {
      }
    }
  } catch {
    verdict = false
  }
  verifiableCache.set(cwd, { verdict, at: Date.now() })
  return verdict
}

function noteReadBack(cwd: string, filePath: string, owner?: OwnerKey): void {
  const state = ownerStates.get(effectiveOwner(owner))
  const abs = canonicalEvidencePath(filePath)
  if (!state.pendingReadBack.delete(abs)) return
  if (
    state.pendingReadBack.size === 0 &&
    !state.pendingUnknownMutation &&
    state.mutationSeq > (state.sessionRecords.at(-1)?.seq ?? 0) &&
    !workspaceVerifiable(cwd, owner)
  ) {
    recordEvidence(
      cwd,
      {
        command: '(read-back)',
        ok: true,
        scope: 'read-back',
        coverage: 'changed files read back (no verification machinery in this workspace)',
      },
      owner,
    )
  }
}

const EMPTY_PATH_SET: ReadonlySet<string> = new Set()

export function demandedReadBackPaths(cwd: string, owner?: OwnerKey): ReadonlySet<string> {
  const state = ownerStates.peek(effectiveOwner(owner))
  if (!state || state.pendingReadBack.size === 0) return EMPTY_PATH_SET
  if (workspaceVerifiable(cwd, owner)) return EMPTY_PATH_SET
  return new Set(state.pendingReadBack)
}

export function noteEvidenceDemandIssued(owner?: OwnerKey): void {
  const state = ownerStates.get(effectiveOwner(owner))
  state.evidenceDemands++
}

export function evidenceDemandCount(owner?: OwnerKey): number {
  return ownerStates.peek(effectiveOwner(owner))?.evidenceDemands ?? 0
}


export function stripQuotedShellArgs(text: string): string {
  return text.replace(/"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'/g, '""')
}

export function leadingShellCommandToken(segment: string): string {
  const tok = segment.trim().split(/\s+/)[0] ?? ''
  return tok.replace(/^.*[\\/]/, '').toLowerCase()
}

export const NOOP_COMMAND_HEADS: ReadonlySet<string> = new Set([
  'echo', 'printf', 'true', 'false', ':', 'cat', 'ls', 'pwd', 'test', '[',
])

export type ShellChainOp = '&&' | 'pipe' | 'or' | 'break'
export interface ShellCommandSegment {
  text: string
  opBefore: ShellChainOp | 'start'
}

export function splitShellControlOps(command: string): ShellCommandSegment[] {
  const bare = stripQuotedShellArgs(command)
    .replace(/\d*>&\d*/g, '>')
    .replace(/&>>?/g, '>')
  const parts = bare.split(/(&&|\|\||;|\n|&|\|)/)
  const segments: ShellCommandSegment[] = []
  let opBefore: ShellCommandSegment['opBefore'] = 'start'
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i]
    if (part === undefined) continue
    if (i % 2 === 1) {
      opBefore = part === '&&' ? '&&' : part === '|' ? 'pipe' : part === '||' ? 'or' : 'break'
      continue
    }
    if (part.trim() === '') continue
    segments.push({ text: part, opBefore })
  }
  return segments
}

export function pipefailActiveBefore(
  segments: readonly ShellCommandSegment[],
  i: number,
): boolean {
  for (let j = 0; j < i; j++) {
    if (/\bset\s+(?:-[a-zA-Z]+\s+)*-[a-zA-Z]*o\s+pipefail\b/.test(segments[j]!.text)) return true
  }
  return false
}

export function projectVerifyPattern(): RegExp | null {
  const raw = flagEnv('MERCURY_VERIFY_PATTERN')
  if (!raw) return null
  try {
    return new RegExp(raw, 'i')
  } catch {
    return null
  }
}

function verbScope(verb: string): VerificationScope {
  const v = verb.toLowerCase()
  if (v === 'test') return 'test'
  if (v === 'typecheck') return 'typecheck'
  if (v === 'build') return 'build'
  if (v === 'lint') return 'lint'
  return 'check'
}

const GENERIC_VERBS = 'test|build|typecheck|lint|check|validate|verify|ci'

const NPM_VERB_RE = new RegExp(
  `\\b(npm|yarn|pnpm)\\s+(?:(?:--prefix|-w|--workspace|-C|--dir|--cwd|cwd|--filter|-F)(?:[=\\s]\\S+)?\\s+)?(?:workspace\\s+\\S+\\s+)?(?:run\\s+)?(${GENERIC_VERBS})(?::\\S+)?\\b`,
  'i',
)
const MAKE_VERB_RE = new RegExp(`\\bmake\\s+(${GENERIC_VERBS})\\b`, 'i')
const JUST_VERB_RE = new RegExp(`\\bjust\\s+(${GENERIC_VERBS})\\b`, 'i')

export interface VerifyClassification {
  scope: VerificationScope
  coverage: string
  gateId?: string
  minRuns?: number
}

export function classifyVerifySegment(
  segment: string,
  cwd?: string,
): VerifyClassification | null {
  const c = segment.trim()
  if (!c || NOOP_COMMAND_HEADS.has(leadingShellCommandToken(c))) return null
  if (cwd !== undefined) {
    const declared = matchDeclaredGate(c, cwd)
    if (declared) return declared
  }
  if (/run-all-suites\.sh/.test(c)) {
    const m = c.match(/run-all-suites\.sh\s+([a-z0-9 _-]+)/)
    return m?.[1]?.trim()
      ? { scope: 'suite', coverage: `gate subset: ${m[1].trim()}` }
      : { scope: 'full-gate', coverage: 'full gate (every domain suite)' }
  }
  if (/scripts\/typecheck\/run-all\.sh|bun run typecheck\b/.test(c)) {
    return { scope: 'typecheck', coverage: 'strict typecheck floor' }
  }
  const suite = c.match(/scripts\/([a-z0-9-]+)\/run-all\.sh/)
  if (suite?.[1]) return { scope: 'suite', coverage: `scripts/${suite[1]} suite` }
  const proof = c.match(/(prove-[a-z0-9-]+\.ts)/)
  if (proof?.[1]) return { scope: 'proof', coverage: proof[1] }
  if (/scripts\/verify\/fast\.ts|bun run verify:fast\b/.test(c)) {
    return { scope: 'fast', coverage: 'verify:fast (slice rung)' }
  }
  if (/bun run verify\b/.test(c)) return { scope: 'full-gate', coverage: 'full gate (bun run verify)' }
  if (/bun run artifact:smoke\b/.test(c)) return { scope: 'artifact-smoke', coverage: 'isolated artifact smoke' }
  if (/bun run build\.ts|bun run build\b/.test(c)) return { scope: 'build', coverage: 'real artifact build' }
  if (/\bbun\s+(run\s+)?test\b|\bvitest\b(?! --version)/.test(c)) return { scope: 'test', coverage: 'test run' }
  const npm = c.match(NPM_VERB_RE)
  if (npm?.[1] && npm[2]) {
    return { scope: verbScope(npm[2]), coverage: `${npm[1].toLowerCase()} ${npm[2].toLowerCase()}` }
  }
  if (/\bpytest\b/i.test(c)) return { scope: 'test', coverage: 'pytest' }
  if (/\bpython3?\s+\S*test/i.test(c)) return { scope: 'test', coverage: 'python test run' }
  if (/\bgo\s+test\b/i.test(c)) return { scope: 'test', coverage: 'go test' }
  const cargo = c.match(/\bcargo\s+(test|build|check)\b/i)
  if (cargo?.[1]) return { scope: verbScope(cargo[1]), coverage: `cargo ${cargo[1].toLowerCase()}` }
  if (/\btsc\b/.test(c)) return { scope: 'typecheck', coverage: 'tsc' }
  if (/\bjest\b/i.test(c)) return { scope: 'test', coverage: 'jest' }
  const make = c.match(MAKE_VERB_RE)
  if (make?.[1]) return { scope: verbScope(make[1]), coverage: `make ${make[1].toLowerCase()}` }
  if (/\bnode\s+--test\b/i.test(c)) return { scope: 'test', coverage: 'node --test' }
  const just = c.match(JUST_VERB_RE)
  if (just?.[1]) return { scope: verbScope(just[1]), coverage: `just ${just[1].toLowerCase()}` }
  const gradle = c.match(/\bgradlew?\s+(test|check|build)\b/i)
  if (gradle?.[1]) return { scope: verbScope(gradle[1]), coverage: `gradle ${gradle[1].toLowerCase()}` }
  const mvn = c.match(/\bmvn\s+(?:-\S+\s+)*(test|verify|package)\b/i)
  if (mvn?.[1]) return { scope: mvn[1].toLowerCase() === 'test' ? 'test' : 'check', coverage: `mvn ${mvn[1].toLowerCase()}` }
  if (/\bsbt\s+test\b/i.test(c)) return { scope: 'test', coverage: 'sbt test' }
  const dotnet = c.match(/\bdotnet\s+(test|build)\b/i)
  if (dotnet?.[1]) return { scope: verbScope(dotnet[1]), coverage: `dotnet ${dotnet[1].toLowerCase()}` }
  const bazel = c.match(/\bbazel\s+(test|build)\b/i)
  if (bazel?.[1]) return { scope: verbScope(bazel[1]), coverage: `bazel ${bazel[1].toLowerCase()}` }
  if (/\brake\s+(test|spec)\b/i.test(c)) return { scope: 'test', coverage: 'rake test' }
  if (/\bmix\s+test\b/i.test(c)) return { scope: 'test', coverage: 'mix test' }
  if (/\btox\b(?!\S)/i.test(c)) return { scope: 'test', coverage: 'tox' }
  if (/\bgodot[\w.-]*(\s|$)/i.test(c)) {
    const script = c.match(/(?:--script|-s)\s+(\S+)/i)
    if (/--headless\b/i.test(c) && script?.[1]) {
      return { scope: 'test', coverage: `godot headless ${script[1]}` }
    }
    if (/--check-only\b|--validate-only\b/i.test(c)) {
      return { scope: 'check', coverage: 'godot parse check' }
    }
  }
  if (/\bgreen-?gate\b/i.test(c)) return { scope: 'check', coverage: 'green-gate runner' }
  const script = c.match(/^\s*(?:bash|sh)\s+(\S*(?:test|check|verify|gate|suite|ci|lint)\S*)/i)
    ?? c.match(/^\s*(\.\/\S*(?:test|check|verify|gate|suite|ci|lint)\S*)/i)
  if (script?.[1]) return { scope: 'check', coverage: `project script ${script[1]}` }
  const extra = projectVerifyPattern()
  if (extra?.test(c)) return { scope: 'check', coverage: 'project verify pattern (MERCURY_VERIFY_PATTERN)' }
  return null
}

export function isVerifySegment(segment: string, cwd?: string): boolean {
  return classifyVerifySegment(stripQuotedShellArgs(segment), cwd) !== null
}

const SAFE_TAIL_HEADS = new Set(['git', 'echo', 'printf', 'true', ':'])

function safeTailSegment(segment: string): boolean {
  if (/(^|\s)>>?\s/.test(segment) && !/>{1,2}\s*['"]?\/(?:dev|proc)\//.test(segment)) {
    return false
  }
  return SAFE_TAIL_HEADS.has(leadingShellCommandToken(segment))
}

export function classifyVerificationCommand(
  command: string,
  cwd?: string,
): VerifyClassification | null {
  const segments = splitShellControlOps(command)
  outer: for (let i = 0; i < segments.length; i++) {
    const cls = classifyVerifySegment(segments[i]!.text, cwd)
    if (!cls) continue
    for (let j = 0; j <= i; j++) {
      const seg = segments[j]!
      if (seg.opBefore === 'or') continue outer
      if (j < i && /^\s*cd\s+['"]?[/~]/.test(seg.text)) continue outer
    }
    if (verifyExitPropagates(segments, i)) return cls
  }
  return null
}

function verifyExitPropagates(
  segments: readonly ShellCommandSegment[],
  i: number,
): boolean {
  const pipefail = pipefailActiveBefore(segments, i)
  for (let j = i + 1; j < segments.length; j++) {
    const op = segments[j]!.opBefore
    if (op === 'pipe' && pipefail) continue
    if (op !== '&&') return false
    if (!classifyVerifySegment(segments[j]!.text) && !safeTailSegment(segments[j]!.text)) {
      return false
    }
  }
  return true
}

type EvidenceRecordedSubscriber = (owner: OwnerKey, record: EvidenceRecord) => void
const evidenceSubscribers = new Set<EvidenceRecordedSubscriber>()

export function subscribeEvidenceRecorded(cb: EvidenceRecordedSubscriber): () => void {
  evidenceSubscribers.add(cb)
  return () => {
    evidenceSubscribers.delete(cb)
  }
}

export function recordEvidence(
  cwd: string,
  e: {
    command: string
    ok: boolean
    scope: VerificationScope
    coverage: string
    gateId?: string
    minRuns?: number
  },
  owner?: OwnerKey,
): void {
  const resolvedOwner = effectiveOwner(owner)
  const state = ownerStates.get(resolvedOwner)
  loadPersisted(cwd, state)
  const record: EvidenceRecord = {
    ...e,
    ranAt: Date.now(),
    treeDigest: computeWorkingTreeDigest(cwd, { fresh: true }),
    seq: state.mutationSeq,
  }
  if (e.ok) state.evidenceDemands = 0
  state.pendingReadBack.clear()
  state.pendingUnknownMutation = false
  state.sessionRecords.push(record)
  if (state.sessionRecords.length > MAX_RECORDS) {
    state.sessionRecords = state.sessionRecords.slice(-MAX_RECORDS)
  }
  persist(cwd, state)
  for (const cb of evidenceSubscribers) {
    try {
      cb(resolvedOwner, record)
    } catch {
    }
  }
  notify()
}

export function recordShellCommandOutcome(
  command: string,
  exitCode: number,
  cwd: string,
  owner?: OwnerKey,
): void {
  try {
    if (!verifyEvidenceEnabled()) return
    const cls = classifyVerificationCommand(command, cwd)
    if (cls) recordEvidence(cwd, { command, ok: exitCode === 0, ...cls }, owner)
  } catch {
  }
}

export function evidenceRecordsFor(owner?: OwnerKey): readonly EvidenceRecord[] {
  const state = ownerStates.peek(effectiveOwner(owner))
  return state ? [...state.sessionRecords] : []
}

export function verificationSummary(
  cwd: string,
  opts?: { skipDigest?: boolean; owner?: OwnerKey },
): VerificationSnapshot {
  const snapshot = summarize(cwd, opts)
  const note = treeScanNote(cwd)
  return note === null ? snapshot : { ...snapshot, detail: `${snapshot.detail} · ${note}` }
}

function summarize(
  cwd: string,
  opts?: { skipDigest?: boolean; owner?: OwnerKey },
): VerificationSnapshot {
  const state = ownerStates.get(effectiveOwner(opts?.owner))
  loadPersisted(cwd, state)
  const last = state.sessionRecords.at(-1) ?? null
  if (!last) {
    return {
      state: 'unverified',
      detail:
        state.mutationSeq > 0
          ? `${state.mutationSeq} mutation(s) this session — no verification evidence yet`
          : 'no verification evidence for this tree yet',
      lastEvidence: null,
      mutationsSinceEvidence: state.mutationSeq,
      lastMutationAt: state.lastMutationAt,
    }
  }
  const mutationsSince = state.mutationSeq - last.seq
  if (!last.ok) {
    return {
      state: 'failed',
      detail: `${last.coverage} FAILED (${ageLabel(last.ranAt)})${mutationsSince > 0 ? ` · ${mutationsSince} mutation(s) since` : ''}`,
      lastEvidence: last,
      mutationsSinceEvidence: mutationsSince,
      lastMutationAt: state.lastMutationAt,
    }
  }
  if (mutationsSince > 0) {
    return {
      state: 'stale',
      detail: `${mutationsSince} mutation(s) after the last evidence (${last.coverage}, ${ageLabel(last.ranAt)})`,
      lastEvidence: last,
      mutationsSinceEvidence: mutationsSince,
      lastMutationAt: state.lastMutationAt,
    }
  }
  if (last.ok && last.gateId !== undefined && (last.minRuns ?? 1) > 1) {
    const need = last.minRuns ?? 1
    let got = 0
    for (let i = state.sessionRecords.length - 1; i >= 0; i--) {
      const r = state.sessionRecords[i]!
      if (r.gateId !== last.gateId) continue
      if (!r.ok || r.seq !== last.seq) break
      got++
    }
    if (got < need) {
      return {
        state: 'stale',
        detail: `soak ${got}/${need} — ${last.coverage} needs ${need} green runs on this tree`,
        lastEvidence: last,
        mutationsSinceEvidence: 0,
        lastMutationAt: state.lastMutationAt,
      }
    }
  }
  if (!opts?.skipDigest && last.treeDigest !== null) {
    const current = computeWorkingTreeDigest(cwd, { fresh: true })
    if (current !== null && current !== last.treeDigest) {
      return {
        state: 'stale',
        detail: `tree changed since the last evidence (${last.coverage}, ${ageLabel(last.ranAt)})`,
        lastEvidence: last,
        mutationsSinceEvidence: 0,
        lastMutationAt: state.lastMutationAt,
      }
    }
  }
  return {
    state: 'verified',
    detail: `${last.coverage} green (${ageLabel(last.ranAt)})`,
    lastEvidence: last,
    mutationsSinceEvidence: 0,
    lastMutationAt: state.lastMutationAt,
  }
}

function ageLabel(t: number): string {
  const s = Math.max(0, Math.round((Date.now() - t) / 1000))
  if (s < 90) return `${s}s ago`
  if (s < 5400) return `${Math.round(s / 60)}m ago`
  return `${Math.round(s / 3600)}h ago`
}
