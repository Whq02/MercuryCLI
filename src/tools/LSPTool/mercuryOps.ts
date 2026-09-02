// The twelve IDE-hands LSP operations behind runMercuryLspOp,
// sharing ONE drift-safe permissioned apply transaction.
//
// The transaction contract (proved by scripts/lsp/prove-lsp-apply-safety.ts):
//   · prepareApply: the ONLY success exit is a round whose ENTIRE touched
//     set was already synced into the snapshots BEFORE that round's request
//     — offsets are then provably computed against held text;
//   · applyPrepared: per-file authorization precedes the shared commit walk
//     (checkWritePermissionForTool before runVerbatimTextCommit — allow
//     writes; deny always refuses; ask writes only inside the write scope);
//   · the commit walk revalidates current bytes under locks (drift aborts
//     with nothing written), and post-write server sync + diagnostic
//     stabilization are AWAITED and bounded.

import type { Dirent } from 'node:fs'
import { mkdir, readdir, readFile, stat, unlink, writeFile } from 'node:fs/promises'
import { basename, dirname, extname, isAbsolute, relative, resolve } from 'node:path'
import { createHash } from 'node:crypto'
import { fileURLToPath, pathToFileURL } from 'node:url'

import type { ServerCapabilities } from 'vscode-languageserver-protocol'

import { runVerbatimTextCommit } from '../../services/changeTransaction/changeSetCommit.js'
import { canonicalPathKey } from '../../services/changeTransaction/changeSetPlan.js'
import {
  clearDeliveredDiagnosticsForFile,
  subscribeLSPDiagnosticPublish,
} from '../../services/lsp/LSPDiagnosticRegistry.js'
import { builtinImplementationInfo } from '../../services/lsp/builtinServers.js'
import type { LSPServerInstance } from '../../services/lsp/LSPServerInstance.js'
import type { LSPServerManager } from '../../services/lsp/LSPServerManager.js'
import {
  applyEditsToText,
  formatEditPreview,
  normalizeWorkspaceEdit,
  type LspRangeLike,
  type LspTextEditLike,
  type NormalizedFileEdits,
  type WorkspaceEditLike,
} from '../../services/lsp/workspaceEditApply.js'
import { noteRunEvent } from '../../services/run/runCoordinator.js'
import { ownerFromToolUseContext } from '../../services/run/resolveOwner.js'
import { buildDiffHunks } from '../../services/structure/transform.js'
import { renameWithWin32Retry } from '../../substrate/durablePublish.js'
import type { ToolUseContext } from '../../Tool.js'
import { logForDebugging } from '../../utils/debug.js'
import { logError } from '../../utils/log.js'
import {
  checkWritePermissionForTool,
  pathInAllowedWorkingPath,
} from '../../utils/permissions/filesystem.js'

// ── contract types ─────────────────────────────────────────────────────────

/** The fourteen bridge operations (contract data). */
export type MercuryLspOperation =
  | 'diagnostics'
  | 'rename'
  | 'codeActions'
  | 'switchSourceHeader'
  | 'typeDefinition'
  | 'serverStatus'
  | 'workspaceDiagnostics'
  | 'pathRename'
  | 'fixDiagnostic'
  | 'formatDocument'
  | 'formatRange'
  | 'organizeImports'
  | 'capabilities'
  | 'rawRequest'

/** The flat validated input (the tool's discriminated union collapses to
 *  this shape at the ops boundary). */
export type MercuryLspOpInput = {
  operation: MercuryLspOperation
  filePath: string
  line: number
  character: number
  endLine?: number
  endCharacter?: number
  newName?: string
  newPath?: string
  apply?: boolean
  actionId?: string
  actionIndex?: number
  paths?: string[]
  /** rawRequest: the LSP method + JSON-text params. */
  method?: string
  params?: string
}

/** The typed effect every op returns. changedPaths carry what was actually
 *  WRITTEN, never intent (the changedPaths-never-intent law). */
export type MercuryOpEffect = {
  outcome: 'succeeded' | 'failed' | 'no-change' | 'indeterminate'
  changedPaths: string[]
  evidence: string
  details?: Record<string, unknown>
}

type LspChangeViewFile = {
  file: string
  hunks: Array<{
    oldStart: number
    oldLines: number
    newStart: number
    newLines: number
    lines: string[]
  }>
  omittedHunks?: number
  changedLines: number
}

export type MercuryLspOpOutput = {
  result: string
  resultCount?: number
  fileCount?: number
  applied?: boolean
  effect: MercuryOpEffect
  changeView?: {
    state: 'proposed' | 'applied'
    action: string
    files: LspChangeViewFile[]
    refs: string[]
  }
}

type OpEnv = {
  input: MercuryLspOpInput
  absolutePath: string
  cwd: string
  manager: LSPServerManager
  tool: { name: string; getPath?: (input: unknown) => string | undefined }
  context: ToolUseContext
}

// ── constants (contract data) ──────────────────────────────────────────────

const MAX_LSP_FILE_BYTES = 10_000_000
const PREPARE_ROUNDS = 3
const WORKSPACE_DIAG_FILE_CAP = 50
const PATH_RENAME_FILE_CAP = 100
const SERVER_SYNC_DEADLINE_MS = 4_000
const STABILIZE_DEADLINE_MS = 3_000
const STABILIZE_QUIET_WINDOW_MS = 300
const IGNORED_WALK_DIRS = new Set(['node_modules', '.git', 'dist', '.build-tree'])

// ── shared plumbing ────────────────────────────────────────────────────────

/** file:// URIs become paths; the answer is cwd-relative unless it escapes
 *  upward, else the absolute form. */
export function displayPathFor(cwd: string, fileOrUri: string): string {
  const path = fileOrUri.startsWith('file://')
    ? fileURLToPath(fileOrUri)
    : fileOrUri
  const rel = relative(cwd, path)
  if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) return path
  return rel
}

function uriToFilePath(uri: string): string {
  if (uri.startsWith('file://')) return fileURLToPath(uri)
  return uri
}

/**
 * One target per document. A server can spell one file as two URIs — the
 * percent-encoded and the bare drive colon on Windows (file:///c%3A/… and
 * file:///c:/…), a differently-cased drive letter, two servers each naming
 * it their own way — and every spelling decodes to one path. The commit
 * core takes each canonical path exactly once (a repeated path chained the
 * in-process lock on itself and the apply never returned — FN-015 rank 5),
 * so the entries fold here, keyed by the same case-folded key the core
 * uses: the first spelling stands, the later entries' edits join it, and an
 * edit two spellings both carry (same range, same text) lands once.
 */
function foldFilesByPath(files: NormalizedFileEdits[]): NormalizedFileEdits[] {
  const byKey = new Map<string, NormalizedFileEdits>()
  for (const file of files) {
    const key = canonicalPathKey(uriToFilePath(file.uri))
    const prior = byKey.get(key)
    if (prior === undefined) {
      byKey.set(key, { uri: file.uri, edits: [...file.edits] })
      continue
    }
    for (const edit of file.edits) {
      const duplicate = prior.edits.some(
        held =>
          held.newText === edit.newText &&
          held.range.start.line === edit.range.start.line &&
          held.range.start.character === edit.range.start.character &&
          held.range.end.line === edit.range.end.line &&
          held.range.end.character === edit.range.end.character,
      )
      if (!duplicate) prior.edits.push(edit)
    }
  }
  return [...byKey.values()]
}

/** A JSON-RPC "this method does not exist here" class error. */
function isMethodNotFoundError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error)
  return /method not found|unhandled method|invalid request/i.test(message)
}

type LspWireDiagnostic = {
  range: LspRangeLike
  severity?: number
  message: string
  source?: string
  code?: string | number
}

const SEVERITY_LABELS: Record<number, string> = {
  1: 'error',
  2: 'warning',
  3: 'info',
  4: 'hint',
}

function severityLabel(severity: number | undefined): string {
  return SEVERITY_LABELS[severity ?? 1] ?? 'error'
}

function sortDiagnostics(items: LspWireDiagnostic[]): LspWireDiagnostic[] {
  return [...items].sort(
    (a, b) =>
      (a.severity ?? 1) - (b.severity ?? 1) ||
      a.range.start.line - b.range.start.line,
  )
}

function formatDiagnosticLine(display: string, diagnostic: LspWireDiagnostic): string {
  const label = severityLabel(diagnostic.severity)
  const line = diagnostic.range.start.line + 1
  const character = diagnostic.range.start.character + 1
  const code =
    diagnostic.code !== undefined && diagnostic.code !== null
      ? ` ${diagnostic.source ?? 'lsp'} ${String(diagnostic.code)}`
      : ''
  const firstMessageLine = diagnostic.message.split('\n')[0] ?? ''
  return `${label}: ${display}:${line}:${character}${code} ${firstMessageLine}`
}

function countBySeverity(items: LspWireDiagnostic[]): { errors: number; warnings: number } {
  let errors = 0
  let warnings = 0
  for (const item of items) {
    const severity = item.severity ?? 1
    if (severity === 1) errors++
    else if (severity === 2) warnings++
  }
  return { errors, warnings }
}

/**
 * Sync a file's CURRENT disk bytes to its language servers and return the
 * exact text synced: stat (size-capped), read utf8, didChange when the
 * document is open, else didOpen.
 */
async function syncFileFromDisk(manager: LSPServerManager, absolutePath: string): Promise<string> {
  const stats = await stat(absolutePath)
  if (stats.size > MAX_LSP_FILE_BYTES) {
    const megabytes = Math.ceil(stats.size / (1024 * 1024))
    throw new Error(`file too large for LSP analysis (${megabytes}MB exceeds 10MB limit)`)
  }
  const text = await readFile(absolutePath, 'utf8')
  if (manager.isFileOpen(absolutePath)) {
    await manager.changeFile(absolutePath, text)
  } else {
    await manager.openFile(absolutePath, text)
  }
  return text
}

// ── pull-diagnostics baselines ─────────────────────────────────────────────

type DiagnosticsBaseline = {
  /** `<serverName>#<generation>` — a restarted server owes a full report. */
  generationKey: string
  docVersion: number | undefined
  resultId: string | undefined
  items: LspWireDiagnostic[]
}

/** Module-scope, keyed by document URI. */
const diagnosticsBaselines = new Map<string, DiagnosticsBaseline>()

/** Manager restart sweeps call this (dynamic import from services/lsp). */
export function clearDiagnosticsBaselines(): void {
  diagnosticsBaselines.clear()
}

export type PullDiagnosticsOutcome =
  | {
      kind: 'fresh'
      items: LspWireDiagnostic[]
      docVersion: number | undefined
      /** Merge provenance: which claimants the items were PULLED from. */
      pulledFrom?: string[]
      /** Which push-only claimants contributed a PUBLISHED report (+age note). */
      pushed?: string[]
    }
  | {
      kind: 'unchanged'
      items: LspWireDiagnostic[]
      docVersion: number | undefined
      pulledFrom?: string[]
      pushed?: string[]
    }
  | { kind: 'unsupported' }
  | { kind: 'no-claimant' }
  | { kind: 'protocol-violation'; detail: string }

/**
 * The install remedy for an extension NO server claims — the honest half of
 * the no-claimant answer. `.py`/`.pyi` compose from the builtin python
 * probes' own reasons (they carry the exact install lines); other extensions
 * read the server catalogue's per-entry remedy; unknown extensions get the
 * operator seam. Wrapped so a probe failure degrades to the generic line,
 * never a broken diagnostics answer.
 */
function remedyForUnclaimedExtension(extension: string): string {
  try {
    if (extension === '.py' || extension === '.pyi') {
      const { probeBuiltinPyright } = require('../../services/lsp/pyrightLane.js') as typeof import('../../services/lsp/pyrightLane.js')
      const { probeRuff } = require('../../services/lsp/ruffLane.js') as typeof import('../../services/lsp/ruffLane.js')
      const reasons = [probeBuiltinPyright(), probeRuff()]
        .map(p => ('reason' in p ? p.reason : undefined))
        .filter((r): r is string => r !== undefined && r.length > 0)
      if (reasons.length > 0) return `Arm the Python lanes: ${reasons.join(' — and: ')}`
    }
    const { SERVER_CATALOGUE } = require('../../services/lsp/serverCatalogue.js') as typeof import('../../services/lsp/serverCatalogue.js')
    const entries = SERVER_CATALOGUE.filter(e => extension in e.extensionToLanguage)
    if (entries.length > 0) {
      return `Install ${entries.map(e => `${e.label} (${e.remedy})`).join(' or ')}.`
    }
  } catch {
    /* the generic seam below is always true */
  }
  return `No built-in or catalogued server covers '${extension}' — add one via MERCURY_LSP_SERVERS or an extension that contributes a language server.`
}

/** Registry Diagnostic (named severities, path uris) → the wire shape the
 *  formatters read. */
function publishedToWire(diagnostic: {
  message: string
  severity: 'Error' | 'Warning' | 'Info' | 'Hint'
  range: LspRangeLike
  source?: string
  code?: string
}): LspWireDiagnostic {
  const severityNumber = { Error: 1, Warning: 2, Info: 3, Hint: 4 }[diagnostic.severity] ?? 1
  return {
    range: diagnostic.range,
    severity: severityNumber,
    message: diagnostic.message,
    ...(diagnostic.source !== undefined ? { source: diagnostic.source } : {}),
    ...(diagnostic.code !== undefined ? { code: diagnostic.code } : {}),
  }
}

/** Bounded harvest of push-only claimants' latest PUBLISHED reports for one
 *  file (pyright never implements pull — it publishes): the last-report
 *  ledger first (clean publishes recorded too), else a non-consuming
 *  subscription raced against the deadline. Never steals passive delivery. */
async function harvestPublishedReports(
  absolutePath: string,
  serverNames: string[],
  deadlineMs: number,
): Promise<Array<{ serverName: string; items: LspWireDiagnostic[]; ageMs: number }>> {
  if (serverNames.length === 0) return []
  const registry = await import('../../services/lsp/LSPDiagnosticRegistry.js')
  const abs = resolve(absolutePath)
  const collect = (): Array<{ serverName: string; items: LspWireDiagnostic[]; ageMs: number }> => {
    const out: Array<{ serverName: string; items: LspWireDiagnostic[]; ageMs: number }> = []
    for (const name of serverNames) {
      const report = registry.peekLastPublishedReport(name, abs)
      if (report) {
        out.push({
          serverName: name,
          items: report.file.diagnostics.map(publishedToWire),
          ageMs: Date.now() - report.at,
        })
      }
    }
    return out
  }
  const immediate = collect()
  if (immediate.length === serverNames.length) return immediate
  return await new Promise(resolvePromise => {
    const finish = (): void => {
      clearTimeout(timer)
      unsubscribe()
      resolvePromise(collect())
    }
    const timer = setTimeout(finish, deadlineMs)
    const unsubscribe = registry.subscribePublishedReports(event => {
      if (!serverNames.includes(event.serverName)) return
      const plain = event.file.uri.startsWith('file://')
        ? event.file.uri.slice('file://'.length)
        : event.file.uri
      if (plain !== abs) return
      if (collect().length === serverNames.length) finish()
    })
  })
}

/**
 * The per-file diagnostics report, merged across EVERY claimant: pull-capable
 * servers (ruff) answer textDocument/diagnostic with baseline discipline —
 * the previousResultId rides ONLY on a same-generation same-version baseline
 * that has a resultId; a server answering 'unchanged' without that is a
 * protocol violation reported honestly, never a fabricated clean. Push-only
 * claimants (pyright — no diagnosticProvider by design) contribute their
 * latest PUBLISHED report via the bounded harvest, so ".py diagnostics"
 * means pyright's semantics AND ruff's lint in ONE answer instead of the
 * old primary-only shrug ("does not support pull diagnostics").
 */
async function pullFileDiagnostics(
  manager: LSPServerManager,
  absolutePath: string,
): Promise<PullDiagnosticsOutcome> {
  const claimants = manager.getServersForFile(absolutePath)
  if (claimants.length === 0) {
    // NO server claims this extension — a different truth from "the server
    // does not support pull diagnostics": nothing will arrive passively
    // either, and the honest answer names the install remedy.
    return { kind: 'no-claimant' }
  }
  const uri = pathToFileURL(resolve(absolutePath)).href
  const docVersion = manager.getDocumentVersion(absolutePath)
  const pulledItems: LspWireDiagnostic[] = []
  const pulledFrom: string[] = []
  const pushOnlyNames: string[] = []
  let anyFresh = false
  let violation: string | null = null
  for (const server of claimants) {
    if (server.state === 'stopped' || server.state === 'error') {
      try {
        await server.start()
      } catch {
        continue // a claimant that cannot start contributes nothing
      }
    }
    const capabilities = server.capabilities as ServerCapabilities | undefined
    if (!capabilities?.diagnosticProvider) {
      pushOnlyNames.push(server.name)
      continue
    }
    const generationKey = `${server.name}#${server.generation}`
    const baselineKey = `${server.name}::${uri}`
    const baseline = diagnosticsBaselines.get(baselineKey)
    const baselineUsable =
      baseline !== undefined &&
      baseline.generationKey === generationKey &&
      baseline.docVersion === docVersion &&
      baseline.resultId !== undefined
    const params: Record<string, unknown> = { textDocument: { uri } }
    if (baselineUsable) params.previousResultId = baseline.resultId
    let response: { kind?: string; resultId?: string; items?: LspWireDiagnostic[] } | undefined | null
    try {
      response = await server.sendRequest<{
        kind?: string
        resultId?: string
        items?: LspWireDiagnostic[]
      }>('textDocument/diagnostic', params)
    } catch (err) {
      // One claimant's pull failure never hides the others' report.
      logForDebugging(`lsp ops: pull from ${server.name} failed: ${String(err)}`)
      continue
    }
    if (response === undefined || response === null) continue
    if (response.kind === 'unchanged') {
      if (!baselineUsable) {
        violation = `${server.name} answered 'unchanged' without a baseline to be unchanged against (protocol violation)`
        continue
      }
      pulledItems.push(...baseline.items)
      pulledFrom.push(server.name)
      continue
    }
    const items = Array.isArray(response.items) ? response.items : []
    diagnosticsBaselines.set(baselineKey, {
      generationKey,
      docVersion,
      resultId: response.resultId,
      items,
    })
    pulledItems.push(...items)
    pulledFrom.push(server.name)
    anyFresh = true
  }
  // The push harvest: shorter when a pull already answered (the report only
  // completes), longer when push is the ONLY road (pyright cold analysis).
  const pushed = await harvestPublishedReports(
    absolutePath,
    pushOnlyNames,
    pulledFrom.length > 0 ? 1_500 : 5_000,
  )
  const pushedNames = pushed.map(p =>
    p.ageMs > 5_000 ? `${p.serverName} (${Math.round(p.ageMs / 1000)}s ago)` : p.serverName,
  )
  for (const p of pushed) pulledItems.push(...p.items)
  if (pulledFrom.length === 0 && pushed.length === 0) {
    if (violation) return { kind: 'protocol-violation', detail: violation }
    return { kind: 'unsupported' }
  }
  return {
    kind: anyFresh || pushed.length > 0 ? 'fresh' : 'unchanged',
    items: pulledItems,
    docVersion,
    ...(pulledFrom.length > 0 ? { pulledFrom } : {}),
    ...(pushedNames.length > 0 ? { pushed: pushedNames } : {}),
  }
}

// ── post-write server sync ─────────────────────────────────────────────────

/**
 * After a write lands on disk: re-arm passive-diagnostic delivery for the
 * file FIRST, then push the new text through the sequenced change→save
 * composite, bounded by a deadline. Failures/timeouts return honestly —
 * callers downgrade to INDETERMINATE (the bytes are on disk; the server's
 * view is the unknown).
 */
export async function syncServersAfterWrite(
  manager: LSPServerManager,
  absolutePath: string,
  newText: string,
  deadlineMs: number = SERVER_SYNC_DEADLINE_MS,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  clearDeliveredDiagnosticsForFile(absolutePath)
  let timer: NodeJS.Timeout | undefined
  try {
    await Promise.race([
      manager.changeAndSaveFile(absolutePath, newText),
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`server sync timed out after ${deadlineMs}ms`)),
          deadlineMs,
        )
      }),
    ])
    return { ok: true }
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    logForDebugging(`lsp ops: post-write server sync failed for ${absolutePath}: ${reason}`)
    return { ok: false, reason }
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

// ── post-edit diagnostic stabilization (the ONE barrier) ───────────────────

export type DiagnosticStabilization =
  | { state: 'fresh'; errors: number; warnings: number; total: number }
  | { state: 'unchanged'; errors: number; warnings: number; total: number }
  | { state: 'unsupported' }
  | { state: 'failed'; reason: string }
  | { state: 'timed-out'; waitedMs: number }

function uriMatchesFile(uri: string, absolutePath: string): boolean {
  return uri.endsWith(absolutePath) || uri.includes(absolutePath)
}

/**
 * Bounded post-edit diagnostic stabilization. Pull-capable claimants get one
 * pull raced against the deadline; push-only lanes observe the diagnostic
 * publish registry through a NON-consuming subscription and resolve when the
 * quiet window elapses. Bounded by construction — no sleeps beyond the
 * window and the deadline; never a fabricated clean.
 */
export async function awaitDiagnosticStabilization(
  manager: LSPServerManager,
  absolutePath: string,
  opts?: { deadlineMs?: number; quietWindowMs?: number },
): Promise<DiagnosticStabilization> {
  const deadlineMs = opts?.deadlineMs ?? STABILIZE_DEADLINE_MS
  const quietWindowMs = opts?.quietWindowMs ?? STABILIZE_QUIET_WINDOW_MS
  const server = manager.getServerForFile(absolutePath)
  if (!server) return { state: 'unsupported' }
  const capabilities = server.capabilities as ServerCapabilities | undefined

  if (capabilities?.diagnosticProvider) {
    // The pull lane: one round trip raced against the deadline.
    let timer: NodeJS.Timeout | undefined
    try {
      const outcome = await Promise.race([
        pullFileDiagnostics(manager, absolutePath),
        new Promise<'timeout'>(resolveRace => {
          timer = setTimeout(() => resolveRace('timeout'), deadlineMs)
        }),
      ])
      if (outcome === 'timeout') return { state: 'timed-out', waitedMs: deadlineMs }
      // no-claimant folds into 'unsupported' here deliberately: the
      // stabilization consumer only needs "nothing will arrive to await".
      if (outcome.kind === 'unsupported' || outcome.kind === 'no-claimant') return { state: 'unsupported' }
      if (outcome.kind === 'protocol-violation') return { state: 'failed', reason: outcome.detail }
      const { errors, warnings } = countBySeverity(outcome.items)
      return {
        state: outcome.kind === 'fresh' ? 'fresh' : 'unchanged',
        errors,
        warnings,
        total: outcome.items.length,
      }
    } catch (error) {
      return { state: 'failed', reason: error instanceof Error ? error.message : String(error) }
    } finally {
      if (timer !== undefined) clearTimeout(timer)
    }
  }

  // The push-only lane: a non-consuming subscription filtered to the file.
  return new Promise<DiagnosticStabilization>(resolvePromise => {
    let lastCounts: { errors: number; warnings: number; total: number } | undefined
    let quietTimer: NodeJS.Timeout | undefined
    let settled = false
    const finish = (outcome: DiagnosticStabilization): void => {
      if (settled) return
      settled = true
      if (quietTimer !== undefined) clearTimeout(quietTimer)
      clearTimeout(deadlineTimer)
      unsubscribe()
      resolvePromise(outcome)
    }
    const unsubscribe = subscribeLSPDiagnosticPublish(event => {
      const matched = event.files.filter(file => uriMatchesFile(file.uri, absolutePath))
      if (matched.length === 0) return
      let errors = 0
      let warnings = 0
      let total = 0
      for (const file of matched) {
        for (const diagnostic of file.diagnostics) {
          total++
          if (diagnostic.severity === 'Error') errors++
          else if (diagnostic.severity === 'Warning') warnings++
        }
      }
      lastCounts = { errors, warnings, total }
      if (quietTimer !== undefined) clearTimeout(quietTimer)
      quietTimer = setTimeout(() => {
        finish({ state: 'fresh', ...lastCounts! })
      }, quietWindowMs)
    })
    const deadlineTimer = setTimeout(() => {
      if (lastCounts !== undefined) finish({ state: 'fresh', ...lastCounts })
      else finish({ state: 'timed-out', waitedMs: deadlineMs })
    }, deadlineMs)
  })
}

// ── server status rows ─────────────────────────────────────────────────────

export type LspServerStatusRow = {
  name: string
  state: string
  generation: number
  restartCount: number
  lastError: string | null
  claimsFile: boolean
  implementation?: { source: string; version?: string }
  capabilities: {
    rename: boolean
    codeActions: boolean
    pullDiagnostics: boolean
    typeDefinition: boolean
    pathRename: boolean
    callHierarchy: boolean
  }
}

function statusRowsFor(manager: LSPServerManager, filePath?: string): LspServerStatusRow[] {
  const claimant = filePath ? manager.getServerForFile(filePath) : undefined
  const rows: LspServerStatusRow[] = []
  for (const server of manager.getAllServers().values()) {
    const capabilities = server.capabilities as ServerCapabilities | undefined
    const configSource = (server.config as { source?: string } | undefined)?.source
    const implementation =
      builtinImplementationInfo(server.name) ??
      (configSource === 'mercury-env' ? { source: 'operator-configured' } : undefined)
    rows.push({
      name: server.name,
      state: server.state,
      generation: server.generation,
      restartCount: server.restartCount,
      lastError: server.lastError ? server.lastError.message : null,
      claimsFile: claimant !== undefined && claimant.name === server.name,
      ...(implementation ? { implementation } : {}),
      capabilities: {
        rename: Boolean(capabilities?.renameProvider),
        codeActions: Boolean(capabilities?.codeActionProvider),
        pullDiagnostics: Boolean(capabilities?.diagnosticProvider),
        typeDefinition: Boolean(capabilities?.typeDefinitionProvider),
        pathRename: Boolean(
          (capabilities?.workspace as { fileOperations?: { willRename?: unknown } } | undefined)
            ?.fileOperations?.willRename,
        ),
        callHierarchy: Boolean(capabilities?.callHierarchyProvider),
      },
    })
  }
  return rows
}

/** The doctor consumes the SAME rows the model sees (no claimant column). */
export function lspServerStatusRows(manager: LSPServerManager): LspServerStatusRow[] {
  return statusRowsFor(manager)
}

// ── code-action identity ───────────────────────────────────────────────────

type WireCodeAction = {
  title: string
  kind?: string
  edit?: WorkspaceEditLike
  command?: unknown
  data?: unknown
}

function actionShape(action: WireCodeAction): 'edit' | 'command-only' | 'lazy' {
  if (action.edit) return 'edit'
  if (action.command) return 'command-only'
  return 'lazy'
}

/** Stable identity derived from what the action IS, never its position:
 *  `ca-` + the first 8 hex of sha256 over JSON [title, kind ?? '', shape]. */
export function actionIdentity(action: WireCodeAction): string {
  const material = JSON.stringify([action.title, action.kind ?? '', actionShape(action)])
  return `ca-${createHash('sha256').update(material).digest('hex').slice(0, 8)}`
}

// ── the shared apply transaction ───────────────────────────────────────────

type PreparedApply =
  | {
      ok: true
      files: NormalizedFileEdits[]
      /** absolute path → the exact text synced to the servers. */
      snapshots: Map<string, string>
    }
  | { ok: false; reason: string }

/**
 * Request → normalize → verify the touched set was synced BEFORE the
 * request; up to three rounds. A round that has to sync files after
 * requesting must loop again — its offsets were computed against unsynced
 * text (the audit-finding ordering).
 */
async function prepareApply(
  env: OpEnv,
  requestEdit: () => Promise<WorkspaceEditLike | null | undefined>,
): Promise<PreparedApply> {
  const snapshots = new Map<string, string>()
  for (let round = 0; round < PREPARE_ROUNDS; round++) {
    let edit: WorkspaceEditLike | null | undefined
    try {
      edit = await requestEdit()
    } catch (error) {
      return { ok: false, reason: error instanceof Error ? error.message : String(error) }
    }
    const normalized = normalizeWorkspaceEdit(edit)
    if (!normalized.ok) return { ok: false, reason: normalized.reason }
    const files = foldFilesByPath(normalized.files)
    const unsynced = files.filter(file => !snapshots.has(uriToFilePath(file.uri)))
    if (unsynced.length === 0) {
      return { ok: true, files, snapshots }
    }
    for (const file of unsynced) {
      const abs = uriToFilePath(file.uri)
      try {
        snapshots.set(abs, await syncFileFromDisk(env.manager, abs))
      } catch (error) {
        return {
          ok: false,
          reason: `could not sync ${displayPathFor(env.cwd, abs)}: ${error instanceof Error ? error.message : String(error)}`,
        }
      }
    }
  }
  return {
    ok: false,
    reason: `the edit did not stabilize after ${PREPARE_ROUNDS} rounds — the server kept widening the touched-file set; nothing was written`,
  }
}

function changeViewOf(
  operation: string,
  state: 'proposed' | 'applied',
  cwd: string,
  files: NormalizedFileEdits[],
  snapshots: Map<string, string>,
): MercuryLspOpOutput['changeView'] {
  const viewFiles: LspChangeViewFile[] = []
  for (const file of files) {
    const abs = uriToFilePath(file.uri)
    const snapshot = snapshots.get(abs)
    if (snapshot === undefined) continue
    const applied = applyEditsToText(snapshot, file.edits)
    if (!applied.ok) continue
    const display = displayPathFor(cwd, abs)
    const { hunks, omittedHunks } = buildDiffHunks(display, snapshot, applied.text)
    let changedLines = 0
    for (const hunk of hunks) {
      for (const line of hunk.lines) {
        if (line.startsWith('+') || line.startsWith('-')) changedLines++
      }
    }
    viewFiles.push({
      file: display,
      hunks,
      ...(omittedHunks > 0 ? { omittedHunks } : {}),
      changedLines,
    })
  }
  return { state, action: operation, files: viewFiles, refs: [] }
}

function previewOf(
  env: OpEnv,
  operation: string,
  files: NormalizedFileEdits[],
  snapshots: Map<string, string>,
  rerunHint: string,
): MercuryLspOpOutput {
  const preview = formatEditPreview(
    files,
    uri => snapshots.get(uriToFilePath(uri)),
    uri => displayPathFor(env.cwd, uriToFilePath(uri)),
  )
  const result = `${preview}\n\nPreview only — nothing written. ${rerunHint}`
  const totalEdits = files.reduce((sum, file) => sum + file.edits.length, 0)
  return {
    result,
    resultCount: totalEdits,
    fileCount: files.length,
    applied: false,
    effect: {
      outcome: 'succeeded',
      changedPaths: [],
      evidence: `previewed ${files.length} file(s), nothing written`,
      details: { preview: true },
    },
    changeView: changeViewOf(operation, 'proposed', env.cwd, files, snapshots),
  }
}

type AppliedOutcome = {
  output: MercuryLspOpOutput
  /** The exact absolute paths written (empty unless something landed). */
  writtenPaths: string[]
}

/**
 * The write phase of the transaction. Phase 0 per-file authorization,
 * phase 1 pure computation against the held snapshots, phase 2 the shared
 * journaled commit walk, phase 3 awaited bounded server sync, phase 4
 * diagnostic stabilization on the primary file.
 */
async function applyPrepared(
  env: OpEnv,
  operation: string,
  files: NormalizedFileEdits[],
  snapshots: Map<string, string>,
  resultPrefix = '',
): Promise<AppliedOutcome> {
  const permissionContext = env.context.getAppState().toolPermissionContext

  // Phase 0 — authorization, before anything else. Allow writes; deny
  // always refuses; ask writes ONLY inside the write scope (the harness
  // already resolved the Edit-class prompt before call(); this raw
  // re-check is a backstop that must not kill an approved apply — and a
  // server can never ride one approval outside the scope).
  const refusals: string[] = []
  for (const file of files) {
    const abs = uriToFilePath(file.uri)
    const decision = checkWritePermissionForTool(
      env.tool,
      { ...env.input, filePath: abs },
      permissionContext,
    ) as { behavior: string; message?: string }
    const display = displayPathFor(env.cwd, abs)
    if (decision.behavior === 'deny') {
      refusals.push(`${display}: blocked by a permission deny rule`)
      continue
    }
    if (decision.behavior !== 'allow' && !pathInAllowedWorkingPath(abs, permissionContext)) {
      refusals.push(
        `${display}: outside the session's working directories — a server edit can never ride one approval outside the scope`,
      )
    }
  }
  if (refusals.length > 0) {
    const result =
      `Apply refused — nothing written:\n${refusals.map(line => `  ${line}`).join('\n')}\n` +
      `Add a directory to the session with /add-dir to bring an out-of-scope file into the write scope.`
    return {
      output: {
        result,
        resultCount: 0,
        fileCount: 0,
        applied: false,
        effect: {
          outcome: 'failed',
          changedPaths: [],
          evidence: `refused ${refusals.length} file(s), nothing written`,
        },
      },
      writtenPaths: [],
    }
  }

  // Phase 1 — compute every new text against the held snapshots.
  const planned: Array<{ abs: string; originalText: string; newText: string; editCount: number }> =
    []
  for (const file of files) {
    const abs = uriToFilePath(file.uri)
    const snapshot = snapshots.get(abs)
    if (snapshot === undefined) {
      return {
        output: {
          result: `Apply aborted: no held snapshot for ${displayPathFor(env.cwd, abs)}; nothing was written.`,
          resultCount: 0,
          fileCount: 0,
          applied: false,
          effect: {
            outcome: 'failed',
            changedPaths: [],
            evidence: 'missing snapshot — nothing written',
          },
        },
        writtenPaths: [],
      }
    }
    const applied = applyEditsToText(snapshot, file.edits)
    if (!applied.ok) {
      return {
        output: {
          result: `Apply aborted: ${applied.reason}; nothing was written.`,
          resultCount: 0,
          fileCount: 0,
          applied: false,
          effect: {
            outcome: 'failed',
            changedPaths: [],
            evidence: 'edit application failed — nothing written',
          },
        },
        writtenPaths: [],
      }
    }
    planned.push({ abs, originalText: snapshot, newText: applied.text, editCount: applied.editCount })
  }

  // Phase 2 — ONE journaled commit walk over the exact planned bytes.
  const owner = ownerFromToolUseContext(env.context)
  const signal = env.context.abortController?.signal
  const commit = await runVerbatimTextCommit({
    ownerKey: owner,
    source: 'lsp',
    files: planned.map(p => ({
      canonicalPath: p.abs,
      originalText: p.originalText,
      plannedText: p.newText,
    })),
    ...(signal !== undefined ? { signal } : {}),
  })
  if (commit.kind === 'stale') {
    const first = commit.stalePaths[0] ?? planned[0]!.abs
    return {
      output: {
        result: `Apply aborted: disk drift detected at ${displayPathFor(env.cwd, first)} — the file changed after the edit was computed; nothing was written. Re-run the operation against the current contents.`,
        resultCount: 0,
        fileCount: 0,
        applied: false,
        effect: {
          outcome: 'failed',
          changedPaths: [],
          evidence: 'drift abort — nothing written',
        },
      },
      writtenPaths: [],
    }
  }
  if (commit.kind === 'cancelled' || commit.kind === 'in-flight') {
    return {
      output: {
        result: `Apply aborted before commit (${commit.kind}); nothing was written.`,
        resultCount: 0,
        fileCount: 0,
        applied: false,
        effect: {
          outcome: 'failed',
          changedPaths: [],
          evidence: `aborted before commit (${commit.kind})`,
        },
      },
      writtenPaths: [],
    }
  }
  if (commit.kind === 'failed-restored') {
    logError(new Error(`lsp apply failed-restored: ${commit.reason}`))
    return {
      output: {
        result: `Apply FAILED: ${commit.reason}. The original contents were restored and verified by reread; nothing remains changed.`,
        resultCount: 0,
        fileCount: 0,
        applied: false,
        effect: {
          outcome: 'failed',
          changedPaths: [],
          evidence: 'commit failed; originals restored + verified by reread',
        },
      },
      writtenPaths: [],
    }
  }
  if (commit.kind === 'indeterminate') {
    const diverged = commit.divergedPaths.map(p => displayPathFor(env.cwd, p)).join(', ')
    const landed = commit.landedPaths.map(p => displayPathFor(env.cwd, p)).join(', ')
    return {
      output: {
        result:
          `Apply INDETERMINATE: ${commit.reason}. Diverged: ${diverged || '(none listed)'}; landed: ${landed || '(none)'}. ` +
          `Re-read these files before relying on their contents.`,
        resultCount: commit.landedPaths.length,
        fileCount: commit.landedPaths.length,
        applied: commit.landedPaths.length > 0,
        effect: {
          outcome: 'indeterminate',
          changedPaths: commit.landedPaths,
          evidence: 'commit indeterminate — re-read before relying',
        },
      },
      writtenPaths: commit.landedPaths,
    }
  }

  // committed (or replayed): the writes are on disk.
  const written = planned
  const writtenPaths = written.map(w => w.abs)

  // Phase 3 — awaited, bounded post-write server sync per written file.
  const manager = env.manager
  const syncFailures: string[] = []
  for (const w of written) {
    const sync = await syncServersAfterWrite(manager, w.abs, w.newText)
    if (!sync.ok) syncFailures.push(`${displayPathFor(env.cwd, w.abs)}: ${sync.reason}`)
  }
  // Phase 4 — diagnostic stabilization on the primary file. It runs on
  // EVERY apply outcome, sync failures included; the verdict
  // feeds a best-effort ide-feedback run event.
  const primary = written[0]!.abs
  const stabilization = await awaitDiagnosticStabilization(manager, primary)
  try {
    const feedbackState =
      stabilization.state === 'fresh' || stabilization.state === 'unchanged'
        ? stabilization.errors > 0
          ? 'dirty'
          : 'clean'
        : 'unknown'
    const detail =
      stabilization.state === 'fresh' || stabilization.state === 'unchanged'
        ? `${stabilization.errors} error(s), ${stabilization.warnings} warning(s) after ${operation}`
        : `post-apply diagnostics ${stabilization.state}`
    noteRunEvent(owner, { type: 'ide-feedback', at: Date.now(), state: feedbackState, detail })
  } catch {
    // The run-event note is observability, never control flow.
  }
  const stabilizationNote =
    stabilization.state === 'fresh' || stabilization.state === 'unchanged'
      ? `Post-apply diagnostics: ${stabilization.errors} error(s), ${stabilization.warnings} warning(s).`
      : `post-apply diagnostics ${stabilization.state} — verify the change with a real check.`
  const totalEdits = written.reduce((sum, w) => sum + w.editCount, 0)

  if (syncFailures.length > 0) {
    return {
      output: {
        result:
          `${resultPrefix}Applied, but the language-server sync did not confirm: ${syncFailures.join('; ')}. ` +
          `The files ARE written; the language servers' view is unconfirmed — diagnostics may lag until the next edit.\n${stabilizationNote}`,
        resultCount: totalEdits,
        fileCount: written.length,
        applied: true,
        effect: {
          outcome: 'indeterminate',
          changedPaths: written.map(w => w.abs),
          evidence: 'writes landed; server sync unconfirmed',
          details: { stabilization: stabilization.state },
        },
        changeView: changeViewOf(operation, 'applied', env.cwd, files, snapshots),
      },
      writtenPaths,
    }
  }

  const fileLines = written
    .map(w => `  ${displayPathFor(env.cwd, w.abs)} (${w.editCount})`)
    .join('\n')
  return {
    output: {
      result: `${resultPrefix}Applied ${totalEdits} edit(s) across ${written.length} file(s):\n${fileLines}\n${stabilizationNote}`,
      resultCount: totalEdits,
      fileCount: written.length,
      applied: true,
      effect: {
        outcome: 'succeeded',
        changedPaths: written.map(w => w.abs),
        evidence: `${totalEdits} edit(s) written + servers synced`,
        details: { stabilization: stabilization.state },
      },
      changeView: changeViewOf(operation, 'applied', env.cwd, files, snapshots),
    },
    writtenPaths,
  }
}

// ── operations ─────────────────────────────────────────────────────────────

async function opDiagnostics(env: OpEnv): Promise<MercuryLspOpOutput> {
  const display = displayPathFor(env.cwd, env.absolutePath)
  await syncFileFromDisk(env.manager, env.absolutePath)
  const pulled = await pullFileDiagnostics(env.manager, env.absolutePath)
  if (pulled.kind === 'no-claimant') {
    // The old answer claimed "the language server … does not support pull
    // diagnostics" here — but there IS no server, and nothing will arrive
    // passively either. Say the true thing, with the install remedy.
    const extension = extname(env.absolutePath).toLowerCase()
    return {
      result:
        `No language server claims ${display} (extension '${extension}') in this session — ` +
        `there are no diagnostics to pull, and none will arrive passively. ` +
        remedyForUnclaimedExtension(extension),
      resultCount: 0,
      fileCount: 0,
      effect: {
        outcome: 'no-change',
        changedPaths: [],
        evidence: `no language server claims '${extension}'`,
      },
    }
  }
  if (pulled.kind === 'unsupported') {
    return {
      result:
        `The language server(s) for ${display} support neither pull diagnostics nor delivered a published report within the wait. ` +
        `Push-only servers publish after opens/edits — edit the file or re-run diagnostics; passive delivery also carries their reports.`,
      resultCount: 0,
      fileCount: 0,
      effect: {
        outcome: 'no-change',
        changedPaths: [],
        evidence: 'no pull capability and no published report',
      },
    }
  }
  if (pulled.kind === 'protocol-violation') {
    return {
      result: `Diagnostics are indeterminate for ${display}: ${pulled.detail} — cannot claim clean; re-run diagnostics after the next edit.`,
      resultCount: 0,
      fileCount: 0,
      effect: {
        outcome: 'indeterminate',
        changedPaths: [],
        evidence: 'diagnostic protocol violation — indeterminate',
      },
    }
  }
  // Merge provenance: which claimants were pulled, which contributed a
  // published report (pyright's road — it never implements pull).
  const sourceNote = [
    ...(pulled.pulledFrom && pulled.pulledFrom.length > 0 ? [`pulled: ${pulled.pulledFrom.join(', ')}`] : []),
    ...(pulled.pushed && pulled.pushed.length > 0 ? [`published: ${pulled.pushed.join(', ')}`] : []),
  ].join(' · ')
  const provenance =
    (pulled.kind === 'fresh'
      ? `[fresh report (document version ${pulled.docVersion ?? 'unknown'})`
      : `[unchanged — server re-affirmed the last report (document version ${pulled.docVersion ?? 'unknown'})`) +
    (sourceNote ? ` — ${sourceNote}]` : ']')
  if (pulled.items.length === 0) {
    return {
      result: `No diagnostics — ${display} is clean. ${provenance}`,
      resultCount: 0,
      fileCount: 0,
      effect: {
        outcome: 'succeeded',
        changedPaths: [],
        evidence: `clean ${provenance}`,
      },
    }
  }
  const sorted = sortDiagnostics(pulled.items)
  const { errors, warnings } = countBySeverity(sorted)
  const lines = sorted.map(item => `  ${formatDiagnosticLine(display, item)}`).join('\n')
  return {
    result: `${sorted.length} diagnostics (${errors} errors, ${warnings} warnings) ${provenance}:\n${lines}`,
    resultCount: sorted.length,
    fileCount: 1,
    effect: {
      outcome: 'succeeded',
      changedPaths: [],
      evidence: `${errors} error(s), ${warnings} warning(s) ${provenance}`,
    },
  }
}

async function opSwitchSourceHeader(env: OpEnv): Promise<MercuryLspOpOutput> {
  const display = displayPathFor(env.cwd, env.absolutePath)
  const claimant = env.manager.getServerForFile(env.absolutePath)
  if (!claimant) {
    const extension = extname(env.absolutePath) || basename(env.absolutePath)
    return {
      result:
        `No language server claims ${extension} files, so switchSourceHeader is unavailable for ${display}. ` +
        `The C/C++ lane (mercury-clangd) provides it when a workspace clangd is present and MERCURY_LSP_CPP is not disabled.`,
      resultCount: 0,
      fileCount: 0,
      effect: {
        outcome: 'failed',
        changedPaths: [],
        evidence: 'no claimant for the C/C++ lane',
      },
    }
  }
  await syncFileFromDisk(env.manager, env.absolutePath)
  const uri = pathToFileURL(resolve(env.absolutePath)).href
  let response: string | null | undefined
  try {
    response = await env.manager.sendRequest<string | null>(
      env.absolutePath,
      'textDocument/switchSourceHeader',
      { uri },
    )
  } catch (error) {
    if (isMethodNotFoundError(error)) {
      return {
        result: `The ${claimant.name} server does not support switchSourceHeader (the request is a clangd extension).`,
        resultCount: 0,
        fileCount: 0,
        effect: {
          outcome: 'no-change',
          changedPaths: [],
          evidence: 'server does not support switchSourceHeader',
        },
      }
    }
    throw error
  }
  if (!response) {
    return {
      result:
        `No source/header counterpart found for ${display}. ` +
        `A compile_commands.json in the workspace usually lets clangd resolve counterparts across directories.`,
      resultCount: 0,
      fileCount: 0,
      effect: {
        outcome: 'no-change',
        changedPaths: [],
        evidence: 'no counterpart (a real answer)',
      },
    }
  }
  return {
    result: `Counterpart: ${displayPathFor(env.cwd, response)}`,
    resultCount: 1,
    fileCount: 1,
    effect: {
      outcome: 'succeeded',
      changedPaths: [],
      evidence: 'counterpart resolved',
    },
  }
}

async function opRename(env: OpEnv): Promise<MercuryLspOpOutput> {
  const input = env.input
  const newName = input.newName ?? ''
  if (newName === '' || /\s/.test(newName)) {
    return {
      result: `Rename failed: newName must be a non-empty identifier without whitespace (got ${JSON.stringify(newName)}).`,
      resultCount: 0,
      fileCount: 0,
      effect: {
        outcome: 'failed',
        changedPaths: [],
        evidence: 'invalid newName',
      },
    }
  }
  await syncFileFromDisk(env.manager, env.absolutePath)
  const uri = pathToFileURL(resolve(env.absolutePath)).href
  const position = { line: (input.line ?? 1) - 1, character: (input.character ?? 1) - 1 }
  const requestEdit = (): Promise<WorkspaceEditLike | null | undefined> =>
    env.manager.sendRequest<WorkspaceEditLike | null>(env.absolutePath, 'textDocument/rename', {
      textDocument: { uri },
      position,
      newName,
    })
  const prepared = await prepareApply(env, requestEdit)
  if (!prepared.ok) {
    return {
      result: `Rename failed: ${prepared.reason}`,
      resultCount: 0,
      fileCount: 0,
      applied: false,
      effect: {
        outcome: 'failed',
        changedPaths: [],
        evidence: 'rename preparation failed — nothing written',
      },
    }
  }
  if (input.apply !== true) {
    return previewOf(
      env,
      'rename',
      prepared.files,
      prepared.snapshots,
      `Re-run with apply: true to write the rename.`,
    )
  }
  const applied = await applyPrepared(env, 'rename', prepared.files, prepared.snapshots)
  return applied.output
}

// The transaction's requester for code actions: RE-FETCH the list each
// round, match by title+kind, and re-resolve — so offsets always come from
// held snapshots.
async function fetchCodeActions(
  env: OpEnv,
  range: LspRangeLike,
  contextDiagnostics: LspWireDiagnostic[],
  only?: string[],
): Promise<WireCodeAction[]> {
  const uri = pathToFileURL(resolve(env.absolutePath)).href
  const response = await env.manager.sendRequest<Array<WireCodeAction | null> | null>(
    env.absolutePath,
    'textDocument/codeAction',
    {
      textDocument: { uri },
      range,
      context: {
        diagnostics: contextDiagnostics,
        ...(only !== undefined ? { only } : {}),
      },
    },
  )
  if (!Array.isArray(response)) return []
  return response.filter(
    (action): action is WireCodeAction =>
      action !== null && typeof action === 'object' && typeof action.title === 'string',
  )
}

async function resolveActionEdit(
  env: OpEnv,
  action: WireCodeAction,
): Promise<{ edit?: WorkspaceEditLike; resolveFailure?: string }> {
  if (action.edit) return { edit: action.edit }
  const claimant = env.manager.getServerForFile(env.absolutePath)
  const capabilities = claimant?.capabilities as ServerCapabilities | undefined
  const resolveProvider = Boolean(
    (capabilities?.codeActionProvider as { resolveProvider?: boolean } | undefined)
      ?.resolveProvider,
  )
  if (!resolveProvider) return {}
  try {
    const resolved = await env.manager.sendRequest<WireCodeAction | null>(
      env.absolutePath,
      'codeAction/resolve',
      action,
    )
    return resolved?.edit ? { edit: resolved.edit } : {}
  } catch (error) {
    const failure = error instanceof Error ? error.message : String(error)
    logForDebugging(
      `lsp ops: codeAction/resolve failed for "${action.title}": ${failure}`,
    )
    return { resolveFailure: failure }
  }
}

function inputRange(input: MercuryLspOpInput): LspRangeLike {
  const start = { line: (input.line ?? 1) - 1, character: (input.character ?? 1) - 1 }
  const end = {
    line: (input.endLine ?? input.line ?? 1) - 1,
    character: (input.endCharacter ?? input.character ?? 1) - 1,
  }
  return { start, end }
}

/** Diagnostics target by LINE-range overlap (ends default to starts at
 *  the input seam) — character precision would produce false "nothing to
 *  fix" on same-line diagnostics. */
function lineRangesOverlap(a: LspRangeLike, b: LspRangeLike): boolean {
  return a.start.line <= b.end.line && a.end.line >= b.start.line
}

function formatActionRows(actions: WireCodeAction[]): string {
  return actions
    .map((action, index) => {
      const kind = action.kind ? ` (${action.kind})` : ''
      return `  [${index}] id:${actionIdentity(action)} ${action.title}${kind} — ${actionShape(action)}`
    })
    .join('\n')
}

const CODE_ACTION_RERUN_HINT =
  'Re-run with apply: true and actionId to apply one (actionIndex is the legacy positional selector).'

async function opCodeActions(env: OpEnv): Promise<MercuryLspOpOutput> {
  const input = env.input
  const display = displayPathFor(env.cwd, env.absolutePath)
  await syncFileFromDisk(env.manager, env.absolutePath)
  const range = inputRange(input)

  // Best-effort context diagnostics for the range.
  let contextDiagnostics: LspWireDiagnostic[] = []
  try {
    const pulled = await pullFileDiagnostics(env.manager, env.absolutePath)
    if (pulled.kind === 'fresh' || pulled.kind === 'unchanged') {
      contextDiagnostics = pulled.items.filter(item => lineRangesOverlap(item.range, range))
    }
  } catch (error) {
    logForDebugging(
      `lsp ops: context diagnostics pull failed (continuing without): ${error instanceof Error ? error.message : String(error)}`,
    )
  }

  const actions = await fetchCodeActions(env, range, contextDiagnostics)
  if (actions.length === 0) {
    return {
      result: `No code actions offered at ${display}:${input.line ?? 1}:${input.character ?? 1}.`,
      resultCount: 0,
      fileCount: 0,
      effect: {
        outcome: 'no-change',
        changedPaths: [],
        evidence: 'no actions offered',
      },
    }
  }

  if (input.apply !== true) {
    return {
      result: `${actions.length} code action(s) at ${display}:${input.line ?? 1}:${input.character ?? 1}:\n${formatActionRows(actions)}\n${CODE_ACTION_RERUN_HINT}`,
      resultCount: actions.length,
      fileCount: 1,
      effect: {
        outcome: 'succeeded',
        changedPaths: [],
        evidence: `${actions.length} action(s) listed`,
        details: { preview: true },
      },
    }
  }

  // Apply selection — identity against the FRESH list.
  let selected: WireCodeAction
  if (input.actionId !== undefined) {
    const matches = actions.filter(action => actionIdentity(action) === input.actionId)
    if (matches.length === 0) {
      return {
        result: `Apply refused: actionId ${input.actionId} is not in the current list — the offered actions changed since the listing. Current list:\n${formatActionRows(actions)}`,
        resultCount: 0,
        fileCount: 0,
        applied: false,
        effect: {
          outcome: 'failed',
          changedPaths: [],
          evidence: 'actionId vanished — list changed',
        },
      }
    }
    if (matches.length > 1) {
      return {
        result: `Apply refused: actionId ${input.actionId} matches ${matches.length} identical actions — the selection is ambiguous. Narrow the range and re-list.`,
        resultCount: 0,
        fileCount: 0,
        applied: false,
        effect: {
          outcome: 'failed',
          changedPaths: [],
          evidence: 'ambiguous actionId',
        },
      }
    }
    selected = matches[0]!
    if (input.actionIndex !== undefined) {
      const byIndex = actions[input.actionIndex]
      if (!byIndex || actionIdentity(byIndex) !== input.actionId) {
        return {
          result: `Apply refused: actionId ${input.actionId} and actionIndex ${input.actionIndex} name different actions in the current list. Re-list and pass ONE selector.`,
          resultCount: 0,
          fileCount: 0,
          applied: false,
          effect: {
            outcome: 'failed',
            changedPaths: [],
            evidence: 'actionId/actionIndex disagree',
          },
        }
      }
    }
  } else {
    if (
      input.actionIndex === undefined ||
      input.actionIndex < 0 ||
      input.actionIndex >= actions.length
    ) {
      return {
        result: `apply: true requires actionId (preferred) or actionIndex in [0, ${actions.length - 1}]. Current list:\n${formatActionRows(actions)}`,
        resultCount: 0,
        fileCount: 0,
        applied: false,
        effect: {
          outcome: 'failed',
          changedPaths: [],
          evidence: 'no valid selector',
        },
      }
    }
    selected = actions[input.actionIndex]!
  }

  const selectedResolution = await resolveActionEdit(env, selected)
  if (selectedResolution.resolveFailure !== undefined) {
    return {
      result: `Apply refused: resolving the edit for "${selected.title}" failed: ${selectedResolution.resolveFailure}. Re-list and retry.`,
      resultCount: 0,
      fileCount: 0,
      applied: false,
      effect: {
        outcome: 'failed',
        changedPaths: [],
        evidence: 'edit resolution failed — nothing written',
      },
    }
  }
  if (!selectedResolution.edit) {
    return {
      result: `Apply refused: "${selected.title}" carries no workspace edit (a command-only action). Mercury refuses command execution via LSP — apply an edit-shaped action or make the change directly.`,
      resultCount: 0,
      fileCount: 0,
      applied: false,
      effect: {
        outcome: 'failed',
        changedPaths: [],
        evidence: 'command-only action refused',
      },
    }
  }

  const selectedTitle = selected.title
  const selectedKind = selected.kind
  const requestEdit = async (): Promise<WorkspaceEditLike | null> => {
    const fresh = await fetchCodeActions(env, range, contextDiagnostics)
    const matches = fresh.filter(
      action => action.title === selectedTitle && (action.kind ?? '') === (selectedKind ?? ''),
    )
    if (matches.length > 1) {
      throw new Error(
        `the action "${selectedTitle}" appears ${matches.length} times in the refreshed list — ambiguous`,
      )
    }
    const match = matches[0]
    if (!match) return null
    return (await resolveActionEdit(env, match)).edit ?? null
  }
  const prepared = await prepareApply(env, requestEdit)
  if (!prepared.ok) {
    return {
      result: `Apply failed for "${selected.title}": ${prepared.reason}`,
      resultCount: 0,
      fileCount: 0,
      applied: false,
      effect: {
        outcome: 'failed',
        changedPaths: [],
        evidence: 'code-action preparation failed — nothing written',
      },
    }
  }
  const applied = await applyPrepared(
    env,
    'codeActions',
    prepared.files,
    prepared.snapshots,
    `"${selected.title}" (${actionIdentity(selected)})\n`,
  )
  return applied.output
}

async function opTypeDefinition(env: OpEnv): Promise<MercuryLspOpOutput> {
  const input = env.input
  const display = displayPathFor(env.cwd, env.absolutePath)
  await syncFileFromDisk(env.manager, env.absolutePath)
  const uri = pathToFileURL(resolve(env.absolutePath)).href
  type Location = { uri?: string; targetUri?: string; range?: LspRangeLike; targetRange?: LspRangeLike }
  let response: Location | Location[] | null | undefined
  try {
    response = await env.manager.sendRequest<Location | Location[] | null>(
      env.absolutePath,
      'textDocument/typeDefinition',
      {
        textDocument: { uri },
        position: { line: (input.line ?? 1) - 1, character: (input.character ?? 1) - 1 },
      },
    )
  } catch (error) {
    if (isMethodNotFoundError(error)) {
      return {
        result: `The language server for ${display} does not support typeDefinition.`,
        resultCount: 0,
        fileCount: 0,
        effect: {
          outcome: 'no-change',
          changedPaths: [],
          evidence: 'typeDefinition unsupported',
        },
      }
    }
    throw error
  }
  const list: Location[] =
    response === null || response === undefined
      ? []
      : Array.isArray(response)
        ? response
        : [response]
  if (list.length === 0) {
    return {
      result: `No type definition found at ${display}:${input.line ?? 1}:${input.character ?? 1}.`,
      resultCount: 0,
      fileCount: 0,
      effect: {
        outcome: 'no-change',
        changedPaths: [],
        evidence: 'no type definition (a real answer)',
      },
    }
  }
  const rows: string[] = []
  const displays = new Set<string>()
  for (const location of list) {
    const locationUri = location.targetUri ?? location.uri
    if (locationUri === undefined) continue
    const range = location.targetRange ?? location.range
    const locationDisplay = displayPathFor(env.cwd, locationUri)
    displays.add(locationDisplay)
    const line = (range?.start.line ?? 0) + 1
    const character = (range?.start.character ?? 0) + 1
    rows.push(`  ${locationDisplay}:${line}:${character}`)
  }
  return {
    result: `${rows.length} type definition(s):\n${rows.join('\n')}`,
    resultCount: rows.length,
    fileCount: displays.size,
    effect: {
      outcome: 'succeeded',
      changedPaths: [],
      evidence: `${rows.length} location(s)`,
    },
  }
}

async function opServerStatus(env: OpEnv): Promise<MercuryLspOpOutput> {
  const rows = statusRowsFor(env.manager, env.input.filePath ? env.absolutePath : undefined)
  if (rows.length === 0) {
    return {
      result: 'No LSP servers are configured for this workspace.',
      resultCount: 0,
      fileCount: 0,
      effect: {
        outcome: 'no-change',
        changedPaths: [],
        evidence: 'no servers configured',
      },
    }
  }
  const lines = rows.map(row => {
    const claims = row.claimsFile ? ' · claims this file' : ''
    const impl = row.implementation
      ? ` · impl: ${row.implementation.source}${row.implementation.version ? ` ${row.implementation.version}` : ''}`
      : ''
    const lastError = row.lastError ? ` · lastError: ${row.lastError.slice(0, 80)}` : ''
    const enabled = Object.entries(row.capabilities)
      .filter(([, on]) => on)
      .map(([name]) => name)
    const capabilitiesLine =
      row.state === 'running'
        ? `    capabilities: ${enabled.length > 0 ? enabled.join(', ') : '(none advertised)'}`
        : '    capabilities: (none until running)'
    return `${row.name} — ${row.state} (gen ${row.generation}, restarts ${row.restartCount})${claims}${impl}${lastError}\n${capabilitiesLine}`
  })
  return {
    result: lines.join('\n'),
    resultCount: rows.length,
    fileCount: 0,
    effect: {
      outcome: 'succeeded',
      changedPaths: [],
      evidence: `${rows.length} server row(s)`,
      details: { servers: rows },
    },
  }
}

async function opWorkspaceDiagnostics(env: OpEnv): Promise<MercuryLspOpOutput> {
  const paths = env.input.paths ?? []
  const included: string[] = []
  const skipped: string[] = []
  let truncated = false

  const includeFile = (abs: string): void => {
    if (included.length >= WORKSPACE_DIAG_FILE_CAP) {
      truncated = true
      return
    }
    if (env.manager.getServerForFile(abs)) included.push(abs)
    else skipped.push(abs)
  }

  const walkDirectory = async (dir: string): Promise<void> => {
    if (truncated) return
    let entries: Dirent[]
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch {
      skipped.push(dir)
      return
    }
    // Locale-aware sibling order; entry types come from the LISTING records
    // themselves — a symbolic link is neither file nor directory and is
    // never entered, so link cycles cannot recurse. The ignore
    // set prunes DIRECTORIES only.
    entries.sort((a, b) => a.name.localeCompare(b.name))
    const files: string[] = []
    const subdirectories: string[] = []
    for (const entry of entries) {
      const child = resolve(dir, entry.name)
      if (entry.isDirectory()) {
        if (IGNORED_WALK_DIRS.has(entry.name)) continue
        subdirectories.push(child)
      } else if (entry.isFile()) {
        files.push(child)
      }
    }
    for (const file of files) {
      if (truncated) return
      includeFile(file)
    }
    for (const subdirectory of subdirectories) {
      if (truncated) return
      await walkDirectory(subdirectory)
    }
  }

  for (const raw of paths) {
    if (truncated) break
    const abs = resolve(env.cwd, raw)
    let stats
    try {
      stats = await stat(abs)
    } catch {
      skipped.push(abs)
      continue
    }
    if (stats.isDirectory()) await walkDirectory(abs)
    else includeFile(abs)
  }

  if (included.length === 0) {
    const shown = skipped.slice(0, 5).map(p => displayPathFor(env.cwd, p))
    const more = skipped.length > 5 ? ` (+${skipped.length - 5} more)` : ''
    return {
      result: `No claimed files to check — every path was unclaimed or unreadable: ${shown.join(', ')}${more}`,
      resultCount: 0,
      fileCount: 0,
      effect: {
        outcome: 'no-change',
        changedPaths: [],
        evidence: 'no claimed files',
        details: { skipped: skipped.length },
      },
    }
  }

  let errors = 0
  let warnings = 0
  let totalDiagnostics = 0
  let filesWithFindings = 0
  let indeterminate = 0
  const lines: string[] = []
  for (const abs of included) {
    const display = displayPathFor(env.cwd, abs)
    try {
      await syncFileFromDisk(env.manager, abs)
      const pulled = await pullFileDiagnostics(env.manager, abs)
      if (pulled.kind === 'fresh' || pulled.kind === 'unchanged') {
        if (pulled.items.length > 0) {
          filesWithFindings++
          const counts = countBySeverity(pulled.items)
          errors += counts.errors
          warnings += counts.warnings
          totalDiagnostics += pulled.items.length
          for (const item of sortDiagnostics(pulled.items)) {
            lines.push(`  ${formatDiagnosticLine(display, item)}`)
          }
        }
      } else if (pulled.kind === 'unsupported') {
        indeterminate++
        lines.push(`  indeterminate: ${display} — pull diagnostics unsupported`)
      } else if (pulled.kind === 'no-claimant') {
        indeterminate++
        lines.push(`  indeterminate: ${display} — no language server claims this extension (nothing to pull)`)
      } else {
        indeterminate++
        lines.push(`  indeterminate: ${display} — ${pulled.detail}`)
      }
    } catch (error) {
      indeterminate++
      lines.push(
        `  indeterminate: ${display} — ${error instanceof Error ? error.message : String(error)}`,
      )
    }
  }

  const capNote = truncated
    ? ` (CAPPED at ${WORKSPACE_DIAG_FILE_CAP} — the set was larger; narrow the paths)`
    : ''
  const skippedNote = skipped.length > 0 ? `, ${skipped.length} skipped (unclaimed/unreadable)` : ''
  const indeterminateNote = indeterminate > 0 ? `, ${indeterminate} indeterminate` : ''
  let summary = `${included.length} file(s) checked${capNote}${skippedNote} — ${errors} error(s), ${warnings} warning(s) in ${filesWithFindings} file(s)${indeterminateNote}`
  if (lines.length === 0) summary += ' — all clean.'
  const allIndeterminate = indeterminate === included.length
  return {
    result: lines.length > 0 ? `${summary}\n${lines.join('\n')}` : summary,
    resultCount: totalDiagnostics,
    fileCount: included.length,
    effect: {
      outcome: allIndeterminate ? 'indeterminate' : 'succeeded',
      changedPaths: [],
      evidence: `${errors} error(s), ${warnings} warning(s) across ${included.length} file(s)`,
      details: { truncated, skipped: skipped.length, indeterminate },
    },
  }
}

/** Whether two LSP ranges intersect (half-open — touching ends are disjoint). */
function lspRangesIntersect(a: LspRangeLike, b: LspRangeLike): boolean {
  const cmp = (x: { line: number; character: number }, y: { line: number; character: number }): number =>
    x.line - y.line || x.character - y.character
  return cmp(a.start, b.end) < 0 && cmp(b.start, a.end) < 0
}

/**
 * Every configured server whose file-type claim matches EITHER end of the
 * move. Directories claim through the extensions of their contained files
 * (bounded walk, ignored dirs skipped).
 */
async function pathRenameClaimants(
  env: OpEnv,
  oldPath: string,
  newPath: string,
  isDirectory: boolean,
): Promise<LSPServerInstance[]> {
  const seen = new Set<string>()
  const out: LSPServerInstance[] = []
  const addAll = (servers: LSPServerInstance[]): void => {
    for (const s of servers) {
      if (!seen.has(s.name)) {
        seen.add(s.name)
        out.push(s)
      }
    }
  }
  if (!isDirectory) {
    addAll(env.manager.getServersForFile(oldPath))
    addAll(env.manager.getServersForFile(newPath))
    return out
  }
  // Directory: one bounded walk collecting contained extensions.
  const FILE_SCAN_CAP = 2_000
  let scanned = 0
  const extensions = new Set<string>()
  const walk = async (dir: string): Promise<void> => {
    if (scanned >= FILE_SCAN_CAP) return
    let entries: Dirent[]
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      if (scanned >= FILE_SCAN_CAP) return
      if (entry.isDirectory()) {
        if (IGNORED_WALK_DIRS.has(entry.name)) continue
        await walk(resolve(dir, entry.name))
      } else {
        scanned++
        const ext = extname(entry.name).toLowerCase()
        if (ext) extensions.add(ext)
      }
    }
  }
  await walk(oldPath)
  for (const ext of extensions) {
    addAll(env.manager.getServersForFile(`${oldPath}/probe${ext}`))
  }
  return out
}

/**
 * Coalesce per-server workspace edits, precedence order (the configured-
 * server merge order — the project-aware/curated claimant first): per URI,
 * a later server's edits that INTERSECT an earlier server's are dropped
 * (the earlier claimant wins the overlap); disjoint edits merge.
 */
function coalesceWorkspaceEdits(
  perServer: Array<{ server: string; files: NormalizedFileEdits[] }>,
): { files: NormalizedFileEdits[]; overlapNotes: string[] } {
  const byUri = new Map<string, { edits: LspTextEditLike[]; owners: string[] }>()
  const overlapNotes: string[] = []
  for (const { server, files } of perServer) {
    for (const file of files) {
      const entry = byUri.get(file.uri) ?? { edits: [], owners: [] }
      let dropped = 0
      for (const edit of file.edits) {
        if (entry.edits.some(existing => lspRangesIntersect(existing.range, edit.range))) {
          dropped++
          continue
        }
        entry.edits.push(edit)
      }
      if (dropped > 0) {
        overlapNotes.push(
          // LSP URIs are slash-delimited on every platform — the basename
          // slice is exact (never a win32 path split).
          `${server}: ${dropped} overlapping edit(s) in ${file.uri.slice(file.uri.lastIndexOf('/') + 1) || file.uri} yielded to ${entry.owners.join('+') || 'the prior claimant'}`,
        )
      }
      if (file.edits.length > dropped) entry.owners.push(server)
      byUri.set(file.uri, entry)
    }
  }
  return {
    files: [...byUri.entries()]
      .filter(([, v]) => v.edits.length > 0)
      .map(([uri, v]) => ({ uri, edits: v.edits })),
    overlapNotes,
  }
}

/**
 * The multi-server prepare: request EVERY willRename-advertising claimant,
 * coalesce, and hold the same sync-before-request law prepareApply pins —
 * the only success exit is a round whose entire merged touched set was
 * synced BEFORE that round's requests.
 */
async function prepareApplyFanOut(
  env: OpEnv,
  requesters: Array<{ name: string; request: () => Promise<WorkspaceEditLike | null | undefined> }>,
): Promise<
  | { ok: true; files: NormalizedFileEdits[]; snapshots: Map<string, string>; notes: string[] }
  | { ok: false; reason: string }
> {
  const snapshots = new Map<string, string>()
  const notes: string[] = []
  for (let round = 0; round < PREPARE_ROUNDS; round++) {
    const perServer: Array<{ server: string; files: NormalizedFileEdits[] }> = []
    for (const r of requesters) {
      let edit: WorkspaceEditLike | null | undefined
      try {
        edit = await r.request()
      } catch (error) {
        // One claimant failing must not sink the fan-out — its absence is a
        // surfaced note, not a silent hole.
        notes.push(`${r.name}: willRenameFiles failed (${error instanceof Error ? error.message : String(error)}) — its import edits are not included`)
        continue
      }
      const normalized = normalizeWorkspaceEdit(edit)
      if (!normalized.ok) {
        if (!/edit set is empty|server returned no edit/.test(normalized.reason)) {
          notes.push(`${r.name}: ${normalized.reason} — its import edits are not included`)
        }
        continue
      }
      perServer.push({ server: r.name, files: normalized.files })
    }
    const merged = coalesceWorkspaceEdits(perServer)
    notes.push(...merged.overlapNotes)
    const unsynced = merged.files.filter(file => !snapshots.has(uriToFilePath(file.uri)))
    if (unsynced.length === 0) {
      return { ok: true, files: merged.files, snapshots, notes }
    }
    for (const file of unsynced) {
      const abs = uriToFilePath(file.uri)
      try {
        snapshots.set(abs, await syncFileFromDisk(env.manager, abs))
      } catch (error) {
        return {
          ok: false,
          reason: `could not sync ${displayPathFor(env.cwd, abs)}: ${error instanceof Error ? error.message : String(error)}`,
        }
      }
    }
  }
  return {
    ok: false,
    reason: `the edit did not stabilize after ${PREPARE_ROUNDS} rounds — the servers kept widening the touched-file set; nothing was written`,
  }
}

function advertisesFileOperation(
  server: LSPServerInstance,
  op: 'willRename' | 'didRename',
): boolean {
  const caps = server.capabilities as ServerCapabilities | undefined
  const fileOps = (caps?.workspace as { fileOperations?: Record<string, unknown> } | undefined)
    ?.fileOperations
  return Boolean(fileOps?.[op])
}

async function opPathRename(env: OpEnv): Promise<MercuryLspOpOutput> {
  const input = env.input
  const oldPath = env.absolutePath
  const display = displayPathFor(env.cwd, oldPath)
  if (!input.newPath || resolve(env.cwd, input.newPath) === resolve(oldPath)) {
    return {
      result: `pathRename failed: newPath is required and must differ from filePath.`,
      resultCount: 0,
      fileCount: 0,
      effect: {
        outcome: 'failed',
        changedPaths: [],
        evidence: 'invalid newPath',
      },
    }
  }
  const newPath = resolve(env.cwd, input.newPath)
  const newDisplay = displayPathFor(env.cwd, newPath)
  let isDirectory = false
  try {
    isDirectory = (await stat(oldPath)).isDirectory()
  } catch {
    return {
      result: `pathRename failed: ${display} does not exist.`,
      resultCount: 0,
      fileCount: 0,
      effect: { outcome: 'failed', changedPaths: [], evidence: 'source missing' },
    }
  }
  try {
    await stat(newPath)
    return {
      result: `pathRename refused: Target already exists at ${newDisplay} — nothing moved.`,
      resultCount: 0,
      fileCount: 0,
      effect: {
        outcome: 'failed',
        changedPaths: [],
        evidence: 'target exists — nothing moved',
      },
    }
  } catch {
    // The target must NOT exist — this is the good path.
  }

  // The fan-out: EVERY configured server whose file types match either end
  // (a directory claims through its contained files' extensions).
  const claimants = await pathRenameClaimants(env, oldPath, newPath, isDirectory)
  for (const c of claimants) {
    if (c.state !== 'running') await c.start().catch(() => {})
  }
  const askable = claimants.filter(c => advertisesFileOperation(c, 'willRename'))

  const oldUri = pathToFileURL(resolve(oldPath)).href
  const newUri = pathToFileURL(newPath).href

  let prepared: { ok: true; files: NormalizedFileEdits[]; snapshots: Map<string, string> }
  let supportNote: string
  const fanOutNotes: string[] = []
  if (askable.length > 0) {
    if (!isDirectory) await syncFileFromDisk(env.manager, oldPath).catch(() => {})
    const fan = await prepareApplyFanOut(
      env,
      askable.map(server => ({
        name: server.name,
        request: () =>
          server.sendRequest<WorkspaceEditLike | null>('workspace/willRenameFiles', {
            files: [{ oldUri, newUri }],
          }),
      })),
    )
    if (!fan.ok) {
      return {
        result: `pathRename failed while preparing import edits: ${fan.reason}. Nothing was moved.`,
        resultCount: 0,
        fileCount: 0,
        effect: {
          outcome: 'failed',
          changedPaths: [],
          evidence: 'import-edit preparation failed — nothing moved',
        },
      }
    }
    fanOutNotes.push(...fan.notes)
    const editCount = fan.files.reduce((sum, file) => sum + file.edits.length, 0)
    if (fan.files.length > PATH_RENAME_FILE_CAP) {
      return {
        result: `pathRename refused: the move would touch ${fan.files.length} files (cap ${PATH_RENAME_FILE_CAP}). Split the move into smaller steps, or move the file with Bash and fix imports incrementally.`,
        resultCount: 0,
        fileCount: 0,
        effect: {
          outcome: 'failed',
          changedPaths: [],
          evidence: `file cap exceeded (${fan.files.length})`,
        },
      }
    }
    prepared = { ok: true, files: fan.files, snapshots: fan.snapshots }
    supportNote =
      editCount === 0
        ? `${askable.map(s => s.name).join(' + ')} reported no import edits for this move.`
        : `${editCount} import-updating edit(s) computed by ${askable.map(s => s.name).join(' + ')}.`
  } else if (claimants.length > 0) {
    prepared = { ok: true, files: [], snapshots: new Map() }
    supportNote = `${claimants.map(c => c.name).join(' + ')} claim${claimants.length === 1 ? 's' : ''} the file type but none advertises path-rename intelligence (workspace.fileOperations.willRename) — the ${isDirectory ? 'directory' : 'file'} moves without import updates.`
  } else {
    prepared = { ok: true, files: [], snapshots: new Map() }
    supportNote = `No language server claims this ${isDirectory ? "directory's contents" : 'file'} — the ${isDirectory ? 'directory' : 'file'} moves without import updates.`
  }

  const preparedFiles = prepared.files
  const preparedSnapshots = prepared.snapshots
  const notesBlock = fanOutNotes.length > 0 ? `\n${fanOutNotes.map(n => `note: ${n}`).join('\n')}` : ''
  if (input.apply !== true) {
    const editPreview =
      preparedFiles.length > 0
        ? `\n${formatEditPreview(
            preparedFiles,
            uri => preparedSnapshots.get(uriToFilePath(uri)),
            uri => displayPathFor(env.cwd, uriToFilePath(uri)),
          )}`
        : ''
    return {
      result: `Move: ${display} → ${newDisplay}\n${supportNote}${notesBlock}${editPreview}\nPreview only — nothing moved, nothing written. Re-run with apply: true to move.`,
      resultCount: preparedFiles.reduce((sum, file) => sum + file.edits.length, 0),
      fileCount: preparedFiles.length,
      applied: false,
      effect: {
        outcome: 'succeeded',
        changedPaths: [],
        evidence: 'move previewed, nothing written',
        details: { preview: true },
      },
      ...(preparedFiles.length > 0
        ? {
            changeView: changeViewOf(
              'pathRename',
              'proposed',
              env.cwd,
              preparedFiles,
              preparedSnapshots,
            ),
          }
        : {}),
    }
  }

  // Apply: BOTH endpoints pass the same permission floor.
  const permissionContext = env.context.getAppState().toolPermissionContext
  for (const endpoint of [oldPath, newPath]) {
    const decision = checkWritePermissionForTool(
      env.tool,
      { ...env.input, filePath: endpoint },
      permissionContext,
    ) as { behavior: string }
    const endpointDisplay = displayPathFor(env.cwd, endpoint)
    if (decision.behavior === 'deny') {
      return {
        result: `pathRename refused: ${endpointDisplay} is blocked by a permission deny rule. Nothing moved.`,
        resultCount: 0,
        fileCount: 0,
        effect: {
          outcome: 'failed',
          changedPaths: [],
          evidence: 'endpoint denied — nothing moved',
        },
      }
    }
    if (decision.behavior !== 'allow' && !pathInAllowedWorkingPath(endpoint, permissionContext)) {
      return {
        result: `pathRename refused: ${endpointDisplay} is outside the session's working directories. Add its directory with /add-dir first. Nothing moved.`,
        resultCount: 0,
        fileCount: 0,
        effect: {
          outcome: 'failed',
          changedPaths: [],
          evidence: 'endpoint out of scope — nothing moved',
        },
      }
    }
  }

  // Phase A — the import edits ride the shared transaction FIRST.
  let editedPaths: string[] = []
  if (prepared.files.length > 0) {
    const applied = await applyPrepared(env, 'pathRename', prepared.files, prepared.snapshots)
    if (applied.output.effect.outcome === 'failed') {
      return {
        ...applied.output,
        result: `${applied.output.result}\nThe file was NOT moved.`,
      }
    }
    if (applied.output.effect.outcome === 'indeterminate' && applied.output.applied !== true) {
      return {
        ...applied.output,
        result: `${applied.output.result}\nThe file was NOT moved — resolve the divergence first.`,
      }
    }
    editedPaths = applied.writtenPaths
    if (applied.output.effect.outcome === 'indeterminate') {
      // Post-write sync indeterminacy: the edits ARE on disk. Stop before
      // the move — a half-confirmed transaction must not compound.
      return {
        ...applied.output,
        result: `${applied.output.result}\nThe file was NOT moved — re-run pathRename once the servers settle.`,
      }
    }
  }

  // Phase B — the move itself. Everything (the cross-device byte read
  // included) sits inside the protected region: a failure after phase-A
  // edits landed must surface as the indeterminate report, never escape
  // raw. Same-device renames never buffer the file.
  try {
    await mkdir(dirname(newPath), { recursive: true })
    try {
      await renameWithWin32Retry(oldPath, newPath)
    } catch (error) {
      if ((error as { code?: string }).code === 'EXDEV' && !isDirectory) {
        const oldBytes = await readFile(oldPath)
        await writeFile(newPath, oldBytes)
        await unlink(oldPath)
      } else if ((error as { code?: string }).code === 'EXDEV') {
        throw new Error(
          'cross-device directory move is not supported — move the tree with Bash (cp -R + rm) and re-run imports per file',
        )
      } else {
        throw error
      }
    }
  } catch (error) {
    return {
      result:
        `pathRename INDETERMINATE: the import edits landed but the move itself failed (${error instanceof Error ? error.message : String(error)}). ` +
        `${display} still exists with updated imports pointing at the NEW path — move it manually or re-run.`,
      resultCount: editedPaths.length,
      fileCount: editedPaths.length,
      applied: true,
      effect: {
        outcome: 'indeterminate',
        changedPaths: editedPaths,
        evidence: 'edits landed; move failed',
      },
    }
  }

  // Phase C — server + read-state follow-up, each best-effort. The
  // didRenameFiles notification fans to EVERY claimant advertising it
  // (contract data: workspace/didRenameFiles), asked or not.
  if (!isDirectory) {
    try {
      await env.manager.closeFile(oldPath)
    } catch (error) {
      logForDebugging(`lsp ops: pathRename didClose failed: ${String(error)}`)
    }
  }
  for (const server of claimants) {
    if (!advertisesFileOperation(server, 'didRename')) continue
    try {
      await server.sendNotification('workspace/didRenameFiles', {
        files: [{ oldUri, newUri }],
      })
    } catch (error) {
      logForDebugging(`lsp ops: didRenameFiles to ${server.name} failed: ${String(error)}`)
    }
  }
  let movedText = ''
  if (!isDirectory) {
    try {
      movedText = await readFile(newPath, 'utf8')
      await env.manager.openFile(newPath, movedText)
    } catch (error) {
      logForDebugging(`lsp ops: post-move open failed: ${String(error)}`)
    }
  }
  try {
    const readFileState = env.context.readFileState
    if (isDirectory) {
      // Every read-state entry under the old prefix follows the move.
      const prefix = oldPath.endsWith('/') ? oldPath : `${oldPath}/`
      for (const [key, value] of [...readFileState.entries()]) {
        if (key === oldPath || key.startsWith(prefix)) {
          readFileState.delete(key)
          readFileState.set(newPath + key.slice(oldPath.length), value)
        }
      }
    } else {
      readFileState.delete(oldPath)
      const stats = await stat(newPath)
      readFileState.set(newPath, {
        content: movedText.replaceAll('\r\n', '\n'),
        timestamp: Math.floor(stats.mtimeMs),
        offset: undefined,
        limit: undefined,
      })
    }
  } catch (error) {
    logForDebugging(`lsp ops: readFileState follow failed: ${String(error)}`)
  }

  const postMoveNote = isDirectory
    ? 'Directory moved — run diagnostics on the touched files to verify.'
    : await (async () => {
        const stabilization = await awaitDiagnosticStabilization(env.manager, newPath)
        return stabilization.state === 'fresh' || stabilization.state === 'unchanged'
          ? `Post-move diagnostics: ${stabilization.errors} error(s), ${stabilization.warnings} warning(s).`
          : `post-move diagnostics ${stabilization.state} — verify the move with a real check.`
      })()
  const editedList =
    editedPaths.length > 0
      ? `\nEdited: ${editedPaths.map(p => displayPathFor(env.cwd, p)).join(', ')}`
      : ''
  const changedPaths = [...new Set([...editedPaths, oldPath, newPath])]
  return {
    result: `Moved ${display} → ${newDisplay}\n${supportNote}${notesBlock}${editedList}\n${postMoveNote}`,
    resultCount: changedPaths.length,
    fileCount: changedPaths.length,
    applied: true,
    effect: {
      outcome: 'succeeded',
      changedPaths,
      evidence: `moved + ${editedPaths.length} file(s) edited`,
      details: { postMove: postMoveNote },
    },
  }
}

async function opFixDiagnostic(env: OpEnv): Promise<MercuryLspOpOutput> {
  const input = env.input
  const display = displayPathFor(env.cwd, env.absolutePath)
  await syncFileFromDisk(env.manager, env.absolutePath)
  const before = await pullFileDiagnostics(env.manager, env.absolutePath)
  if (before.kind === 'unsupported') {
    return {
      result: `fixDiagnostic needs pull diagnostics, which the language server for ${display} does not support — use codeActions directly.`,
      resultCount: 0,
      fileCount: 0,
      effect: {
        outcome: 'no-change',
        changedPaths: [],
        evidence: 'pull diagnostics unsupported',
      },
    }
  }
  if (before.kind === 'protocol-violation') {
    return {
      result: `fixDiagnostic is indeterminate for ${display}: ${before.detail} — cannot establish the before picture.`,
      resultCount: 0,
      fileCount: 0,
      effect: {
        outcome: 'indeterminate',
        changedPaths: [],
        evidence: 'before picture indeterminate',
      },
    }
  }
  if (before.kind === 'no-claimant') {
    const extension = extname(env.absolutePath).toLowerCase()
    return {
      result:
        `fixDiagnostic is unavailable for ${display}: no language server claims '${extension}'. ` +
        remedyForUnclaimedExtension(extension),
      resultCount: 0,
      fileCount: 0,
      effect: {
        outcome: 'no-change',
        changedPaths: [],
        evidence: `no language server claims '${extension}'`,
      },
    }
  }
  const range = inputRange(input)
  const targets = before.items.filter(item => lineRangesOverlap(item.range, range))
  if (targets.length === 0) {
    return {
      result: `No diagnostics at ${display}:${input.line ?? 1} — nothing to fix.`,
      resultCount: 0,
      fileCount: 0,
      effect: {
        outcome: 'no-change',
        changedPaths: [],
        evidence: 'nothing to fix',
      },
    }
  }
  const beforeCounts = countBySeverity(before.items)
  const picture = `${targets.length} diagnostic(s) at the position (file has ${beforeCounts.errors} error(s)):\n${targets
    .map(item => `  ${formatDiagnosticLine(display, item)}`)
    .join('\n')}`

  const fixRerunHint =
    'Re-run fixDiagnostic with apply: true and actionId to apply a fix (or apply: true alone when exactly one edit-shaped fix is offered).'

  if (input.apply !== true) {
    const listing = await opCodeActions({
      ...env,
      input: { ...input, operation: 'codeActions', apply: false },
    })
    const rewritten = listing.result.replace(CODE_ACTION_RERUN_HINT, fixRerunHint)
    return {
      ...listing,
      result: `${picture}\n${rewritten}`,
    }
  }

  // Apply: delegate to the codeActions apply.
  const delegate = await opCodeActions({
    ...env,
    input: { ...input, operation: 'codeActions', apply: true },
  })
  let applied = delegate
  if (
    input.actionId === undefined &&
    delegate.effect.outcome === 'failed' &&
    delegate.result.includes('apply: true requires actionId')
  ) {
    // Auto-select: exactly one edit-capable candidate applies itself.
    const listing = await opCodeActions({
      ...env,
      input: { ...input, operation: 'codeActions', apply: false },
    })
    const editRows = [...listing.result.matchAll(/id:(ca-[0-9a-f]{8}).*— edit$/gm)]
    if (editRows.length !== 1) {
      return {
        result: `${picture}\nfixDiagnostic needs a selection: ${editRows.length} edit-shaped fixes are offered. ${listing.result.replace(CODE_ACTION_RERUN_HINT, fixRerunHint)}`,
        resultCount: 0,
        fileCount: 0,
        applied: false,
        effect: {
          outcome: 'failed',
          changedPaths: [],
          evidence: `selection required (${editRows.length} candidates)`,
        },
      }
    }
    applied = await opCodeActions({
      ...env,
      input: { ...input, operation: 'codeActions', apply: true, actionId: editRows[0]![1]! },
    })
  }
  if (applied.applied !== true) {
    return applied
  }

  // PROVE: re-pull and report the movement.
  let movement: string
  let afterErrors: number | undefined
  try {
    const after = await pullFileDiagnostics(env.manager, env.absolutePath)
    if (after.kind === 'fresh' || after.kind === 'unchanged') {
      afterErrors = countBySeverity(after.items).errors
      const suffix =
        afterErrors < beforeCounts.errors
          ? ' ✓'
          : afterErrors > beforeCounts.errors
            ? ' — the fix INTRODUCED errors, inspect'
            : ' (unchanged count)'
      movement = `errors before: ${beforeCounts.errors} → after: ${afterErrors}${suffix}`
    } else {
      movement = `errors before: ${beforeCounts.errors} → after: indeterminate (re-pull ${after.kind})`
    }
  } catch (error) {
    movement = `errors before: ${beforeCounts.errors} → after: indeterminate (re-pull failed: ${error instanceof Error ? error.message : String(error)})`
  }
  return {
    ...applied,
    result: `${applied.result}\n${movement}`,
    effect: {
      ...applied.effect,
      evidence: `${applied.effect.evidence}; ${movement}`,
      details: {
        ...(applied.effect.details ?? {}),
        beforeErrors: beforeCounts.errors,
        ...(afterErrors !== undefined ? { afterErrors } : {}),
      },
    },
  }
}

// ── the formatting family ──────────────────────────────────────────────────

type FormatWant = 'formatDocument' | 'formatRange' | 'organizeImports'

function advertisesWant(capabilities: ServerCapabilities | undefined, want: FormatWant): boolean {
  if (want === 'formatDocument') return Boolean(capabilities?.documentFormattingProvider)
  if (want === 'formatRange') return Boolean(capabilities?.documentRangeFormattingProvider)
  const provider = capabilities?.codeActionProvider
  if (!provider || typeof provider === 'boolean') return false
  const kinds = (provider as { codeActionKinds?: string[] }).codeActionKinds ?? []
  return kinds.some(
    kind => kind === 'source.organizeImports' || kind.startsWith('source.organizeImports.'),
  )
}

function capabilityNameFor(want: FormatWant): string {
  if (want === 'formatDocument') return 'documentFormatting'
  if (want === 'formatRange') return 'documentRangeFormatting'
  return 'source.organizeImports code actions'
}

/** The FIRST claimant (manager registration order) advertising the wanted
 *  capability; stopped/errored claimants are started before their
 *  capabilities are read. */
async function resolveFormatOwner(
  env: OpEnv,
  want: FormatWant,
): Promise<{ owner: LSPServerInstance } | { refusal: string }> {
  const claimants = env.manager.getServersForFile(env.absolutePath)
  if (claimants.length === 0) {
    return { refusal: `No language server claims ${displayPathFor(env.cwd, env.absolutePath)}.` }
  }
  const reports: string[] = []
  for (const claimant of claimants) {
    // Not running: start it — a start in flight is joined rather than
    // raced past (FN-015 rank 55), a stop in flight waited out first.
    if (claimant.state !== 'running') {
      try {
        if (claimant.state === 'stopping') await claimant.stop()
        await claimant.start()
      } catch (error) {
        reports.push(
          `${claimant.name}: failed to start (${error instanceof Error ? error.message : String(error)})`,
        )
        continue
      }
    }
    if (advertisesWant(claimant.capabilities as ServerCapabilities | undefined, want)) {
      return { owner: claimant }
    }
    reports.push(`${claimant.name}: does not advertise ${capabilityNameFor(want)}`)
  }
  const extension = extname(env.absolutePath).toLowerCase()
  const pythonRemedy =
    extension === '.py' || extension === '.pyi'
      ? '\nFor Python, install ruff (the mercury-ruff companion advertises formatting and import organisation once the binary is on PATH).'
      : ''
  return {
    refusal: `No claimant can ${want} this file:\n${reports.map(line => `  ${line}`).join('\n')}${pythonRemedy}`,
  }
}

async function opFormatFamily(env: OpEnv, want: FormatWant): Promise<MercuryLspOpOutput> {
  const input = env.input
  const display = displayPathFor(env.cwd, env.absolutePath)
  if (
    want === 'formatRange' &&
    (input.line === undefined ||
      input.character === undefined ||
      input.endLine === undefined ||
      input.endCharacter === undefined)
  ) {
    return {
      result: `formatRange failed: line, character, endLine and endCharacter are all required.`,
      resultCount: 0,
      fileCount: 0,
      effect: {
        outcome: 'failed',
        changedPaths: [],
        evidence: 'missing range fields',
      },
    }
  }
  const resolved = await resolveFormatOwner(env, want)
  if ('refusal' in resolved) {
    return {
      result: resolved.refusal,
      resultCount: 0,
      fileCount: 0,
      effect: {
        outcome: 'no-change',
        changedPaths: [],
        evidence: 'no capable owner',
      },
    }
  }
  const owner = resolved.owner
  const uri = pathToFileURL(resolve(env.absolutePath)).href

  const requestEdit = async (): Promise<WorkspaceEditLike | null> => {
    if (want === 'organizeImports') {
      // The whole-file range is computed from the CURRENT text — strict
      // servers reject out-of-range positions (S47).
      const wholeFileText = await readFile(env.absolutePath, 'utf8')
      const wholeFileLines = wholeFileText.split('\n')
      const actions = await owner.sendRequest<Array<WireCodeAction | null> | null>(
        'textDocument/codeAction',
        {
          textDocument: { uri },
          range: {
            start: { line: 0, character: 0 },
            end: {
              line: wholeFileLines.length - 1,
              character: wholeFileLines[wholeFileLines.length - 1]!.length,
            },
          },
          context: { diagnostics: [], only: ['source.organizeImports'] },
        },
      )
      const action = (actions ?? []).find(
        (candidate): candidate is WireCodeAction =>
          candidate !== null &&
          typeof candidate === 'object' &&
          typeof candidate.title === 'string' &&
          (candidate.kind === 'source.organizeImports' ||
            (candidate.kind ?? '').startsWith('source.organizeImports')),
      )
      if (!action) return { changes: {} }
      if (action.edit) return action.edit
      const capabilities = owner.capabilities as ServerCapabilities | undefined
      const resolveProvider = Boolean(
        (capabilities?.codeActionProvider as { resolveProvider?: boolean } | undefined)
          ?.resolveProvider,
      )
      if (resolveProvider) {
        const resolvedAction = await owner.sendRequest<WireCodeAction | null>(
          'codeAction/resolve',
          action,
        )
        if (resolvedAction?.edit) return resolvedAction.edit
      }
      return { changes: {} }
    }
    const method =
      want === 'formatDocument' ? 'textDocument/formatting' : 'textDocument/rangeFormatting'
    const params: Record<string, unknown> = {
      textDocument: { uri },
      options: { tabSize: 4, insertSpaces: true },
    }
    if (want === 'formatRange') {
      params.range = {
        start: { line: input.line! - 1, character: input.character! - 1 },
        end: { line: input.endLine! - 1, character: input.endCharacter! - 1 },
      }
    }
    const edits = await owner.sendRequest<LspTextEditLike[] | null>(method, params)
    return { changes: { [uri]: edits ?? [] } }
  }

  await syncFileFromDisk(env.manager, env.absolutePath)
  const prepared = await prepareApply(env, requestEdit)
  if (!prepared.ok) {
    // The empty-set translation: a server
    // answering "no edits" means the file already satisfies it.
    if (/edit set is empty/.test(prepared.reason)) {
      const message =
        want === 'organizeImports'
          ? `Imports already organized (${owner.name} returned no edits) — ${display} is unchanged.`
          : `Already formatted (${owner.name} returned no edits) — ${display} is unchanged.`
      return {
        result: message,
        resultCount: 0,
        fileCount: 0,
        applied: false,
        effect: {
          outcome: 'no-change',
          changedPaths: [],
          evidence: 'no edits needed',
        },
      }
    }
    return {
      result: `${want} failed: ${prepared.reason}`,
      resultCount: 0,
      fileCount: 0,
      applied: false,
      effect: {
        outcome: 'failed',
        changedPaths: [],
        evidence: 'preparation failed — nothing written',
      },
    }
  }
  if (input.apply !== true) {
    return previewOf(
      env,
      want,
      prepared.files,
      prepared.snapshots,
      `Re-run with apply: true to write (${owner.name} is the formatting owner).`,
    )
  }
  const applied = await applyPrepared(env, want, prepared.files, prepared.snapshots)
  return applied.output
}

// ── capabilities + the raw-request escape hatch ────────────────────────────

const RAW_RESULT_CHAR_CAP = 20_000

/** Methods whose RESULT (or server-side effect) is a mutation. The escape
 *  hatch never opens a second write path around the apply transaction: each
 *  refusal names the typed op that owns the behaviour. */
const RAW_REQUEST_EDIT_CLASS: Record<string, string> = {
  'textDocument/rename': 'use the rename operation — its result rides the drift-safe apply transaction',
  'workspace/willRenameFiles': 'use the pathRename operation — the move + import edits ride ONE transaction',
  'workspace/executeCommand': 'executes a server-side command that can edit the workspace outside the transaction — use codeActions (apply) instead',
  'textDocument/codeAction': 'use the codeActions operation — resolved edits ride the apply transaction',
  'codeAction/resolve': 'use the codeActions operation — resolved edits ride the apply transaction',
  'textDocument/formatting': 'use the formatDocument operation',
  'textDocument/rangeFormatting': 'use the formatRange operation',
  'workspace/applyEdit': 'a server→client request — a client cannot send it',
}

async function opCapabilities(env: OpEnv): Promise<MercuryLspOpOutput> {
  const display = displayPathFor(env.cwd, env.absolutePath)
  const server = env.manager.getServerForFile(env.absolutePath)
  if (!server) {
    return {
      result: `No language server claims ${display} — nothing to dump. op:"serverStatus" lists the configured servers.`,
      resultCount: 0,
      fileCount: 0,
      effect: { outcome: 'no-change', changedPaths: [], evidence: 'no claimant' },
    }
  }
  await env.manager.ensureServerStarted(env.absolutePath)
  const caps = server.capabilities
  if (!caps) {
    return {
      result: `${server.name} claims ${display} but reports no capabilities yet (state: ${server.state}).`,
      resultCount: 0,
      fileCount: 0,
      effect: { outcome: 'no-change', changedPaths: [], evidence: `no capabilities (state ${server.state})` },
    }
  }
  const text = JSON.stringify(caps, null, 2)
  const clipped = text.length > RAW_RESULT_CHAR_CAP
  return {
    result:
      `${server.name} capabilities for ${display}:\n` +
      (clipped ? `${text.slice(0, RAW_RESULT_CHAR_CAP)}\n… (${text.length - RAW_RESULT_CHAR_CAP} more chars)` : text),
    resultCount: Object.keys(caps).length,
    fileCount: 1,
    effect: {
      outcome: 'succeeded',
      changedPaths: [],
      evidence: `dumped ${Object.keys(caps).length} capability key(s) from ${server.name}`,
    },
  }
}

async function opRawRequest(env: OpEnv): Promise<MercuryLspOpOutput> {
  const input = env.input
  const display = displayPathFor(env.cwd, env.absolutePath)
  const method = input.method ?? ''
  const editClassReason = RAW_REQUEST_EDIT_CLASS[method]
  if (editClassReason !== undefined) {
    return {
      result: `rawRequest refused: '${method}' is an edit-class method — ${editClassReason}. Nothing was sent.`,
      resultCount: 0,
      fileCount: 0,
      effect: { outcome: 'failed', changedPaths: [], evidence: `edit-class method refused (${method})` },
    }
  }
  let params: unknown = undefined
  if (input.params !== undefined && input.params !== '') {
    try {
      params = JSON.parse(input.params)
    } catch (error) {
      return {
        result: `rawRequest failed: params is not valid JSON (${error instanceof Error ? error.message : String(error)}). Nothing was sent.`,
        resultCount: 0,
        fileCount: 0,
        effect: { outcome: 'failed', changedPaths: [], evidence: 'params JSON parse failed' },
      }
    }
  }
  const server = env.manager.getServerForFile(env.absolutePath)
  if (!server) {
    return {
      result: `No language server claims ${display} — rawRequest has no target.`,
      resultCount: 0,
      fileCount: 0,
      effect: { outcome: 'failed', changedPaths: [], evidence: 'no claimant' },
    }
  }
  await syncFileFromDisk(env.manager, env.absolutePath)
  try {
    const response = await server.sendRequest<unknown>(method, params ?? {})
    const text = JSON.stringify(response, null, 2) ?? 'null'
    const clipped = text.length > RAW_RESULT_CHAR_CAP
    return {
      result:
        `${server.name} · ${method}:\n` +
        (clipped ? `${text.slice(0, RAW_RESULT_CHAR_CAP)}\n… (${text.length - RAW_RESULT_CHAR_CAP} more chars)` : text) +
        `\n\nRaw protocol response — nothing was applied. Edit-returning behaviour lives in the typed operations.`,
      resultCount: 1,
      fileCount: 1,
      effect: {
        outcome: 'succeeded',
        changedPaths: [],
        evidence: `raw ${method} answered by ${server.name}`,
        details: { method, server: server.name },
      },
    }
  } catch (error) {
    return {
      result: `rawRequest ${method} failed: ${error instanceof Error ? error.message : String(error)}`,
      resultCount: 0,
      fileCount: 0,
      effect: { outcome: 'failed', changedPaths: [], evidence: `raw ${method} failed` },
    }
  }
}

// ── dispatch ───────────────────────────────────────────────────────────────

/** The fourteen-way dispatch: the union is total, so there is no default. */
export async function runMercuryLspOp(env: OpEnv): Promise<MercuryLspOpOutput> {
  // FN-013 IDE-02a: before ANY operation is served, every open document
  // revalidates against disk — a mutation outside this tool's path (a
  // checkout, a formatter, a generator) otherwise leaves servers answering
  // from content no longer on disk. Stats before reading; unchanged
  // documents cost one stat and zero notifications; a failure leaves that
  // document as it was and the operation still runs.
  try {
    await env.manager.revalidateOpenDocuments()
  } catch {
    /* revalidation is belt-and-braces — never an op hazard */
  }
  switch (env.input.operation) {
    case 'capabilities':
      return opCapabilities(env)
    case 'rawRequest':
      return opRawRequest(env)
    case 'diagnostics':
      return opDiagnostics(env)
    case 'switchSourceHeader':
      return opSwitchSourceHeader(env)
    case 'rename':
      return opRename(env)
    case 'codeActions':
      return opCodeActions(env)
    case 'typeDefinition':
      return opTypeDefinition(env)
    case 'serverStatus':
      return opServerStatus(env)
    case 'workspaceDiagnostics':
      return opWorkspaceDiagnostics(env)
    case 'pathRename':
      return opPathRename(env)
    case 'fixDiagnostic':
      return opFixDiagnostic(env)
    case 'formatDocument':
      return opFormatFamily(env, 'formatDocument')
    case 'formatRange':
      return opFormatFamily(env, 'formatRange')
    case 'organizeImports':
      return opFormatFamily(env, 'organizeImports')
  }
}
