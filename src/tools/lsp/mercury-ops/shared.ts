import { readFile, stat } from 'node:fs/promises'
import { isAbsolute, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { canonicalPathKey } from '../../engines/change-transaction/changeSetPlan.js'
import { claimDiagnosticsLook } from '../../../integrations/lsp/LSPDiagnosticRegistry.js'
import type { LSPServerManager } from '../../../integrations/lsp/LSPServerManager.js'
import { ownerFromToolUseContext } from '../../../engine/run-owner/resolveOwner.js'
import type { ToolUseContext } from '../../kit/tool.js'
import { type LspRangeLike, type NormalizedFileEdits } from '../../../integrations/lsp/workspaceEditApply.js'

const MAX_LSP_FILE_BYTES = 10_000_000

export const PREPARE_ROUNDS = 3

export const WORKSPACE_DIAG_FILE_CAP = 50

export const PATH_RENAME_FILE_CAP = 100

export const SERVER_SYNC_DEADLINE_MS = 4_000

export const STABILIZE_DEADLINE_MS = 3_000

export const STABILIZE_QUIET_WINDOW_MS = 300

export const IGNORED_WALK_DIRS = new Set(['node_modules', '.git', 'dist', '.build-tree'])

export function displayPathFor(cwd: string, fileOrUri: string): string {
  const path = fileOrUri.startsWith('file://')
    ? fileURLToPath(fileOrUri)
    : fileOrUri
  const rel = relative(cwd, path)
  if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) return path
  return rel
}

export function uriToFilePath(uri: string): string {
  if (uri.startsWith('file://')) return fileURLToPath(uri)
  return uri
}

export function foldFilesByPath(files: NormalizedFileEdits[]): NormalizedFileEdits[] {
  const byKey = new Map<string, NormalizedFileEdits>()
  for (const file of files) {
    const key = canonicalPathKey(uriToFilePath(file.uri))
    const prior = byKey.get(key)
    if (prior === undefined) {
      byKey.set(key, { uri: file.uri, edits: [...file.edits], ...(file.create === true ? { create: true } : {}) })
      continue
    }
    if (file.create === true) prior.create = true
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

export function isMethodNotFoundError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error)
  return /method not found|unhandled method|invalid request/i.test(message)
}

export type LspWireDiagnostic = {
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

export function sortDiagnostics(items: LspWireDiagnostic[]): LspWireDiagnostic[] {
  return [...items].sort(
    (a, b) =>
      (a.severity ?? 1) - (b.severity ?? 1) ||
      a.range.start.line - b.range.start.line,
  )
}

export function formatDiagnosticLine(display: string, diagnostic: LspWireDiagnostic): string {
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

export function countBySeverity(items: LspWireDiagnostic[]): { errors: number; warnings: number } {
  let errors = 0
  let warnings = 0
  for (const item of items) {
    const severity = item.severity ?? 1
    if (severity === 1) errors++
    else if (severity === 2) warnings++
  }
  return { errors, warnings }
}

export async function syncFileFromDisk(manager: LSPServerManager, absolutePath: string, context: Pick<ToolUseContext, 'owner' | 'agentId'>): Promise<string> {
  const stats = await stat(absolutePath)
  if (stats.size > MAX_LSP_FILE_BYTES) {
    const megabytes = Math.ceil(stats.size / (1024 * 1024))
    throw new Error(`file too large for LSP analysis (${megabytes}MB exceeds 10MB limit)`)
  }
  const text = await readFile(absolutePath, 'utf8')
  if (manager.isFileOpen(absolutePath)) {
    await manager.changeFile(absolutePath, text)
  } else {
    claimDiagnosticsLook(absolutePath, ownerFromToolUseContext(context))
    await manager.openFile(absolutePath, text)
  }
  return text
}
