import { createHash, randomUUID } from 'node:crypto'
import type { UUID } from 'node:crypto'
import type { Stats } from 'node:fs'
import { chmod, copyFile, link, mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { isAbsolute, join, relative } from 'node:path'

import { structuredPatch } from 'diff'

import { getIsNonInteractiveSession, getOriginalCwd, getSessionId } from '../../bootstrap/state.js'
import { commitPlanDigest, runTextChangeSetCommit, type CommitTarget } from './changeSetCommit.js'
import { sha256Hex } from '../../utils/hash.js'
import { flagEnv } from '../../substrate/flagRegistry.js'
import type { FileHistoryBackup, FileHistorySnapshot, FileHistoryState } from '../../types/fileHistory.js'
import type { SessionListing } from '../../types/logs.js'
import { getGlobalConfig } from '../../utils/config.js'
import { logForDebugging } from '../../utils/debug.js'
import { noteFileTouched } from '../../mneme/lineageSession.js'
import { getMercuryHome } from '../../utils/envUtils.js'
import { getErrnoCode, isENOENT } from '../../utils/errors.js'
import { stripBOM } from '../../utils/jsonRead.js'
import { logError } from '../../utils/log.js'
import { recordFileHistorySnapshot } from '../../utils/sessionStorage.js'
import { passedOver } from '../../utils/passedOver.js'
import { notBuilt } from '../../pi/holes.js'


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
  return notBuilt('src/services/changeTransaction/fileHistory.ts:171')
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
  return notBuilt('src/services/changeTransaction/fileHistory.ts:377')
}


export function fileHistoryRestoreStateFromLog(
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
  const previousSessionId = lastMessage?.sessionId
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
