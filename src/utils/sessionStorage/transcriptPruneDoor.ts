import { getFsImplementation } from '../fsOperations.js'
import { receiptsPathBesideTranscript } from '../../services/switchboard/sessionReceipts.js'
import { snapshotPathFor } from './resumeSnapshot.js'

export type PruneCandidate = {
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
      await fs.unlink(candidate.transcriptPath)
      receipt.deleted++
      receipt.bytesFreed += candidate.bytes
      receipt.deletedSessionIds.push(candidate.sessionId)
      try {
        await fs.unlink(candidate.receiptsPath)
        receipt.receiptsDeleted++
      } catch {
      }
      try {
        const snapBytes = (await fs.stat(candidate.snapshotPath)).size
        await fs.unlink(candidate.snapshotPath)
        receipt.snapshotsDeleted++
        receipt.bytesFreed += snapBytes
      } catch {
      }
    } catch {
      receipt.failed++
    }
  }
  return receipt
}
