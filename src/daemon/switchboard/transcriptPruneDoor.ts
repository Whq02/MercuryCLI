import { dirname, join } from 'node:path'
import { ownedHistoryParts } from '../../sessions/transcripts/historyParts.js'
import { getFsImplementation } from '../../platform/files/fsOperations.js'
import { removePrefixRecord } from '../../models/roads/anthropic/prefixRecordStore.js'
import { receiptsPathBesideTranscript } from './sessionReceipts.js'
import { snapshotPathFor } from '../../sessions/transcripts/resumeSnapshot.js'
import { passedOver } from '../../platform/errors/passedOver.js'

type PruneCandidate = {
  sessionId: string
  transcriptPath: string
  receiptsPath: string
  snapshotPath: string
  bytes: number
  modified: Date
}

export type PruneOffer = {
  scopeLabel: string
  windowDays: number
  candidates: PruneCandidate[]
  totalBytes: number
  oldestModified: Date | null
  newestModified: Date | null
}

export type PruneReceipt = {
  deleted: number
  failed: number
  bytesFreed: number
  at: Date
  deletedSessionIds: string[]
  receiptsDeleted: number
  snapshotsDeleted: number
}

export function buildPruneOffer(
  rows: Array<{ sessionId?: string; fullPath?: string; fileSize?: number; modified: Date }>,
  opts: {
    scopeLabel: string
    windowDays: number
    now?: Date
    activeSessionId?: string
    liveSessionIds?: ReadonlySet<string>
  },
): PruneOffer {
  const now = opts.now ?? new Date()
  const cutoffMs = now.getTime() - opts.windowDays * 24 * 60 * 60 * 1000
  const candidates: PruneCandidate[] = []
  for (const row of rows) {
    if (!row.sessionId || !row.fullPath) continue
    if (row.sessionId === opts.activeSessionId) continue
    if (opts.liveSessionIds?.has(row.sessionId)) continue
    if (row.modified.getTime() >= cutoffMs) continue
    candidates.push({
      sessionId: row.sessionId,
      transcriptPath: row.fullPath,
      receiptsPath: receiptsPathBesideTranscript(row.fullPath),
      snapshotPath: snapshotPathFor(row.fullPath),
      bytes: row.fileSize ?? 0,
      modified: row.modified,
    })
  }
  candidates.sort((a, b) => a.modified.getTime() - b.modified.getTime())
  const totalBytes = candidates.reduce((sum, c) => sum + c.bytes, 0)
  return {
    scopeLabel: opts.scopeLabel,
    windowDays: opts.windowDays,
    candidates,
    totalBytes,
    oldestModified: candidates[0]?.modified ?? null,
    newestModified: candidates[candidates.length - 1]?.modified ?? null,
  }
}

export function buildSessionDeleteOffer(
  row: { sessionId: string; fullPath: string; fileSize: number; modified: Date },
  opts: { scopeLabel: string; liveSessionIds: ReadonlySet<string> },
): PruneOffer | null {
  if (opts.liveSessionIds.has(row.sessionId)) return null
  const candidate: PruneCandidate = {
    sessionId: row.sessionId,
    transcriptPath: row.fullPath,
    receiptsPath: receiptsPathBesideTranscript(row.fullPath),
    snapshotPath: snapshotPathFor(row.fullPath),
    bytes: row.fileSize,
    modified: row.modified,
  }
  return {
    scopeLabel: opts.scopeLabel,
    windowDays: 0,
    candidates: [candidate],
    totalBytes: row.fileSize,
    oldestModified: row.modified,
    newestModified: row.modified,
  }
}

function safeSubagentsPaths(transcriptPath: string, sessionId: string): { sessionDir: string; subagentsDir: string } | null {
  if (sessionId === '' || sessionId === '.' || sessionId === '..' || sessionId.includes('/') || sessionId.includes('\\')) {
    return null
  }
  const sessionDir = join(dirname(transcriptPath), sessionId)
  return { sessionDir, subagentsDir: join(sessionDir, 'subagents') }
}

async function directoryBytes(fs: ReturnType<typeof getFsImplementation>, dir: string): Promise<number> {
  let total = 0
  let entries: Awaited<ReturnType<typeof fs.readdir>>
  try {
    entries = await fs.readdir(dir)
  } catch (error) {
    passedOver(error)
    return 0
  }
  for (const entry of entries) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) {
      total += await directoryBytes(fs, path)
    } else if (entry.isFile()) {
      try {
        total += (await fs.stat(path)).size
      } catch (error) {
        passedOver(error)
      }
    }
  }
  return total
}
export async function operatorPruneTranscripts(offer: PruneOffer): Promise<PruneReceipt> {
  const fs = getFsImplementation()
  const receipt: PruneReceipt = {
    deleted: 0,
    failed: 0,
    bytesFreed: 0,
    at: new Date(),
    deletedSessionIds: [],
    receiptsDeleted: 0,
    snapshotsDeleted: 0,
  }
  for (const candidate of offer.candidates) {
    try {
      const parts = ownedHistoryParts(candidate.transcriptPath)
      await fs.unlink(candidate.transcriptPath)
      if (parts) {
        for (const path of parts.files) await fs.unlink(path)
        await fs.rmdir(parts.dir).catch(passedOver)
      }
      receipt.deleted++
      receipt.bytesFreed += candidate.bytes
      receipt.deletedSessionIds.push(candidate.sessionId)
      removePrefixRecord(candidate.sessionId)
      try {
        await fs.unlink(candidate.receiptsPath)
        receipt.receiptsDeleted++
      } catch (error) {
        passedOver(error)
      }
      try {
        const snapBytes = (await fs.stat(candidate.snapshotPath)).size
        await fs.unlink(candidate.snapshotPath)
        receipt.snapshotsDeleted++
        receipt.bytesFreed += snapBytes
      } catch (error) {
        passedOver(error)
      }
      const subagents = safeSubagentsPaths(candidate.transcriptPath, candidate.sessionId)
      if (subagents !== null) {
        try {
          if (fs.lstatSync(subagents.subagentsDir).isDirectory()) {
            const subagentsBytes = await directoryBytes(fs, subagents.subagentsDir)
            await fs.rm(subagents.subagentsDir, { recursive: true, force: true })
            receipt.bytesFreed += subagentsBytes
            await fs.rmdir(subagents.sessionDir).catch(passedOver)
          }
        } catch (error) {
          passedOver(error)
        }
      }
    } catch {
      receipt.failed++
    }
  }
  return receipt
}
