import { join } from 'node:path'

import { CACHE_PATHS } from './cachePaths.js'
import { logForDebugging } from './debug.js'
import { getMercuryHome } from './envUtils.js'
import { isENOENT } from './errors.js'
import { getFsImplementation } from './fsOperations.js'
import { cleanupOldImageCaches } from './imageStore.js'
import { logError } from './log.js'
import { cleanupOldPastes } from './pasteStore.js'
import { getProjectsDir } from './sessionStorage.js'
import { getSettingsWithAllErrors } from './settings/allErrors.js'
import { getInitialSettings, rawSettingsContainsKey } from './settings/settings.js'
import { TOOL_RESULTS_SUBDIR } from './toolResultStorage.js'
import { cleanupStaleAgentWorktrees } from './worktree.js'


const DEFAULT_CLEANUP_PERIOD_DAYS = 30

export function retentionWindowDays(): number {
  return getInitialSettings().cleanupPeriodDays ?? DEFAULT_CLEANUP_PERIOD_DAYS
}

export type CleanupResult = {
  messages: number
  errors: number
}

export function addCleanupResults(a: CleanupResult, b: CleanupResult): CleanupResult {
  return { messages: a.messages + b.messages, errors: a.errors + b.errors }
}

export function convertFileNameToDate(filename: string): Date {
  const segment = filename.split('.')[0] ?? ''
  const iso = segment.replace(/T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z/, 'T$1:$2:$3.$4Z')
  return new Date(iso)
}

function computeCutoffDate(): Date {
  return new Date(Date.now() - retentionWindowDays() * 24 * 60 * 60 * 1000)
}

export async function cleanupOldMessageFiles(): Promise<CleanupResult> {
  const result: CleanupResult = { messages: 0, errors: 0 }
  const fs = getFsImplementation()
  const cutoff = computeCutoffDate()

  const errorsDir = CACHE_PATHS.errors()
  try {
    const entries = await fs.readdir(errorsDir)
    for (const entry of entries) {
      if (!(convertFileNameToDate(entry.name) < cutoff)) continue
      try {
        await fs.unlink(join(errorsDir, entry.name))
        result.errors++
      } catch (err) {
        logError(err)
      }
    }
  } catch (err) {
    if (!isENOENT(err)) logError(err)
  }

  const cacheBase = CACHE_PATHS.baseLogs()
  let baseEntries: Awaited<ReturnType<typeof fs.readdir>>
  try {
    baseEntries = await fs.readdir(cacheBase)
  } catch {
    return result
  }
  for (const baseEntry of baseEntries) {
    if (!baseEntry.name.startsWith('mcp-logs-')) continue
    const mcpLogDir = join(cacheBase, baseEntry.name)
    try {
      const entries = await fs.readdir(mcpLogDir)
      for (const entry of entries) {
        if (!(convertFileNameToDate(entry.name) < cutoff)) continue
        try {
          await fs.unlink(join(mcpLogDir, entry.name))
          result.messages++
        } catch (err) {
          logError(err)
        }
      }
    } catch (err) {
      if (!isENOENT(err)) logError(err)
      continue
    }
    try {
      await fs.rmdir(mcpLogDir)
    } catch {
    }
  }
  return result
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
    if (fs.readFileChunks === undefined) {
      blobScanCensus.wholeReads++
      const text = (await fs.readFileBytes(transcriptPath)).toString('latin1')
      for (const match of text.matchAll(pattern)) {
        referenced.add(match[1] as string)
      }
      return referenced
    }
    let carry = ''
    await fs.readFileChunks(transcriptPath, SCAN_CHUNK_BYTES, chunk => {
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
    return referenced
  } catch {
    return null
  }
}

export async function cleanupOldSessionFiles(): Promise<CleanupResult> {
  const result: CleanupResult = { messages: 0, errors: 0 }
  const fs = getFsImplementation()
  const cutoff = computeCutoffDate()
  const projectsRoot = getProjectsDir()

  let projectEntries: Awaited<ReturnType<typeof fs.readdir>>
  try {
    projectEntries = await fs.readdir(projectsRoot)
  } catch {
    return result
  }

  for (const projectEntry of projectEntries) {
    if (!projectEntry.isDirectory()) continue
    const projectDir = join(projectsRoot, projectEntry.name)
    let entries: Awaited<ReturnType<typeof fs.readdir>>
    try {
      entries = await fs.readdir(projectDir)
    } catch {
      result.errors++
      continue
    }

    for (const entry of entries) {
      const entryPath = join(projectDir, entry.name)
      if (entry.isDirectory()) {
        const sessionDir = entryPath
        const toolResultsDir = join(sessionDir, TOOL_RESULTS_SUBDIR)
        let toolResultEntries: Awaited<ReturnType<typeof fs.readdir>> | null = null
        try {
          toolResultEntries = await fs.readdir(toolResultsDir)
        } catch {
          toolResultEntries = null
        }
        if (toolResultEntries === null) {
          try {
            await fs.rmdir(sessionDir)
          } catch {
          }
          continue
        }

        const transcriptPath = join(projectDir, `${entry.name}.jsonl`)
        const referenced = await collectReferencedBlobDirs(transcriptPath, cutoff)

        for (const toolResultEntry of toolResultEntries) {
          const toolResultPath = join(toolResultsDir, toolResultEntry.name)
          if (toolResultEntry.isDirectory()) {
            if (referenced?.has(toolResultEntry.name)) continue
            let blobEntries: Awaited<ReturnType<typeof fs.readdir>>
            try {
              blobEntries = await fs.readdir(toolResultPath)
            } catch {
              continue
            }
            for (const blobEntry of blobEntries) {
              if (!blobEntry.isFile()) continue
              const blobFilePath = join(toolResultPath, blobEntry.name)
              try {
                const stats = await fs.stat(blobFilePath)
                if (stats.mtime < cutoff) {
                  await fs.unlink(blobFilePath)
                  result.messages++
                }
              } catch {
                result.errors++
              }
            }
            try {
              await fs.rmdir(toolResultPath)
            } catch {
            }
          } else if (toolResultEntry.isFile()) {
            if (referenced?.has(toolResultEntry.name)) continue
            try {
              const stats = await fs.stat(toolResultPath)
              if (stats.mtime < cutoff) {
                await fs.unlink(toolResultPath)
                result.messages++
              }
            } catch {
              result.errors++
            }
          }
        }

        try {
          await fs.rmdir(toolResultsDir)
        } catch {
        }
        try {
          await fs.rmdir(sessionDir)
        } catch {
        }
      } else if (entry.isFile()) {
        if (!entry.name.endsWith('.cast')) continue
        try {
          const stats = await fs.stat(entryPath)
          if (stats.mtime < cutoff) {
            await fs.unlink(entryPath)
            result.messages++
          }
        } catch {
          result.errors++
        }
      }
    }

    try {
      await fs.rmdir(projectDir)
    } catch {
    }
  }
  return result
}

export async function recordingsUnderSweep(): Promise<{ count: number; bytes: number }> {
  const fs = getFsImplementation()
  const projectsRoot = getProjectsDir()
  let count = 0
  let bytes = 0
  let projectEntries: Awaited<ReturnType<typeof fs.readdir>>
  try {
    projectEntries = await fs.readdir(projectsRoot)
  } catch {
    return { count, bytes }
  }
  for (const projectEntry of projectEntries) {
    if (!projectEntry.isDirectory()) continue
    const projectDir = join(projectsRoot, projectEntry.name)
    let entries: Awaited<ReturnType<typeof fs.readdir>>
    try {
      entries = await fs.readdir(projectDir)
    } catch {
      continue
    }
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith('.cast')) continue
      try {
        const stats = await fs.stat(join(projectDir, entry.name))
        count++
        bytes += stats.size
      } catch {
      }
    }
  }
  return { count, bytes }
}

export async function cleanupOldPlanFiles(): Promise<CleanupResult> {
  const result: CleanupResult = { messages: 0, errors: 0 }
  const fs = getFsImplementation()
  const cutoff = computeCutoffDate()
  const plansDir = join(getMercuryHome(), 'plans')
  let entries: Awaited<ReturnType<typeof fs.readdir>>
  try {
    entries = await fs.readdir(plansDir)
  } catch (err) {
    if (!isENOENT(err)) logError(err)
    return result
  }
  for (const entry of entries) {
    if (!entry.isFile()) continue
    if (!entry.name.endsWith('.md')) continue
    const filePath = join(plansDir, entry.name)
    try {
      const stats = await fs.stat(filePath)
      if (stats.mtime < cutoff) {
        await fs.unlink(filePath)
        result.messages++
      }
    } catch {
      result.errors++
    }
  }
  try {
    await fs.rmdir(plansDir)
  } catch {
  }
  return result
}

async function cleanupAgedDirectoryTree(root: string, concurrent: boolean): Promise<CleanupResult> {
  const result: CleanupResult = { messages: 0, errors: 0 }
  const fs = getFsImplementation()
  const cutoff = computeCutoffDate()
  let entries: Awaited<ReturnType<typeof fs.readdir>>
  try {
    entries = await fs.readdir(root)
  } catch (err) {
    if (!isENOENT(err)) logError(err)
    return result
  }
  const removeOne = async (name: string): Promise<void> => {
    const dirPath = join(root, name)
    try {
      const stats = await fs.stat(dirPath)
      if (stats.mtime < cutoff) {
        await fs.rm(dirPath, { recursive: true, force: true })
        result.messages++
      }
    } catch {
      result.errors++
    }
  }
  const directories = entries.filter(entry => entry.isDirectory())
  try {
    if (concurrent) {
      await Promise.all(directories.map(entry => removeOne(entry.name)))
    } else {
      for (const entry of directories) {
        await removeOne(entry.name)
      }
    }
  } catch (err) {
    logError(err)
  }
  try {
    await fs.rmdir(root)
  } catch {
  }
  return result
}

export async function cleanupOldFileHistoryBackups(): Promise<CleanupResult> {
  return cleanupAgedDirectoryTree(join(getMercuryHome(), 'file-history'), true)
}

export async function cleanupOldSessionEnvDirs(): Promise<CleanupResult> {
  return cleanupAgedDirectoryTree(join(getMercuryHome(), 'session-env'), false)
}

export async function cleanupOldDebugLogs(): Promise<CleanupResult> {
  const result: CleanupResult = { messages: 0, errors: 0 }
  const fs = getFsImplementation()
  const cutoff = computeCutoffDate()
  const debugDir = join(getMercuryHome(), 'debug')
  let entries: Awaited<ReturnType<typeof fs.readdir>>
  try {
    entries = await fs.readdir(debugDir)
  } catch (err) {
    if (!isENOENT(err)) logError(err)
    return result
  }
  for (const entry of entries) {
    if (!entry.isFile()) continue
    if (entry.name === 'latest') continue
    if (!entry.name.endsWith('.txt')) continue
    const filePath = join(debugDir, entry.name)
    try {
      const stats = await fs.stat(filePath)
      if (stats.mtime < cutoff) {
        await fs.unlink(filePath)
        result.messages++
      }
    } catch {
      result.errors++
    }
  }
  return result
}

export async function cleanupOldMessageFilesInBackground(): Promise<CleanupResult> {
  const { errors: settingsErrors } = getSettingsWithAllErrors()
  if (settingsErrors.length > 0 && rawSettingsContainsKey('cleanupPeriodDays')) {
    logForDebugging(
      'cleanup: skipped — settings have validation errors and cleanupPeriodDays is (or may be) configured',
    )
    return { messages: 0, errors: 1 }
  }

  let result = await cleanupOldMessageFiles()
  result = addCleanupResults(result, await cleanupOldSessionFiles())
  result = addCleanupResults(result, await cleanupOldPlanFiles())
  result = addCleanupResults(result, await cleanupOldFileHistoryBackups())
  result = addCleanupResults(result, await cleanupOldSessionEnvDirs())
  result = addCleanupResults(result, await cleanupOldDebugLogs())

  try {
    await cleanupOldImageCaches()
  } catch {
    result = addCleanupResults(result, { messages: 0, errors: 1 })
  }
  try {
    await cleanupOldPastes(computeCutoffDate())
  } catch {
    result = addCleanupResults(result, { messages: 0, errors: 1 })
  }
  try {
    const removed = await cleanupStaleAgentWorktrees(computeCutoffDate())
    result = addCleanupResults(result, { messages: removed, errors: 0 })
  } catch {
    result = addCleanupResults(result, { messages: 0, errors: 1 })
  }
  return result
}
