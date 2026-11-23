import { dirname } from 'node:path'
import type { ServerCapabilities } from 'vscode-languageserver-protocol'
import { clearDeliveredDiagnosticsForFile, foldDriveCase, snapshotDiagnosticsBeforeWrite, subscribeLSPDiagnosticPublish } from '../../../integrations/lsp/LSPDiagnosticRegistry.js'
import type { LSPServerManager } from '../../../integrations/lsp/LSPServerManager.js'
import type { OwnerKey } from '../../../engine/run-owner/ownerKey.js'
import { logForDebugging } from '../../../platform/logs/debugLog.js'
import { SERVER_SYNC_DEADLINE_MS, STABILIZE_DEADLINE_MS, STABILIZE_QUIET_WINDOW_MS, countBySeverity } from './shared.js'
import { pullFileDiagnostics, unavailableWords } from './pull.js'
import { withDeadline } from '../../../platform/async/deadline.js'
import { startTimeout, stopTimeout } from '../../../platform/async/timers.js'

export async function syncServersAfterWrite(
  manager: LSPServerManager,
  absolutePath: string,
  newText: string,
  before: string | null = null,
  owner?: OwnerKey,
  deadlineMs: number = SERVER_SYNC_DEADLINE_MS,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  snapshotDiagnosticsBeforeWrite(absolutePath, before, newText, manager.getDocumentVersion(absolutePath), owner)
  clearDeliveredDiagnosticsForFile(absolutePath)
  try {
    await withDeadline(
      manager.changeAndSaveFile(absolutePath, newText),
      deadlineMs,
      () => {
        throw new Error(`server sync timed out after ${deadlineMs}ms`)
      },
    )
    return { ok: true }
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    logForDebugging(`lsp ops: post-write server sync failed for ${absolutePath}: ${reason}`)
    return { ok: false, reason }
  }
}

type DiagnosticStabilization =
  | { state: 'fresh'; errors: number; warnings: number; total: number }
  | { state: 'unchanged'; errors: number; warnings: number; total: number }
  | { state: 'unsupported' }
  | { state: 'failed'; reason: string }
  | { state: 'timed-out'; waitedMs: number }

function uriMatchesFile(uri: string, absolutePath: string): boolean {
  return foldDriveCase(uri).endsWith(foldDriveCase(absolutePath))
}

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
    try {
      const outcome = await withDeadline(
        pullFileDiagnostics(manager, absolutePath),
        deadlineMs,
        () => 'timeout' as const,
      )
      if (outcome === 'timeout') return { state: 'timed-out', waitedMs: deadlineMs }
      if (outcome.kind === 'unsupported' || outcome.kind === 'no-claimant') return { state: 'unsupported' }
      if (outcome.kind === 'protocol-violation') return { state: 'failed', reason: outcome.detail }
      if (outcome.kind === 'unavailable') return { state: 'failed', reason: unavailableWords(outcome.failed, absolutePath, dirname(absolutePath)).what }
      const { errors, warnings } = countBySeverity(outcome.items)
      return {
        state: outcome.kind === 'fresh' ? 'fresh' : 'unchanged',
        errors,
        warnings,
        total: outcome.items.length,
      }
    } catch (error) {
      return { state: 'failed', reason: error instanceof Error ? error.message : String(error) }
    }
  }

  return new Promise<DiagnosticStabilization>(resolvePromise => {
    let lastCounts: { errors: number; warnings: number; total: number } | undefined
    let quietTimer: NodeJS.Timeout | undefined
    let settled = false
    const finish = (outcome: DiagnosticStabilization): void => {
      if (settled) return
      settled = true
      if (quietTimer !== undefined) stopTimeout(quietTimer)
      stopTimeout(deadlineTimer)
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
      if (quietTimer !== undefined) stopTimeout(quietTimer)
      quietTimer = startTimeout(() => {
        finish({ state: 'fresh', ...lastCounts! })
      }, quietWindowMs)
    })
    const deadlineTimer = startTimeout(() => {
      if (lastCounts !== undefined) finish({ state: 'fresh', ...lastCounts })
      else finish({ state: 'timed-out', waitedMs: deadlineMs })
    }, deadlineMs)
  })
}
