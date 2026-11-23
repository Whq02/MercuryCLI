import { fileURLToPath } from 'node:url'
import { foldDriveCase } from './LSPDiagnosticRegistry.js'

import type { PublishDiagnosticsParams } from 'vscode-languageserver-protocol'

import { logForDebugging } from '../../utils/debug.js'
import { logError } from '../../utils/log.js'
import type { Diagnostic, DiagnosticFile } from '../../utils/diagnosticTracking.js'
import { recordPublishedReport, registerPendingLSPDiagnostic } from './LSPDiagnosticRegistry.js'
import type { LSPServerManager } from './LSPServerManager.js'


type HandlerRegistrationResult = {
  totalServers: number
  successCount: number
  registrationErrors: Array<{ serverName: string; error: Error }>
  diagnosticFailures: Map<string, { count: number; lastError: string }>
}

function formatDiagnosticMessage(raw: unknown): string {
  if (typeof raw === 'string') return raw
  if (raw !== null && typeof raw === 'object' && 'value' in raw) {
    return raw.value === undefined || raw.value === null ? '' : String(raw.value)
  }
  return ''
}

function formatSeverity(severity: number | undefined): Diagnostic['severity'] {
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
      return 'Error'
  }
}

function convertDiagnostics(rawDiagnostics: PublishDiagnosticsParams['diagnostics']): Diagnostic[] {
  return rawDiagnostics.map(diag => ({
    message: formatDiagnosticMessage(diag.message),
    severity: formatSeverity(diag.severity),
    range: {
      start: {
        line: diag.range.start.line,
        character: diag.range.start.character,
      },
      end: {
        line: diag.range.end.line,
        character: diag.range.end.character,
      },
    },
    ...(diag.source !== undefined ? { source: diag.source } : {}),
    ...(diag.code !== undefined && diag.code !== null ? { code: String(diag.code) } : {}),
  }))
}

export function registerLSPNotificationHandlers(manager: LSPServerManager): HandlerRegistrationResult {
  const servers = manager.getAllServers()
  const totalServers = servers.size
  let successCount = 0
  const registrationErrors: Array<{ serverName: string; error: Error }> = []
  const diagnosticFailures = new Map<string, { count: number; lastError: string }>()

  for (const [serverName, server] of servers) {
    if (server === null || server === undefined) {
      registrationErrors.push({
        serverName,
        error: new Error('server instance is null/undefined'),
      })
      continue
    }
    if (typeof server.onNotification !== 'function') {
      registrationErrors.push({
        serverName,
        error: new Error('server has no notification registration method'),
      })
      continue
    }
    try {
      server.onNotification('textDocument/publishDiagnostics', (params: unknown) => {
        if (
          params === null ||
          params === undefined ||
          typeof params !== 'object' ||
          typeof (params as PublishDiagnosticsParams).uri !== 'string' ||
          !Array.isArray((params as PublishDiagnosticsParams).diagnostics)
        ) {
          logForDebugging(`passiveFeedback: malformed publishDiagnostics from ${serverName}`)
          return
        }
        try {
          const publish = params as PublishDiagnosticsParams
          let uri = publish.uri
          if (uri.startsWith('file://')) {
            try {
              uri = foldDriveCase(fileURLToPath(uri))
            } catch (err) {
              logForDebugging(
                `passiveFeedback: could not convert URI ${uri}: ${err instanceof Error ? err.message : String(err)}`,
              )
            }
          }
          const diagnostics = convertDiagnostics(publish.diagnostics)
          const file: DiagnosticFile = { uri, diagnostics }
          const version = typeof publish.version === 'number' ? publish.version : undefined
          recordPublishedReport(serverName, file, version)
          if (diagnostics.length === 0) {
            logForDebugging(`passiveFeedback: ${serverName} published an empty diagnostic set for ${publish.uri}`)
          }
          registerPendingLSPDiagnostic({
            serverName,
            files: [file],
            ...(version !== undefined ? { version } : {}),
          })
          diagnosticFailures.set(serverName, { count: 0, lastError: '' })
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err)
          logError(err instanceof Error ? err : new Error(message))
          const prev = diagnosticFailures.get(serverName)
          const count = (prev?.count ?? 0) + 1
          diagnosticFailures.set(serverName, { count, lastError: message })
          if (count >= 3) {
            logForDebugging(
              `passiveFeedback: ${serverName} has failed ${count} consecutive diagnostic deliveries (last: ${message}) — the server or the diagnostic processing is the likely cause`,
              { level: 'warn' },
            )
          }
        }
      })
      successCount++
    } catch (err) {
      registrationErrors.push({
        serverName,
        error: err instanceof Error ? err : new Error(String(err)),
      })
    }
  }

  if (registrationErrors.length > 0) {
    const failedNames = registrationErrors.map(entry => entry.serverName).join(', ')
    logError(new Error(`passiveFeedback: diagnostic handler registration failed for ${failedNames}`))
    logForDebugging(
      `passiveFeedback: ${successCount}/${totalServers} handlers registered; diagnostics from failed servers will not be delivered`,
    )
  } else {
    logForDebugging(`passiveFeedback: registered diagnostic handlers for ${successCount}/${totalServers} servers`)
  }

  return {
    totalServers,
    successCount,
    registrationErrors,
    diagnosticFailures,
  }
}
