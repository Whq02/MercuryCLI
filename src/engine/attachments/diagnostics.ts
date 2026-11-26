import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { ServerCapabilities } from 'vscode-languageserver-protocol'
import {
  checkForLSPDiagnostics,
  foldDriveCase,
  pendingReportsForOwner,
  reconcilePendingLSPDiagnostic,
  settleWritesAwaitingReport,
  subscribePublishedReports,
  writesAwaitingReport,
} from '../../integrations/lsp/LSPDiagnosticRegistry.js'
import { convertDiagnostics } from '../../integrations/lsp/publishedDiagnostics.js'
import type { LSPServerManager } from '../../integrations/lsp/LSPServerManager.js'
import { ownerFromToolUseContext } from '../run-owner/resolveOwner.js'
import type { OwnerKey } from '../run-owner/ownerKey.js'
import { toolMatchesName, type ToolUseContext } from '../../tools/kit/tool.js'
import { BASH_TOOL_NAME } from '../../tools/kit/names/bash.js'
import { logForDebugging } from '../../platform/logs/debugLog.js'
import { toError } from '../../platform/errors/errors.js'
import { logError } from '../../platform/logs/errorLog.js'
import type { Attachment } from '../attachment-shapes/attachmentTypes.js'
import { passedOver } from '../../platform/errors/passedOver.js'
import { withDeadline } from '../../platform/async/deadline.js'
import { startTimeout, stopTimeout } from '../../platform/async/timers.js'
const RESYNC_REPORT_WAIT_MS = 1_500

async function managerIfAny(): Promise<LSPServerManager | undefined> {
  try {
    const lsp = await import('../../integrations/lsp/serverManagerLifecycle.js')
    return lsp.getLspServerManager()
  } catch (error) {
    passedOver(error)
    return undefined
  }
}

async function refreshDiagnosticDocuments(manager: LSPServerManager | undefined): Promise<string[]> {
  try {
    const report = await manager?.revalidateOpenDocuments()
    return report?.resynced ?? []
  } catch (error) {
    passedOver(error)
    return []
  }
}

function awaitFreshReports(paths: readonly string[], deadlineMs = RESYNC_REPORT_WAIT_MS, stillAwaited?: (path: string) => boolean): Promise<string[]> {
  const waiting = new Set(paths.map(path => foldDriveCase(path)))
  if (waiting.size === 0) return Promise.resolve([])
  return new Promise(resolvePromise => {
    const finish = (): void => {
      stopTimeout(timer)
      unsubscribe()
      resolvePromise([...waiting])
    }
    const timer = startTimeout(finish, deadlineMs)
    const unsubscribe = subscribePublishedReports(event => {
      const plain = foldDriveCase(event.file.uri.startsWith('file://') ? event.file.uri.slice('file://'.length) : event.file.uri)
      if (!waiting.has(plain) || stillAwaited?.(plain) === true) return
      waiting.delete(plain)
      if (waiting.size === 0) finish()
    })
  })
}

function deliverDiagnostics(owner: OwnerKey | undefined): Attachment[] {
  try {
    const rows = checkForLSPDiagnostics(owner).map<Attachment>(set => ({ type: 'diagnostics', files: set.files, isNew: true }))
    if (rows.length) logForDebugging(`diagnostics: ${rows.length} sets attached for the model${owner === undefined ? '' : ` (lane ${owner})`}`)
    return rows
  } catch (failure) {
    logError(new Error(`Failed to get LSP diagnostic attachments: ${toError(failure).message}`))
    return []
  }
}

async function reconcilePendingReports(
  manager: LSPServerManager | undefined,
  owner: OwnerKey | undefined,
  deadlineMs: number,
): Promise<void> {
  if (manager === undefined || typeof manager.getAllServers !== 'function') return
  const candidates = pendingReportsForOwner(owner)
  if (candidates.length === 0) return
  const servers = manager.getAllServers()
  const tasks: Array<Promise<void>> = []
  for (const { serverName, uri } of candidates) {
    const server = servers.get(serverName)
    if (server === undefined || server.state !== 'running') continue
    const capabilities = server.capabilities as ServerCapabilities | undefined
    if (!capabilities?.diagnosticProvider) continue
    const docVersion = manager.getDocumentVersion(uri)
    const fileUri = pathToFileURL(resolve(uri)).href
    tasks.push(
      withDeadline(
        server.sendRequest<{ kind?: string; items?: Parameters<typeof convertDiagnostics>[0] }>('textDocument/diagnostic', {
          textDocument: { uri: fileUri },
        }),
        deadlineMs,
        () => undefined,
      )
        .then(response => {
          if (response === undefined || response === null || response.kind === 'unchanged' || !Array.isArray(response.items)) return
          const file = { uri: foldDriveCase(uri), diagnostics: convertDiagnostics(response.items) }
          reconcilePendingLSPDiagnostic(serverName, file, owner, docVersion)
        })
        .catch(passedOver),
    )
  }
  if (tasks.length > 0) await Promise.all(tasks)
}

export async function deliverAfterRevalidation(
  resynced: readonly string[],
  deadlineMs = RESYNC_REPORT_WAIT_MS,
  settle?: { owner: OwnerKey | undefined; written: readonly string[] },
  manager?: LSPServerManager,
): Promise<Attachment[]> {
  const written = settle?.written ?? []
  const waitFor = [...resynced, ...written]
  if (waitFor.length > 0) {
    const writtenKeys = new Set(written.map(path => foldDriveCase(path)))
    const stillAwaited = (path: string): boolean => writtenKeys.has(path) && writesAwaitingReport(settle?.owner).some(armed => foldDriveCase(armed) === path)
    const unanswered = await awaitFreshReports(waitFor, deadlineMs, stillAwaited)
    logForDebugging(`diagnostics: ${resynced.length} document(s) re-synced from disk and ${written.length} just written awaited before delivery${unanswered.length > 0 ? `; no fresh report within ${deadlineMs} ms for ${unanswered.join(', ')} — their earlier publishes are held back` : ''}`)
  }
  if (settle !== undefined && written.length > 0) settleWritesAwaitingReport(settle.owner, written)
  await reconcilePendingReports(manager, settle?.owner, deadlineMs)
  return deliverDiagnostics(settle?.owner)
}

export async function getLSPDiagnosticAttachments(context: ToolUseContext): Promise<Attachment[]> {
  if (!context.options.tools.some(tool => toolMatchesName(tool, BASH_TOOL_NAME))) return []
  logForDebugging('LSP Diagnostics: getLSPDiagnosticAttachments called')
  const owner = ownerFromToolUseContext(context)
  const manager = await managerIfAny()
  const resynced = await refreshDiagnosticDocuments(manager)
  const armed = writesAwaitingReport(owner)
  const written = manager === undefined ? [] : armed.filter(path => isOpenOn(manager, path))
  const unserved = armed.filter(path => !written.includes(path))
  if (unserved.length > 0) settleWritesAwaitingReport(owner, unserved)
  return deliverAfterRevalidation(resynced, RESYNC_REPORT_WAIT_MS, { owner, written }, manager)
}
export async function settleWriterDiagnosticsAtTurnEnd(context: ToolUseContext): Promise<Attachment[]> {
  if (context.abortController.signal.aborted) return []
  const rows = await getLSPDiagnosticAttachments(context)
  if (context.abortController.signal.aborted) return []
  return rows.filter(row => row.type === 'diagnostics' && row.files.length > 0)
}

function isOpenOn(manager: LSPServerManager, path: string): boolean {
  try {
    return manager.isFileOpen(path)
  } catch (error) {
    passedOver(error)
    return false
  }
}
