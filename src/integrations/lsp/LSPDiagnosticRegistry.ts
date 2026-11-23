import { randomUUID } from 'node:crypto'
import { resolve } from 'node:path'

import { structuredPatch } from 'diff'
import { LRUCache } from 'lru-cache'

import { logForDebugging } from '../../platform/logs/debugLog.js'
import type { Diagnostic, DiagnosticFile } from './diagnosticTracking.js'
import { MAIN_LANE, parseOwnerKey, type OwnerKey } from '../../engine/run-owner/ownerKey.js'


type Lane = OwnerKey | null

type PendingLSPDiagnostic = {
  serverName: string
  files: DiagnosticFile[]
  timestamp: number
  attachmentSent: boolean
  owner: Lane
}

type PublishListener = (event: { serverName: string; files: DiagnosticFile[] }) => void

const MAX_PER_FILE = 10
const MAX_TOTAL = 30
const MAX_TRACKED_FILES = 500
const MAX_WRITE_BASELINES = 256
const MAX_BASELINE_TEXT_CHARS = 10_000_000
const BASELINE_DIFF_TIMEOUT_MS = 5_000
const MAX_ROOT_CLAIMS = 64
const AWAITING_WRITE_MAX_AGE_MS = 60_000
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
const delivered = new LRUCache<string, Map<string, Set<string>>>({ max: MAX_TRACKED_FILES })

type AwaitingWrite = { owner: Lane; docVersion: number | undefined; at: number }

const awaitingWrites = new Map<string, AwaitingWrite>()

function laneOf(owner: OwnerKey | undefined): Lane {
  if (owner === undefined) return null
  try {
    return parseOwnerKey(owner).lane === MAIN_LANE ? null : owner
  } catch {
    return owner
  }
}

const laneKey = (lane: Lane): string => lane ?? ''

const writers = new LRUCache<string, OwnerKey>({ max: MAX_TRACKED_FILES })
const roots = new Map<OwnerKey, string>()
const ended = new Set<OwnerKey>()

function normaliseRoot(root: string): string {
  const folded = foldDriveCase(resolve(root))
  return folded.length > 1 && /[\\/]$/.test(folded) ? folded.slice(0, -1) : folded
}

function underRoot(fileKey: string, root: string): boolean {
  return fileKey === root || fileKey.startsWith(root + '/') || fileKey.startsWith(root + '\\')
}

function laneForFile(fileKey: string): Lane | 'sunk' {
  const writer = writers.peek(fileKey)
  if (writer !== undefined) return ended.has(writer) ? 'sunk' : writer
  for (const [owner, root] of roots) {
    if (underRoot(fileKey, root)) return ended.has(owner) ? 'sunk' : owner
  }
  return null
}

function claimWriter(lane: Lane, fileKey: string): void {
  if (lane === null) {
    writers.delete(fileKey)
    return
  }
  writers.set(fileKey, lane)
  ended.delete(lane)
}

export function claimDiagnosticsRoot(owner: OwnerKey, root: string): void {
  const lane = laneOf(owner)
  if (lane === null) return
  roots.delete(lane)
  roots.set(lane, normaliseRoot(root))
  ended.delete(lane)
  boundRootClaims()
}

function boundRootClaims(): void {
  if (roots.size <= MAX_ROOT_CLAIMS) return
  for (const owner of roots.keys()) {
    if (!ended.has(owner)) continue
    roots.delete(owner)
    ended.delete(owner)
    if (roots.size <= MAX_ROOT_CLAIMS) return
  }
}

export function releaseDiagnosticsWriter(owner: OwnerKey, worktree?: string): void {
  const lane = laneOf(owner)
  if (lane === null) return
  const root = worktree !== undefined ? normaliseRoot(worktree) : roots.get(lane)
  let dropped = 0
  let handed = 0
  for (const [pendingId, entry] of pending) {
    if (entry.owner !== lane) continue
    const kept = root === undefined ? entry.files : entry.files.filter(file => !underRoot(plainPathKey(file.uri), root))
    dropped += entry.files.length - kept.length
    if (kept.length === 0) {
      pending.delete(pendingId)
      continue
    }
    entry.files = kept
    entry.owner = null
    handed += kept.length
  }
  for (const [fileKey, writer] of writers.entries()) if (writer === lane) writers.delete(fileKey)
  for (const [fileKey, entry] of awaitingWrites) if (entry.owner === lane) awaitingWrites.delete(fileKey)
  if (root !== undefined) {
    roots.delete(lane)
    roots.set(lane, root)
    ended.add(lane)
    boundRootClaims()
  } else {
    roots.delete(lane)
    ended.delete(lane)
  }
  logForDebugging(`LSP diagnostics: lane ${lane} handed back — ${dropped} worktree file publish${dropped === 1 ? '' : 'es'} dropped, ${handed} shared-tree file publish${handed === 1 ? '' : 'es'} returned to the main lane${root !== undefined ? ` (root ${root} sunk)` : ''}`)
}

function armAwaitingWrite(lane: Lane, fileKey: string, docVersion: number | undefined): void {
  awaitingWrites.delete(fileKey)
  awaitingWrites.set(fileKey, { owner: lane, docVersion, at: Date.now() })
  while (awaitingWrites.size > MAX_TRACKED_FILES) {
    const oldest = awaitingWrites.keys().next().value
    if (oldest === undefined) break
    awaitingWrites.delete(oldest)
  }
}

function settleAwaitingWrite(fileKey: string, version: number | undefined): void {
  const entry = awaitingWrites.get(fileKey)
  if (entry === undefined) return
  if (version !== undefined && entry.docVersion !== undefined && version <= entry.docVersion) return
  awaitingWrites.delete(fileKey)
}

export function writesAwaitingReport(owner?: OwnerKey): string[] {
  const lane = laneOf(owner)
  const now = Date.now()
  const paths: string[] = []
  for (const [fileKey, entry] of awaitingWrites) {
    if (now - entry.at > AWAITING_WRITE_MAX_AGE_MS) {
      awaitingWrites.delete(fileKey)
      continue
    }
    if (entry.owner === lane) paths.push(fileKey)
  }
  return paths
}

export function settleWritesAwaitingReport(owner: OwnerKey | undefined, paths: readonly string[]): void {
  const lane = laneOf(owner)
  for (const path of paths) {
    const fileKey = plainPathKey(path)
    if (awaitingWrites.get(fileKey)?.owner === lane) awaitingWrites.delete(fileKey)
  }
}

function diagnosticKey(diagnostic: Diagnostic): string {
  return JSON.stringify([
    diagnostic.message,
    diagnostic.severity,
    diagnostic.range,
    diagnostic.source || null,
    diagnostic.code || null,
  ])
}

export function registerPendingLSPDiagnostic({
  serverName,
  files,
  version,
}: {
  serverName: string
  files: DiagnosticFile[]
  version?: number
}): void {
  const nonStale = files.filter(file => !staleAgainstWriteBaseline(serverName, file.uri, version))
  if (nonStale.length < files.length) {
    logForDebugging(
      `LSP diagnostics: ${serverName} published document version ${version} for a file written since — no data until it publishes the written version`,
    )
  }
  if (nonStale.length === 0) return

  let sunkCount = 0
  const byLane = new Map<Lane, DiagnosticFile[]>()
  for (const file of nonStale) {
    const owner = laneForFile(plainPathKey(file.uri))
    if (owner === 'sunk') {
      sunkCount++
      continue
    }
    let group = byLane.get(owner)
    if (group === undefined) {
      group = []
      byLane.set(owner, group)
    }
    group.push(file)
  }

  if (sunkCount > 0) {
    logForDebugging(
      `LSP diagnostics: ${serverName} published for ${sunkCount} file${sunkCount === 1 ? '' : 's'} of a handed-back worktree — dropped`,
    )
  }

  if (byLane.size > 0) {
    const publishedKeys = new Set(nonStale.map(file => plainPathKey(file.uri)))
    for (const [id, entry] of pending) {
      if (entry.attachmentSent || entry.serverName !== serverName) continue
      const remaining = entry.files.filter(file => !publishedKeys.has(plainPathKey(file.uri)))
      if (remaining.length === entry.files.length) continue
      if (remaining.length === 0) pending.delete(id)
      else entry.files = remaining
    }

    const now = Date.now()
    for (const [owner, groupFiles] of byLane) {
      const id = randomUUID()
      pending.set(id, {
        serverName,
        files: groupFiles,
        timestamp: now,
        attachmentSent: false,
        owner,
      })
      const diagCount = groupFiles.reduce((sum, file) => sum + file.diagnostics.length, 0)
      logForDebugging(
        `LSP diagnostics: registered ${diagCount} from ${serverName} (${id}${owner !== null ? `, lane ${owner}` : ''})`,
      )
    }

    if (pending.size > MAX_PENDING_PUBLISHES) {
      let dropped = 0
      for (const id of pending.keys()) {
        if (pending.size <= MAX_PENDING_PUBLISHES) break
        pending.delete(id)
        dropped++
      }
      if (dropped > 0) {
        logForDebugging(
          `LSP diagnostics: pending table full — dropped ${dropped} oldest publish${dropped === 1 ? '' : 'es'}`,
        )
      }
    }
  }

  for (const listener of publishListeners) {
    try {
      listener({ serverName, files: nonStale })
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
  settleAwaitingWrite(plainPathKey(file.uri), version)
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

export function snapshotDiagnosticsBeforeWrite(path: string, before: string | null, after: string, docVersion: number | undefined, owner?: OwnerKey): void {
  const fileKey = plainPathKey(path)
  const lane = laneOf(owner)
  claimWriter(lane, fileKey)
  armAwaitingWrite(lane, fileKey, docVersion)
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

export function _pendingForTesting(): Array<{ serverName: string; uris: string[]; owner: OwnerKey | null }> {
  return [...pending.values()].filter(entry => !entry.attachmentSent).map(entry => ({ serverName: entry.serverName, uris: entry.files.map(file => file.uri), owner: entry.owner }))
}

export function _writerForTesting(path: string): OwnerKey | null {
  return writers.peek(plainPathKey(path)) ?? null
}

export function _publishListenerCountForTesting(): number {
  return publishListeners.size
}

function dedupe(files: DiagnosticFile[], lane: Lane): DiagnosticFile[] {
  const byFile = new Map<string, { file: DiagnosticFile; seen: Set<string>; kept: Diagnostic[] }>()
  for (const file of files) {
    const fileKey = foldFileKey(file.uri)
    let entry = byFile.get(fileKey)
    if (entry === undefined) {
      entry = { file, seen: new Set(), kept: [] }
      byFile.set(fileKey, entry)
    }
    const already = delivered.get(fileKey)?.get(laneKey(lane))
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

function recordDelivered(files: DiagnosticFile[], lane: Lane): void {
  for (const file of files) {
    for (const diagnostic of file.diagnostics) {
      try {
        const key = diagnosticKey(diagnostic)
        const fileKey = foldFileKey(file.uri)
        let lanes = delivered.get(fileKey)
        if (lanes === undefined) {
          lanes = new Map()
          delivered.set(fileKey, lanes)
        }
        let set = lanes.get(laneKey(lane))
        if (set === undefined) {
          set = new Set()
          lanes.set(laneKey(lane), set)
        }
        set.add(key)
      } catch (err) {
        logForDebugging(`LSP diagnostics: could not record delivered key: ${String(err).slice(0, 100)}`)
      }
    }
  }
}

function introducedSinceWrite(serverName: string, file: DiagnosticFile): DiagnosticFile {
  const baseline = writeBaselines.peek(plainPathKey(file.uri))?.get(serverName)
  if (baseline === undefined) return file
  try {
    const priorKeys = new Set<string>()
    for (const prior of baseline.report.file.diagnostics) {
      const remapped = remapThroughWrites(prior, baseline.steps)
      if (remapped === null) continue
      priorKeys.add(diagnosticKey(remapped))
    }
    const kept = file.diagnostics.filter(diag => !priorKeys.has(diagnosticKey(diag)))
    const removed = file.diagnostics.length - kept.length
    if (removed === 0) return file
    logForDebugging(
      `LSP diagnostics: ${file.uri}: ${removed} pre-existing before the write subtracted, ${kept.length} introduced by it`,
    )
    return { ...file, diagnostics: kept }
  } catch (err) {
    logForDebugging(
      `LSP diagnostics: baseline subtraction failed, delivering whole: ${String(err).slice(0, 100)}`,
    )
    return file
  }
}

function severityRank(severity: string): number {
  if (severity === 'Error') return 0
  if (severity === 'Warning') return 1
  if (severity === 'Info') return 2
  return 3
}

export function checkForLSPDiagnostics(
  owner?: OwnerKey,
): Array<{ serverName: string; files: DiagnosticFile[] }> {
  const lane = laneOf(owner)
  const gatheredIds: string[] = []
  const serverNames: string[] = []
  const seenServers = new Set<string>()
  const gatheredFiles: DiagnosticFile[] = []

  for (const [id, entry] of pending) {
    if (entry.attachmentSent || entry.owner !== lane) continue
    gatheredIds.push(id)
    if (!seenServers.has(entry.serverName)) {
      seenServers.add(entry.serverName)
      serverNames.push(entry.serverName)
    }
    for (const file of entry.files) {
      gatheredFiles.push(introducedSinceWrite(entry.serverName, file))
    }
  }

  if (gatheredIds.length === 0) return []

  const beforeDedupCount = gatheredFiles.reduce((sum, file) => sum + file.diagnostics.length, 0)
  let deduped: DiagnosticFile[]
  try {
    deduped = dedupe(gatheredFiles, lane)
  } catch (err) {
    logForDebugging(`LSP diagnostics: dedup failed, delivering undeduplicated: ${String(err)}`)
    deduped = gatheredFiles
  }
  const afterDedupCount = deduped.reduce((sum, file) => sum + file.diagnostics.length, 0)
  if (beforeDedupCount > afterDedupCount) {
    logForDebugging(`LSP diagnostics: dedup removed ${beforeDedupCount - afterDedupCount}`)
  }

  for (const id of gatheredIds) {
    const entry = pending.get(id)
    if (entry !== undefined) entry.attachmentSent = true
    pending.delete(id)
  }

  const cappedFiles: DiagnosticFile[] = []
  let totalKept = 0
  for (const file of deduped) {
    if (file.diagnostics.length === 0) continue
    const remainingBudget = MAX_TOTAL - totalKept
    if (remainingBudget <= 0) break
    const sorted = [...file.diagnostics].sort((a, b) => severityRank(a.severity) - severityRank(b.severity))
    const kept = sorted.slice(0, Math.min(MAX_PER_FILE, remainingBudget))
    if (kept.length > 0) {
      cappedFiles.push({ ...file, diagnostics: kept })
      totalKept += kept.length
    }
  }

  const truncated = afterDedupCount - totalKept
  if (truncated > 0) {
    logForDebugging(
      `LSP diagnostics: truncated ${truncated} (caps: ${MAX_PER_FILE} per file, ${MAX_TOTAL} total)`,
    )
  }

  if (cappedFiles.length === 0) {
    logForDebugging('LSP diagnostics: nothing survives dedup/capping')
    return []
  }

  recordDelivered(cappedFiles, lane)
  return [{ serverName: serverNames.join(', '), files: cappedFiles }]
}

export function clearDeliveredDiagnosticsForFile(fileUriOrPath: string): void {
  const plain = plainPathKey(fileUriOrPath)
  for (const key of [plain, `file://${plain}`]) {
    if (delivered.delete(key)) {
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
  writers.clear()
  roots.clear()
  ended.clear()
  awaitingWrites.clear()
}

export function getPendingLSPDiagnosticCount(): number {
  return pending.size
}
