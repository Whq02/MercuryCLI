import { checkForLSPDiagnostics, clearAllLSPDiagnostics, foldDriveCase, subscribePublishedReports } from '../../services/lsp/LSPDiagnosticRegistry.js'
import { toolMatchesName, type ToolUseContext } from '../../Tool.js'
import { BASH_TOOL_NAME } from '../../tools/BashTool/toolName.js'
import { logForDebugging } from '../debug.js'
import { toError } from '../errors.js'
import { logError } from '../log.js'
import type { Attachment } from './types.js'

const RESYNC_REPORT_WAIT_MS = 1_500

async function refreshDiagnosticDocuments(): Promise<string[]> {
  try {
    const lsp = await import('../../services/lsp/manager.js')
    const report = await lsp.getLspServerManager()?.revalidateOpenDocuments()
    return report?.resynced ?? []
  } catch {
    return []
  }
}

function awaitFreshReports(resynced: readonly string[], deadlineMs = RESYNC_REPORT_WAIT_MS): Promise<string[]> {
  const waiting = new Set(resynced.map(path => foldDriveCase(path)))
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
      waiting.delete(plain)
      if (waiting.size === 0) finish()
    })
  })
}

function deliverDiagnostics(): Attachment[] {
  try {
    const rows = checkForLSPDiagnostics().map<Attachment>(set => ({ type: 'diagnostics', files: set.files, isNew: true }))
    if (rows.length) {
      clearAllLSPDiagnostics()
      logForDebugging(`diagnostics: ${rows.length} sets attached for the model and cleared from the registry`)
    }
    return rows
  } catch (failure) {
    logError(new Error(`Failed to get LSP diagnostic attachments: ${toError(failure).message}`))
    return []
  }
}

export async function deliverAfterRevalidation(resynced: readonly string[], deadlineMs = RESYNC_REPORT_WAIT_MS): Promise<Attachment[]> {
  if (resynced.length > 0) {
    const unanswered = await awaitFreshReports(resynced, deadlineMs)
    logForDebugging(`diagnostics: ${resynced.length} document(s) re-synced from disk before delivery${unanswered.length > 0 ? `; no fresh report within ${deadlineMs} ms for ${unanswered.join(', ')} — their earlier publishes are held back` : ''}`)
  }
  return deliverDiagnostics()
}

export async function getLSPDiagnosticAttachments(context: ToolUseContext): Promise<Attachment[]> {
  if (!context.options.tools.some(tool => toolMatchesName(tool, BASH_TOOL_NAME))) return []
  logForDebugging('LSP Diagnostics: getLSPDiagnosticAttachments called')
  const resynced = await refreshDiagnosticDocuments()
  return deliverAfterRevalidation(resynced)
}
