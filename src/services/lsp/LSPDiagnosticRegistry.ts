import { randomUUID } from 'node:crypto'

import { structuredPatch } from 'diff'
import { LRUCache } from 'lru-cache'

import { logForDebugging } from '../../utils/debug.js'
import { logError } from '../../utils/log.js'
import type { Diagnostic, DiagnosticFile } from '../diagnosticTracking.js'


type PendingLSPDiagnostic = {
  serverName: string
  files: DiagnosticFile[]
  timestamp: number
  attachmentSent: boolean
}

type PublishListener = (event: { serverName: string; files: DiagnosticFile[] }) => void

const MAX_PER_FILE = 10
const MAX_TOTAL = 30
const MAX_TRACKED_FILES = 500
const MAX_WRITE_BASELINES = 256
const MAX_BASELINE_TEXT_CHARS = 10_000_000
const BASELINE_DIFF_TIMEOUT_MS = 5_000
export const MAX_PENDING_PUBLISHES = 500

export function foldDriveCase(path: string): string {
  return /^[a-z]:[\\/]/.test(path) ? path[0]!.toUpperCase() + path.slice(1) : path
}

const foldFileKey = (uriOrPath: string): string =>
  uriOrPath.startsWith('file://') ? 'file://' + foldDriveCase(uriOrPath.slice('file://'.length)) : foldDriveCase(uriOrPath)

const plainPathKey = (uriOrPath: string): string =>
  foldDriveCase(uriOrPath.startsWith('file://') ? uriOrPath.slice('file://'.length) : uriOrPath)

type LineShiftStep = Array<{ oldStart: number; oldLines: number; newLines: number }>

type WriteBaseline = {
  report: { file: DiagnosticFile; at: number }
  steps: LineShiftStep[]
  docVersion: number | undefined
}

const writeBaselines = new LRUCache<string, Map<string, WriteBaseline>>({ max: MAX_WRITE_BASELINES })

function lineShiftStepBetween(before: string, after: string): LineShiftStep | null {
  if (before.length > MAX_BASELINE_TEXT_CHARS || after.length > MAX_BASELINE_TEXT_CHARS) return null
  const options = { context: 0, timeout: BASELINE_DIFF_TIMEOUT_MS } as Parameters<typeof structuredPatch>[6]
  const patch = structuredPatch('a', 'a', before.replace(/\r\n?/g, '\n'), after.replace(/\r\n?/g, '\n'), undefined, undefined, options)
  if (!patch) return null
  return patch.hunks.map(hunk => ({ oldStart: hunk.oldStart, oldLines: hunk.oldLines, newLines: hunk.newLines }))
}

function shiftLine(line: number, step: LineShiftStep): number | null {
  const oneBased = line + 1
  let delta = 0
  for (const hunk of step) {
    if (hunk.oldLines > 0 && oneBased >= hunk.oldStart && oneBased < hunk.oldStart + hunk.oldLines) return null
    if (oneBased < hunk.oldStart + hunk.oldLines) break
    delta += hunk.newLines - hunk.oldLines
  }
  return line + delta
}

function remapThroughWrites(diagnostic: Diagnostic, steps: LineShiftStep[]): Diagnostic | null {
  let start = diagnostic.range.start.line
  let end = diagnostic.range.end.line
  for (const step of steps) {
    const movedStart = shiftLine(start, step)
    const movedEnd = shiftLine(end, step)
    if (movedStart === null || movedEnd === null) return null
    start = movedStart
    end = movedEnd
  }
  if (start === diagnostic.range.start.line && end === diagnostic.range.end.line) return diagnostic
  return { ...diagnostic, range: { start: { ...diagnostic.range.start, line: start }, end: { ...diagnostic.range.end, line: end } } }
}

const pending = new Map<string, PendingLSPDiagnostic>()
const publishListeners = new Set<PublishListener>()
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
  files: published,
  version,
}: {
  serverName: string
  files: DiagnosticFile[]
  version?: number
}): void {
  const files = published.filter(file => !staleAgainstWriteBaseline(serverName, file.uri, version))
  if (files.length < published.length) logForDebugging(`LSP diagnostics: ${serverName} published document version ${version} for a file written since — no data until it publishes the written version`)
  if (files.length === 0) return
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
      logForDebugging(`LSP diagnostics: publish listener threw: ${String(err)}`)
    }
  }
}

export function subscribeLSPDiagnosticPublish(cb: PublishListener): () => void {
  publishListeners.add(cb)
  return () => {
    publishListeners.delete(cb)
  }
}


const lastReports = new LRUCache<string, { file: DiagnosticFile; at: number }>({
  max: MAX_TRACKED_FILES,
})
type ReportListener = (event: { serverName: string; file: DiagnosticFile }) => void
const reportListeners = new Set<ReportListener>()

export function recordPublishedReport(serverName: string, file: DiagnosticFile, version?: number): void {
  if (staleAgainstWriteBaseline(serverName, file.uri, version)) return
  lastReports.set(`${serverName}::${foldFileKey(file.uri)}`, { file, at: Date.now() })
  for (const listener of reportListeners) {
    try {
      listener({ serverName, file })
    } catch (err) {
      logForDebugging(`LSP diagnostics: report listener threw: ${String(err)}`)
    }
  }
}

export function subscribePublishedReports(cb: ReportListener): () => void {
  reportListeners.add(cb)
  return () => {
    reportListeners.delete(cb)
  }
}

export function peekLastPublishedReport(
  serverName: string,
  uriOrPath: string,
): { file: DiagnosticFile; at: number } | undefined {
  const plain = foldDriveCase(uriOrPath.startsWith('file://') ? uriOrPath.slice('file://'.length) : uriOrPath)
  return (
    lastReports.get(`${serverName}::${plain}`) ?? lastReports.get(`${serverName}::file://${plain}`)
  )
}

function staleAgainstWriteBaseline(serverName: string, uri: string, version: number | undefined): boolean {
  if (version === undefined) return false
  const baseline = writeBaselines.peek(plainPathKey(uri))?.get(serverName)
  return baseline !== undefined && baseline.docVersion !== undefined && version <= baseline.docVersion
}

function introducedSinceWrite(serverName: string, file: DiagnosticFile): DiagnosticFile {
  const baseline = writeBaselines.peek(plainPathKey(file.uri))?.get(serverName)
  if (baseline === undefined) return file
  try {
    const preExisting = new Set<string>()
    for (const diagnostic of baseline.report.file.diagnostics) {
      const moved = remapThroughWrites(diagnostic, baseline.steps)
      if (moved !== null) preExisting.add(diagnosticKey(moved))
    }
    const introduced = file.diagnostics.filter(diagnostic => !preExisting.has(diagnosticKey(diagnostic)))
    if (introduced.length === file.diagnostics.length) return file
    logForDebugging(`LSP diagnostics: ${file.uri}: ${file.diagnostics.length - introduced.length} pre-existing before the write subtracted, ${introduced.length} introduced by it`)
    return { ...file, diagnostics: introduced }
  } catch (err) {
    logForDebugging(`LSP diagnostics: baseline subtraction failed, delivering whole: ${String(err).slice(0, 100)}`)
    return file
  }
}

export function snapshotDiagnosticsBeforeWrite(path: string, before: string | null, after: string, docVersion: number | undefined): void {
  const fileKey = plainPathKey(path)
  for (const [pendingId, entry] of pending) {
    const kept = entry.files.filter(file => plainPathKey(file.uri) !== fileKey)
    if (kept.length === entry.files.length) continue
    if (kept.length === 0) pending.delete(pendingId)
    else entry.files = kept
    logForDebugging(`LSP diagnostics: ${entry.serverName}'s publish for ${fileKey} predates the write — no data until it publishes again`)
  }
  let step: LineShiftStep | null = null
  try {
    step = before === null ? null : lineShiftStepBetween(before, after)
  } catch (err) {
    logForDebugging(`LSP diagnostics: no line map for ${fileKey}, the write reports as a first write: ${String(err).slice(0, 100)}`)
  }
  if (step === null) {
    writeBaselines.delete(fileKey)
    return
  }
  const previous = writeBaselines.peek(fileKey)
  const next = new Map<string, WriteBaseline>()
  for (const suffix of [`::${fileKey}`, `::file://${fileKey}`]) {
    for (const [ledgerKey, report] of lastReports.entries()) {
      if (!ledgerKey.endsWith(suffix)) continue
      const serverName = ledgerKey.slice(0, ledgerKey.length - suffix.length)
      const earlier = previous?.get(serverName)
      next.set(serverName, earlier !== undefined && earlier.report === report ? { report, steps: [...earlier.steps, step], docVersion } : { report, steps: [step], docVersion })
    }
  }
  if (next.size === 0) {
    writeBaselines.delete(fileKey)
    return
  }
  writeBaselines.set(fileKey, next)
  logForDebugging(`LSP diagnostics: baseline for ${fileKey} snapshotted before the write (${[...next.keys()].join(', ')}; document version ${docVersion ?? 'unknown'})`)
}

export function noteOutOfBandWrite(path: string, versions: ReadonlyArray<{ serverName: string; docVersion: number }>): void {
  const fileKey = plainPathKey(path)
  for (const [pendingId, entry] of pending) {
    const kept = entry.files.filter(file => plainPathKey(file.uri) !== fileKey)
    if (kept.length === entry.files.length) continue
    if (kept.length === 0) pending.delete(pendingId)
    else entry.files = kept
    logForDebugging(`LSP diagnostics: ${entry.serverName}'s publish for ${fileKey} predates a write outside the tools — no data until it publishes the re-synced text`)
  }
  const previous = writeBaselines.peek(fileKey)
  const next = new Map<string, WriteBaseline>(previous ?? [])
  for (const { serverName, docVersion } of versions) {
    const report = lastReports.get(`${serverName}::${fileKey}`) ?? lastReports.get(`${serverName}::file://${fileKey}`)
    if (report === undefined) continue
    const earlier = previous?.get(serverName)
    next.set(serverName, earlier !== undefined && earlier.report === report ? { ...earlier, docVersion } : { report, steps: [], docVersion })
  }
  if (next.size === 0) return
  writeBaselines.set(fileKey, next)
  logForDebugging(`LSP diagnostics: baseline for ${fileKey} pinned at a write outside the tools (${[...next.keys()].join(', ')}; document version ${versions.map(row => row.docVersion).join('/')})`)
}

export function _writeBaselineForTesting(path: string): Array<{ serverName: string; steps: number; docVersion: number | undefined }> {
  const baselines = writeBaselines.peek(plainPathKey(path))
  if (baselines === undefined) return []
  return [...baselines].map(([serverName, baseline]) => ({ serverName, steps: baseline.steps.length, docVersion: baseline.docVersion }))
}

export function _pendingForTesting(): Array<{ serverName: string; uris: string[] }> {
  return [...pending.values()].filter(entry => !entry.attachmentSent).map(entry => ({ serverName: entry.serverName, uris: entry.files.map(file => file.uri) }))
}

export function _publishListenerCountForTesting(): number {
  return publishListeners.size
}

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

export function checkForLSPDiagnostics(): Array<{ serverName: string; files: DiagnosticFile[] }> {
  const gatheredIds: string[] = []
  const gatheredFiles: DiagnosticFile[] = []
  const serverNames = new Set<string>()
  for (const [id, entry] of pending) {
    if (entry.attachmentSent) continue
    gatheredIds.push(id)
    gatheredFiles.push(...entry.files.map(file => introducedSinceWrite(entry.serverName, file)))
    serverNames.add(entry.serverName)
  }
  if (gatheredFiles.length === 0) return []

  const before = gatheredFiles.reduce((total, file) => total + file.diagnostics.length, 0)
  let deduped: DiagnosticFile[]
  try {
    deduped = dedupe(gatheredFiles)
  } catch (err) {
    logForDebugging(`LSP diagnostics: dedup failed, delivering undeduplicated: ${String(err)}`)
    deduped = gatheredFiles
  }
  for (const id of gatheredIds) {
    const entry = pending.get(id)
    if (entry !== undefined) entry.attachmentSent = true
    pending.delete(id)
  }
  const afterDedup = deduped.reduce((total, file) => total + file.diagnostics.length, 0)
  if (afterDedup < before) {
    logForDebugging(`LSP diagnostics: dedup removed ${before - afterDedup}`)
  }

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

export function clearDeliveredDiagnosticsForFile(fileUriOrPath: string): void {
  const plain = foldDriveCase(fileUriOrPath.startsWith('file://') ? fileUriOrPath.slice('file://'.length) : fileUriOrPath)
  for (const key of [plain, `file://${plain}`]) {
    if (delivered.has(key)) {
      delivered.delete(key)
      logForDebugging(`LSP diagnostics: cleared delivered set for ${key}`)
    }
  }
}

export function clearAllLSPDiagnostics(): void {
  logForDebugging(`LSP diagnostics: clearing ${pending.size} pending entries`)
  pending.clear()
}

export function resetAllLSPDiagnosticState(): void {
  logForDebugging(`LSP diagnostics: reset (${pending.size} pending, ${delivered.size} tracked files)`)
  pending.clear()
  delivered.clear()
  lastReports.clear()
  writeBaselines.clear()
}

export function getPendingLSPDiagnosticCount(): number {
  return pending.size
}
