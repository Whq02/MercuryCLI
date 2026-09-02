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

/**
 * Retention sweep over caches, transcripts, tool-result blobs, plans, file
 * history, session env dirs and debug logs.
 *
 * Two different "age" tests are in use and must not be conflated. The log
 * directories (errors, MCP logs) age files by the DATE ENCODED IN THE
 * FILENAME — a name that does not parse yields an invalid date, every
 * comparison against which is false, which is what keeps unrecognised files
 * in those directories safe. Every other family ages entries by their
 * filesystem mtime.
 *
 * The "errors" counter carries two meanings, both load-bearing: everywhere
 * except one place it counts FAILURES; in the errors-directory sweep it
 * counts successfully DELETED error-log files. The caller advances its
 * "last cleanup" sentinel only on a zero-error sweep, so deleting even one
 * aged error log defers the sentinel to the next run. That is the tuned
 * housekeeping cadence — do not "clean up" the counter.
 */

const DEFAULT_CLEANUP_PERIOD_DAYS = 30

/**
 * The retention window in days — the ONE owner of the sweep's age threshold
 * (settings `cleanupPeriodDays`, else the 30-day default). The sweep's
 * cutoff derives from this number and /status reads this same number, so
 * the surface and the sweep can never disagree about the window.
 */
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

/**
 * Recover a Date from a log filename: the segment before the first `.`,
 * with the `T##-##-##-###Z` time portion converted back to the ISO
 * `T##:##:##.###Z` form. Unparseable names yield an invalid date.
 */
export function convertFileNameToDate(filename: string): Date {
  const segment = filename.split('.')[0] ?? ''
  const iso = segment.replace(/T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z/, 'T$1:$2:$3.$4Z')
  return new Date(iso)
}

// Each family computes its own cutoff at call time, so a long sweep is not
// pinned to one instant.
function computeCutoffDate(): Date {
  return new Date(Date.now() - retentionWindowDays() * 24 * 60 * 60 * 1000)
}

/**
 * Sweep the errors directory (deletions counted as ERRORS — see the module
 * note) and every `mcp-logs-*` directory under the project cache base
 * (deletions counted as messages). Both age by filename date. Every entry
 * is tried regardless of kind — a subdirectory's unlink simply fails and is
 * logged. Per-file failures are logged, not counted.
 */
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
    // Any listing failure of the base silently ends the sweep with what was
    // counted so far.
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
      // Not empty (or already gone) — fine.
    }
  }
  return result
}

/**
 * The blob-directory names a LIVE sibling transcript still references.
 * "Live" means the transcript exists and its mtime is not older than the
 * cutoff — a transcript that itself ages out takes its blobs with it. An
 * unreadable or missing transcript yields no set at all, and with no set
 * every blob directory is age-eligible.
 *
 * The reference set comes from a RAW text scan of the transcript for the
 * tool-results subdirectory name followed by path separators (either kind)
 * and a run of name characters. The pointer the transcript stores is a
 * plain path string on every platform, so matching the stored text needs no
 * JSONL parsing and no decoding step in a boot-time path.
 */
// FN-020 row 11: the scan streams the transcript in SCAN_CHUNK_BYTES chunks
// through one handle with a carry of the last SCAN_CARRY_BYTES (longer than
// any reference: the subdirectory name, separators and a filesystem name of
// at most 255 bytes), so a reference straddling a chunk edge is found whole
// in the next chunk; a match touching a chunk's end is deferred to that
// carry (its name may continue). Peak transient memory is one chunk plus
// the carry, not twice the transcript (the whole Buffer plus a whole latin1
// string) — on the sessions that qualify, the recent tool-heavy large ones.
const SCAN_CHUNK_BYTES = 4 * 1024 * 1024
const SCAN_CARRY_BYTES = 1024
/** PROOF CENSUS (operation-shaped): chunk reads, whole-file fallbacks, the
 *  largest chunk handed to the scan — read by
 *  scripts/settings/prove-blob-scan-stream.ts. */
export const blobScanCensus = { chunkReads: 0, wholeReads: 0, maxChunkBytes: 0 }

/** Exported for the streaming-parity tooth; cleanupOldSessionFiles is the
 *  one product caller. */
export async function collectReferencedBlobDirs(transcriptPath: string, cutoff: Date): Promise<Set<string> | null> {
  const fs = getFsImplementation()
  try {
    const stats = await fs.stat(transcriptPath)
    if (stats.mtime < cutoff) return null
    const referenced = new Set<string>()
    const escapedSubdir = TOOL_RESULTS_SUBDIR.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    const pattern = new RegExp(`${escapedSubdir}[/\\\\]+([A-Za-z0-9_.-]+)`, 'g')
    if (fs.readFileChunks === undefined) {
      // A fake without the chunk reader: the whole-file road, unchanged.
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
        // Touching the end: the name may continue in the next chunk — the
        // carry re-scans it whole (the file's own end is scanned below).
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

/**
 * The session sweep: aged transcripts and recordings, tool-result blob
 * directories (with the reachability rule), and empty-directory removal all
 * the way up to the project directory.
 */
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
    // A stray non-directory at the projects root is skipped silently: no
    // readdir attempt, no error counted.
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
        // A directory is a session directory.
        const sessionDir = entryPath
        const toolResultsDir = join(sessionDir, TOOL_RESULTS_SUBDIR)
        let toolResultEntries: Awaited<ReturnType<typeof fs.readdir>> | null = null
        try {
          toolResultEntries = await fs.readdir(toolResultsDir)
        } catch {
          toolResultEntries = null
        }
        if (toolResultEntries === null) {
          // No tool-results child at all: still attempt to remove the
          // (possibly empty) session directory; no error counted.
          try {
            await fs.rmdir(sessionDir)
          } catch {
            // Not empty — leave it.
          }
          continue
        }

        // Build the live-transcript reference set for this session.
        const transcriptPath = join(projectDir, `${entry.name}.jsonl`)
        const referenced = await collectReferencedBlobDirs(transcriptPath, cutoff)

        for (const toolResultEntry of toolResultEntries) {
          const toolResultPath = join(toolResultsDir, toolResultEntry.name)
          if (toolResultEntry.isDirectory()) {
            // A tool-result blob directory. Referenced blobs are NEVER
            // deleted by age.
            if (referenced?.has(toolResultEntry.name)) continue
            let blobEntries: Awaited<ReturnType<typeof fs.readdir>>
            try {
              blobEntries = await fs.readdir(toolResultPath)
            } catch {
              // An unreadable blob directory is skipped WITHOUT counting an
              // error (unlike an unreadable project directory).
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
              // Not empty — leave it.
            }
          } else if (toolResultEntry.isFile()) {
            // A loose file directly under tool-results — the shape EVERY
            // persisted tool-result body takes (<toolUseId>.txt|.json from
            // persistToolResult / mcpOutputStorage / LocalShellTask; only
            // pdf-<uuid> mints a directory). Referenced blobs are NEVER
            // deleted by age here either: the transcript's pointer line
            // ("Full output saved to: …") captures the full file NAME with
            // its extension, so the same set the directory arm consults
            // protects the loose form too (TASK-017 S2,
            // tool-result-blobs-swept-unreferenced — the sweep deleted the
            // bodies of a session used daily while its transcript still
            // claimed they were saved). Entries that are neither file nor
            // directory (symlinks) are skipped.
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
          // Not empty — leave it.
        }
        try {
          await fs.rmdir(sessionDir)
        } catch {
          // Not empty — leave it.
        }
      } else if (entry.isFile()) {
        // Files: only aged RECORDINGS are deleted. A session transcript
        // (.jsonl) is never auto-deleted — it is the operator's history, and
        // the board hides it instead (parkedCleared); only the operator's own
        // act removes one. Entries that are neither file nor directory
        // (symlinks) are skipped.
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
      // Not empty — leave it.
    }
  }
  return result
}

/**
 * READ-ONLY census of the recordings (.cast) the session sweep above ages —
 * counted here, in the aging rule's own file, so /status's number derives
 * from the sweep's owner and never from a second counter elsewhere. Same
 * walk shape as the sweep's file branch (project directories under the
 * projects root, plain files only); counts and sizes only — this function
 * deletes nothing.
 */
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
        // A recording that vanished mid-census simply doesn't count.
      }
    }
  }
  return { count, bytes }
}

/** Aged plan documents under `<mercuryHome>/plans`. */
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
    // Plain files only: an aged directory named like a plan file is
    // skipped, uncounted.
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
    // Not empty — leave it.
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
  // Directories only: a loose file under the root is ignored entirely —
  // neither deleted nor counted.
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
    // Not empty — leave it.
  }
  return result
}

/** Whole per-session backup directories under `<mercuryHome>/file-history`. */
export async function cleanupOldFileHistoryBackups(): Promise<CleanupResult> {
  return cleanupAgedDirectoryTree(join(getMercuryHome(), 'file-history'), true)
}

/** Whole per-session env directories under `<mercuryHome>/session-env`. */
export async function cleanupOldSessionEnvDirs(): Promise<CleanupResult> {
  return cleanupAgedDirectoryTree(join(getMercuryHome(), 'session-env'), false)
}

/**
 * Aged `.txt` debug logs under `<mercuryHome>/debug`. The `latest` entry
 * (the current session's symlink) is preserved and the directory itself is
 * never removed even when emptied — future logs need it. Only plain-file
 * entries are considered, so a symlink entry is skipped in any case.
 */
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

/**
 * The one background aggregate entry point, returning one honest receipt.
 *
 * With settings validation errors AND an explicitly configured
 * `cleanupPeriodDays`, the whole sweep is skipped and one error is
 * reported: with the user's own retention value unreadable, running on the
 * 30-day default could delete files they meant to keep — and because
 * nothing was swept, the receipt must not look like a finished sweep. The
 * one error keeps the caller from stamping its "last cleanup" sentinel, so
 * a later run tries again.
 */
export async function cleanupOldMessageFilesInBackground(): Promise<CleanupResult> {
  // The gate reads the accessor that includes MCP-configuration errors as
  // well as settings validation errors.
  const { errors: settingsErrors } = getSettingsWithAllErrors()
  // rawSettingsContainsKey answers YES for a source that exists but cannot
  // be read or parsed (release-hardening audit rank 40): the broken file
  // may be the very one carrying the user's retention window, so the sweep
  // must not run on the 30-day default over it.
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

  // Three further families that report nothing themselves; each wrapped so
  // a throw adds exactly one error — counted, not also written to the
  // error log.
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
