import { checkForLSPDiagnostics, clearAllLSPDiagnostics } from '../../services/lsp/LSPDiagnosticRegistry.js'
import { toolMatchesName, type ToolUseContext } from '../../Tool.js'
import { BASH_TOOL_NAME } from '../../tools/BashTool/toolName.js'
import { logForDebugging } from '../debug.js'
import { toError } from '../errors.js'
import { logError } from '../log.js'
import type { Attachment } from './types.js'

async function refreshDiagnosticDocuments(): Promise<void> {
  try {
    const lsp = await import('../../services/lsp/manager.js')
    await lsp.getLspServerManager()?.revalidateOpenDocuments()
  } catch {}
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

export async function getLSPDiagnosticAttachments(context: ToolUseContext): Promise<Attachment[]> {
  if (!context.options.tools.some(tool => toolMatchesName(tool, BASH_TOOL_NAME))) return []
  logForDebugging('LSP Diagnostics: getLSPDiagnosticAttachments called')
  await refreshDiagnosticDocuments()
  return deliverDiagnostics()
}
