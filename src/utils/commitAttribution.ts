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
import { notBuilt, type Unbuilt } from '../pi/holes.js'


const GIT_PROBE_TIMEOUT_MS = 5000

const CHARS_PER_LINE_ESTIMATE = 40

const UNTRACKED_DELETION_FALLBACK_CHARS = 100

type SessionBaseline = {
  contentHash: string
  mtime: number
}

export type AttributionState = Unbuilt

type AttributionData = Unbuilt

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
  return notBuilt('src/utils/commitAttribution.ts:117')
}

function contributedChars(s: FileAttributionState | undefined): number {
  return notBuilt('src/utils/commitAttribution.ts:154')
}

export function trackFileModification(
  state: AttributionState,
  filePath: string,
  oldContent: string,
  newContent: string,
  _userModified: boolean,
  mtime?: number,
): AttributionState {
  return notBuilt('src/utils/commitAttribution.ts:158')
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

export async function calculateCommitAttribution(
  states: AttributionState[],
  stagedFiles: string[],
): Promise<AttributionData> {
  return notBuilt('src/utils/commitAttribution.ts:211')
}

export function stateToSnapshotMessage(
  state: AttributionState,
  messageId: string,
): AttributionSnapshotEntry {
  return notBuilt('src/utils/commitAttribution.ts:342')
}

export function restoreAttributionStateFromSnapshots(
  snapshots: AttributionSnapshotEntry[],
): AttributionState {
  return notBuilt('src/utils/commitAttribution.ts:360')
}
