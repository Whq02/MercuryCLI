import { historyHead, sealedExtents } from '../utils/sessionStorage/historyParts.js'
import { join } from 'node:path'

import { CACHE_PATHS } from '../utils/cachePaths.js'
import { logForDebugging } from '../utils/debug.js'
import { getMercuryHome } from '../utils/envUtils.js'
import { isENOENT } from '../utils/errors.js'
import { getFsImplementation } from '../utils/fsOperations.js'
import { cleanupOldImageCaches } from '../utils/imageStore.js'
import { logError } from '../utils/log.js'
import { cleanupOldPastes } from '../utils/pasteStore.js'
import { historyPasteHashes } from '../history.js'
import { draftPasteHashes } from '../utils/promptDraft.js'
import { getProjectsDir } from '../utils/sessionStorage.js'
import { getSettingsWithAllErrors } from './settings/allErrors.js'
import { getInitialSettings, rawSettingsContainsKey } from '../utils/settings/settings.js'
import { TOOL_RESULTS_SUBDIR } from '../utils/toolResultStorage.js'
import { cleanupStaleAgentWorktrees } from './worktree.js'
import { passedOver } from '../utils/passedOver.js'
import { notBuilt, unbuilt, type Unbuilt } from '../pi/holes.js'


const DEFAULT_CLEANUP_PERIOD_DAYS: Unbuilt = unbuilt('src/services/cleanup.ts:22')

export function retentionWindowDays(): number {
  return getInitialSettings().records?.retentionDays ?? DEFAULT_CLEANUP_PERIOD_DAYS
}

type CleanupResult = Unbuilt

function computeCutoffDate(): Date {
  const cutoff = Date.now() - retentionWindowDays() * 86_400_000
  return new Date(Number.isFinite(cutoff) && Math.abs(cutoff) <= 8_640_000_000_000_000 ? cutoff : -8_640_000_000_000_000)
}

export function retentionCutoffMs(): number | null {
  const { errors: settingsErrors } = getSettingsWithAllErrors()
  if (settingsErrors.length > 0 && rawSettingsContainsKey('records.retentionDays')) return null
  return computeCutoffDate().getTime()
}

const SCAN_CHUNK_BYTES = 4 * 1024 * 1024
const SCAN_CARRY_BYTES = 1024
export const blobScanCensus = { chunkReads: 0, wholeReads: 0, maxChunkBytes: 0 }

export async function collectReferencedBlobDirs(transcriptPath: string, cutoff: Date): Promise<Set<string> | null> {
  const fs = getFsImplementation()
  try {
    const stats = await fs.stat(transcriptPath)
    if (stats.mtime < cutoff) return null
    const referenced = new Set<string>()
    const escapedSubdir = TOOL_RESULTS_SUBDIR.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    const pattern = new RegExp(`${escapedSubdir}[/\\\\]+([A-Za-z0-9_.-]+)`, 'g')
    const parts = [...sealedExtents(historyHead(transcriptPath)).map(part => part.path), transcriptPath]
    for (const file of parts) {
      if (fs.readFileChunks === undefined) {
        blobScanCensus.wholeReads++
        const text = (await fs.readFileBytes(file)).toString('latin1')
        for (const match of text.matchAll(pattern)) {
          referenced.add(match[1] as string)
        }
        continue
      }
      let carry = ''
      await fs.readFileChunks(file, SCAN_CHUNK_BYTES, chunk => {
        blobScanCensus.chunkReads++
        blobScanCensus.maxChunkBytes = Math.max(blobScanCensus.maxChunkBytes, chunk.length)
        const text = carry + chunk.toString('latin1')
        for (const match of text.matchAll(pattern)) {
          if ((match.index ?? 0) + match[0].length >= text.length) continue
          referenced.add(match[1] as string)
        }
        carry = text.slice(-SCAN_CARRY_BYTES)
      })
      for (const match of carry.matchAll(pattern)) {
        referenced.add(match[1] as string)
      }
    }
    return referenced
  } catch (error) {
    if (isENOENT(error) && !historyHead(transcriptPath).before) return null
    throw error
  }
}

export async function cleanupOldSessionFiles(): Promise<CleanupResult> {
  return notBuilt('src/services/cleanup.ts:153')
}

export async function recordingsUnderSweep(): Promise<{ count: number; bytes: number }> {
  return notBuilt('src/services/cleanup.ts:283')
}

export const FILE_HISTORY_MAX_BYTES = 500 * 1024 * 1024

type HistoryDirectory = { path: string; bytes: number; modified: number }

async function fileHistoryDirectories(): Promise<HistoryDirectory[]> {
  const fs = getFsImplementation()
  const root = join(getMercuryHome(), 'file-history')
  let entries: Awaited<ReturnType<typeof fs.readdir>>
  try {
    entries = await fs.readdir(root)
  } catch (error) {
    if (isENOENT(error)) return []
    throw error
  }
  const directories: HistoryDirectory[] = []
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const path = join(root, entry.name)
    try {
      let bytes = 0
      let modified = (await fs.stat(path)).mtimeMs
      for (const blob of await fs.readdir(path)) {
        if (!blob.isFile()) continue
        const facts = await fs.stat(join(path, blob.name))
        bytes += facts.size
        modified = Math.max(modified, facts.mtimeMs)
      }
      directories.push({ path, bytes, modified })
    } catch (error) {
      if (!isENOENT(error)) throw error
    }
  }
  return directories.sort((a, b) => a.modified - b.modified || a.path.localeCompare(b.path))
}

export async function fileHistoryStorage(): Promise<{ bytes: number; limit: number; sessions: number }> {
  const directories = await fileHistoryDirectories()
  return { bytes: directories.reduce((sum, dir) => sum + dir.bytes, 0), limit: FILE_HISTORY_MAX_BYTES, sessions: directories.length }
}

export async function cleanupOldFileHistoryBackups(): Promise<CleanupResult> {
  return notBuilt('src/services/cleanup.ts:402')
}

async function recallablePasteHashes(): Promise<Set<string>> {
  const retained = await historyPasteHashes()
  for (const hash of draftPasteHashes()) retained.add(hash)
  return retained
}

export async function cleanupOldMessageFilesInBackground(): Promise<CleanupResult> {
  return notBuilt('src/services/cleanup.ts:464')
}
