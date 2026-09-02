// Project-committed agent-memory snapshots: detect, initialize,
// replace, mark-synced.
//
// Layout (contract data):
//   <project config home>/agent-memory-snapshots/<agentType>/  + snapshot.json { updatedAt }
//   <agent memory dir>/.snapshot-synced.json                    { syncedFrom }
//
// Note the deliberate asymmetry: the snapshot directory uses the agent type
// VERBATIM while the paired memory directory sanitises colons to dashes
// Existing committed snapshot directories are named that way —
// preserved unless the operator rules otherwise.

import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { getCwd } from '../../utils/cwd.js'
import { logForDebugging } from '../../utils/debug.js'
import { adoptiveProjectPath } from '../../utils/projectStoreAdoption.js'
import { getAgentMemoryDir, type AgentMemoryScope } from './agentMemory.js'

const SNAPSHOTS_SUBDIR = 'agent-memory-snapshots'
const SNAPSHOT_METADATA_FILE = 'snapshot.json'
const SYNCED_MARKER_FILE = '.snapshot-synced.json'

/** The snapshot directory for an agent type (type used verbatim). */
export function getSnapshotDirForAgent(agentType: string): string {
  return adoptiveProjectPath(getCwd(), SNAPSHOTS_SUBDIR, agentType)
}

type SnapshotMetadata = { updatedAt: string }
type SyncedMarker = { syncedFrom: string }

/** Malformed or unreadable JSON reads as absent. */
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

/**
 * Decide what a snapshot means for this agent's local memory:
 * no snapshot ⇒ none; snapshot but no local markdown ⇒ initialize; local
 * memory present ⇒ prompt-update when the marker is missing or the snapshot
 * is strictly newer, else none.
 */
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

/**
 * Copy every regular snapshot file except the snapshot metadata into the
 * memory directory (UTF-8 read/write). Copy failures are logged, not thrown.
 */
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

/** Record the sync marker; creates the directory first, swallows failures. */
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

/** Copy then record sync. */
export async function initializeFromSnapshot(
  agentType: string,
  scope: AgentMemoryScope,
  snapshotTimestamp: string,
): Promise<void> {
  await copySnapshotIntoMemory(agentType, scope)
  await recordSync(agentType, scope, snapshotTimestamp)
}

/**
 * Delete existing markdown files first (no orphans survive), then copy and
 * record sync.
 */
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
    // No local memory directory yet — nothing to clear.
  }
  await copySnapshotIntoMemory(agentType, scope)
  await recordSync(agentType, scope, snapshotTimestamp)
}

/** Record sync without touching memory content. */
export async function markSnapshotSynced(
  agentType: string,
  scope: AgentMemoryScope,
  snapshotTimestamp: string,
): Promise<void> {
  await recordSync(agentType, scope, snapshotTimestamp)
}
