import { dirname, join } from 'path'
import { readFile, readdir } from 'fs/promises'
import type { Dirent } from 'fs'
import type { UUID } from 'crypto'
import { flagEnv } from '../../platform/substrate/flagRegistry.js'
import { getOriginalCwd, getSessionId, getSessionProjectDir } from '../../boot/process-state/processState.js'
import { durableAtomicPublish } from '../../platform/substrate/durablePublish.js'
import { EPHEMERAL_STORAGE_PROGRESS, storageRowPolicy } from '../../engine/rows/storage.js'
import type { AgentId } from './ids.js'
import type { Entry, TranscriptMessage } from './transcriptEntries.js'
import type { Message } from '../../engine/message-shapes/message.js'
import { getProjectDir as resolveProjectDir } from './sessionStoragePortable.js'
import { getFsImplementation } from '../../platform/files/fsOperations.js'
import { getMercuryHome } from '../../platform/environment/envUtils.js'
import { isFsInaccessible } from '../../platform/errors/errors.js'
import { isRecord } from '../../platform/primitives/isRecord.js'
import { logForDebugging } from '../../platform/logs/debugLog.js'
import { passedOver, passedOverAs } from '../../platform/errors/passedOver.js'
import type { ThinkingConfig } from '../../models/effort/thinking.js'

export const MAX_TRANSCRIPT_READ_BYTES: number = 50 * 1024 * 1024

export const getProjectDir = (projectDir: string): string => resolveProjectDir(projectDir)

export function getProjectsDir(): string {
  return join(getMercuryHome(), 'projects')
}

function activeProjectDir(): string {
  return getSessionProjectDir() ?? getProjectDir(getOriginalCwd())
}

function currentSubagents(): string {
  return join(activeProjectDir(), getSessionId(), 'subagents')
}

export function getTranscriptPath(): string {
  return join(activeProjectDir(), `${getSessionId()}.jsonl`)
}

export function getTranscriptPathForSession(sessionId: string): string {
  const dir = sessionId === getSessionId() ? activeProjectDir() : getProjectDir(getOriginalCwd())
  return join(dir, `${sessionId}.jsonl`)
}

export function sessionIdExists(sessionId: string): boolean {
  const filePath = join(getProjectDir(getOriginalCwd()), `${sessionId}.jsonl`)
  try {
    getFsImplementation().statSync(filePath)
    return true
  } catch (error) {
    passedOver(error)
    return false
  }
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
  worktreePath?: string
  cwd?: string
  description?: string
  model?: string
  effort?: string
  effortOverride?: string
  thinkingConfig?: ThinkingConfig
  structuredOutputSpec?: {
    schema: Record<string, unknown>
    mode: 'permissive' | 'strict'
    source: 'dispatch' | 'agent-definition'
  }
  instructionProfile?: string
  instructionDigest?: string
  name?: string
  launchedAt?: number
  swarmBrief?: string
  compactOnResume?: boolean
}
export type AgentMetadataRow = { agentId: AgentId; metadata: AgentMetadata }

export async function writeAgentMetadata(agentId: AgentId, metadata: AgentMetadata): Promise<void> {
  await durableAtomicPublish(getAgentMetadataPath(agentId), JSON.stringify(metadata))
}

export async function readAgentMetadata(agentId: AgentId): Promise<AgentMetadata | null> {
  const metaPath = getAgentMetadataPath(agentId)
  let content: string
  try {
    content = await readFile(metaPath, 'utf-8')
  } catch (error) {
    if (isFsInaccessible(error)) return null
    throw error
  }
  try {
    return JSON.parse(content) as AgentMetadata
  } catch (error) {
    passedOver(error)
    logForDebugging(
      `The launch sidecar at ${metaPath} does not decode; the resume re-resolves the agent instead`,
      { level: 'warn' },
    )
    return null
  }
}

function absentDirectory(error: unknown): [] {
  if (isFsInaccessible(error)) return []
  throw error
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
  const rows: AgentMetadataRow[] = []
  for (const agentId of sidecarIds(await currentSidecarNames())) {
    const metadata = await readAgentMetadata(agentId).catch(passedOverAs(null))
    if (metadata !== null) rows.push({ agentId, metadata })
  }
  return rows
}

async function readDirectoryEntries(dir: string): Promise<Dirent[]> {
  try {
    return await readdir(dir, { withFileTypes: true })
  } catch (failure) {
    return absentDirectory(failure)
  }
}

export async function listAgentTranscriptPaths(transcriptPath: string, sessionId: string): Promise<string[]> {
  const root = join(dirname(transcriptPath), sessionId, 'subagents')
  const paths: string[] = []
  const walk = async (dir: string, depth: number): Promise<void> => {
    for (const entry of await readDirectoryEntries(dir)) {
      if (entry.isDirectory()) {
        if (depth < 4) await walk(join(dir, entry.name), depth + 1)
      } else if (/^agent-.+\.jsonl$/.test(entry.name)) {
        paths.push(join(dir, entry.name))
      }
    }
  }
  await walk(root, 0)
  return paths.sort()
}

export function isTranscriptMessage(entry: Entry): entry is TranscriptMessage {
  return storageRowPolicy(entry.type)?.fold === 'message'
}

export function isChainParticipant(message: Pick<Message, 'type'>): boolean {
  return message.type !== 'progress'
}

type PersistedProgressEntry = {
  type: 'progress'
  uuid: UUID
  parentUuid: UUID | null
}

export function isPersistedProgressEntry(entry: unknown): entry is PersistedProgressEntry {
  return isRecord(entry) && entry.type === 'progress' && typeof entry.uuid === 'string'
}

export function isEphemeralToolProgress(dataType: unknown): boolean {
  return typeof dataType === 'string' && EPHEMERAL_STORAGE_PROGRESS.has(dataType)
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
