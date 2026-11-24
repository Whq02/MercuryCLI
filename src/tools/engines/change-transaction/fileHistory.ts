import { createHash, randomUUID } from 'node:crypto'
import type { UUID } from 'node:crypto'
import type { Stats } from 'node:fs'
import { chmod, copyFile, link, mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { isAbsolute, join, relative } from 'node:path'

import { structuredPatch } from 'diff'

import { getIsNonInteractiveSession, getOriginalCwd, getSessionId } from '../../../boot/process-state/processState.js'
import { commitPlanDigest, runTextChangeSetCommit, type CommitTarget } from './changeSetCommit.js'
import { sha256Hex } from '../../../platform/primitives/hash.js'
import { flagEnv } from '../../../platform/substrate/flagRegistry.js'
import type { FileHistoryBackup, FileHistorySnapshot, FileHistoryState } from '../../../sessions/transcripts/fileHistory.js'
import type { SessionListing } from '../../../sessions/transcripts/transcriptEntries.js'
import { getGlobalConfig } from '../../../platform/settings/config.js'
import { logForDebugging } from '../../../platform/logs/debugLog.js'
import { noteFileTouched } from '../../../sessions/mneme/lineageSession.js'
import { getMercuryHome } from '../../../platform/environment/envUtils.js'
import { getErrnoCode, isENOENT } from '../../../platform/errors/errors.js'
import { stripBOM } from '../../../platform/storage/jsonRead.js'
import { logError } from '../../../platform/logs/errorLog.js'
import { recordFileHistorySnapshot } from '../../../sessions/transcripts/sessionStorage.js'
import { passedOver } from '../../../platform/errors/passedOver.js'


type StateUpdater = (updater: (prev: FileHistoryState) => FileHistoryState) => void
const MAX_SNAPSHOTS = 100
const MAX_FAILURES_LISTED = 10

const RACY_MTIME_WINDOW_MS = 2_000

export const fileHistoryIoCensus = { stats: 0, reads: 0, copies: 0 }
type StatResult = Stats
const statCounted = (path: string): Promise<StatResult> => {
  fileHistoryIoCensus.stats++
  return stat(path)
}
const readCounted = (path: string): Promise<Buffer> => {
  fileHistoryIoCensus.reads++
  return readFile(path)
}
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


function isSessionRunnerProcess(): boolean {
  return flagEnv('MERCURY_CONCOURSE_WORKER') === '1'
}

export const FILE_CHECKPOINT_SOURCES = ['interactive', 'seat', 'initialize', 'setting', 'headless'] as const
type FileCheckpointSource = (typeof FILE_CHECKPOINT_SOURCES)[number]

let fileCheckpointsRequested = false

export function requestFileCheckpoints(on: boolean): void {
  fileCheckpointsRequested = on
}

export function fileCheckpointSource(): FileCheckpointSource {
  const road: FileCheckpointSource = !getIsNonInteractiveSession() ? 'interactive' : isSessionRunnerProcess() ? 'seat' : fileCheckpointsRequested ? 'initialize' : 'headless'
  if (road === 'headless') return road
  if ((getGlobalConfig() as { fileCheckpointingEnabled?: unknown }).fileCheckpointingEnabled === false) return 'setting'
  return road
}

export function fileHistoryEnabled(): boolean {
  const source = fileCheckpointSource()
  return source === 'interactive' || source === 'seat' || source === 'initialize'
}


function toTrackingKey(filePath: string): string {
  if (!isAbsolute(filePath)) return filePath
  const cwd = getOriginalCwd()
  if (filePath.startsWith(cwd)) return relative(cwd, filePath)
  return filePath
}

export function maybeExpandFilePath(trackingKey: string): string {
  if (isAbsolute(trackingKey)) return trackingKey
  return join(getOriginalCwd(), trackingKey)
}

function backupDirectory(sessionId: string = getSessionId()): string {
  return join(getMercuryHome(), 'file-history', sessionId)
}

function backupFileName(filePath: string, version: number): string {
  const hash = createHash('sha256').update(filePath).digest('hex').slice(0, 16)
  return `${hash}@v${version}`
}

function backupPath(backupName: string, sessionId?: string): string {
  return join(backupDirectory(sessionId), backupName)
}

async function createBackup(filePath: string, version: number): Promise<FileHistoryBackup> {
  let stats: StatResult
  try {
    stats = await statCounted(filePath)
  } catch (error) {
    if (isENOENT(error)) {
      return { backupFileName: null, version, backupTime: new Date() }
    }
    throw error
  }
  const name = backupFileName(filePath, version)
  const target = backupPath(name)
  try {
    await copyCounted(filePath, target)
  } catch (error) {
    if (isENOENT(error)) {
      await mkdir(backupDirectory(), { recursive: true })
      await copyCounted(filePath, target)
    } else {
      throw error
    }
  }
  await chmod(target, stats.mode)
  return {
    backupFileName: name,
    version,
    backupTime: new Date(),
    ...sourceHint(stats),
  }
}

async function statOrMissing(
  path: string,
): Promise<{ status: 'ok'; stats: StatResult } | { status: 'missing' } | { status: 'error' }> {
  try {
    return { status: 'ok', stats: await statCounted(path) }
  } catch (error) {
    if (isENOENT(error)) return { status: 'missing' }
    passedOver(error)
    return { status: 'error' }
  }
}

async function filesMatch(
  sourcePath: string,
  targetPath: string,
  sourceStats?: StatResult,
): Promise<boolean> {
  const [src, dst] = await Promise.all([
    sourceStats !== undefined
      ? Promise.resolve({ status: 'ok' as const, stats: sourceStats })
      : statOrMissing(sourcePath),
    statOrMissing(targetPath),
  ])
  if (src.status === 'missing' && dst.status === 'missing') return true
  if (src.status !== 'ok' || dst.status !== 'ok') return false
  if (src.stats.mode !== dst.stats.mode || src.stats.size !== dst.stats.size) return false
  try {
    const [a, b] = await Promise.all([readCounted(sourcePath), readCounted(targetPath)])
    return a.equals(b)
  } catch (error) {
    passedOver(error)
    return false
  }
}

function captureState(updateState: StateUpdater): FileHistoryState | undefined {
  let captured: FileHistoryState | undefined
  updateState(prev => {
    captured = prev
    return prev
  })
  return captured
}

function latestSnapshot(state: FileHistoryState): FileHistorySnapshot | undefined {
  return state.snapshots[state.snapshots.length - 1]
}


export async function fileHistoryTrackEdit(updateState: StateUpdater, filePath: string, messageId: UUID): Promise<void> {
  try {
    noteFileTouched(filePath)
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
      await recordFileHistorySnapshot(messageId, persisted, true)
    }
  } catch (err) {
    logError(err)
  }
}


export async function fileHistoryMakeSnapshot(updateState: StateUpdater, messageId: UUID): Promise<void> {
  updateState(prev => {
    if (prev.rewindUndo === undefined) return prev
    const { rewindUndo: _, ...rest } = prev
    return rest
  })
  if (!fileHistoryEnabled()) return
  try {
    const state = captureState(updateState)
    if (!state) return
    const previous = latestSnapshot(state)
    const trackedFileBackups: Record<string, FileHistoryBackup> = {}
    if (previous) {
      await Promise.all(
        [...state.trackedFiles].map(async key => {
          try {
            const prior = previous.trackedFileBackups[key]
            const nextVersion = prior ? prior.version + 1 : 1
            const fullPath = maybeExpandFilePath(key)
            let sourceStats: StatResult | null
            try {
              sourceStats = await statCounted(fullPath)
            } catch (error) {
              if (isENOENT(error)) {
                sourceStats = null
              } else {
                throw error
              }
            }
            if (sourceStats === null) {
              trackedFileBackups[key] = {
                backupFileName: null,
                version: nextVersion,
                backupTime: new Date(),
              }
              return
            }
            if (prior && prior.backupFileName !== null) {
              if (hintMatches(prior, sourceStats)) {
                trackedFileBackups[key] = prior
                return
              }
              if (await filesMatch(fullPath, backupPath(prior.backupFileName), sourceStats)) {
                trackedFileBackups[key] = {
                  backupFileName: prior.backupFileName,
                  version: prior.version,
                  backupTime: prior.backupTime,
                  ...sourceHint(sourceStats),
                }
                return
              }
            }
            trackedFileBackups[key] = await createBackup(fullPath, nextVersion)
          } catch (error) {
            logError(error)
          }
        }),
      )
    }
    let committed: FileHistorySnapshot | undefined
    updateState(prev => {
      const livePrevious = latestSnapshot(prev)
      const mergedBackups: Record<string, FileHistoryBackup> = { ...trackedFileBackups }
      if (livePrevious) {
        for (const key of prev.trackedFiles) {
          if (
            !Object.hasOwn(mergedBackups, key) &&
            Object.hasOwn(livePrevious.trackedFileBackups, key)
          ) {
            const entry = livePrevious.trackedFileBackups[key]
            if (entry) mergedBackups[key] = entry
          }
        }
      }
      committed = {
        messageId,
        trackedFileBackups: mergedBackups,
        timestamp: new Date(),
      }
      return {
        ...prev,
        snapshots: [...prev.snapshots, committed].slice(-MAX_SNAPSHOTS),
        snapshotSequence: prev.snapshotSequence + 1,
      }
    })
    if (committed) {
      void recordFileHistorySnapshot(messageId, committed, false).catch(logError)
    }
  } catch (error) {
    logError(error)
  }
}


function resolveTargetBackup(state: FileHistoryState, snapshot: FileHistorySnapshot, key: string): FileHistoryBackup | undefined {
  const own = snapshot.trackedFileBackups[key]
  if (own) return own
  for (const candidate of state.snapshots) {
    const entry = candidate.trackedFileBackups[key]
    if (entry && entry.version === 1) return entry
  }
  return undefined
}


export function fileHistoryCanRestore(state: FileHistoryState, messageId: UUID): boolean {
  if (!fileHistoryEnabled()) return false
  return state.snapshots.some(snapshot => snapshot.messageId === messageId)
}


type FileHistoryRestoreRefusalKind = 'no-checkpoint' | 'drift' | 'backup-missing' | 'restore-failed'

type FileHistoryRestoreResult =
  | { ok: true; changed: string[]; insertions: number; deletions: number; dryRun: boolean }
  | { ok: false; kind: FileHistoryRestoreRefusalKind; paths: string[]; detail: string }

interface RestoreDriftEntry {
  content: string
  timestamp: number
  offset: number | undefined
  limit: number | undefined
  isPartialView?: boolean | undefined
}

export interface RestoreDriftOracle {
  get(path: string): RestoreDriftEntry | undefined
  set?(path: string, entry: RestoreDriftEntry): unknown
  delete?(path: string): unknown
}

async function readBytesOrNull(path: string): Promise<Buffer | null> {
  try {
    return await readFile(path)
  } catch (error) {
    if (isENOENT(error)) return null
    throw error
  }
}

function blobMatchesRecord(blobSize: number, record: FileHistoryBackup): boolean {
  return record.sourceSize === undefined || record.sourceSize === blobSize
}

function cachedSpelling(text: string): string {
  return stripBOM(text).replaceAll('\r\n', '\n')
}

function decodeSpelling(bytes: Buffer): string {
  return bytes.toString(bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe ? 'utf16le' : 'utf8')
}

function decodeAsCached(bytes: Buffer): string {
  return cachedSpelling(decodeSpelling(bytes))
}

async function driftedSinceLastTouch(entry: RestoreDriftEntry, filePath: string, current: Buffer): Promise<boolean> {
  let mtime: number
  try {
    mtime = Math.floor((await stat(filePath)).mtimeMs)
  } catch (err) {
    if (isENOENT(err)) return false
    throw err
  }
  if (mtime <= entry.timestamp) return false
  const fullView = (entry.offset === undefined || entry.offset === 0) && entry.limit === undefined
  if (fullView || entry.isPartialView === true) {
    return entry.content !== current.toString('utf8') && cachedSpelling(entry.content) !== decodeAsCached(current)
  }
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

export async function fileHistoryRestore(
  state: FileHistoryState,
  messageId: UUID,
  opts: { dryRun: boolean; ownerKey: string; drift?: RestoreDriftOracle; signal?: AbortSignal; filePath?: string; undo?: boolean; updateState?: StateUpdater },
): Promise<FileHistoryRestoreResult> {
  const snapshot = opts.undo
    ? state.rewindUndo?.messageId === messageId ? state.rewindUndo : undefined
    : [...state.snapshots].reverse().find(candidate => candidate.messageId === messageId)
  if (!snapshot) {
    return { ok: false, kind: 'no-checkpoint', paths: [], detail: 'no saved files at this point — the checkpoint store holds nothing for it' }
  }
  const targets: CommitTarget[] = []
  const changed: string[] = []
  const drifted: string[] = []
  const missing: string[] = []
  let insertions = 0
  let deletions = 0
  const selectedKey = opts.filePath === undefined ? undefined : toTrackingKey(opts.filePath)
  if (selectedKey !== undefined && !state.trackedFiles.has(selectedKey)) {
    return { ok: false, kind: 'no-checkpoint', paths: [selectedKey], detail: `${selectedKey} is not tracked at this checkpoint — nothing was restored` }
  }
  const keys = opts.undo ? Object.keys(snapshot.trackedFileBackups) : selectedKey === undefined ? state.trackedFiles : [selectedKey]
  for (const key of keys) {
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
    if (opts.undo && state.rewindUndo?.restoredDigests[key] !== (current === null ? null : sha256Hex(current))) {
      drifted.push(key)
      continue
    }
    let planned: Buffer | null = null
    let plannedMode = 0o644
    if (target.backupFileName !== null) {
      const blob = backupPath(target.backupFileName)
      planned = await readBytesOrNull(blob)
      if (planned === null || !blobMatchesRecord(planned.length, target)) {
        missing.push(key)
        continue
      }
      try {
        plannedMode = (await stat(blob)).mode & 0o7777
      } catch (err) {
        if (isENOENT(err)) {
          missing.push(key)
          continue
        }
        return { ok: false, kind: 'restore-failed', paths: [key], detail: `${key}: ${err instanceof Error ? err.message : String(err)} — nothing was restored` }
      }
    }
    if (current === null && planned === null) continue
    if (current !== null && planned !== null && current.equals(planned)) continue
    const known = current !== null ? opts.drift?.get(filePath) : undefined
    let driftedHere: boolean
    try {
      driftedHere = known !== undefined && current !== null && (await driftedSinceLastTouch(known, filePath, current))
    } catch (err) {
      return { ok: false, kind: 'restore-failed', paths: [key], detail: `${key}: ${err instanceof Error ? err.message : String(err)} — nothing was restored` }
    }
    if (driftedHere) {
      drifted.push(key)
      continue
    }
    let mode = plannedMode
    if (current !== null) {
      try {
        mode = (await stat(filePath)).mode & 0o7777
      } catch (err) {
        return { ok: false, kind: 'restore-failed', paths: [key], detail: `${key}: ${err instanceof Error ? err.message : String(err)} — nothing was restored` }
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
  let undo: FileHistoryState['rewindUndo']
  if (!opts.undo && opts.updateState !== undefined) {
    undo = { messageId: randomUUID(), timestamp: new Date(), trackedFileBackups: {}, restoredDigests: {} }
    await mkdir(backupDirectory(), { recursive: true })
    for (let i = 0; i < targets.length; i++) {
      const target = targets[i]!
      const name = target.kind === 'create' ? null : `${backupFileName(target.canonicalPath, 0)}-${undo.messageId}`
      if (name !== null) {
        await writeFile(backupPath(name), target.originalBytes, { flag: 'wx', mode: target.mode })
        if (!(await readFile(backupPath(name))).equals(target.originalBytes)) {
          return { ok: false, kind: 'restore-failed', paths: [changed[i]!], detail: 'the pre-rewind snapshot could not be verified — nothing was restored' }
        }
      }
      undo.trackedFileBackups[changed[i]!] = { backupFileName: name, version: 0, backupTime: undo.timestamp, sourceSize: target.originalBytes.length }
      undo.restoredDigests[changed[i]!] = target.kind === 'delete' ? null : target.plannedDigest
    }
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
      for (const target of targets) {
        if (target.kind === 'delete') {
          opts.drift?.delete?.(target.canonicalPath)
          continue
        }
        let timestamp = Date.now()
        try {
          timestamp = Math.floor((await stat(target.canonicalPath)).mtimeMs)
        } catch (error) {
          passedOver(error)
        }
        opts.drift?.set?.(target.canonicalPath, { content: decodeSpelling(target.plannedBytes).replaceAll('\r\n', '\n'), timestamp, offset: undefined, limit: undefined })
      }
      opts.updateState?.(prev => {
        const { rewindUndo: _prior, ...next } = prev
        return undo === undefined ? next : { ...next, rewindUndo: undo }
      })
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


export function fileHistoryRestoreStateFromSnapshots(
  snapshots: FileHistorySnapshot[],
  onUpdateState: (state: FileHistoryState) => void,
): void {
  if (!fileHistoryEnabled()) return
  const trackedFiles = new Set<string>()
  const migrated = snapshots.map(snapshot => {
    const trackedFileBackups: Record<string, FileHistoryBackup> = {}
    for (const [key, backup] of Object.entries(snapshot.trackedFileBackups)) {
      const normalized = toTrackingKey(key)
      trackedFiles.add(normalized)
      trackedFileBackups[normalized] = backup
    }
    return {
      ...snapshot,
      trackedFileBackups,
    }
  })
  onUpdateState({
    snapshots: migrated,
    trackedFiles,
    snapshotSequence: migrated.length,
  })
}

export async function copyFileHistoryForResume(log: SessionListing): Promise<void> {
  if (!fileHistoryEnabled()) return
  const snapshots = log.fileHistorySnapshots
  if (!snapshots || snapshots.length === 0) return
  if (!log.messages || log.messages.length === 0) return
  const lastMessage = log.messages[log.messages.length - 1]
  const previousSessionId = lastMessage.sessionId
  if (!previousSessionId) {
    logError(new Error('copyFileHistoryForResume: no previous session id on the last message'))
    return
  }
  const currentSessionId = getSessionId()
  if (previousSessionId === currentSessionId) return
  try {
    await mkdir(backupDirectory(currentSessionId), { recursive: true })
    let failedSnapshots = 0
    await Promise.all(
      snapshots.map(async snapshot => {
        let snapshotFailed = false
        const entries = Object.values(snapshot.trackedFileBackups).filter(
          (backup): backup is FileHistoryBackup & { backupFileName: string } =>
            backup.backupFileName !== null,
        )
        await Promise.all(
          entries.map(async backup => {
            const source = backupPath(backup.backupFileName, previousSessionId)
            const target = backupPath(backup.backupFileName, currentSessionId)
            try {
              await link(source, target)
            } catch (error) {
              if (isENOENT(error)) {
                snapshotFailed = true
                return
              }
              if (getErrnoCode(error) !== 'EEXIST') {
                try {
                  await copyFile(source, target)
                } catch (copyError) {
                  passedOver(copyError)
                  snapshotFailed = true
                  return
                }
              }
            }
            try {
              const targetStats = await stat(target)
              if (!blobMatchesRecord(targetStats.size, backup)) {
                snapshotFailed = true
              }
            } catch (statError) {
              passedOver(statError)
              snapshotFailed = true
            }
          }),
        )
        if (snapshotFailed) {
          failedSnapshots++
          return
        }
        await recordFileHistorySnapshot(snapshot.messageId, snapshot, false)
      }),
    )
    if (failedSnapshots > 0) {
      logForDebugging(
        `copyFileHistoryForResume: ${failedSnapshots} snapshot(s) had missing blobs and were not re-recorded`,
      )
    }
  } catch (error) {
    logError(error)
  }
}
