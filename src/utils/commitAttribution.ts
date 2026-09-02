import { createHash, randomUUID } from 'node:crypto'
import { isAbsolute, join, relative, sep } from 'node:path'

import { getOriginalCwd, getSessionId } from '../bootstrap/state.js'
import type { AttributionSnapshotMessage, FileAttributionState } from '../types/logs.js'
import { getCwd } from './cwd.js'
import { logForDebugging } from './debug.js'
import { execFileNoThrowWithCwd } from './execFileNoThrow.js'
import { getFsImplementation } from './fsOperations.js'
import { findGitRoot, gitExe } from './git.js'
import { resolveGitDir } from './git/gitFilesystem.js'
import { isGeneratedFile } from './generatedFiles.js'
import { logError } from './log.js'

/**
 * Character-level attribution accounting per file, snapshot persistence and
 * restore, and the git staged-file/diff probes that turn tracked states into
 * the commit attribution document written to git notes.
 */

const GIT_PROBE_TIMEOUT_MS = 5000

// Average characters per line, applied to git's insertion/deletion counts.
const CHARS_PER_LINE_ESTIMATE = 40

// Used for an untracked staged deletion whose diff estimate came back zero.
// A zero-fallback, not a floor: a one-line deletion estimating 40 stays 40.
const UNTRACKED_DELETION_FALLBACK_CHARS = 100

type SessionBaseline = {
  contentHash: string
  mtime: number
}

export type AttributionState = {
  fileStates: Map<string, FileAttributionState>
  sessionBaselines: Map<string, SessionBaseline>
  surface: string
  startingHeadSha: string | null
  promptCount: number
  promptCountAtLastCommit: number
  permissionPromptCount: number
  permissionPromptCountAtLastCommit: number
  escapeCount: number
  escapeCountAtLastCommit: number
}

export type AttributionSummary = {
  mercuryChars: number
  humanChars: number
  percentage: number
  /** Union of the merged states' surfaces, in insertion order. */
  surfaces: string[]
}

export type FileAttribution = {
  mercuryChars: number
  humanChars: number
  percentage: number
  surface: string
}

export type AttributionData = {
  version: 1
  summary: AttributionSummary
  files: Record<string, FileAttribution>
  surfaceBreakdown: Record<string, { mercuryChars: number; percentage: number }>
  excludedGenerated: string[]
  sessions: string[]
}

/**
 * The repo root for all attribution operations: the git root of the TRACKED
 * working directory (the one that follows an agent into its worktree, not
 * the process directory), falling back to the original launch directory.
 */
export function getAttributionRepoRoot(): string {
  return findGitRoot(getCwd()) ?? getOriginalCwd()
}

/**
 * The client surface string. Defaults to `cli` only when the variable is
 * UNSET — an explicitly empty value is kept as the empty surface.
 */
export function getClientSurface(): string {
  const value = process.env.MERCURY_ENTRYPOINT
  return value === undefined ? 'cli' : value
}

export function computeContentHash(content: string): string {
  return createHash('sha256').update(content).digest('hex')
}

function toEntries<V>(mapOrObject: Map<string, V> | Record<string, V> | undefined): Array<[string, V]> {
  if (!mapOrObject) return []
  if (mapOrObject instanceof Map) return [...mapOrObject.entries()]
  return Object.entries(mapOrObject)
}

function tryRelativeUnderRoot(root: string, filePath: string): string | null {
  const relativePath = relative(root, filePath)
  if (relativePath === '' || relativePath.startsWith('..') || isAbsolute(relativePath)) return null
  // git prints staged paths with forward slashes on every platform, and the
  // per-file map is keyed by exactly those strings.
  return relativePath.split(sep).join('/')
}

/**
 * Relative paths pass through. Absolute paths are compared against the repo
 * root with symlinks resolved on both sides (so a path reached through a
 * symlinked parent, such as macOS's temporary directory, still lands inside
 * the root); a resolution failure on either side leaves that side
 * unresolved. A fallback comparison against the unresolved root is tried
 * before giving up and returning the path unchanged.
 */
export function normalizeFilePath(filePath: string): string {
  if (!isAbsolute(filePath)) return filePath
  const root = getAttributionRepoRoot()
  const fs = getFsImplementation()
  let resolvedPath = filePath
  try {
    resolvedPath = fs.realpathSync(filePath)
  } catch {
    // Leave unresolved.
  }
  let resolvedRoot = root
  try {
    resolvedRoot = fs.realpathSync(root)
  } catch {
    // Leave unresolved.
  }
  return (
    tryRelativeUnderRoot(resolvedRoot, resolvedPath) ??
    tryRelativeUnderRoot(root, filePath) ??
    filePath
  )
}

/** The inverse: absolute paths pass through, relative ones join the root. */
export function expandFilePath(filePath: string): string {
  if (isAbsolute(filePath)) return filePath
  return join(getAttributionRepoRoot(), filePath)
}

export function createEmptyAttributionState(): AttributionState {
  return {
    fileStates: new Map(),
    sessionBaselines: new Map(),
    surface: getClientSurface(),
    startingHeadSha: null,
    promptCount: 0,
    promptCountAtLastCommit: 0,
    permissionPromptCount: 0,
    permissionPromptCountAtLastCommit: 0,
    escapeCount: 0,
    escapeCountAtLastCommit: 0,
  }
}

/**
 * The file's mtime in ms, or now when it does not exist. Async so callers
 * can precompute it before entering a synchronous state update.
 */
export async function getFileMtime(filePath: string): Promise<number> {
  try {
    const expanded = expandFilePath(normalizeFilePath(filePath))
    const stats = await getFsImplementation().stat(expanded)
    return stats.mtimeMs
  } catch {
    return Date.now()
  }
}

/**
 * Character contribution of one modification. Creation or full deletion
 * contributes the non-empty side's length. Otherwise the common prefix and
 * suffix are measured (the suffix scan must not overrun into the prefix)
 * and the larger changed-region length is the contribution — a replacement
 * that keeps the length (one word re-cased) still counts its changed span,
 * where a naive size delta would count nothing.
 */
function computeCharacterContribution(oldContent: string, newContent: string): number {
  if (oldContent.length === 0 || newContent.length === 0) {
    return Math.max(oldContent.length, newContent.length)
  }
  const shorter = Math.min(oldContent.length, newContent.length)
  let prefix = 0
  while (prefix < shorter && oldContent[prefix] === newContent[prefix]) {
    prefix++
  }
  let suffix = 0
  const maxSuffix = shorter - prefix
  while (
    suffix < maxSuffix &&
    oldContent[oldContent.length - 1 - suffix] === newContent[newContent.length - 1 - suffix]
  ) {
    suffix++
  }
  const oldChanged = oldContent.length - prefix - suffix
  const newChanged = newContent.length - prefix - suffix
  return Math.max(oldChanged, newChanged)
}

/** The per-file contributed-character count. */
function contributedChars(s: FileAttributionState | undefined): number {
  return s?.mercuryContribution ?? 0
}

/**
 * Track a modification. The "user modified" flag is accepted and ignored —
 * kept for call-site compatibility only. A failed contribution computation
 * returns the ORIGINAL state object unchanged (not a copy).
 */
export function trackFileModification(
  state: AttributionState,
  filePath: string,
  oldContent: string,
  newContent: string,
  _userModified: boolean,
  mtime?: number,
): AttributionState {
  try {
    const normalized = normalizeFilePath(filePath)
    const contribution = computeCharacterContribution(oldContent, newContent)
    const fileStates = new Map(toEntries(state.fileStates))
    const existing = fileStates.get(normalized)
    fileStates.set(normalized, {
      contentHash: computeContentHash(newContent),
      mercuryContribution: contributedChars(existing) + contribution,
      mtime: mtime ?? Date.now(),
    })
    logForDebugging(`attribution: tracked ${contribution} chars for ${normalized}`)
    return { ...state, fileStates }
  } catch (err) {
    logError(err)
    return state
  }
}

export function trackFileCreation(
  state: AttributionState,
  filePath: string,
  content: string,
  mtime?: number,
): AttributionState {
  return trackFileModification(state, filePath, '', content, false, mtime)
}

/**
 * Track a deletion: the old content's length joins the accumulated
 * contribution and the stored hash is the empty content's, always stamped
 * with the current time (this single-file form takes no mtime argument).
 */
export function trackFileDeletion(
  state: AttributionState,
  filePath: string,
  oldContent: string,
): AttributionState {
  try {
    const normalized = normalizeFilePath(filePath)
    const fileStates = new Map(toEntries(state.fileStates))
    const existing = fileStates.get(normalized)
    fileStates.set(normalized, {
      contentHash: computeContentHash(''),
      mercuryContribution: contributedChars(existing) + oldContent.length,
      mtime: Date.now(),
    })
    logForDebugging(`attribution: tracked deletion of ${normalized} (${oldContent.length} chars)`)
    return { ...state, fileStates }
  } catch (err) {
    logError(err)
    return state
  }
}

export type BulkFileChange = {
  path: string
  type: 'modified' | 'created' | 'deleted'
  oldContent: string
  newContent: string
  mtime?: number
}

/**
 * Bulk tracking with ONE map copy mutated per change, to avoid quadratic
 * copying over very large diffs. One divergence from the single-file rules:
 * a bulk deletion honours a supplied mtime (falling back to now). A change
 * whose computation fails is skipped and the rest continue.
 */
export function trackBulkFileChanges(
  state: AttributionState,
  changes: BulkFileChange[],
): AttributionState {
  const fileStates = new Map(toEntries(state.fileStates))
  for (const change of changes) {
    try {
      const normalized = normalizeFilePath(change.path)
      const existing = fileStates.get(normalized)
      if (change.type === 'deleted') {
        fileStates.set(normalized, {
          contentHash: computeContentHash(''),
          mercuryContribution: contributedChars(existing) + change.oldContent.length,
          mtime: change.mtime ?? Date.now(),
        })
      } else {
        const contribution = computeCharacterContribution(change.oldContent, change.newContent)
        fileStates.set(normalized, {
          contentHash: computeContentHash(change.newContent),
          mercuryContribution: contributedChars(existing) + contribution,
          mtime: change.mtime ?? Date.now(),
        })
      }
    } catch (err) {
      logError(err)
    }
  }
  return { ...state, fileStates }
}

type MergedStates = {
  surface: string
  /** Union of the input states' surfaces, insertion order. */
  surfaces: string[]
  fileStates: Map<string, FileAttributionState>
  sessionBaselines: Map<string, SessionBaseline>
}

/**
 * Merge states: baselines earliest-wins; file states sum their
 * contributions for the same path, the merged entry's other fields coming
 * from the LATER state (nothing downstream reads them). Both maps are
 * accepted as real maps or as serialized plain objects; a missing map is
 * empty.
 */
function mergeStates(states: AttributionState[]): MergedStates {
  const fileStates = new Map<string, FileAttributionState>()
  const sessionBaselines = new Map<string, SessionBaseline>()
  const surfaces: string[] = []
  for (const state of states) {
    if (!surfaces.includes(state.surface)) surfaces.push(state.surface)
    for (const [path, baseline] of toEntries(state.sessionBaselines)) {
      if (!sessionBaselines.has(path)) sessionBaselines.set(path, baseline)
    }
    for (const [path, fileState] of toEntries(state.fileStates)) {
      const existing = fileStates.get(path)
      fileStates.set(path, {
        ...fileState,
        mercuryContribution: contributedChars(existing) + contributedChars(fileState),
      })
    }
  }
  return { surface: states[0]?.surface ?? getClientSurface(), surfaces, fileStates, sessionBaselines }
}

/**
 * Compute the commit attribution document over merged states and the staged
 * file list. Byte counts stand in for character counts — file content is
 * never read, so a multi-gigabyte artefact costs one stat.
 */
export async function calculateCommitAttribution(
  states: AttributionState[],
  stagedFiles: string[],
): Promise<AttributionData> {
  const merged = mergeStates(states)
  const files: Record<string, FileAttribution> = {}
  const excludedGenerated: string[] = []

  type WalkOutcome =
    | { kind: 'excluded' }
    | { kind: 'dropped' }
    | { kind: 'file'; attribution: FileAttribution }

  const outcomes = await Promise.all(
    stagedFiles.map(async (stagedFile): Promise<WalkOutcome> => {
      if (isGeneratedFile(stagedFile)) {
        return { kind: 'excluded' }
      }
      const tracked = merged.fileStates.get(stagedFile)
      let mercuryChars = 0
      let humanChars = 0
      if (await isFileDeleted(stagedFile)) {
        if (tracked) {
          mercuryChars = contributedChars(tracked)
        } else {
          const estimate = await getGitDiffSize(stagedFile)
          humanChars = estimate === 0 ? UNTRACKED_DELETION_FALLBACK_CHARS : estimate
        }
      } else {
        let fileSize: number
        try {
          const stats = await getFsImplementation().stat(expandFilePath(stagedFile))
          fileSize = stats.size
        } catch {
          // A stat failure drops the file from the result entirely.
          return { kind: 'dropped' }
        }
        if (tracked) {
          mercuryChars = contributedChars(tracked)
        } else if (merged.sessionBaselines.has(stagedFile)) {
          const estimate = await getGitDiffSize(stagedFile)
          humanChars = estimate === 0 ? fileSize : estimate
        } else {
          // A new file not created by Mercury: wholly human.
          humanChars = fileSize
        }
      }
      mercuryChars = Math.max(0, mercuryChars)
      humanChars = Math.max(0, humanChars)
      const total = mercuryChars + humanChars
      return {
        kind: 'file',
        attribution: {
          mercuryChars,
          humanChars,
          percentage: total === 0 ? 0 : Math.round((mercuryChars / total) * 100),
          surface: merged.surface,
        },
      }
    }),
  )
  // Aggregated AFTER the concurrent walk, in staged-file order, so the
  // document's key order is deterministic.
  for (let i = 0; i < stagedFiles.length; i++) {
    const outcome = outcomes[i] as WalkOutcome
    const stagedFile = stagedFiles[i] as string
    if (outcome.kind === 'excluded') {
      excludedGenerated.push(stagedFile)
    } else if (outcome.kind === 'file') {
      files[stagedFile] = outcome.attribution
    }
  }

  let totalMercury = 0
  let totalHuman = 0
  const perSurfaceMercury: Record<string, number> = {}
  for (const attribution of Object.values(files)) {
    totalMercury += attribution.mercuryChars
    totalHuman += attribution.humanChars
    perSurfaceMercury[attribution.surface] =
      (perSurfaceMercury[attribution.surface] ?? 0) + attribution.mercuryChars
  }
  const grandTotal = totalMercury + totalHuman
  const surfaceBreakdown: Record<string, { mercuryChars: number; percentage: number }> = {}
  for (const [surface, mercuryChars] of Object.entries(perSurfaceMercury)) {
    // A share of the GRAND total (Mercury + human), not of the Mercury
    // total, so the per-surface percentages sum to the overall percentage.
    surfaceBreakdown[surface] = {
      mercuryChars,
      percentage: grandTotal === 0 ? 0 : Math.round((mercuryChars / grandTotal) * 100),
    }
  }

  return {
    version: 1,
    summary: {
      mercuryChars: totalMercury,
      humanChars: totalHuman,
      percentage: grandTotal === 0 ? 0 : Math.round((totalMercury / grandTotal) * 100),
      surfaces: merged.surfaces,
    },
    files,
    surfaceBreakdown,
    excludedGenerated,
    sessions: [getSessionId()],
  }
}

/**
 * Estimated staged-diff size in characters: insertions plus deletions from
 * the `--stat` summary line, at 40 characters per line. Never throws.
 */
export async function getGitDiffSize(filePath: string): Promise<number> {
  try {
    const result = await execFileNoThrowWithCwd(
      gitExe(),
      ['diff', '--cached', '--stat', '--', filePath],
      { cwd: getAttributionRepoRoot(), timeout: GIT_PROBE_TIMEOUT_MS },
    )
    if (result.code !== 0) return 0
    const lines = result.stdout.trim().split('\n')
    const summary = lines[lines.length - 1] ?? ''
    if (!summary) return 0
    const insertions = Number(/(\d+) insertion/.exec(summary)?.[1] ?? 0)
    const deletions = Number(/(\d+) deletion/.exec(summary)?.[1] ?? 0)
    return (insertions + deletions) * CHARS_PER_LINE_ESTIMATE
  } catch {
    return 0
  }
}

/** True when git reports the staged change for the path as a deletion. */
export async function isFileDeleted(filePath: string): Promise<boolean> {
  try {
    const result = await execFileNoThrowWithCwd(
      gitExe(),
      ['diff', '--cached', '--name-status', '--', filePath],
      { cwd: getAttributionRepoRoot(), timeout: GIT_PROBE_TIMEOUT_MS },
    )
    return result.stdout.trim().startsWith('D\t')
  } catch {
    return false
  }
}

export async function getStagedFiles(): Promise<string[]> {
  try {
    const result = await execFileNoThrowWithCwd(gitExe(), ['diff', '--cached', '--name-only'], {
      cwd: getAttributionRepoRoot(),
      timeout: GIT_PROBE_TIMEOUT_MS,
    })
    if (result.code !== 0) return []
    return result.stdout.split('\n').filter(line => line.length > 0)
  } catch (err) {
    logError(err)
    return []
  }
}

/**
 * True when the repository is mid-rebase/merge/cherry-pick/bisect — git's
 * own marker names, probed concurrently inside the resolved git directory.
 */
export async function isGitTransientState(): Promise<boolean> {
  const gitDir = await resolveGitDir()
  if (!gitDir) return false
  const markers = ['rebase-merge', 'rebase-apply', 'MERGE_HEAD', 'CHERRY_PICK_HEAD', 'BISECT_LOG']
  const fs = getFsImplementation()
  const present = await Promise.all(
    markers.map(async marker => fs.existsSync(join(gitDir, marker))),
  )
  return present.some(Boolean)
}

/**
 * Mint the session-JSONL snapshot record. It deliberately carries neither
 * the session baselines nor the starting HEAD sha.
 */
export function stateToSnapshotMessage(
  state: AttributionState,
  messageId: string,
): AttributionSnapshotMessage {
  return {
    type: 'attribution-snapshot',
    messageId,
    surface: state.surface,
    fileStates: Object.fromEntries(toEntries(state.fileStates)),
    promptCount: state.promptCount,
    promptCountAtLastCommit: state.promptCountAtLastCommit,
    permissionPromptCount: state.permissionPromptCount,
    permissionPromptCountAtLastCommit: state.permissionPromptCountAtLastCommit,
    escapeCount: state.escapeCount,
    escapeCountAtLastCommit: state.escapeCountAtLastCommit,
  } as AttributionSnapshotMessage
}

/**
 * Restore from snapshots. Every snapshot carries the WHOLE state as of its
 * writing (the file-state map only ever grows), so only the LAST one is
 * read — summing them instead is a known defect class: each snapshot
 * already contains every earlier one's totals, so the sum grows with the
 * square of the session length. A restored state always comes back with
 * empty baselines and a null starting HEAD sha; the commit-attribution
 * merge tolerates that (a tracked file with no baseline is still attributed
 * to Mercury).
 */
export function restoreAttributionStateFromSnapshots(
  snapshots: AttributionSnapshotMessage[],
): AttributionState {
  const empty = createEmptyAttributionState()
  const last = snapshots[snapshots.length - 1]
  if (!last) return empty
  const fileStates = new Map<string, FileAttributionState>()
  for (const [path, raw] of Object.entries(last.fileStates ?? {})) {
    fileStates.set(path, {
      contentHash: raw.contentHash,
      mercuryContribution: contributedChars(raw),
      mtime: raw.mtime,
    })
  }
  return {
    ...empty,
    surface: last.surface,
    fileStates,
    promptCount: last.promptCount ?? 0,
    promptCountAtLastCommit: last.promptCountAtLastCommit ?? 0,
    permissionPromptCount: last.permissionPromptCount ?? 0,
    permissionPromptCountAtLastCommit: last.permissionPromptCountAtLastCommit ?? 0,
    escapeCount: last.escapeCount ?? 0,
    escapeCountAtLastCommit: last.escapeCountAtLastCommit ?? 0,
  }
}

export function attributionRestoreStateFromLog(
  snapshots: AttributionSnapshotMessage[],
  onUpdateState: (state: AttributionState) => void,
): void {
  onUpdateState(restoreAttributionStateFromSnapshots(snapshots))
}

/**
 * Raise the prompt count, mint a snapshot under a fresh random UUID, hand
 * it to the save callback, and return the new state.
 */
export function incrementPromptCount(
  attribution: AttributionState,
  saveSnapshot: (snapshot: AttributionSnapshotMessage) => void,
): AttributionState {
  const next = { ...attribution, promptCount: attribution.promptCount + 1 }
  saveSnapshot(stateToSnapshotMessage(next, randomUUID()))
  return next
}
