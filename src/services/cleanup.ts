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


const DEFAULT_CLEANUP_PERIOD_DAYS = 30

export function retentionWindowDays(): number {
  return getInitialSettings().records?.retentionDays ?? DEFAULT_CLEANUP_PERIOD_DAYS
}

type CleanupResult = {
  messages: number
  errors: number
}

function addResults(a: CleanupResult, b: CleanupResult): CleanupResult {
  return { messages: a.messages + b.messages, errors: a.errors + b.errors }
}

function parseLogDate(filename: string): Date | null {
  const stem = filename.split('.')[0]
  if (!stem) return null
  const iso = stem.replace(/T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z$/, 'T$1:$2:$3.$4Z')
  const date = new Date(iso)
  return Number.isNaN(date.getTime()) ? null : date
}

async function cleanupLogDirectory(
  dir: string,
  cutoff: Date,
): Promise<{ messages: number; readable: boolean }> {
  const fs = getFsImplementation()
  let entries: Awaited<ReturnType<typeof fs.readdir>>
  try {
    entries = await fs.readdir(dir)
  } catch (error) {
    if (!isENOENT(error)) logError(error)
    return { messages: 0, readable: false }
  }
  let messages = 0
  for (const entry of entries) {
    const fileDate = parseLogDate(entry.name)
    if (fileDate !== null && fileDate < cutoff) {
      try {
        await fs.unlink(join(dir, entry.name))
        messages++
      } catch (error) {
        logError(error)
      }
    }
  }
  return { messages, readable: true }
}

async function cleanupOldMessageLogFiles(cutoff: Date): Promise<CleanupResult> {
  const fs = getFsImplementation()
  let messages = 0
  const errorsResult = await cleanupLogDirectory(CACHE_PATHS.errors(), cutoff)
  messages += errorsResult.messages

  const baseLogs = CACHE_PATHS.baseLogs()
  let baseEntries: Awaited<ReturnType<typeof fs.readdir>>
  try {
    baseEntries = await fs.readdir(baseLogs)
  } catch (error) {
    passedOver(error)
    return { messages, errors: 0 }
  }
  for (const entry of baseEntries) {
    if (!entry.name.startsWith('mcp-logs-')) continue
    const mcpDir = join(baseLogs, entry.name)
    const mcpResult = await cleanupLogDirectory(mcpDir, cutoff)
    messages += mcpResult.messages
    if (mcpResult.readable) {
      await fs.rmdir(mcpDir).catch(passedOver)
    }
  }
  return { messages, errors: 0 }
}

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
          referenced.add(match[1])
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
          referenced.add(match[1])
        }
        carry = text.slice(-SCAN_CARRY_BYTES)
      })
      for (const match of carry.matchAll(pattern)) {
        referenced.add(match[1])
      }
    }
    return referenced
  } catch (error) {
    if (isENOENT(error) && !historyHead(transcriptPath).before) return null
    throw error
  }
}

export async function cleanupOldSessionFiles(): Promise<CleanupResult> {
  const fs = getFsImplementation()
  const cutoff = computeCutoffDate()
  const projectsDir = getProjectsDir()
  let messages = 0
  let errors = 0
  let projectEntries: Awaited<ReturnType<typeof fs.readdir>>
  try {
    projectEntries = await fs.readdir(projectsDir)
  } catch (error) {
    passedOver(error)
    return { messages: 0, errors: 0 }
  }

  for (const projectEntry of projectEntries) {
    if (!projectEntry.isDirectory()) continue
    const projectPath = join(projectsDir, projectEntry.name)
    let entries: Awaited<ReturnType<typeof fs.readdir>>
    try {
      entries = await fs.readdir(projectPath)
    } catch (error) {
      logError(error)
      errors++
      continue
    }

    for (const entry of entries) {
      if (entry.isDirectory()) {
        const sessionDir = join(projectPath, entry.name)
        const resultsDir = join(sessionDir, TOOL_RESULTS_SUBDIR)
        let resultEntries: Awaited<ReturnType<typeof fs.readdir>>
        try {
          resultEntries = await fs.readdir(resultsDir)
        } catch (error) {
          passedOver(error)
          await fs.rmdir(sessionDir).catch(passedOver)
          continue
        }

        const transcriptPath = join(projectPath, `${entry.name}.jsonl`)
        let referenced: Set<string> | null
        try {
          referenced = await collectReferencedBlobDirs(transcriptPath, cutoff)
        } catch (error) {
          logError(error)
          errors++
          continue
        }

        for (const resEntry of resultEntries) {
          if (referenced?.has(resEntry.name)) continue
          const resPath = join(resultsDir, resEntry.name)
          if (resEntry.isDirectory()) {
            let blobFiles: Awaited<ReturnType<typeof fs.readdir>>
            try {
              blobFiles = await fs.readdir(resPath)
            } catch (error) {
              passedOver(error)
              continue
            }
            for (const blobFile of blobFiles) {
              if (!blobFile.isFile()) continue
              const blobFilePath = join(resPath, blobFile.name)
              try {
                const stats = await fs.stat(blobFilePath)
                if (stats.mtime < cutoff) {
                  await fs.unlink(blobFilePath)
                  messages++
                }
              } catch (error) {
                logError(error)
                errors++
              }
            }
            await fs.rmdir(resPath).catch(passedOver)
          } else if (resEntry.isFile()) {
            try {
              const stats = await fs.stat(resPath)
              if (stats.mtime < cutoff) {
                await fs.unlink(resPath)
                messages++
              }
            } catch (error) {
              logError(error)
              errors++
            }
          }
        }
        await fs.rmdir(resultsDir).catch(passedOver)
        await fs.rmdir(sessionDir).catch(passedOver)
      } else if (entry.isFile() && entry.name.endsWith('.cast')) {
        const castPath = join(projectPath, entry.name)
        try {
          const stats = await fs.stat(castPath)
          if (stats.mtime < cutoff) {
            await fs.unlink(castPath)
            messages++
          }
        } catch (error) {
          logError(error)
          errors++
        }
      }
    }
    await fs.rmdir(projectPath).catch(passedOver)
  }

  return { messages, errors }
}

export async function recordingsUnderSweep(): Promise<{ count: number; bytes: number }> {
  const fs = getFsImplementation()
  const projectsDir = getProjectsDir()
  let projectEntries: Awaited<ReturnType<typeof fs.readdir>>
  try {
    projectEntries = await fs.readdir(projectsDir)
  } catch (error) {
    if (isENOENT(error)) return { count: 0, bytes: 0 }
    throw error
  }
  let count = 0
  let bytes = 0
  for (const projectEntry of projectEntries) {
    if (!projectEntry.isDirectory()) continue
    const projectPath = join(projectsDir, projectEntry.name)
    let entries: Awaited<ReturnType<typeof fs.readdir>>
    try {
      entries = await fs.readdir(projectPath)
    } catch (error) {
      if (isENOENT(error)) continue
      throw error
    }
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith('.cast')) continue
      try {
        const stats = await fs.stat(join(projectPath, entry.name))
        count++
        bytes += stats.size
      } catch (error) {
        if (isENOENT(error)) continue
        throw error
      }
    }
  }
  return { count, bytes }
}

async function cleanupAgedDirectories(
  root: string,
  cutoff: Date,
  parallel: boolean,
): Promise<CleanupResult> {
  const fs = getFsImplementation()
  let entries: Awaited<ReturnType<typeof fs.readdir>>
  try {
    entries = await fs.readdir(root)
  } catch (error) {
    if (!isENOENT(error)) logError(error)
    return { messages: 0, errors: 0 }
  }
  const subdirs = entries.filter(entry => entry.isDirectory())
  let messages = 0
  let errors = 0
  const sweepOne = async (name: string): Promise<void> => {
    const dirPath = join(root, name)
    try {
      const stats = await fs.stat(dirPath)
      if (stats.mtime < cutoff) {
        await fs.rm(dirPath, { recursive: true, force: true })
        messages++
      }
    } catch (error) {
      logError(error)
      errors++
    }
  }
  if (parallel) {
    await Promise.all(subdirs.map(entry => sweepOne(entry.name)))
  } else {
    for (const entry of subdirs) {
      await sweepOne(entry.name)
    }
  }
  await fs.rmdir(root).catch(passedOver)
  return { messages, errors }
}

async function cleanupOldDebugFiles(cutoff: Date): Promise<CleanupResult> {
  const fs = getFsImplementation()
  const debugDir = join(getMercuryHome(), 'debug')
  let entries: Awaited<ReturnType<typeof fs.readdir>>
  try {
    entries = await fs.readdir(debugDir)
  } catch (error) {
    if (!isENOENT(error)) logError(error)
    return { messages: 0, errors: 0 }
  }
  let messages = 0
  let errors = 0
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.txt') || entry.name === 'latest') continue
    const filePath = join(debugDir, entry.name)
    try {
      const stats = await fs.stat(filePath)
      if (stats.mtime < cutoff) {
        await fs.unlink(filePath)
        messages++
      }
    } catch (error) {
      logError(error)
      errors++
    }
  }
  return { messages, errors }
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
  const fs = getFsImplementation()
  const cutoff = computeCutoffDate()
  const root = join(getMercuryHome(), 'file-history')
  const result = await cleanupAgedDirectories(root, cutoff, true)
  try {
    const directories = await fileHistoryDirectories()
    let totalBytes = directories.reduce((sum, dir) => sum + dir.bytes, 0)
    for (const dir of directories) {
      if (totalBytes <= FILE_HISTORY_MAX_BYTES) break
      try {
        await fs.rm(dir.path, { recursive: true, force: true })
        totalBytes -= dir.bytes
        result.messages++
      } catch (error) {
        logError(error)
        result.errors++
      }
    }
  } catch (error) {
    logError(error)
    result.errors++
  }
  return result
}

async function recallablePasteHashes(): Promise<Set<string>> {
  const retained = await historyPasteHashes()
  for (const hash of draftPasteHashes()) retained.add(hash)
  return retained
}

export async function cleanupOldMessageFilesInBackground(): Promise<CleanupResult> {
  const cutoffMs = retentionCutoffMs()
  if (cutoffMs === null) {
    logForDebugging(
      'cleanup: skipped — settings have validation errors and records.retentionDays is (or may be) configured',
    )
    return { messages: 0, errors: 1 }
  }
  const cutoff = new Date(cutoffMs)
  let total: CleanupResult = { messages: 0, errors: 0 }
  total = addResults(total, await cleanupOldMessageLogFiles(cutoff))
  total = addResults(total, await cleanupOldSessionFiles())
  total = addResults(total, await cleanupOldFileHistoryBackups())
  total = addResults(
    total,
    await cleanupAgedDirectories(join(getMercuryHome(), 'session-env'), cutoff, false),
  )
  total = addResults(total, await cleanupOldDebugFiles(cutoff))

  try {
    await cleanupOldImageCaches(cutoff)
  } catch (error) {
    logError(error)
    total.errors++
  }

  try {
    const retained = await recallablePasteHashes()
    await cleanupOldPastes(cutoff, retained)
  } catch (error) {
    logError(error)
    total.errors++
  }

  try {
    const removed = await cleanupStaleAgentWorktrees(cutoff)
    total.messages += removed
  } catch (error) {
    logError(error)
    total.errors++
  }

  return total
}
