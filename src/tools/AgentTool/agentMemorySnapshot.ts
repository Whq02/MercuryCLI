
import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { getCwd } from '../../utils/cwd.js'
import { logForDebugging } from '../../utils/debug.js'
import { adoptiveProjectPath } from '../../utils/projectStoreAdoption.js'
import { getAgentMemoryDir, type AgentMemoryScope } from './agentMemory.js'

const SNAPSHOTS_SUBDIR = 'agent-memory-snapshots'
const SNAPSHOT_METADATA_FILE = 'snapshot.json'
const SYNCED_MARKER_FILE = '.snapshot-synced.json'

export function getSnapshotDirForAgent(agentType: string): string {
  return adoptiveProjectPath(getCwd(), SNAPSHOTS_SUBDIR, agentType)
}

type SnapshotMetadata = { updatedAt: string }
type SyncedMarker = { syncedFrom: string }

async function readJsonOrNull<T>(path: string): Promise<T | null> {
  try {
    return JSON.parse(await readFile(path, 'utf-8')) as T
  } catch {
    return null
  }
}

export type AgentMemorySnapshotCheck = {
  action: 'none' | 'initialize' | 'prompt-update'
  snapshotTimestamp?: string
}

export async function checkAgentMemorySnapshot(
  agentType: string,
  scope: AgentMemoryScope,
): Promise<AgentMemorySnapshotCheck> {
  const snapshotDir = getSnapshotDirForAgent(agentType)
  const metadata = await readJsonOrNull<SnapshotMetadata>(
    join(snapshotDir, SNAPSHOT_METADATA_FILE),
  )
  if (!metadata) return { action: 'none' }

  const memoryDir = getAgentMemoryDir(agentType, scope)
  let hasLocalMarkdown = false
  try {
    const entries = await readdir(memoryDir)
    hasLocalMarkdown = entries.some(name => name.endsWith('.md'))
  } catch {
    hasLocalMarkdown = false
  }
  if (!hasLocalMarkdown) {
    return { action: 'initialize', snapshotTimestamp: metadata.updatedAt }
  }

  const synced = await readJsonOrNull<SyncedMarker>(
    join(memoryDir, SYNCED_MARKER_FILE),
  )
  if (!synced || metadata.updatedAt > synced.syncedFrom) {
    return { action: 'prompt-update', snapshotTimestamp: metadata.updatedAt }
  }
  return { action: 'none' }
}

async function copySnapshotIntoMemory(
  agentType: string,
  scope: AgentMemoryScope,
): Promise<void> {
  const snapshotDir = getSnapshotDirForAgent(agentType)
  const memoryDir = getAgentMemoryDir(agentType, scope)
  await mkdir(memoryDir, { recursive: true })
  let entries: string[] = []
  try {
    entries = await readdir(snapshotDir)
  } catch (error) {
    logForDebugging(
      `agent-memory snapshot: cannot read snapshot dir for ${agentType}: ${String(error)}`,
    )
    return
  }
  for (const name of entries) {
    if (name === SNAPSHOT_METADATA_FILE) continue
    try {
      const content = await readFile(join(snapshotDir, name), 'utf-8')
      await writeFile(join(memoryDir, name), content, 'utf-8')
    } catch (error) {
      logForDebugging(
        `agent-memory snapshot: copy of ${name} failed for ${agentType}: ${String(error)}`,
      )
    }
  }
}

async function recordSync(
  agentType: string,
  scope: AgentMemoryScope,
  snapshotTimestamp: string,
): Promise<void> {
  const memoryDir = getAgentMemoryDir(agentType, scope)
  try {
    await mkdir(memoryDir, { recursive: true })
    await writeFile(
      join(memoryDir, SYNCED_MARKER_FILE),
      JSON.stringify({ syncedFrom: snapshotTimestamp } satisfies SyncedMarker),
      'utf-8',
    )
  } catch (error) {
    logForDebugging(
      `agent-memory snapshot: sync marker write failed for ${agentType}: ${String(error)}`,
    )
  }
}

export async function initializeFromSnapshot(
  agentType: string,
  scope: AgentMemoryScope,
  snapshotTimestamp: string,
): Promise<void> {
  await copySnapshotIntoMemory(agentType, scope)
  await recordSync(agentType, scope, snapshotTimestamp)
}

export async function replaceFromSnapshot(
  agentType: string,
  scope: AgentMemoryScope,
  snapshotTimestamp: string,
): Promise<void> {
  const memoryDir = getAgentMemoryDir(agentType, scope)
  try {
    const entries = await readdir(memoryDir)
    for (const name of entries) {
      if (!name.endsWith('.md')) continue
      try {
        await rm(join(memoryDir, name))
      } catch (error) {
        logForDebugging(
          `agent-memory snapshot: stale file removal failed (${name}): ${String(error)}`,
        )
      }
    }
  } catch {
  }
  await copySnapshotIntoMemory(agentType, scope)
  await recordSync(agentType, scope, snapshotTimestamp)
}

export async function markSnapshotSynced(
  agentType: string,
  scope: AgentMemoryScope,
  snapshotTimestamp: string,
): Promise<void> {
  await recordSync(agentType, scope, snapshotTimestamp)
}
