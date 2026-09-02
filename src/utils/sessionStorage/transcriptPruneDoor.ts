// ============================================================================
//  src/utils/sessionStorage/transcriptPruneDoor.ts — THE ONE PRUNE DOOR.
//
//  THIS IS THE ONLY DOOR IN THE PRODUCT THAT DELETES A TRANSCRIPT. The
//  retention law (the operator's L11): transcripts (.jsonl) are NEVER
//  auto-deleted — the retention sweep (utils/cleanup.ts) ages only
//  recordings (.cast); the board hides only. Deleting a transcript is the
//  operator's own act, and it happens here and nowhere else:
//  operatorPruneTranscripts has exactly ONE caller — the confirmed Yes of
//  the /sessions prune card (SessionManagerView), a default-No card the
//  operator pressed open, answered No on esc, remembered never.
//
//  This module shares no code with the sweep, so a future edit cannot
//  re-arm auto-deletion by threading the sweep through it: the never-unlink
//  walk in scripts/switchboard/prove-concourse-resume.ts exempts exactly
//  this file and pins that this function never appears in the sweep's file;
//  scripts/switchboard/prove-status-prune.ts pins the door's own laws
//  (deletes only the confirmed card's named set, No/esc delete nothing,
//  a live record's transcript is never in the offered set).
// ============================================================================
import { getFsImplementation } from '../fsOperations.js'
import { receiptsPathBesideTranscript } from '../../services/switchboard/sessionReceipts.js'
import { snapshotPathFor } from './resumeSnapshot.js'

/** One offered deletion, named in full: the session, its transcript, and
 *  the receipts sidecar that rides it (the T5–T6 retention ruling: the
 *  operator's prune takes a session's receipts WITH its transcript). The
 *  sidecar path is a pure spelling off the transcript path — named in the
 *  frozen offer, tolerated absent at the delete. */
export type PruneCandidate = {
  sessionId: string
  /** The transcript's absolute path — the one conversation file the door
   *  may delete. */
  transcriptPath: string
  /** The receipts sidecar's one possible home beside it — deleted with the
   *  transcript when present; most sessions never wrote one. */
  receiptsPath: string
  /** The resume-snapshot sidecar's one possible home beside it — a full
   *  serialized copy of the conversation any ≥256KB load writes (even a
   *  /resume PREVIEW). Left behind, the operator's prune "deleted" a
   *  conversation whose text stayed on disk indefinitely and the freed
   *  figure lied by the sidecar's size (TASK-017 S2,
   *  prune-door-leaves-resume-snapshot-sidecar). Named frozen, like the
   *  receipts sidecar; tolerated absent. */
  snapshotPath: string
  bytes: number
  modified: Date
}

/** The frozen set the card names — built at card open, never rebuilt under
 *  the operator's answer. */
export type PruneOffer = {
  /** The scope in the operator's words, exactly as the card paints it. */
  scopeLabel: string
  windowDays: number
  candidates: PruneCandidate[]
  totalBytes: number
  oldestModified: Date | null
  newestModified: Date | null
}

/** The typed receipt the confirmed act paints: count · bytes freed · when;
 *  the caller says "by the operator" — no other actor reaches this door. */
export type PruneReceipt = {
  deleted: number
  failed: number
  bytesFreed: number
  at: Date
  deletedSessionIds: string[]
  /** Receipts sidecars that actually rode their transcript out — absent
   *  sidecars are normal and count nowhere. */
  receiptsDeleted: number
  /** Resume-snapshot sidecars that rode their transcript out; their bytes
   *  join bytesFreed so the freed figure stops under-claiming. */
  snapshotsDeleted: number
}

/**
 * Freeze the offer the card names — PURE, from the rows the /sessions list
 * itself shows (never a second directory scan). A row joins the offer only
 * when it is older than the window, carries a real session id and
 * transcript path, and is not the operator's live estate: the active
 * session and every live/board-homed record are excluded here AGAIN, even
 * though the view's list already excludes them — a live record's
 * transcript must never be in the offered set, whatever rows arrive.
 */
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

/**
 * THE ONE DELETE. Unlinks exactly the offer's named transcripts — the set
 * the confirmed card showed, frozen at card open — each with the TWO
 * sidecars the offer named beside it (T5–T6: a session's receipts go WITH
 * its transcript; and its resume-snapshot, the serialized copy of the same
 * conversation, goes too — left behind it kept the pruned text on disk
 * indefinitely while the freed figure excluded it, TASK-017 S2), nothing
 * else: no .cast, no blob directories, no directories at all (recordings
 * stay the sweep's business; empty session dirs stay the sweep's tidy-up).
 * THE FREEZE LAW (lead-ratified): Yes deletes exactly the
 * frozen set — the offer never rebuilds at Yes, so a chat born, or aged
 * past the window, between the card and the Yes is never in it. A file
 * that vanished between card and Yes counts as failed, honestly — never
 * re-resolved onto something else.
 *
 * TWO NAMED CALLERS, ONE DELETE ROAD (widened, lead-ruled
 * — an exemption-with-teeth over the one-caller census,
 * whose WHY is unchanged): the operator-pressed prune cards' confirmed Yes
 * — the /sessions card (SessionManagerView) and the Boot face's resume
 * screen card (BootResumeScreen). Both freeze the offer at card open,
 * start answered No, leave on esc/n, and paint the typed receipt. No other
 * actor reaches this door: never a sweep, never an automatic road, never
 * the picker core (its dropSessions is a list-state mirror only) —
 * prove-status-prune's census pins exactly these two card files.
 */
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
      // The session's receipts ride its transcript out (the T5–T6 retention
      // ruling) — exactly the sidecar the frozen offer named, nothing
      // re-resolved. Absent is normal (most sessions wrote none), and a
      // sidecar failure never converts a deleted transcript into 'failed'.
      try {
        await fs.unlink(candidate.receiptsPath)
        receipt.receiptsDeleted++
      } catch {
        /* no sidecar rode this transcript */
      }
      // The resume-snapshot sidecar goes the same way — it is a serialized
      // copy of the SAME conversation the operator just deleted, and its
      // bytes join the freed figure (stat-then-unlink; a failure here never
      // converts the deleted transcript into 'failed').
      try {
        const snapBytes = (await fs.stat(candidate.snapshotPath)).size
        await fs.unlink(candidate.snapshotPath)
        receipt.snapshotsDeleted++
        receipt.bytesFreed += snapBytes
      } catch {
        /* no resume snapshot rode this transcript */
      }
    } catch {
      receipt.failed++
    }
  }
  return receipt
}
