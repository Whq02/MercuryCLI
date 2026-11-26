import { dirname } from 'node:path'
import type { ServerCapabilities } from 'vscode-languageserver-protocol'
import {
  clearDeliveredDiagnosticsForFile,
  foldDriveCase,
  rearmAfterMultiFileSync,
  recordPublishedReport,
  registerPendingLSPDiagnostic,
  snapshotDiagnosticsBeforeWrite,
  subscribeLSPDiagnosticPublish,
} from '../../../integrations/lsp/LSPDiagnosticRegistry.js'
import { convertDiagnostics } from '../../../integrations/lsp/publishedDiagnostics.js'
import type { LSPServerManager } from '../../../integrations/lsp/LSPServerManager.js'
import type { OwnerKey } from '../../../engine/run-owner/ownerKey.js'
import { logForDebugging } from '../../../platform/logs/debugLog.js'
import { SERVER_SYNC_DEADLINE_MS, STABILIZE_DEADLINE_MS, STABILIZE_QUIET_WINDOW_MS, countBySeverity } from './shared.js'
import { pullFileDiagnostics, unavailableWords, type PullDiagnosticsOutcome } from './pull.js'
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

export async function syncServersAfterWrites(
  manager: LSPServerManager,
  writes: ReadonlyArray<{ absolutePath: string; newText: string; before: string | null }>,
  owner?: OwnerKey,
  deadlineMs: number = SERVER_SYNC_DEADLINE_MS,
): Promise<Array<{ absolutePath: string; ok: true } | { absolutePath: string; ok: false; reason: string }>> {
  const preVersions = writes.map(w => ({
    path: w.absolutePath,
    docVersion: manager.getDocumentVersion(w.absolutePath),
  }))
  for (let i = 0; i < writes.length; i++) {
    const w = writes[i]!
    snapshotDiagnosticsBeforeWrite(w.absolutePath, w.before, w.newText, preVersions[i]!.docVersion, owner)
    clearDeliveredDiagnosticsForFile(w.absolutePath)
  }
  const results: Array<{ absolutePath: string; ok: true } | { absolutePath: string; ok: false; reason: string }> = []
  for (let i = 0; i < writes.length; i++) {
    const w = writes[i]!
    if (writes.length > 1 && i === writes.length - 1) {
      rearmAfterMultiFileSync(preVersions, owner)
    }
    try {
      await withDeadline(
        manager.changeAndSaveFile(w.absolutePath, w.newText),
        deadlineMs,
        () => {
          throw new Error(`server sync timed out after ${deadlineMs}ms`)
        },
      )
      results.push({ absolutePath: w.absolutePath, ok: true })
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
      logForDebugging(`lsp ops: post-write server sync failed for ${w.absolutePath}: ${reason}`)
      results.push({ absolutePath: w.absolutePath, ok: false, reason })
    }
  }
  return results
}

type DiagnosticStabilization =
  | { state: 'fresh'; errors: number; warnings: number; total: number }
  | { state: 'unchanged'; errors: number; warnings: number; total: number }
  | { state: 'unsupported' }
  | { state: 'failed'; reason: string }
  | { state: 'timed-out'; waitedMs: number }

function plainPath(uriOrPath: string): string {
  return foldDriveCase(uriOrPath.startsWith('file://') ? uriOrPath.slice('file://'.length) : uriOrPath)
}

function recordPulledPostApply(
  absolutePath: string,
  outcome: Extract<PullDiagnosticsOutcome, { kind: 'fresh' | 'unchanged' }>,
): void {
  const pulled = outcome.pulledByServer
  if (pulled === undefined || pulled.length === 0) return
  const uri = foldDriveCase(absolutePath)
  for (const entry of pulled) {
    const file = { uri, diagnostics: convertDiagnostics(entry.items) }
    recordPublishedReport(entry.serverName, file, outcome.docVersion)
    registerPendingLSPDiagnostic({
      serverName: entry.serverName,
      files: [file],
      ...(outcome.docVersion !== undefined ? { version: outcome.docVersion } : {}),
    })
  }
}

async function stabilizePullPaths(
  manager: LSPServerManager,
  pullPaths: readonly string[],
  deadlineMs: number,
): Promise<DiagnosticStabilization> {
  try {
    const outcomes = await withDeadline(
      Promise.all(pullPaths.map(async path => ({ path, outcome: await pullFileDiagnostics(manager, path) }))),
      deadlineMs,
      () => 'timeout' as const,
    )
    if (outcomes === 'timeout') return { state: 'timed-out', waitedMs: deadlineMs }
    let errors = 0
    let warnings = 0
    let total = 0
    let anyFresh = false
    let anySettled = false
    let firstFailure: string | undefined
    for (const { path, outcome } of outcomes) {
      if (outcome.kind === 'unsupported' || outcome.kind === 'no-claimant') continue
      if (outcome.kind === 'protocol-violation') {
        firstFailure ??= outcome.detail
        continue
      }
      if (outcome.kind === 'unavailable') {
        firstFailure ??= unavailableWords(outcome.failed, path, dirname(path)).what
        continue
      }
      recordPulledPostApply(path, outcome)
      const counts = countBySeverity(outcome.items)
      errors += counts.errors
      warnings += counts.warnings
      total += outcome.items.length
      if (outcome.kind === 'fresh') anyFresh = true
      anySettled = true
    }
    if (!anySettled) {
      return firstFailure !== undefined ? { state: 'failed', reason: firstFailure } : { state: 'unsupported' }
    }
    return { state: anyFresh ? 'fresh' : 'unchanged', errors, warnings, total }
  } catch (error) {
    return { state: 'failed', reason: error instanceof Error ? error.message : String(error) }
  }
}

function stabilizePushPaths(
  pushPaths: readonly string[],
  deadlineMs: number,
  quietWindowMs: number,
): Promise<DiagnosticStabilization> {
  const watched = new Set(pushPaths.map(plainPath))
  return new Promise<DiagnosticStabilization>(resolvePromise => {
    const latestByFile = new Map<string, { errors: number; warnings: number; total: number }>()
    let quietTimer: NodeJS.Timeout | undefined
    let settled = false
    const totals = (): { errors: number; warnings: number; total: number } => {
      let errors = 0
      let warnings = 0
      let total = 0
      for (const counts of latestByFile.values()) {
        errors += counts.errors
        warnings += counts.warnings
        total += counts.total
      }
      return { errors, warnings, total }
    }
    const finish = (outcome: DiagnosticStabilization): void => {
      if (settled) return
      settled = true
      if (quietTimer !== undefined) stopTimeout(quietTimer)
      stopTimeout(deadlineTimer)
      unsubscribe()
      resolvePromise(outcome)
    }
    const unsubscribe = subscribeLSPDiagnosticPublish(event => {
      let matchedAny = false
      for (const file of event.files) {
        const key = plainPath(file.uri)
        if (!watched.has(key)) continue
        matchedAny = true
        let errors = 0
        let warnings = 0
        let total = 0
        for (const diagnostic of file.diagnostics) {
          total++
          if (diagnostic.severity === 'Error') errors++
          else if (diagnostic.severity === 'Warning') warnings++
        }
        latestByFile.set(key, { errors, warnings, total })
      }
      if (!matchedAny) return
      if (quietTimer !== undefined) stopTimeout(quietTimer)
      quietTimer = startTimeout(() => {
        finish({ state: 'fresh', ...totals() })
      }, quietWindowMs)
    })
    const deadlineTimer = startTimeout(() => {
      if (latestByFile.size > 0) finish({ state: 'fresh', ...totals() })
      else finish({ state: 'timed-out', waitedMs: deadlineMs })
    }, deadlineMs)
  })
}

export async function awaitDiagnosticStabilization(
  manager: LSPServerManager,
  absolutePathOrPaths: string | readonly string[],
  opts?: { deadlineMs?: number; quietWindowMs?: number },
): Promise<DiagnosticStabilization> {
  const deadlineMs = opts?.deadlineMs ?? STABILIZE_DEADLINE_MS
  const quietWindowMs = opts?.quietWindowMs ?? STABILIZE_QUIET_WINDOW_MS
  const rawPaths = typeof absolutePathOrPaths === 'string' ? [absolutePathOrPaths] : absolutePathOrPaths
  const seen = new Set<string>()
  const pullPaths: string[] = []
  const pushPaths: string[] = []
  for (const absolutePath of rawPaths) {
    const key = plainPath(absolutePath)
    if (seen.has(key)) continue
    seen.add(key)
    const server = manager.getServerForFile(absolutePath)
    if (!server) continue
    const capabilities = server.capabilities as ServerCapabilities | undefined
    if (capabilities?.diagnosticProvider) pullPaths.push(absolutePath)
    else pushPaths.push(absolutePath)
  }
  if (pullPaths.length === 0 && pushPaths.length === 0) return { state: 'unsupported' }
  if (pushPaths.length === 0) return stabilizePullPaths(manager, pullPaths, deadlineMs)
  if (pullPaths.length === 0) return stabilizePushPaths(pushPaths, deadlineMs, quietWindowMs)

  const [pullOutcome, pushOutcome] = await Promise.all([
    stabilizePullPaths(manager, pullPaths, deadlineMs),
    stabilizePushPaths(pushPaths, deadlineMs, quietWindowMs),
  ])
  const settledOutcomes = [pullOutcome, pushOutcome].filter(
    (item): item is Extract<DiagnosticStabilization, { state: 'fresh' | 'unchanged' }> =>
      item.state === 'fresh' || item.state === 'unchanged',
  )
  if (settledOutcomes.length > 0) {
    return {
      state: settledOutcomes.some(item => item.state === 'fresh') ? 'fresh' : 'unchanged',
      errors: settledOutcomes.reduce((sum, item) => sum + item.errors, 0),
      warnings: settledOutcomes.reduce((sum, item) => sum + item.warnings, 0),
      total: settledOutcomes.reduce((sum, item) => sum + item.total, 0),
    }
  }
  return pullOutcome.state === 'failed' ? pullOutcome : pushOutcome
}
