// Diagnostics producers — IDE (MCP tracker) and passive-LSP diagnostics,
// both Bash-tool-gated (an agent without Bash can't act on them). Owned
// Mercury module.

import { diagnosticTracker } from '../../services/diagnosticTracking.js'
import {
  checkForLSPDiagnostics,
  clearAllLSPDiagnostics,
} from '../../services/lsp/LSPDiagnosticRegistry.js'
import { toolMatchesName, type ToolUseContext } from '../../Tool.js'
import { BASH_TOOL_NAME } from '../../tools/BashTool/toolName.js'
import { logForDebugging } from '../debug.js'
import { toError } from '../errors.js'
import { logError } from '../log.js'
import type { Attachment } from './types.js'

export async function getDiagnosticAttachments(
  toolUseContext: ToolUseContext,
): Promise<Attachment[]> {
  // No Bash, no diagnostics: an agent that cannot run anything cannot fix
  // what the diagnostics report, so feeding them is pure noise.
  if (
    !toolUseContext.options.tools.some(t => toolMatchesName(t, BASH_TOOL_NAME))
  ) {
    return []
  }

  // The IDE lane: whatever the MCP diagnostic tracker collected since the
  // last drain.
  const newDiagnostics = await diagnosticTracker.getNewDiagnostics()
  if (newDiagnostics.length === 0) {
    return []
  }

  return [
    {
      type: 'diagnostics',
      files: newDiagnostics,
      isNew: true,
    },
  ]
}

/**
 * The passive-LSP lane: language servers push diagnostics into a registry,
 * and this drain turns them into attachments on the same collect-deliver-
 * clear rhythm AsyncHookRegistry uses.
 */
export async function getLSPDiagnosticAttachments(
  toolUseContext: ToolUseContext,
): Promise<Attachment[]> {
  // Same Bash gate as the IDE lane, same reasoning.
  if (
    !toolUseContext.options.tools.some(t => toolMatchesName(t, BASH_TOOL_NAME))
  ) {
    return []
  }

  logForDebugging('LSP Diagnostics: getLSPDiagnosticAttachments called')

  // FN-013 IDE-02a: before the drain delivers, every open document
  // revalidates against disk — otherwise a build's generated declarations
  // (or any out-of-band mutation) leave the servers reporting phantom
  // errors against stale content, and the agent edits correct code to
  // satisfy them. Never throws into the drain; a failed revalidation
  // delivers what stands.
  try {
    const { getLspServerManager } = await import('../../services/lsp/manager.js')
    const manager = getLspServerManager()
    if (manager) await manager.revalidateOpenDocuments()
  } catch {
    /* revalidation is belt-and-braces — never a drain hazard */
  }

  try {
    const diagnosticSets = checkForLSPDiagnostics()

    if (diagnosticSets.length === 0) {
      return []
    }

    logForDebugging(
      `LSP Diagnostics: Found ${diagnosticSets.length} pending diagnostic set(s)`,
    )

    const attachments: Attachment[] = diagnosticSets.map(({ files }) => ({
      type: 'diagnostics' as const,
      files,
      isNew: true,
    }))

    // Delivered means gone: the registry is cleared on the spot (the
    // removeDeliveredAsyncHooks rhythm) or it grows for the session's life.
    if (diagnosticSets.length > 0) {
      clearAllLSPDiagnostics()
      logForDebugging(
        `LSP Diagnostics: Cleared ${diagnosticSets.length} delivered diagnostic(s) from registry`,
      )
    }

    logForDebugging(
      `LSP Diagnostics: Returning ${attachments.length} diagnostic attachment(s)`,
    )

    return attachments
  } catch (error) {
    const err = toError(error)
    logError(
      new Error(`Failed to get LSP diagnostic attachments: ${err.message}`),
    )
    // One broken lane must not sink the rest of the attachment batch.
    return []
  }
}
