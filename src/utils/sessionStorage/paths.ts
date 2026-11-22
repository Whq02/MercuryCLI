import { dirname, join } from 'path'
import { readFile, readdir } from 'fs/promises'
import type { Dirent } from 'fs'
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
import { notBuilt, unbuilt, type Unbuilt } from '../../pi/holes.js'

export const MAX_TRANSCRIPT_READ_BYTES: Unbuilt = unbuilt('src/utils/sessionStorage/paths.ts:19')

export const getProjectDir = (projectDir: string): string => notBuilt('src/utils/sessionStorage/paths.ts:21')

export function getProjectsDir(): string {
  return notBuilt('src/utils/sessionStorage/paths.ts:25')
}

function currentSubagents(): string {
  return notBuilt('src/utils/sessionStorage/paths.ts:38')
}

export function getTranscriptPath(): string {
  return notBuilt('src/utils/sessionStorage/paths.ts:42')
}

export function getTranscriptPathForSession(sessionId: string): string {
  return notBuilt('src/utils/sessionStorage/paths.ts:46')
}

export function sessionIdExists(sessionId: string): boolean {
  return notBuilt('src/utils/sessionStorage/paths.ts:51')
}

export function getAgentTranscriptPath(agentId: AgentId): string {
  return join(currentSubagents(), `agent-${agentId}.jsonl`)
}

export function getAgentMetadataPath(agentId: AgentId): string {
  const transcript = getAgentTranscriptPath(agentId)
  return transcript.replace(/\.jsonl$/, '.meta.json')
}

export type AgentMetadata = Unbuilt
export type AgentMetadataRow = { agentId: AgentId; metadata: AgentMetadata }

export async function writeAgentMetadata(agentId: AgentId, metadata: AgentMetadata): Promise<void> {
  return notBuilt('src/utils/sessionStorage/paths.ts:86')
}

export async function readAgentMetadata(agentId: AgentId): Promise<AgentMetadata | null> {
  return notBuilt('src/utils/sessionStorage/paths.ts:92')
}

function absentDirectory(error: unknown): [] {
  return notBuilt('src/utils/sessionStorage/paths.ts:109')
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
  return notBuilt('src/utils/sessionStorage/paths.ts:129')
}

export async function listAgentTranscriptPaths(transcriptPath: string, sessionId: string): Promise<string[]> {
  return notBuilt('src/utils/sessionStorage/paths.ts:147')
}

export function isTranscriptMessage(entry: Entry): entry is TranscriptMessage {
  return notBuilt('src/utils/sessionStorage/paths.ts:169')
}

export function isChainParticipant(message: Pick<Message, 'type'>): boolean {
  return notBuilt('src/utils/sessionStorage/paths.ts:173')
}

type PersistedProgressEntry = Unbuilt

export function isPersistedProgressEntry(entry: unknown): entry is PersistedProgressEntry {
  return notBuilt('src/utils/sessionStorage/paths.ts:179')
}

export function isEphemeralToolProgress(dataType: unknown): boolean {
  return notBuilt('src/utils/sessionStorage/paths.ts:185')
}

export function getNodeEnv(): string {
  return notBuilt('src/utils/sessionStorage/paths.ts:190')
}

export function getEntrypoint(): string | undefined {
  return notBuilt('src/utils/sessionStorage/paths.ts:194')
}

export function isCustomTitleEnabled(): boolean {
  return notBuilt('src/utils/sessionStorage/paths.ts:198')
}
