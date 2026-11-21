import { basename, dirname, join, resolve } from 'path'
import { readFile, readdir } from 'fs/promises'
import { existsSync, watch, type Dirent, type FSWatcher } from 'fs'
import type { UUID } from 'crypto'
import { flagEnv } from '../../substrate/flagRegistry.js'
import { getOriginalCwd, getSessionId, getSessionProjectDir } from '../../bootstrap/state.js'
import { durableAtomicPublish } from '../../substrate/durablePublish.js'
import { EPHEMERAL_STORAGE_PROGRESS, storageRowPolicy } from '../../rows/storage.js'
import type { AgentId } from '../../types/ids.js'
import type { Entry, TranscriptMessage } from '../../types/logs.js'
import type { Message } from '../../types/message.js'
import { getProjectDir as resolveProjectDir } from '../sessionStoragePortable.js'
import { getFsImplementation } from '../fsOperations.js'
import { getMercuryHome } from '../envUtils.js'
import { isFsInaccessible } from '../errors.js'
import { logForDebugging } from '../debug.js'
import { passedOver, passedOverAs } from '../passedOver.js'
import { subscribeUiClock } from '../cockpit/uiClock.js'
import { resolveWatchRoot } from '../watchRoot.js'

export const MAX_TRANSCRIPT_READ_BYTES = 50 * 1024 * 1024

export const getProjectDir = (projectDir: string): string => {
  return resolveProjectDir(projectDir)
}

export function getProjectsDir(): string {
  return join(getMercuryHome(), 'projects')
}

function activeProjectStore(): string {
  return getSessionProjectDir() ?? getProjectDir(getOriginalCwd())
}

function originalTranscript(id: string): string {
  const store = getProjectDir(getOriginalCwd())
  return join(store, `${id}.jsonl`)
}

function currentSubagents(): string {
  return join(activeProjectStore(), getSessionId(), 'subagents')
}

export function getTranscriptPath(): string {
  return join(activeProjectStore(), `${getSessionId()}.jsonl`)
}

export function getTranscriptPathForSession(sessionId: string): string {
  if (getSessionId() !== sessionId) return originalTranscript(sessionId)
  return getTranscriptPath()
}

export function sessionIdExists(sessionId: string): boolean {
  const file = originalTranscript(sessionId)
  try {
    getFsImplementation().statSync(file)
  } catch (error) {
    passedOver(error)
    return false
  }
  return true
}

export function getAgentTranscriptPath(agentId: AgentId): string {
  return join(currentSubagents(), `agent-${agentId}.jsonl`)
}

export function getAgentMetadataPath(agentId: AgentId): string {
  const transcript = getAgentTranscriptPath(agentId)
  return transcript.replace(/\.jsonl$/, '.meta.json')
}

export type AgentMetadata = {
  agentType: string
  swarm?: boolean
  model?: string
  effortOverride?: string
  thinkingConfig?: import('../thinking.js').ThinkingConfig
  structuredOutputSpec?: { schema: Record<string, unknown>; mode: 'permissive' | 'strict'; source: 'dispatch' | 'agent-definition' }
  launchedAt?: number
  compactOnResume?: boolean
} & Partial<Record<
  'worktreePath' | 'cwd' | 'description' | 'effort' |
  'instructionProfile' | 'instructionDigest' | 'name' | 'swarmBrief', string
>>
export type AgentMetadataRow = { agentId: AgentId; metadata: AgentMetadata }

const STORAGE_WATCH_FALLBACK_MS = 2500

type StorageFileWatch = {
  listeners: Set<() => void>
  stop: () => void
}

const storageFileWatchers = new Map<string, StorageFileWatch>()

function nearestExistingDir(dir: string): string {
  let current = dir
  while (current !== dirname(current) && !existsSync(current)) current = dirname(current)
  return current
}

function fanOutStorageFile(key: string): void {
  const entry = storageFileWatchers.get(key)
  if (!entry) return
  for (const listener of [...entry.listeners]) {
    try {
      listener()
    } catch (error) {
      passedOver(error)
    }
  }
}

export function notifyStorageFile(filePath: string): void {
  fanOutStorageFile(resolve(filePath))
}

export function subscribeStorageFile(filePath: string, listener: () => void): () => void {
  const key = resolve(filePath)
  let entry = storageFileWatchers.get(key)
  if (!entry) {
    const targetDir = dirname(key)
    const base = basename(key)
    const listeners = new Set<() => void>()
    let watcher: FSWatcher | null = null
    let watchedDir: string | null = null
    let stopFallback: (() => void) | null = null
    let disposed = false

    const closeWatcher = (): void => {
      if (watcher === null) return
      const active = watcher
      watcher = null
      watchedDir = null
      try {
        active.close()
      } catch (error) {
        passedOver(error)
      }
    }

    const armFallback = (): void => {
      if (disposed || stopFallback !== null) return
      stopFallback = subscribeUiClock(STORAGE_WATCH_FALLBACK_MS, () => fanOutStorageFile(key))
    }

    const armWatcher = (): void => {
      if (disposed) return
      const nextDir = nearestExistingDir(targetDir)
      if (watcher !== null && watchedDir === nextDir) return
      closeWatcher()
      const onTarget = nextDir === targetDir
      try {
        const next = watch(resolveWatchRoot(nextDir), { persistent: false }, (_event, filename) => {
          if (disposed) return
          if (!onTarget) {
            const refreshed = nearestExistingDir(targetDir)
            if (refreshed !== nextDir) {
              armWatcher()
              fanOutStorageFile(key)
            }
            return
          }
          const name = filename === null ? null : String(filename)
          if (name === null || name === base || name.startsWith(`${base}.`)) {
            fanOutStorageFile(key)
          }
        })
        next.on('error', () => {
          if (watcher === next) closeWatcher()
          armFallback()
        })
        watcher = next
        watchedDir = nextDir
        if (!onTarget && nearestExistingDir(targetDir) !== nextDir) armWatcher()
      } catch (error) {
        passedOver(error)
        armFallback()
      }
    }

    entry = {
      listeners,
      stop: () => {
        disposed = true
        closeWatcher()
        if (stopFallback !== null) {
          stopFallback()
          stopFallback = null
        }
      },
    }
    storageFileWatchers.set(key, entry)
    armWatcher()
  }
  entry.listeners.add(listener)
  return () => {
    const current = storageFileWatchers.get(key)
    if (!current) return
    current.listeners.delete(listener)
    if (current.listeners.size === 0) {
      current.stop()
      storageFileWatchers.delete(key)
    }
  }
}

export function subscribeAgentMetadataPath(path: string, listener: () => void): () => void {
  return subscribeStorageFile(path, listener)
}

export async function writeAgentMetadata(agentId: AgentId, metadata: AgentMetadata): Promise<void> {
  const destination = getAgentMetadataPath(agentId)
  const bytes = JSON.stringify(metadata)
  await durableAtomicPublish(destination, bytes)
  notifyStorageFile(destination)
}

export async function readAgentMetadata(agentId: AgentId): Promise<AgentMetadata | null> {
  const source = getAgentMetadataPath(agentId)
  let bytes: string
  try {
    bytes = await readFile(source, 'utf-8')
  } catch (failure) {
    if (!isFsInaccessible(failure)) throw failure
    return null
  }
  try {
    return JSON.parse(bytes) as AgentMetadata
  } catch {
    logForDebugging(`The launch sidecar at ${source} does not decode; the resume re-resolves the agent instead`, { level: 'warn' })
    return null
  }
}

function absentDirectory(error: unknown): [] {
  if (!isFsInaccessible(error)) throw error
  return []
}

function* sidecarIds(names: string[]): Generator<AgentId> {
  for (const name of names) {
    const match = /^agent-(.+)\.meta\.json$/.exec(name)
    if (match) yield match[1] as AgentId
  }
}

async function currentSidecarNames(): Promise<string[]> {
  try {
    return await readdir(currentSubagents())
  } catch (failure) {
    return absentDirectory(failure)
  }
}

export async function listAgentMetadata(): Promise<AgentMetadataRow[]> {
  const names = await currentSidecarNames()
  const rows: AgentMetadataRow[] = []
  for (const agentId of sidecarIds(names)) {
    const metadata = await readAgentMetadata(agentId).catch(passedOverAs(null))
    if (metadata === null) continue
    rows.push({ agentId, metadata })
  }
  return rows
}

type DirectoryFrame = { directory: string; depth: number; entries: Iterator<Dirent> }

async function openDirectory(directory: string, depth: number): Promise<DirectoryFrame> {
  const entries = await readdir(directory, { withFileTypes: true }).catch(absentDirectory)
  return { directory, depth, entries: entries[Symbol.iterator]() }
}

export async function listAgentTranscriptPaths(transcriptPath: string, sessionId: string): Promise<string[]> {
  const root = join(dirname(transcriptPath), sessionId, 'subagents')
  const stack = [await openDirectory(root, 0)]
  const files: string[] = []
  while (stack.length) {
    const frame = stack[stack.length - 1]!
    const next = frame.entries.next()
    if (next.done) {
      stack.pop()
      continue
    }
    const entry = next.value
    const file = join(frame.directory, entry.name)
    if (!entry.isDirectory()) {
      if (/^agent-.+\.jsonl$/.test(entry.name)) files.push(file)
    } else if (frame.depth < 4) {
      stack.push(await openDirectory(file, frame.depth + 1))
    }
  }
  return files.sort()
}

export function isTranscriptMessage(entry: Entry): entry is TranscriptMessage {
  return storageRowPolicy(entry.type)?.fold === 'message'
}

export function isChainParticipant(message: Pick<Message, 'type'>): boolean {
  return message.type !== 'progress'
}

type PersistedProgressEntry = { type: 'progress'; uuid: UUID; parentUuid: UUID | null }

export function isPersistedProgressEntry(entry: unknown): entry is PersistedProgressEntry {
  if (typeof entry !== 'object' || entry === null) return false
  if (!('type' in entry) || entry.type !== 'progress') return false
  return 'uuid' in entry && typeof entry.uuid === 'string'
}

export function isEphemeralToolProgress(dataType: unknown): boolean {
  if (typeof dataType !== 'string') return false
  return EPHEMERAL_STORAGE_PROGRESS.has(dataType)
}

export function getNodeEnv(): string {
  return process.env.NODE_ENV || 'development'
}

export function getEntrypoint(): string | undefined {
  return flagEnv('MERCURY_ENTRYPOINT')
}

export function isCustomTitleEnabled(): boolean {
  return true
}
