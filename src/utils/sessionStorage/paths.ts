import { dirname, join } from 'path'
import { readFile, readdir } from 'fs/promises'
import type { Dirent } from 'fs'
import type { UUID } from 'crypto'
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
  } catch {
    return false
  }
  return true
}

const agentFolders = new Map<string, string>()

export function setAgentTranscriptSubdir(agentId: string, subdir: string): void {
  agentFolders.set(agentId, subdir)
}

export function clearAgentTranscriptSubdir(agentId: string): void {
  agentFolders.delete(agentId)
}

export function getAgentTranscriptPath(agentId: AgentId): string {
  const grouping = agentFolders.get(agentId)
  let directory = currentSubagents()
  if (grouping) directory = join(directory, grouping)
  return join(directory, `agent-${agentId}.jsonl`)
}

export function getAgentMetadataPath(agentId: AgentId): string {
  const transcript = getAgentTranscriptPath(agentId)
  return transcript.replace(/\.jsonl$/, '.meta.json')
}

export function getWorkflowTranscriptDir(runId: string): string {
  return join(currentSubagents(), 'workflows', runId)
}

export type AgentMetadata = {
  agentType: string
  model?: string
  effortOverride?: string
  thinkingConfig?: import('../thinking.js').ThinkingConfig
  launchedAt?: number
} & Partial<Record<
  'worktreePath' | 'cwd' | 'description' | 'effort' |
  'instructionProfile' | 'instructionDigest' | 'name', string
>>
export type AgentMetadataRow = { agentId: AgentId; metadata: AgentMetadata }

export async function writeAgentMetadata(agentId: AgentId, metadata: AgentMetadata): Promise<void> {
  const destination = getAgentMetadataPath(agentId)
  const bytes = JSON.stringify(metadata)
  await durableAtomicPublish(destination, bytes)
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
    const metadata = await readAgentMetadata(agentId).catch(() => null)
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
  return process.env.MERCURY_ENTRYPOINT
}

export function isCustomTitleEnabled(): boolean {
  return true
}
