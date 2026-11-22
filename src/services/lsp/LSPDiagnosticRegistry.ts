import { randomUUID } from 'node:crypto'
import { resolve } from 'node:path'

import { structuredPatch } from 'diff'
import { LRUCache } from 'lru-cache'

import { logForDebugging } from '../../utils/debug.js'
import type { Diagnostic, DiagnosticFile } from '../../utils/diagnosticTracking.js'
import { MAIN_LANE, parseOwnerKey, type OwnerKey } from '../../utils/run/ownerKey.js'
import { notBuilt, type Unbuilt } from '../../pi/holes.js'


type Lane = OwnerKey | null

type PendingLSPDiagnostic = Unbuilt

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
  return notBuilt('src/services/lsp/LSPDiagnosticRegistry.ts:156')
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

export function registerPendingLSPDiagnostic(arg0: {
  serverName: string
  files: DiagnosticFile[]
  version?: number
}): void {
  return notBuilt('src/services/lsp/LSPDiagnosticRegistry.ts:252')
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
  return notBuilt('src/services/lsp/LSPDiagnosticRegistry.ts:379')
}

export function noteOutOfBandWrite(path: string, versions: ReadonlyArray<{ serverName: string; docVersion: number }>): void {
  return notBuilt('src/services/lsp/LSPDiagnosticRegistry.ts:419')
}

export function _writeBaselineForTesting(path: string): Array<{ serverName: string; steps: number; docVersion: number | undefined }> {
  const baselines = writeBaselines.peek(plainPathKey(path))
  if (baselines === undefined) return []
  return [...baselines].map(([serverName, baseline]) => ({ serverName, steps: baseline.steps.length, docVersion: baseline.docVersion }))
}

export function _pendingForTesting(): Array<{ serverName: string; uris: string[]; owner: OwnerKey | null }> {
  return notBuilt('src/services/lsp/LSPDiagnosticRegistry.ts:447')
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

export function checkForLSPDiagnostics(owner?: OwnerKey): Array<{ serverName: string; files: DiagnosticFile[] }> {
  return notBuilt('src/services/lsp/LSPDiagnosticRegistry.ts:515')
}

export function clearDeliveredDiagnosticsForFile(fileUriOrPath: string): void {
  return notBuilt('src/services/lsp/LSPDiagnosticRegistry.ts:571')
}

export function clearAllLSPDiagnostics(): void {
  return notBuilt('src/services/lsp/LSPDiagnosticRegistry.ts:581')
}

export function resetAllLSPDiagnosticState(): void {
  return notBuilt('src/services/lsp/LSPDiagnosticRegistry.ts:586')
}

export function getPendingLSPDiagnosticCount(): number {
  return notBuilt('src/services/lsp/LSPDiagnosticRegistry.ts:598')
}
