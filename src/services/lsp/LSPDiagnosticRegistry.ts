import { randomUUID } from 'node:crypto'

import { LRUCache } from 'lru-cache'

import { logForDebugging } from '../../utils/debug.js'
import { logError } from '../../utils/log.js'
import type { Diagnostic, DiagnosticFile } from '../diagnosticTracking.js'

/**
 * Process-global store for push diagnostics awaiting delivery into the
 * conversation; dedup (in-batch + cross-turn), volume capping, and a
 * non-consuming publish subscription.
 */

export type PendingLSPDiagnostic = {
  serverName: string
  files: DiagnosticFile[]
  timestamp: number
  attachmentSent: boolean
}

type PublishListener = (event: { serverName: string; files: DiagnosticFile[] }) => void

const MAX_PER_FILE = 10
const MAX_TOTAL = 30
const MAX_TRACKED_FILES = 500
/** Publishes parked between consuming reads (sweep #2, packet 47):
 *  a server re-checking a large workspace can publish thousands of times
 *  inside one turn; the table holds at most this many and drops the OLDEST
 *  beyond it (a newer publish for the same file already superseded it). */
export const MAX_PENDING_PUBLISHES = 500

/**
 * Fold a lowercase Windows drive letter to uppercase — pyright publishes
 * c:\… while Mercury resolves C:\…, and the case split made every by-path
 * lookup here miss: no harvest, stabilization timeouts, and a dedup CLEAR
 * that never cleared (FC-014). Pure and platform-neutral: only a string
 * shaped ^[a-z]:[\\/] changes; POSIX paths pass byte-identically.
 */
export function foldDriveCase(path: string): string {
  return /^[a-z]:[\\/]/.test(path) ? path[0]!.toUpperCase() + path.slice(1) : path
}

const foldFileKey = (uriOrPath: string): string =>
  uriOrPath.startsWith('file://') ? 'file://' + foldDriveCase(uriOrPath.slice('file://'.length)) : foldDriveCase(uriOrPath)

const pending = new Map<string, PendingLSPDiagnostic>()
const publishListeners = new Set<PublishListener>()
// Cross-turn memory: per-file delivered sets, bounded.
const delivered = new LRUCache<string, Set<string>>({ max: MAX_TRACKED_FILES })

function diagnosticKey(diagnostic: Diagnostic): string {
  return JSON.stringify([
    diagnostic.message,
    diagnostic.severity,
    diagnostic.range,
    diagnostic.source || null,
    diagnostic.code || null,
  ])
}

function severityRank(severity: string | undefined): number {
  switch (severity) {
    case 'Error':
      return 1
    case 'Warning':
      return 2
    case 'Info':
      return 3
    case 'Hint':
      return 4
    default:
      return 4
  }
}

export function registerPendingLSPDiagnostic({
  serverName,
  files,
}: {
  serverName: string
  files: DiagnosticFile[]
}): void {
  // publishDiagnostics is a full replacement per URI: a newer publish for a
  // file supersedes whatever that server parked for it earlier, so a flood
  // of re-checks for one file costs one entry, not one per publish.
  const uris = new Set(files.map(file => file.uri))
  for (const [pendingId, entry] of pending) {
    if (entry.attachmentSent || entry.serverName !== serverName) continue
    const kept = entry.files.filter(file => !uris.has(file.uri))
    if (kept.length === entry.files.length) continue
    if (kept.length === 0) pending.delete(pendingId)
    else entry.files = kept
  }
  const id = randomUUID()
  pending.set(id, { serverName, files, timestamp: Date.now(), attachmentSent: false })
  let evicted = 0
  while (pending.size > MAX_PENDING_PUBLISHES) {
    const oldest = pending.keys().next().value
    if (oldest === undefined) break
    pending.delete(oldest)
    evicted++
  }
  if (evicted > 0) logForDebugging(`LSP diagnostics: pending table full — dropped ${evicted} oldest publish${evicted === 1 ? '' : 'es'}`)
  const count = files.reduce((total, file) => total + file.diagnostics.length, 0)
  logForDebugging(`LSP diagnostics: registered ${count} from ${serverName} (${id})`)
  for (const listener of publishListeners) {
    try {
      listener({ serverName, files })
    } catch (err) {
      // Listener errors must never break diagnostic delivery.
      logForDebugging(`LSP diagnostics: publish listener threw: ${String(err)}`)
    }
  }
}

/** Non-consuming: subscribers observe a push without stealing delivery. */
export function subscribeLSPDiagnosticPublish(cb: PublishListener): () => void {
  publishListeners.add(cb)
  return () => {
    publishListeners.delete(cb)
  }
}

// ── the last-report ledger (push-only servers) ──────────────────────────────
// pyright never implements pull diagnostics — it PUBLISHES. The diagnostics
// op needs the latest published report for one file WITHOUT stealing passive
// delivery, INCLUDING the clean (empty) publishes the delivery path drops.
// This ledger is separate from `pending` by design: pending is delivery
// machinery (consumed, deduped, capped); the ledger is the last full report
// per server::file, bounded, with its own non-consuming listener set.

const lastReports = new LRUCache<string, { file: DiagnosticFile; at: number }>({
  max: MAX_TRACKED_FILES,
})
type ReportListener = (event: { serverName: string; file: DiagnosticFile }) => void
const reportListeners = new Set<ReportListener>()

/** Record EVERY publish (empties included) — called by passiveFeedback
 *  beside its delivery registration; delivery semantics untouched. */
export function recordPublishedReport(serverName: string, file: DiagnosticFile): void {
  lastReports.set(`${serverName}::${foldFileKey(file.uri)}`, { file, at: Date.now() })
  for (const listener of reportListeners) {
    try {
      listener({ serverName, file })
    } catch (err) {
      logForDebugging(`LSP diagnostics: report listener threw: ${String(err)}`)
    }
  }
}

/** Non-consuming subscription to recorded reports (clean publishes fire too). */
export function subscribePublishedReports(cb: ReportListener): () => void {
  reportListeners.add(cb)
  return () => {
    reportListeners.delete(cb)
  }
}

/** The latest recorded report from one server for one file — either key
 *  form (passiveFeedback normalises file:// uris to plain paths). */
export function peekLastPublishedReport(
  serverName: string,
  uriOrPath: string,
): { file: DiagnosticFile; at: number } | undefined {
  const plain = foldDriveCase(uriOrPath.startsWith('file://') ? uriOrPath.slice('file://'.length) : uriOrPath)
  return (
    lastReports.get(`${serverName}::${plain}`) ?? lastReports.get(`${serverName}::file://${plain}`)
  )
}

/** Prover projection: parked publishes and the files they carry. */
export function _pendingForTesting(): Array<{ serverName: string; uris: string[] }> {
  return [...pending.values()].filter(entry => !entry.attachmentSent).map(entry => ({ serverName: entry.serverName, uris: entry.files.map(file => file.uri) }))
}

export function _publishListenerCountForTesting(): number {
  return publishListeners.size
}

/** Two passes: within the batch, and against the cross-turn delivered set. */
function dedupe(files: DiagnosticFile[]): DiagnosticFile[] {
  const byFile = new Map<string, { file: DiagnosticFile; seen: Set<string>; kept: Diagnostic[] }>()
  for (const file of files) {
    const fileKey = foldFileKey(file.uri)
    let entry = byFile.get(fileKey)
    if (entry === undefined) {
      entry = { file, seen: new Set(), kept: [] }
      byFile.set(fileKey, entry)
    }
    const already = delivered.get(fileKey)
    for (const diagnostic of file.diagnostics) {
      let key: string
      try {
        key = diagnosticKey(diagnostic)
      } catch (err) {
        logForDebugging(`LSP diagnostics: key failed, including anyway: ${String(err).slice(0, 100)}`)
        entry.kept.push(diagnostic)
        continue
      }
      if (entry.seen.has(key)) continue
      if (already?.has(key)) continue
      entry.seen.add(key)
      entry.kept.push(diagnostic)
    }
  }
  const out: DiagnosticFile[] = []
  for (const { file, kept } of byFile.values()) {
    if (kept.length > 0) out.push({ ...file, diagnostics: kept })
  }
  return out
}

function recordDelivered(files: DiagnosticFile[]): void {
  for (const file of files) {
    for (const diagnostic of file.diagnostics) {
      try {
        const key = diagnosticKey(diagnostic)
        const fileKey = foldFileKey(file.uri)
        let set = delivered.get(fileKey)
        if (set === undefined) {
          set = new Set()
          delivered.set(fileKey, set)
        }
        set.add(key)
      } catch (err) {
        logForDebugging(`LSP diagnostics: could not record delivered key: ${String(err).slice(0, 100)}`)
      }
    }
  }
}

/** The consuming read. */
export function checkForLSPDiagnostics(): Array<{ serverName: string; files: DiagnosticFile[] }> {
  const gatheredIds: string[] = []
  const gatheredFiles: DiagnosticFile[] = []
  const serverNames = new Set<string>()
  for (const [id, entry] of pending) {
    if (entry.attachmentSent) continue
    gatheredIds.push(id)
    gatheredFiles.push(...entry.files)
    serverNames.add(entry.serverName)
  }
  if (gatheredFiles.length === 0) return []

  const before = gatheredFiles.reduce((total, file) => total + file.diagnostics.length, 0)
  let deduped: DiagnosticFile[]
  try {
    deduped = dedupe(gatheredFiles)
  } catch (err) {
    // Losing diagnostics is worse than duplicating them.
    logForDebugging(`LSP diagnostics: dedup failed, delivering undeduplicated: ${String(err)}`)
    deduped = gatheredFiles
  }
  // Mark sent only AFTER dedup succeeded, then drop the entries.
  for (const id of gatheredIds) {
    const entry = pending.get(id)
    if (entry !== undefined) entry.attachmentSent = true
    pending.delete(id)
  }
  const afterDedup = deduped.reduce((total, file) => total + file.diagnostics.length, 0)
  if (afterDedup < before) {
    logForDebugging(`LSP diagnostics: dedup removed ${before - afterDedup}`)
  }

  // Volume cap: per-file first (errors survive truncation), then the total.
  let remaining = MAX_TOTAL
  let truncated = 0
  const capped: DiagnosticFile[] = []
  for (const file of deduped) {
    const sorted = [...file.diagnostics].sort(
      (a, b) => severityRank(a.severity) - severityRank(b.severity),
    )
    const perFile = sorted.slice(0, Math.min(MAX_PER_FILE, remaining))
    truncated += sorted.length - perFile.length
    remaining -= perFile.length
    if (perFile.length > 0) capped.push({ ...file, diagnostics: perFile })
  }
  if (truncated > 0) {
    logForDebugging(
      `LSP diagnostics: truncated ${truncated} (caps: ${MAX_PER_FILE} per file, ${MAX_TOTAL} total)`,
    )
  }
  recordDelivered(capped)
  if (capped.length === 0) {
    logForDebugging('LSP diagnostics: nothing survives dedup/capping')
    return []
  }
  return [{ serverName: [...serverNames].join(', '), files: capped }]
}

/** Re-arms delivery for a file after an edit; accepts either key form. */
export function clearDeliveredDiagnosticsForFile(fileUriOrPath: string): void {
  const plain = foldDriveCase(fileUriOrPath.startsWith('file://') ? fileUriOrPath.slice('file://'.length) : fileUriOrPath)
  for (const key of [plain, `file://${plain}`]) {
    if (delivered.has(key)) {
      delivered.delete(key)
      logForDebugging(`LSP diagnostics: cleared delivered set for ${key}`)
    }
  }
}

/** Pending entries only; the cross-turn memory survives. */
export function clearAllLSPDiagnostics(): void {
  logForDebugging(`LSP diagnostics: clearing ${pending.size} pending entries`)
  pending.clear()
}

export function resetAllLSPDiagnosticState(): void {
  logForDebugging(`LSP diagnostics: reset (${pending.size} pending, ${delivered.size} tracked files)`)
  pending.clear()
  delivered.clear()
}

export function getPendingLSPDiagnosticCount(): number {
  return pending.size
}
