import { fileURLToPath } from 'node:url'
import { foldDriveCase } from './LSPDiagnosticRegistry.js'

import type { PublishDiagnosticsParams } from 'vscode-languageserver-protocol'

import { logForDebugging } from '../../utils/debug.js'
import { logError } from '../../utils/log.js'
import type { Diagnostic, DiagnosticFile } from '../diagnosticTracking.js'
import { recordPublishedReport, registerPendingLSPDiagnostic } from './LSPDiagnosticRegistry.js'
import type { LSPServerManager } from './LSPServerManager.js'

/**
 * Converts LSP `publishDiagnostics` payloads to the internal diagnostic shape
 * and registers per-server notification handlers with isolated failure
 * tracking.
 */

export type HandlerRegistrationResult = {
  totalServers: number
  successCount: number
  registrationErrors: Array<{ serverName: string; error: Error }>
  diagnosticFailures: Map<string, { count: number; lastError: string }>
}

const CONSECUTIVE_FAILURE_WARN_AT = 3

function severityName(severity: unknown): Diagnostic['severity'] {
  switch (severity) {
    case 1:
      return 'Error'
    case 2:
      return 'Warning'
    case 3:
      return 'Info'
    case 4:
      return 'Hint'
    default:
      // Anything else, including absent, maps to Error.
      return 'Error'
  }
}

/** Exactly one file entry; the URI normalised to a filesystem path when file://. */
export function formatDiagnosticsForAttachment(publishParams: PublishDiagnosticsParams): DiagnosticFile[] {
  let uri = publishParams.uri
  if (uri.startsWith('file://')) {
    try {
      uri = foldDriveCase(fileURLToPath(uri))
    } catch (err) {
      // Servers do send malformed URIs; fall back to the original string.
      logForDebugging(`passiveFeedback: could not convert URI ${uri}: ${String(err)}`)
    }
  }
  const diagnostics: Diagnostic[] = publishParams.diagnostics.map(diagnostic => {
    const rawMessage = diagnostic.message as unknown
    const message =
      typeof rawMessage === 'string'
        ? rawMessage
        : String((rawMessage as { value?: unknown } | null)?.value ?? '')
    const entry: Diagnostic = {
      message,
      severity: severityName(diagnostic.severity),
      range: {
        start: { line: diagnostic.range.start.line, character: diagnostic.range.start.character },
        end: { line: diagnostic.range.end.line, character: diagnostic.range.end.character },
      },
    }
    if (diagnostic.source !== undefined) entry.source = diagnostic.source
    if (diagnostic.code !== undefined && diagnostic.code !== null) entry.code = String(diagnostic.code)
    return entry
  })
  return [{ uri, diagnostics }]
}

export function registerLSPNotificationHandlers(manager: LSPServerManager): HandlerRegistrationResult {
  const servers = manager.getAllServers()
  const registrationErrors: Array<{ serverName: string; error: Error }> = []
  const diagnosticFailures = new Map<string, { count: number; lastError: string }>()
  let successCount = 0

  const recordFailure = (serverName: string, err: unknown): void => {
    const message = err instanceof Error ? err.message : String(err)
    const current = diagnosticFailures.get(serverName) ?? { count: 0, lastError: '' }
    current.count++
    current.lastError = message
    diagnosticFailures.set(serverName, current)
    if (current.count >= CONSECUTIVE_FAILURE_WARN_AT) {
      logForDebugging(
        `passiveFeedback: ${serverName} has failed ${current.count} consecutive diagnostic deliveries (last: ${message}) — the server or the diagnostic processing is the likely cause`,
        { level: 'warn' },
      )
    }
  }

  for (const [serverName, instance] of servers) {
    try {
      if (instance === undefined || instance === null) {
        registrationErrors.push({ serverName, error: new Error(`server instance is null/undefined`) })
        continue
      }
      if (typeof instance.onNotification !== 'function') {
        registrationErrors.push({ serverName, error: new Error(`server has no notification registration method`) })
        continue
      }
      instance.onNotification('textDocument/publishDiagnostics', params => {
        try {
          const payload = params as PublishDiagnosticsParams | undefined
          if (!payload || typeof payload.uri !== 'string' || !Array.isArray(payload.diagnostics)) {
            logError(new Error(`passiveFeedback: malformed publishDiagnostics from ${serverName}`))
            return
          }
          const files = formatDiagnosticsForAttachment(payload)
          // The last-report ledger records EVERY publish (clean ones too) —
          // the diagnostics op's push harvest reads it; delivery semantics
          // below are untouched.
          if (files.length > 0) {
            recordPublishedReport(serverName, files[0] as DiagnosticFile)
          }
          if (files.length === 0 || (files[0] as DiagnosticFile).diagnostics.length === 0) {
            // The "all clear" signal is not delivered as an attachment.
            logForDebugging(`passiveFeedback: ${serverName} published an empty diagnostic set for ${payload.uri}`)
            return
          }
          try {
            registerPendingLSPDiagnostic({ serverName, files })
            diagnosticFailures.set(serverName, { count: 0, lastError: '' })
          } catch (err) {
            logError(err)
            recordFailure(serverName, err)
          }
        } catch (err) {
          // Never rethrow: one server's handler must not break the loop.
          logError(err)
          recordFailure(serverName, err)
        }
      })
      successCount++
    } catch (err) {
      registrationErrors.push({ serverName, error: err instanceof Error ? err : new Error(String(err)) })
    }
  }

  const totalServers = servers.size
  if (registrationErrors.length > 0) {
    logError(
      new Error(
        `passiveFeedback: diagnostic handler registration failed for ${registrationErrors
          .map(entry => entry.serverName)
          .join(', ')}`,
      ),
    )
    logForDebugging(
      `passiveFeedback: ${successCount}/${totalServers} handlers registered; diagnostics from failed servers will not be delivered`,
    )
  } else {
    logForDebugging(`passiveFeedback: registered diagnostic handlers for ${successCount}/${totalServers} servers`)
  }
  return { totalServers, successCount, registrationErrors, diagnosticFailures }
}
