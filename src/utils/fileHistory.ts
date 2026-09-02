import { createHash } from 'node:crypto'
import type { UUID } from 'node:crypto'
import type { Stats } from 'node:fs'
import { chmod, copyFile, link, mkdir, readFile, stat } from 'node:fs/promises'
import { isAbsolute, join, relative } from 'node:path'

import { structuredPatch } from 'diff'

import { getIsNonInteractiveSession, getOriginalCwd, getSessionId } from '../bootstrap/state.js'
import { commitPlanDigest, runTextChangeSetCommit, type CommitTarget } from '../services/changeTransaction/changeSetCommit.js'
import { sha256Hex } from '../services/changeTransaction/changeSetPlan.js'
import { notifyVscodeFileUpdated } from '../services/mcp/vscodeSdkMcp.js'
import { flagEnv } from '../substrate/flagRegistry.js'
import type { LogOption } from '../types/logs.js'
import { getGlobalConfig } from './config.js'
import { logForDebugging } from './debug.js'
import { getMercuryHome } from './envUtils.js'
import { isENOENT } from './errors.js'
import { logError } from './log.js'
import { recordFileHistorySnapshot } from './sessionStorage.js'

/**
 * Per-turn file checkpointing: track edits, snapshot, rewind, diff stats.
 * Every user turn is a restore point.
 */

export type FileHistoryBackup = {
  /** Null is the explicit marker "this file did not exist at this version". */
  backupFileName: string | null
  version: number
  backupTime: Date
  /** FN-020 row 7: the SOURCE's stat facts (size · mtimeMs · mode) as of
   *  the moment this backup was proven current. A fresh source stat equal
   *  to the three reuses the record with no further I/O; absent (an older
   *  persisted row, or a source modified inside the racy window) means the
   *  full stat-and-compare road decides. Optional, so every persisted row
   *  and every constructor stays valid. */
  sourceSize?: number
  sourceMtimeMs?: number
  sourceMode?: number
}

export type FileHistorySnapshot = {
  messageId: UUID
  trackedFileBackups: Record<string, FileHistoryBackup>
  timestamp: Date
}

export type FileHistoryState = {
  snapshots: FileHistorySnapshot[]
  trackedFiles: Set<string>
  /** Monotonic — keeps rising after the cap so the UI can use it as an activity signal. */
  snapshotSequence: number
}

type StateUpdater = (updater: (prev: FileHistoryState) => FileHistoryState) => void

const MAX_SNAPSHOTS = 100
const MAX_FAILURES_LISTED = 10

/** A source modified within this window of "now" gets no stat hint: a
 *  later same-size edit could land inside the same mtime tick on a coarse-
 *  timestamp filesystem, so the byte-compare road keeps deciding until the
 *  file has been still for longer than any tick (git's racy-clean idea). */
const RACY_MTIME_WINDOW_MS = 2_000

/** PROOF CENSUS (operation-shaped, never a wall clock): the checkpoint
 *  sweep's I/O, read by scripts/rewind/prove-checkpoint-sweep-economy.ts. */
export const fileHistoryIoCensus = { stats: 0, reads: 0, copies: 0 }
// The number-valued Stats (the option-less overload), never the bigint one:
// the hint arithmetic below subtracts mtimes.
type StatResult = Stats
const statCounted = (path: string): Promise<StatResult> => {
  fileHistoryIoCensus.stats++
  return stat(path)
}
const readCounted = (path: string): Promise<Buffer> => {
  fileHistoryIoCensus.reads++
  return readFile(path)
}
// Counts copies that LANDED: the first backup's attempt into a missing
// directory fails ENOENT by design (mkdir, then retry) and moves no bytes.
const copyCounted = async (source: string, target: string): Promise<void> => {
  await copyFile(source, target)
  fileHistoryIoCensus.copies++
}
type SourceHint = Pick<FileHistoryBackup, 'sourceSize' | 'sourceMtimeMs' | 'sourceMode'>
function sourceHint(stats: StatResult): SourceHint {
  if (Date.now() - stats.mtimeMs < RACY_MTIME_WINDOW_MS) return {}
  return { sourceSize: stats.size, sourceMtimeMs: stats.mtimeMs, sourceMode: stats.mode }
}
function hintMatches(prior: FileHistoryBackup, stats: StatResult): boolean {
  return prior.sourceSize === stats.size && prior.sourceMtimeMs === stats.mtimeMs && prior.sourceMode === stats.mode
}

// ---------------------------------------------------------------------------
// Enablement (re-checked per call, never cached at module load)
// ---------------------------------------------------------------------------

/**
 * The process that executes an operator's tools is the daemon-hosted
 * session runner — a `-p` child wearing the concourse worker stamp — and
 * its transcript IS the cockpit's chat. It captures under the interactive
 * world's law; a plain `-p`/SDK run keeps the headless contract (off).
 */
function isSessionRunnerProcess(): boolean {
  return flagEnv('MERCURY_CONCOURSE_WORKER') === '1'
}

export function fileHistoryEnabled(): boolean {
  // Off for non-interactive/SDK sessions — except the seat runner, which is
  // the interactive session's own tool process; the compat enable/disable
  // env pair is retired — settings fileCheckpointingEnabled is the off
  // switch for every capturing process.
  if (getIsNonInteractiveSession() && !isSessionRunnerProcess()) return false
  return (getGlobalConfig() as { fileCheckpointingEnabled?: unknown }).fileCheckpointingEnabled !== false
}

// ---------------------------------------------------------------------------
// Keys and backup addressing
// ---------------------------------------------------------------------------

/**
 * Tracking keys are relative where possible: an absolute path is
 * relativised against the original working directory when it BEGINS with
 * that string (a plain prefix test — a sibling `/w/repo2/x` under `/w/repo`
 * yields a `..`-prefixed key that expands back to the same absolute path).
 */
function toTrackingKey(filePath: string): string {
  if (!isAbsolute(filePath)) return filePath
  const originalCwd = getOriginalCwd()
  if (filePath.startsWith(originalCwd)) return relative(originalCwd, filePath)
  return filePath
}

export function maybeExpandFilePath(trackingKey: string): string {
  if (isAbsolute(trackingKey)) return trackingKey
  return join(getOriginalCwd(), trackingKey)
}

function backupDirectory(sessionId: string = getSessionId()): string {
  return join(getMercuryHome(), 'file-history', sessionId)
}

/** `<path-hash>@v<version>` — the hash is over the path string the caller handed in. */
function backupFileName(filePath: string, version: number): string {
  return `${createHash('sha256').update(filePath).digest('hex').slice(0, 16)}@v${version}`
}

/** Takes an optional explicit session id — the resume migration addresses the PREVIOUS session's directory. */
function backupPath(backupName: string, sessionId?: string): string {
  return join(backupDirectory(sessionId), backupName)
}

/**
 * Create a backup by copying (never reading the whole file into memory),
 * creating the directory lazily on a missing-directory error and retrying.
 * The source is stat'ed BEFORE the copy so "source does not exist" (the
 * null marker) and "backup directory does not exist" (mkdir + retry) stay
 * distinguishable — sharing one catch orphaned blobs whenever a file
 * vanished between copy and stat.
 */
async function createBackup(filePath: string, version: number): Promise<FileHistoryBackup> {
  let sourceStats
  try {
    sourceStats = await statCounted(filePath)
  } catch (err) {
    if (isENOENT(err)) return { backupFileName: null, version, backupTime: new Date() }
    throw err
  }
  const name = backupFileName(filePath, version)
  const target = backupPath(name)
  try {
    await copyCounted(filePath, target)
  } catch (err) {
    if (!isENOENT(err)) throw err
    await mkdir(backupDirectory(), { recursive: true })
    await copyCounted(filePath, target)
  }
  await chmod(target, sourceStats.mode)
  return { backupFileName: name, version, backupTime: new Date(), ...sourceHint(sourceStats) }
}

// ---------------------------------------------------------------------------
// Change detection
// ---------------------------------------------------------------------------

/**
 * Whether the file differs from a backup. Compares two filesystem mtimes
 * (the source's against the BACKUP FILE's own), never the recorded backup
 * timestamp; a stat failure other than not-found is treated as changed.
 * Exported for tests.
 */
export async function checkOriginFileChanged(
  originalFile: string,
  backupFileName: string,
  statsHint?: Awaited<ReturnType<typeof stat>>,
): Promise<boolean> {
  const safeStat = async (path: string): Promise<StatResult | null | 'error'> => {
    try {
      return await statCounted(path)
    } catch (err) {
      return isENOENT(err) ? null : 'error'
    }
  }
  const sourceStats = statsHint ?? (await safeStat(originalFile))
  const backupStats = await safeStat(backupPath(backupFileName))
  if (sourceStats === 'error' || backupStats === 'error') return true
  if ((sourceStats === null) !== (backupStats === null)) return true
  if (sourceStats === null || backupStats === null) return false
  if (sourceStats.mode !== backupStats.mode || sourceStats.size !== backupStats.size) return true
  if (sourceStats.mtimeMs < backupStats.mtimeMs) return false
  try {
    const [source, backup] = await Promise.all([readCounted(originalFile), readCounted(backupPath(backupFileName))])
    return !source.equals(backup)
  } catch {
    // A file that disappears between the stat and the read counts as changed.
    return true
  }
}

// ---------------------------------------------------------------------------
// State access helpers
// ---------------------------------------------------------------------------

function captureState(updateState: StateUpdater): FileHistoryState | null {
  let captured: FileHistoryState | null = null
  updateState(prev => {
    captured = prev
    return prev
  })
  return captured
}

function latestSnapshot(state: FileHistoryState): FileHistorySnapshot | undefined {
  return state.snapshots[state.snapshots.length - 1]
}

// ---------------------------------------------------------------------------
// Tracking an edit
// ---------------------------------------------------------------------------

/**
 * Called BEFORE a write. Never fails a tool call. The early return when the
 * most recent snapshot already holds a backup for the key is load-bearing:
 * version 1's name is deterministic, so a second track-edit after the write
 * would overwrite version 1 with post-edit content and destroy the restore
 * point.
 */
export async function fileHistoryTrackEdit(updateState: StateUpdater, filePath: string, messageId: UUID): Promise<void> {
  try {
    if (!fileHistoryEnabled()) return
    const state = captureState(updateState)
    if (!state) return
    const latest = latestSnapshot(state)
    if (!latest) {
      logError(new Error('fileHistoryTrackEdit: no snapshot to attach the edit to'))
      return
    }
    const key = toTrackingKey(filePath)
    if (latest.trackedFileBackups[key]) return
    const backup = await createBackup(filePath, 1)
    let persisted: FileHistorySnapshot | null = null
    updateState(prev => {
      const current = latestSnapshot(prev)
      // Re-check: a concurrent track-edit may have won the race.
      if (!current || current.trackedFileBackups[key]) return prev
      const updatedSnapshot: FileHistorySnapshot = {
        ...current,
        trackedFileBackups: { ...current.trackedFileBackups, [key]: backup },
      }
      persisted = updatedSnapshot
      const snapshots = [...prev.snapshots.slice(0, -1), updatedSnapshot]
      const trackedFiles = new Set(prev.trackedFiles)
      trackedFiles.add(key)
      return { ...prev, snapshots, trackedFiles }
    })
    if (persisted) {
      // Keyed by the message id the CALLER passed in.
      await recordFileHistorySnapshot(messageId, persisted, true)
    }
  } catch (err) {
    logError(err)
  }
}

// ---------------------------------------------------------------------------
// Snapshots
// ---------------------------------------------------------------------------

/**
 * Once per user turn. Reuses an unchanged backup RECORD verbatim (no new
 * copy, no version bump); at commit the tracked set is re-read fresh and any
 * key added by a concurrent track-edit carries its previous-snapshot entry
 * forward; the list is capped at 100 (oldest evicted) while the sequence
 * keeps rising.
 */
export async function fileHistoryMakeSnapshot(updateState: StateUpdater, messageId: UUID): Promise<void> {
  try {
    if (!fileHistoryEnabled()) return
    const state = captureState(updateState)
    // A no-op updater (an MCP host) never runs the reducer.
    if (!state) return
    const previous = latestSnapshot(state)
    const backups: Record<string, FileHistoryBackup> = {}
    if (previous) {
      await Promise.all(
        [...state.trackedFiles].map(async key => {
          try {
            const filePath = maybeExpandFilePath(key)
            const prior = previous.trackedFileBackups[key]
            const nextVersion = prior ? prior.version + 1 : 1
            let fileStats
            try {
              fileStats = await statCounted(filePath)
            } catch (err) {
              if (!isENOENT(err)) throw err
              backups[key] = { backupFileName: null, version: nextVersion, backupTime: new Date() }
              return
            }
            if (prior && prior.backupFileName) {
              // FN-020 row 7: the record's own source facts answer first —
              // an unchanged (size · mtimeMs · mode) triple reuses it with
              // no further I/O. Before: a backup-side stat per tracked file
              // per turn, and two whole-file reads per turn FOREVER after a
              // touch that changed no byte (git checkout and back, a no-op
              // formatter) — the source mtime never dropped below the
              // backup's again.
              if (hintMatches(prior, fileStats)) {
                backups[key] = prior
                return
              }
              if (!(await checkOriginFileChanged(filePath, prior.backupFileName, fileStats))) {
                // Proven unchanged by the full road: the record learns the
                // current facts (outside the racy window), so the touched-
                // but-identical file costs that road once, not every turn.
                backups[key] = {
                  backupFileName: prior.backupFileName,
                  version: prior.version,
                  backupTime: prior.backupTime,
                  ...sourceHint(fileStats),
                }
                return
              }
            }
            backups[key] = await createBackup(filePath, nextVersion)
          } catch (err) {
            logError(err)
          }
        }),
      )
    }
    let committed: FileHistorySnapshot | null = null
    updateState(prev => {
      const priorSnapshot = latestSnapshot(prev)
      for (const key of prev.trackedFiles) {
        if (!(key in backups) && priorSnapshot?.trackedFileBackups[key]) {
          backups[key] = priorSnapshot.trackedFileBackups[key] as FileHistoryBackup
        }
      }
      const snapshot: FileHistorySnapshot = { messageId, trackedFileBackups: backups, timestamp: new Date() }
      committed = snapshot
      const snapshots = [...prev.snapshots, snapshot].slice(-MAX_SNAPSHOTS)
      return { ...prev, snapshots, snapshotSequence: prev.snapshotSequence + 1 }
    })
    if (committed) {
      const finished = committed as FileHistorySnapshot
      if (previous) void notifyEditorOfChanges(previous, finished)
      void recordFileHistorySnapshot(messageId, finished, false)
    }
  } catch (err) {
    logError(err)
  }
}

async function readBackupContent(name: string | null): Promise<string | null> {
  if (name === null) return null
  try {
    return await readFile(backupPath(name), 'utf8')
  } catch {
    return null
  }
}

/** Fire-and-forget: notify the editor of files whose backup identity changed. */
async function notifyEditorOfChanges(previous: FileHistorySnapshot, next: FileHistorySnapshot): Promise<void> {
  try {
    for (const [key, backup] of Object.entries(next.trackedFileBackups)) {
      const prior = previous.trackedFileBackups[key]
      if (prior && prior.backupFileName === backup.backupFileName && prior.version === backup.version) continue
      const [oldContent, newContent] = await Promise.all([
        readBackupContent(prior?.backupFileName ?? null),
        readBackupContent(backup.backupFileName),
      ])
      if (oldContent === newContent) continue
      notifyVscodeFileUpdated(maybeExpandFilePath(key), oldContent ?? '', newContent ?? '')
    }
  } catch {
    // Best effort.
  }
}

// ---------------------------------------------------------------------------
// Rewind
// ---------------------------------------------------------------------------

/** The snapshot's own entry, else the file's version-1 backup found scanning oldest-first. */
function resolveTargetBackup(state: FileHistoryState, snapshot: FileHistorySnapshot, key: string): FileHistoryBackup | undefined {
  const own = snapshot.trackedFileBackups[key]
  if (own) return own
  for (const candidate of state.snapshots) {
    const entry = candidate.trackedFileBackups[key]
    if (entry && entry.version === 1) return entry
  }
  return undefined
}

// (The per-file copy-loop rewind that lived here — sequential, collecting
// failures, throwing a "mixed state" sentence after the fact — is replaced
// by the all-or-nothing restore below; every caller rides that one road.)

export function fileHistoryCanRestore(state: FileHistoryState, messageId: UUID): boolean {
  if (!fileHistoryEnabled()) return false
  return state.snapshots.some(snapshot => snapshot.messageId === messageId)
}

// ---------------------------------------------------------------------------
// The all-or-nothing restore (the /rewind code road — FN-015 rank 8)
// ---------------------------------------------------------------------------
//  The per-file copy loop above could leave a MIXED tree on a mid-way
//  failure. The operator's safety net rides the shared change-transaction
//  commit core instead: current-byte revalidation, durable staging, the
//  journaled rename walk, digest-guarded compensation — nothing is written
//  unless every target can land, and a midway interruption reconciles at
//  the next boot. DRIFT — a file changed OUTSIDE the session since its
//  tools last touched it — refuses BY NAME before any write: the oracle is
//  the tools' own read-state (what the model last saw or wrote), the same
//  fact the edit tools' staleness check reads.

export type FileHistoryRestoreRefusalKind = 'no-checkpoint' | 'drift' | 'backup-missing' | 'restore-failed'

export type FileHistoryRestoreResult =
  | { ok: true; changed: string[]; insertions: number; deletions: number; dryRun: boolean }
  | { ok: false; kind: FileHistoryRestoreRefusalKind; paths: string[]; detail: string }

/** What the session last knew of a file — the tools' read-state entry
 *  (the FileStateCache shape, so the runner's cache IS the oracle). */
export interface RestoreDriftEntry {
  content: string
  timestamp: number
  offset: number | undefined
  limit: number | undefined
  isPartialView?: boolean | undefined
}

/** The oracle reads the last touch; after a landed restore it is TOLD the
 *  new bytes (a restore is the session's own write — the next rewind must
 *  not read it as a hand edit). */
export interface RestoreDriftOracle {
  get(path: string): RestoreDriftEntry | undefined
  set?(path: string, entry: RestoreDriftEntry): unknown
  delete?(path: string): unknown
}

async function readBytesOrNull(path: string): Promise<Buffer | null> {
  try {
    return await readFile(path)
  } catch (err) {
    if (isENOENT(err)) return null
    throw err
  }
}

/**
 * True when the file on disk moved past the session's last touch of it. A
 * full-view entry (and an injected partial view, whose content holds the
 * raw disk bytes) compares bytes — an mtime bump with identical content is
 * not drift; a windowed read can only trust the clock.
 */
async function driftedSinceLastTouch(entry: RestoreDriftEntry, filePath: string, current: Buffer): Promise<boolean> {
  let mtime: number
  try {
    mtime = Math.floor((await stat(filePath)).mtimeMs)
  } catch {
    return false
  }
  if (mtime <= entry.timestamp) return false
  const fullView = (entry.offset === undefined || entry.offset === 0) && entry.limit === undefined
  if (fullView || entry.isPartialView === true) return entry.content !== current.toString('utf8')
  return true
}

function lineDiffCounts(key: string, before: string, after: string): { added: number; removed: number } {
  const patch = structuredPatch(key, key, before, after, undefined, undefined, { context: 0 })
  let added = 0
  let removed = 0
  for (const hunk of patch.hunks) {
    for (const line of hunk.lines) {
      if (line.startsWith('+')) added++
      else if (line.startsWith('-')) removed++
    }
  }
  return { added, removed }
}

function listPaths(paths: string[]): string {
  const shown = paths.slice(0, MAX_FAILURES_LISTED).join(', ')
  const rest = paths.length - MAX_FAILURES_LISTED
  return rest > 0 ? `${shown} and ${rest} more` : shown
}

/**
 * Restore every tracked file to its state at `messageId`, all or nothing.
 * A dry run reports what would change and writes nothing. Not gated on the
 * capture switch: the caller decides what an off switch means for it.
 */
export async function fileHistoryRestore(
  state: FileHistoryState,
  messageId: UUID,
  opts: { dryRun: boolean; ownerKey: string; drift?: RestoreDriftOracle; signal?: AbortSignal },
): Promise<FileHistoryRestoreResult> {
  const snapshot = [...state.snapshots].reverse().find(candidate => candidate.messageId === messageId)
  if (!snapshot) {
    return { ok: false, kind: 'no-checkpoint', paths: [], detail: 'no saved files at this point — the checkpoint store holds nothing for it' }
  }
  const targets: CommitTarget[] = []
  const changed: string[] = []
  const drifted: string[] = []
  const missing: string[] = []
  let insertions = 0
  let deletions = 0
  for (const key of state.trackedFiles) {
    const filePath = maybeExpandFilePath(key)
    const target = resolveTargetBackup(state, snapshot, key)
    if (!target) {
      missing.push(key)
      continue
    }
    let current: Buffer | null
    try {
      current = await readBytesOrNull(filePath)
    } catch (err) {
      return { ok: false, kind: 'restore-failed', paths: [key], detail: `${key}: ${err instanceof Error ? err.message : String(err)} — nothing was restored` }
    }
    let planned: Buffer | null = null
    let plannedMode = 0o644
    if (target.backupFileName !== null) {
      const blob = backupPath(target.backupFileName)
      planned = await readBytesOrNull(blob)
      if (planned === null) {
        missing.push(key)
        continue
      }
      try {
        plannedMode = (await stat(blob)).mode & 0o7777
      } catch {
        /* the blob just answered a read; a vanished mode keeps the default */
      }
    }
    if (current === null && planned === null) continue
    if (current !== null && planned !== null && current.equals(planned)) continue
    const known = current !== null ? opts.drift?.get(filePath) : undefined
    if (known !== undefined && current !== null && (await driftedSinceLastTouch(known, filePath, current))) {
      drifted.push(key)
      continue
    }
    let mode = plannedMode
    if (current !== null) {
      try {
        mode = (await stat(filePath)).mode & 0o7777
      } catch {
        /* revalidation inside the walk surfaces a vanished file as stale */
      }
    }
    const originalBytes = current ?? Buffer.alloc(0)
    const plannedBytes = planned ?? Buffer.alloc(0)
    targets.push({
      canonicalPath: filePath,
      originalDigest: sha256Hex(originalBytes),
      plannedDigest: sha256Hex(plannedBytes),
      originalBytes,
      plannedBytes,
      mode,
      kind: current === null ? 'create' : planned === null ? 'delete' : 'write',
    })
    changed.push(key)
    const counts = lineDiffCounts(key, originalBytes.toString('utf8'), plannedBytes.toString('utf8'))
    insertions += counts.added
    deletions += counts.removed
  }
  if (drifted.length > 0) {
    return {
      ok: false,
      kind: 'drift',
      paths: drifted,
      detail: `${listPaths(drifted)} changed outside this session since its last edit — nothing was restored; reconcile it, then /rewind again`,
    }
  }
  if (missing.length > 0) {
    return {
      ok: false,
      kind: 'backup-missing',
      paths: missing,
      detail: `the saved copy of ${listPaths(missing)} is gone from the checkpoint store — nothing was restored`,
    }
  }
  if (opts.dryRun || targets.length === 0) {
    return { ok: true, changed, insertions, deletions, dryRun: opts.dryRun }
  }
  const outcome = await runTextChangeSetCommit({
    ownerKey: opts.ownerKey,
    source: 'rewind',
    planDigest: commitPlanDigest(targets),
    targets,
    ...(opts.signal !== undefined ? { signal: opts.signal } : {}),
  })
  switch (outcome.kind) {
    case 'committed':
    case 'replayed':
      // The restore is the session's own write: the read-state now names
      // the restored bytes, so the next rewind (and the edit tools' own
      // staleness check) reads them as known, never as drift.
      for (const target of targets) {
        if (target.kind === 'delete') {
          opts.drift?.delete?.(target.canonicalPath)
          continue
        }
        let timestamp = Date.now()
        try {
          timestamp = Math.floor((await stat(target.canonicalPath)).mtimeMs)
        } catch {
          /* a vanished file answers no oracle; the clock stands in */
        }
        opts.drift?.set?.(target.canonicalPath, { content: target.plannedBytes.toString('utf8'), timestamp, offset: undefined, limit: undefined })
      }
      return { ok: true, changed, insertions, deletions, dryRun: false }
    case 'stale':
      return {
        ok: false,
        kind: 'drift',
        paths: outcome.stalePaths,
        detail: `${listPaths(outcome.stalePaths)} changed while the restore was being prepared — nothing was restored; /rewind again`,
      }
    case 'cancelled':
      return { ok: false, kind: 'restore-failed', paths: [], detail: 'the restore was cancelled before any file was written' }
    case 'in-flight':
      return { ok: false, kind: 'restore-failed', paths: [], detail: 'another apply is still committing these files — nothing was restored; /rewind again once it settles' }
    case 'failed-restored':
      return { ok: false, kind: 'restore-failed', paths: [], detail: `the restore could not land and every file was put back: ${outcome.reason}` }
    case 'indeterminate':
      return {
        ok: false,
        kind: 'restore-failed',
        paths: outcome.divergedPaths,
        detail: `the restore was interrupted: ${outcome.landedPaths.length} file(s) restored, ${listPaths(outcome.divergedPaths)} could not be put back without overwriting later bytes (${outcome.reason}) — the tree is mixed; check those files by hand`,
      }
  }
}

// (The diff-statistics and any-changes probes that lived here read the
// SCREEN's own state — a process that runs no tools; the confirm phase asks
// the runner's dry run through fileHistoryRestore instead.)

// ---------------------------------------------------------------------------
// Restore and resume
// ---------------------------------------------------------------------------

/** Rebuild state from persisted snapshots, migrating absolute keys to tracking keys. */
export function fileHistoryRestoreStateFromLog(
  snapshots: FileHistorySnapshot[],
  onUpdateState: (state: FileHistoryState) => void,
): void {
  if (!fileHistoryEnabled()) return
  const trackedFiles = new Set<string>()
  const migrated = snapshots.map(snapshot => {
    const backups: Record<string, FileHistoryBackup> = {}
    for (const [path, backup] of Object.entries(snapshot.trackedFileBackups)) {
      const key = toTrackingKey(path)
      backups[key] = backup
      trackedFiles.add(key)
    }
    return { ...snapshot, trackedFileBackups: backups }
  })
  onUpdateState({ snapshots: migrated, trackedFiles, snapshotSequence: migrated.length })
}

/**
 * Hard-link (falling back to copy) the previous session's blobs into the
 * new session's directory; a snapshot is re-recorded only when every one of
 * its backups migrated. Best-effort, never throws.
 */
export async function copyFileHistoryForResume(log: LogOption): Promise<void> {
  try {
    if (!fileHistoryEnabled()) return
    const snapshots = log.fileHistorySnapshots as FileHistorySnapshot[] | undefined
    if (snapshots === undefined) return
    if (!log.messages || log.messages.length === 0) return
    const previousSessionId = (log.messages[log.messages.length - 1] as { sessionId?: string } | undefined)?.sessionId
    if (!previousSessionId) {
      logError(new Error('copyFileHistoryForResume: no previous session id on the last message'))
      return
    }
    const currentSessionId = getSessionId()
    if (previousSessionId === currentSessionId) return
    await mkdir(backupDirectory(currentSessionId), { recursive: true })
    let failedSnapshots = 0
    await Promise.all(
      snapshots.map(async snapshot => {
        let failed = false
        await Promise.all(
          Object.values(snapshot.trackedFileBackups).map(async backup => {
            if (backup.backupFileName === null) return
            const from = backupPath(backup.backupFileName, previousSessionId)
            const to = backupPath(backup.backupFileName, currentSessionId)
            try {
              await link(from, to)
            } catch (err) {
              const code = (err as { code?: string }).code
              if (code === 'EEXIST') return
              if (code === 'ENOENT') {
                failed = true
                return
              }
              try {
                await copyFile(from, to)
              } catch {
                failed = true
              }
            }
          }),
        )
        if (failed) {
          failedSnapshots++
          return
        }
        await recordFileHistorySnapshot(snapshot.messageId, snapshot, false)
      }),
    )
    if (failedSnapshots > 0) {
      logForDebugging(`copyFileHistoryForResume: ${failedSnapshots} snapshot(s) had missing blobs and were not re-recorded`)
    }
  } catch (err) {
    logError(err)
  }
}
