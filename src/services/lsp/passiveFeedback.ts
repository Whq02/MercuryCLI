import { fileURLToPath } from 'node:url'
import { foldDriveCase } from './LSPDiagnosticRegistry.js'

import type { PublishDiagnosticsParams } from 'vscode-languageserver-protocol'

import { logForDebugging } from '../../utils/debug.js'
import { logError } from '../../utils/log.js'
import type { Diagnostic, DiagnosticFile } from '../../utils/diagnosticTracking.js'
import { recordPublishedReport, registerPendingLSPDiagnostic } from './LSPDiagnosticRegistry.js'
import type { LSPServerManager } from './LSPServerManager.js'
import { notBuilt, type Unbuilt } from '../../pi/holes.js'


type HandlerRegistrationResult = Unbuilt

export function registerLSPNotificationHandlers(manager: LSPServerManager): HandlerRegistrationResult {
  return notBuilt('src/services/lsp/passiveFeedback.ts:67')
}
