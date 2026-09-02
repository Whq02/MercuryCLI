
import { readFile } from 'fs/promises'
import { join } from 'path'
import type { UUID } from 'crypto'
import {
  getOriginalCwd,
  getSessionId,
  getSessionProjectDir,
} from '../../bootstrap/state.js'
import type { AgentId } from '../../types/ids.js'
import type { Entry, TranscriptMessage } from '../../types/logs.js'
import type { Message } from '../../types/message.js'
import { logForDebugging } from '../debug.js'
import { getMercuryHome } from '../envUtils.js'
import { isFsInaccessible } from '../errors.js'
import { getFsImplementation } from '../fsOperations.js'
import { durableAtomicPublish } from '../../substrate/durablePublish.js'
import { getProjectDir as resolveProjectDirWithAdoption } from '../sessionStoragePortable.js'

export function isTranscriptMessage(entry: Entry): entry is TranscriptMessage {
  switch (entry.type) {
    case 'user':
    case 'assistant':
    case 'attachment':
    case 'system':
      return true
    default:
      return false
  }
}

export function isChainParticipant(m: Pick<Message, 'type'>): boolean {
  return m.type !== 'progress'
}

type PersistedProgressEntry = {
  type: 'progress'
  uuid: UUID
  parentUuid: UUID | null
}

export function isPersistedProgressEntry(
  entry: unknown,
): entry is PersistedProgressEntry {
  return (
    typeof entry === 'object' &&
    entry !== null &&
    'type' in entry &&
    entry.type === 'progress' &&
    'uuid' in entry &&
    typeof entry.uuid === 'string'
  )
}

const EPHEMERAL_PROGRESS_TYPES = new Set([
  'bash_progress',
  'powershell_progress',
  'mcp_progress',
])

export function isEphemeralToolProgress(dataType: unknown): boolean {
  return typeof dataType === 'string' && EPHEMERAL_PROGRESS_TYPES.has(dataType)
}

export function getProjectsDir(): string {
  return join(getMercuryHome(), 'projects')
}

export function getTranscriptPath(): string {
  const projectDir = getSessionProjectDir() ?? getProjectDir(getOriginalCwd())
  return join(projectDir, `${getSessionId()}.jsonl`)
}

export function getTranscriptPathForSession(sessionId: string): string {
  if (sessionId === getSessionId()) {
    return getTranscriptPath()
  }
  const projectDir = getProjectDir(getOriginalCwd())
  return join(projectDir, `${sessionId}.jsonl`)
}

export const MAX_TRANSCRIPT_READ_BYTES = 50 * 1024 * 1024

const agentTranscriptSubdirs = new Map<string, string>()

export function setAgentTranscriptSubdir(agentId: string, subdir: string): void {
  agentTranscriptSubdirs.set(agentId, subdir)
}

export function clearAgentTranscriptSubdir(agentId: string): void {
  agentTranscriptSubdirs.delete(agentId)
}

export function getAgentTranscriptPath(agentId: AgentId): string {
  const projectDir = getSessionProjectDir() ?? getProjectDir(getOriginalCwd())
  const sessionId = getSessionId()
  const subdir = agentTranscriptSubdirs.get(agentId)
  const base = subdir
    ? join(projectDir, sessionId, 'subagents', subdir)
    : join(projectDir, sessionId, 'subagents')
  return join(base, `agent-${agentId}.jsonl`)
}

export function getAgentMetadataPath(agentId: AgentId): string {
  return getAgentTranscriptPath(agentId).replace(/\.jsonl$/, '.meta.json')
}

export function getWorkflowTranscriptDir(runId: string): string {
  const projectDir = getSessionProjectDir() ?? getProjectDir(getOriginalCwd())
  return join(projectDir, getSessionId(), 'subagents', 'workflows', runId)
}

export type AgentMetadata = {
  agentType: string
  worktreePath?: string
  description?: string
  model?: string
  effortOverride?: string
  effort?: string
  instructionProfile?: string
  instructionDigest?: string
}

export async function writeAgentMetadata(
  agentId: AgentId,
  metadata: AgentMetadata,
): Promise<void> {
  const path = getAgentMetadataPath(agentId)
  await durableAtomicPublish(path, JSON.stringify(metadata))
}

export async function readAgentMetadata(
  agentId: AgentId,
): Promise<AgentMetadata | null> {
  const path = getAgentMetadataPath(agentId)
  let raw: string
  try {
    raw = await readFile(path, 'utf-8')
  } catch (e) {
    if (isFsInaccessible(e)) return null
    throw e
  }
  try {
    return JSON.parse(raw) as AgentMetadata
  } catch {
    logForDebugging(
      `agent metadata sidecar unreadable (corrupt JSON) at ${path} — resume falls back to re-resolution`,
      { level: 'warn' },
    )
    return null
  }
}

export function sessionIdExists(sessionId: string): boolean {
  const projectDir = getProjectDir(getOriginalCwd())
  const sessionFile = join(projectDir, `${sessionId}.jsonl`)
  const fs = getFsImplementation()
  try {
    fs.statSync(sessionFile)
    return true
  } catch {
    return false
  }
}

export function getNodeEnv(): string {
  return process.env.NODE_ENV || 'development'
}

export function getUserType(): string {
  return 'external'
}

export function getEntrypoint(): string | undefined {
  return process.env.MERCURY_ENTRYPOINT
}

export function isCustomTitleEnabled(): boolean {
  return true
}

export const getProjectDir = (projectDir: string): string => {
  return resolveProjectDirWithAdoption(projectDir)
}
