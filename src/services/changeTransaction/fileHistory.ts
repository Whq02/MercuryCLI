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
import { isENOENT } from '../../utils/errors.js'
import { stripBOM } from '../../utils/jsonRead.js'
import { logError } from '../../utils/log.js'
import { recordFileHistorySnapshot } from '../../utils/sessionStorage.js'
import { passedOver } from '../../utils/passedOver.js'
import { notBuilt, type Unbuilt } from '../../pi/holes.js'


type StateUpdater = (...args: Unbuilt[]) => Unbuilt
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
  return notBuilt('src/services/changeTransaction/fileHistory.ts:77')
}

export function maybeExpandFilePath(trackingKey: string): string {
  return notBuilt('src/services/changeTransaction/fileHistory.ts:90')
}

function backupDirectory(sessionId: string = getSessionId()): string {
  return join(getMercuryHome(), 'file-history', sessionId)
}

function latestSnapshot(state: FileHistoryState): FileHistorySnapshot | undefined {
  return state.snapshots[state.snapshots.length - 1]
}


export async function fileHistoryTrackEdit(updateState: StateUpdater, filePath: string, messageId: UUID): Promise<void> {
  return notBuilt('src/services/changeTransaction/fileHistory.ts:171')
}


export async function fileHistoryMakeSnapshot(updateState: StateUpdater, messageId: UUID): Promise<void> {
  return notBuilt('src/services/changeTransaction/fileHistory.ts:208')
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
  return notBuilt('src/services/changeTransaction/fileHistory.ts:291')
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
  return notBuilt('src/services/changeTransaction/fileHistory.ts:561')
}

export async function copyFileHistoryForResume(log: SessionListing): Promise<void> {
  return notBuilt('src/services/changeTransaction/fileHistory.ts:579')
}
