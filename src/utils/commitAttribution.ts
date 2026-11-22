import { createHash } from 'node:crypto'
import { isAbsolute, join, relative, sep } from 'node:path'

import { flagEnv } from '../substrate/flagRegistry.js'
import { getOriginalCwd, getSessionId } from '../bootstrap/state.js'
import type { AttributionSnapshotEntry, FileAttributionState } from '../types/logs.js'
import { getCwd } from './cwd.js'
import { logForDebugging } from './debug.js'
import { execFileNoThrowWithCwd } from './execFileNoThrow.js'
import { getFsImplementation } from './fsOperations.js'
import { findGitRoot, gitExe } from './git.js'
import { isGeneratedFile } from './generatedFiles.js'
import { logError } from './log.js'
import { passedOver } from './passedOver.js'

const GIT_PROBE_TIMEOUT_MS = 5000

const CHARS_PER_LINE_ESTIMATE = 40

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

type FileShare = { mercuryChars: number; humanChars: number; percentage: number; surface: string }

type AttributionData = {
  version: 1
  summary: { mercuryChars: number; humanChars: number; percentage: number; surfaces: string[] }
  files: Record<string, FileShare>
  surfaceBreakdown: Record<string, { mercuryChars: number; percentage: number }>
  excludedGenerated: string[]
  sessions: string[]
}

function getAttributionRepoRoot(): string {
  return findGitRoot(getCwd()) ?? getOriginalCwd()
}

function getClientSurface(): string {
  const value = flagEnv('MERCURY_ENTRYPOINT')
  return value === undefined ? 'cli' : value
}

function computeContentHash(content: string): string {
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
  return relativePath.split(sep).join('/')
}

function normalizeFilePath(filePath: string): string {
  if (!isAbsolute(filePath)) return filePath
  const root = getAttributionRepoRoot()
  const fs = getFsImplementation()
  let resolvedPath = filePath
  try {
    resolvedPath = fs.realpathSync(filePath)
  } catch (error) {
    passedOver(error)
  }
  let resolvedRoot = root
  try {
    resolvedRoot = fs.realpathSync(root)
  } catch (error) {
    passedOver(error)
  }
  return (
    tryRelativeUnderRoot(resolvedRoot, resolvedPath) ??
    tryRelativeUnderRoot(root, filePath) ??
    filePath
  )
}

export function createEmptyAttributionState(): AttributionState {
  return {
    fileStates: new Map(), sessionBaselines: new Map(), surface: getClientSurface(), startingHeadSha: null,
    promptCount: 0, promptCountAtLastCommit: 0, permissionPromptCount: 0, permissionPromptCountAtLastCommit: 0,
    escapeCount: 0, escapeCountAtLastCommit: 0,
  }
}

function contributedChars(s: FileAttributionState | undefined): number {
  return s?.mercuryContribution ?? 0
}

export function trackFileModification(
  state: AttributionState,
  filePath: string,
  oldContent: string,
  newContent: string,
  _userModified: boolean,
  mtime?: number,
): AttributionState {
  try {
    const path = normalizeFilePath(filePath)
    const common = Math.min(oldContent.length, newContent.length)
    let prefix = 0
    while (prefix < common && oldContent[prefix] === newContent[prefix]) prefix++
    let suffix = 0
    while (suffix < common - prefix && oldContent[oldContent.length - 1 - suffix] === newContent[newContent.length - 1 - suffix]) suffix++
    const count = Math.max(oldContent.length, newContent.length) - prefix - suffix
    const fileStates = new Map(toEntries(state.fileStates))
    fileStates.set(path, { contentHash: computeContentHash(newContent), mercuryContribution: contributedChars(fileStates.get(path)) + count, mtime: mtime ?? Date.now() })
    logForDebugging(`attribution: tracked ${count} chars for ${path}`)
    return { ...state, fileStates }
  } catch (error) {
    logError(error)
    return state
  }
}

type MergedStates = {
  surface: string
  surfaces: string[]
  fileStates: Map<string, FileAttributionState>
  sessionBaselines: Map<string, SessionBaseline>
}

function mergeStates(states: AttributionState[]): MergedStates {
  const fileStates = new Map<string, FileAttributionState>()
  const sessionBaselines = new Map<string, SessionBaseline>()
  for (const state of states) {
    for (const [path, baseline] of toEntries(state.sessionBaselines)) if (!sessionBaselines.has(path)) sessionBaselines.set(path, baseline)
    for (const [path, entry] of toEntries(state.fileStates)) {
      fileStates.set(path, { ...entry, mercuryContribution: contributedChars(fileStates.get(path)) + contributedChars(entry) })
    }
  }
  return { surface: states[0]?.surface ?? getClientSurface(), surfaces: [...new Set(states.map(s => s.surface))], fileStates, sessionBaselines }
}

function percentage(chars: number, total: number): number {
  return total === 0 ? 0 : Math.round(chars / total * 100)
}

async function stagedSize(path: string): Promise<number> {
  try {
    const { stdout, code } = await execFileNoThrowWithCwd(gitExe(), ['diff', '--cached', '--stat', '--', path], { cwd: getAttributionRepoRoot(), timeout: GIT_PROBE_TIMEOUT_MS })
    if (code !== 0) return 0
    const last = stdout.trim().split('\n').at(-1) ?? ''
    return (Number(/(\d+) insertion/.exec(last)?.[1] ?? 0) + Number(/(\d+) deletion/.exec(last)?.[1] ?? 0)) * CHARS_PER_LINE_ESTIMATE
  } catch (error) {
    passedOver(error)
    return 0
  }
}

async function fileShare(merged: MergedStates, path: string): Promise<FileShare | null> {
  const cwd = getAttributionRepoRoot()
  const { stdout } = await execFileNoThrowWithCwd(gitExe(), ['diff', '--cached', '--name-status', '--', path], { cwd, timeout: GIT_PROBE_TIMEOUT_MS })
  const state = merged.fileStates.get(path)
  const mercuryChars = Math.max(0, contributedChars(state))
  let humanChars = 0
  if (stdout.trim().startsWith('D\t')) {
    if (!state) humanChars = await stagedSize(path) || UNTRACKED_DELETION_FALLBACK_CHARS
  } else {
    let size: number
    try {
      size = (await getFsImplementation().stat(isAbsolute(path) ? path : join(cwd, path))).size
    } catch (error) {
      passedOver(error)
      return null
    }
    if (!state) humanChars = merged.sessionBaselines.has(path) ? await stagedSize(path) || size : size
  }
  humanChars = Math.max(0, humanChars)
  return { mercuryChars, humanChars, percentage: percentage(mercuryChars, humanChars + mercuryChars), surface: merged.surface }
}

export async function calculateCommitAttribution(
  states: AttributionState[],
  stagedFiles: string[],
): Promise<AttributionData> {
  const merged = mergeStates(states)
  const results = await Promise.all(stagedFiles.map(async path => {
    if (isGeneratedFile(path)) return { kind: 'excluded' as const, path }
    const row = await fileShare(merged, path)
    return { kind: 'file' as const, path, row }
  }))
  const excludedGenerated: string[] = []
  const byPath = new Map<string, FileShare>()
  for (const result of results) {
    if (result.kind === 'excluded') excludedGenerated.push(result.path)
    else if (result.row) byPath.set(result.path, result.row)
  }
  let mercuryChars = 0
  let humanChars = 0
  const surfaces = new Map<string, number>()
  for (const row of byPath.values()) {
    mercuryChars += row.mercuryChars
    humanChars += row.humanChars
    surfaces.set(row.surface, (surfaces.get(row.surface) ?? 0) + row.mercuryChars)
  }
  const total = mercuryChars + humanChars
  return {
    version: 1,
    summary: { mercuryChars, humanChars, percentage: percentage(mercuryChars, total), surfaces: merged.surfaces },
    files: Object.fromEntries(byPath),
    surfaceBreakdown: Object.fromEntries([...surfaces].map(([surface, chars]) => [surface, { mercuryChars: chars, percentage: percentage(chars, total) }])),
    excludedGenerated,
    sessions: [getSessionId()],
  }
}

export function stateToSnapshotMessage(
  state: AttributionState,
  messageId: string,
): AttributionSnapshotEntry {
  return {
    type: 'attribution-snapshot',
    messageId: messageId as AttributionSnapshotEntry['messageId'],
    surface: state.surface as AttributionSnapshotEntry['surface'],
    fileStates: Object.fromEntries(toEntries(state.fileStates)),
    promptCount: state.promptCount, promptCountAtLastCommit: state.promptCountAtLastCommit,
    permissionPromptCount: state.permissionPromptCount, permissionPromptCountAtLastCommit: state.permissionPromptCountAtLastCommit,
    escapeCount: state.escapeCount, escapeCountAtLastCommit: state.escapeCountAtLastCommit,
  }
}

export function restoreAttributionStateFromSnapshots(
  snapshots: AttributionSnapshotEntry[],
): AttributionState {
  const state = createEmptyAttributionState()
  const last = snapshots.at(-1)
  if (!last) return state
  for (const [path, entry] of Object.entries(last.fileStates ?? {})) {
    state.fileStates.set(path, { contentHash: entry.contentHash, mercuryContribution: contributedChars(entry), mtime: entry.mtime })
  }
  return {
    ...state, surface: last.surface,
    promptCount: last.promptCount ?? 0, promptCountAtLastCommit: last.promptCountAtLastCommit ?? 0,
    permissionPromptCount: last.permissionPromptCount ?? 0, permissionPromptCountAtLastCommit: last.permissionPromptCountAtLastCommit ?? 0,
    escapeCount: last.escapeCount ?? 0, escapeCountAtLastCommit: last.escapeCountAtLastCommit ?? 0,
  }
}
