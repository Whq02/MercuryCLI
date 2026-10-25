import { checkForLSPDiagnostics, foldDriveCase, settleWritesAwaitingReport, subscribePublishedReports, writesAwaitingReport } from '../../services/lsp/LSPDiagnosticRegistry.js'
import type { LSPServerManager } from '../../services/lsp/LSPServerManager.js'
import { ownerFromToolUseContext } from '../../services/run/resolveOwner.js'
import type { OwnerKey } from '../../services/run/ownerKey.js'
import { toolMatchesName, type ToolUseContext } from '../../Tool.js'
import { BASH_TOOL_NAME } from '../../tools/BashTool/toolName.js'
import { logForDebugging } from '../debug.js'
import { toError } from '../errors.js'
import { logError } from '../log.js'
import type { Attachment } from './types.js'

const RESYNC_REPORT_WAIT_MS = 1_500

async function managerIfAny(): Promise<LSPServerManager | undefined> {
  try {
    const lsp = await import('../../services/lsp/manager.js')
    return lsp.getLspServerManager()
  } catch {
    return undefined
  }
}

async function refreshDiagnosticDocuments(manager: LSPServerManager | undefined): Promise<string[]> {
  try {
    const report = await manager?.revalidateOpenDocuments()
    return report?.resynced ?? []
  } catch {
    return []
  }
}

function awaitFreshReports(paths: readonly string[], deadlineMs = RESYNC_REPORT_WAIT_MS, stillAwaited?: (path: string) => boolean): Promise<string[]> {
  const waiting = new Set(paths.map(path => foldDriveCase(path)))
  if (waiting.size === 0) return Promise.resolve([])
  return new Promise(resolvePromise => {
    const finish = (): void => {
      clearTimeout(timer)
      unsubscribe()
      resolvePromise([...waiting])
    }
    const timer = setTimeout(finish, deadlineMs)
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

export async function deliverAfterRevalidation(
  resynced: readonly string[],
  deadlineMs = RESYNC_REPORT_WAIT_MS,
  settle?: { owner: OwnerKey | undefined; written: readonly string[] },
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
  return deliverAfterRevalidation(resynced, RESYNC_REPORT_WAIT_MS, { owner, written })
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
  } catch {
    return false
  }
}
