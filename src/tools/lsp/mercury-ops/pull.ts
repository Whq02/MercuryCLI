import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { ServerCapabilities } from 'vscode-languageserver-protocol'
import { lspStartFailureWords, remedyForLanguageServer, serverTitle, startFailureCause, unclaimedCause } from '../../../integrations/lsp/failureWords.js'
import { isLspStartFailure, type LSPServerInstance, type LspStartFailure } from '../../../integrations/lsp/LSPServerInstance.js'
import type { LSPServerManager } from '../../../integrations/lsp/LSPServerManager.js'
import { type LspRangeLike } from '../../../integrations/lsp/workspaceEditApply.js'
import { logForDebugging } from '../../../platform/logs/debugLog.js'
import type { LspWireDiagnostic } from './shared.js'
import { passedOver } from '../../../platform/errors/passedOver.js'
import { startTimeout, stopTimeout } from '../../../platform/async/timers.js'

type DiagnosticsBaseline = {
  generationKey: string
  docVersion: number | undefined
  resultId: string | undefined
  items: LspWireDiagnostic[]
}

const diagnosticsBaselines = new Map<string, DiagnosticsBaseline>()

export function clearDiagnosticsBaselines(): void {
  diagnosticsBaselines.clear()
}

type ClaimantFailure = { server: LSPServerInstance; stage: 'start' | 'pull'; cause: string; startFailure?: LspStartFailure }

export type PullDiagnosticsOutcome =
  | {
      kind: 'fresh'
      items: LspWireDiagnostic[]
      docVersion: number | undefined
      pulledFrom?: string[]
      pulledByServer?: Array<{ serverName: string; items: LspWireDiagnostic[] }>
      pushed?: string[]
      failed?: ClaimantFailure[]
    }
  | {
      kind: 'unchanged'
      items: LspWireDiagnostic[]
      docVersion: number | undefined
      pulledFrom?: string[]
      pulledByServer?: Array<{ serverName: string; items: LspWireDiagnostic[] }>
      pushed?: string[]
      failed?: ClaimantFailure[]
    }
  | { kind: 'unsupported'; pushOnly: string[] }
  | { kind: 'unavailable'; failed: ClaimantFailure[] }
  | { kind: 'no-claimant' }
  | { kind: 'protocol-violation'; detail: string }

function claimantFailureWords(failure: ClaimantFailure, path: string, cwd: string): { what: string; remedy: string } {
  const title = serverTitle(failure.server, path)
  const remedy = remedyForLanguageServer(failure.server, path, failure.cause, cwd)
  const what = failure.startFailure
    ? lspStartFailureWords(failure.startFailure, title, '', `${title} did not start: ${failure.cause}.`).replace(/\.$/, '')
    : failure.stage === 'start'
      ? `${title} did not start: ${failure.cause}`
      : `${title} did not answer textDocument/diagnostic: ${failure.cause}`
  return { what, remedy }
}

function requestFailureCause(server: LSPServerInstance, method: string, error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error)
  return raw.replace(`LSP request ${method} to server ${server.name} `, '').replace(/^failed: /, '').trim()
}

export function remedyForUnclaimedExtension(extension: string, cwd?: string): string {
  try {
    if (cwd !== undefined) {
      const typescript = unclaimedCause(extension, cwd)
      if (typescript.remedy !== '') return `${typescript.cause}. What helps: ${typescript.remedy}.`
    }
    if (extension === '.py' || extension === '.pyi') {
      const { probeBuiltinPyright } = require('../../../integrations/lsp/pyrightLane.js') as typeof import('../../../integrations/lsp/pyrightLane.js')
      const { probeRuff } = require('../../../integrations/lsp/ruffLane.js') as typeof import('../../../integrations/lsp/ruffLane.js')
      const reasons = [probeBuiltinPyright(), probeRuff()]
        .map(p => ('reason' in p ? p.reason : undefined))
        .filter((r): r is string => r !== undefined && r.length > 0)
      if (reasons.length > 0) return `Arm the Python lanes: ${reasons.join(' — and: ')}`
    }
    const { SERVER_CATALOGUE } = require('../../../integrations/lsp/serverCatalogue.js') as typeof import('../../../integrations/lsp/serverCatalogue.js')
    const entries = SERVER_CATALOGUE.filter(e => extension in e.extensionToLanguage)
    if (entries.length > 0) {
      return `Install ${entries.map(e => `${e.label} (${e.remedy})`).join(' or ')}.`
    }
  } catch (error) {
    passedOver(error)
  }
  return `No built-in or catalogued server covers '${extension}' — add one via MERCURY_LSP_SERVERS or an extension that contributes a language server.`
}

function publishedToWire(diagnostic: {
  message: string
  severity: 'Error' | 'Warning' | 'Info' | 'Hint'
  range: LspRangeLike
  source?: string
  code?: string
}): LspWireDiagnostic {
  const severityNumber = { Error: 1, Warning: 2, Info: 3, Hint: 4 }[diagnostic.severity] ?? 1
  return {
    range: diagnostic.range,
    severity: severityNumber,
    message: diagnostic.message,
    ...(diagnostic.source !== undefined ? { source: diagnostic.source } : {}),
    ...(diagnostic.code !== undefined ? { code: diagnostic.code } : {}),
  }
}

async function harvestPublishedReports(
  absolutePath: string,
  serverNames: string[],
  deadlineMs: number,
): Promise<Array<{ serverName: string; items: LspWireDiagnostic[]; ageMs: number }>> {
  if (serverNames.length === 0) return []
  const registry = await import('../../../integrations/lsp/LSPDiagnosticRegistry.js')
  const abs = resolve(absolutePath)
  const collect = (): Array<{ serverName: string; items: LspWireDiagnostic[]; ageMs: number }> => {
    const out: Array<{ serverName: string; items: LspWireDiagnostic[]; ageMs: number }> = []
    for (const name of serverNames) {
      const report = registry.peekLastPublishedReport(name, abs)
      if (report) {
        out.push({
          serverName: name,
          items: report.file.diagnostics.map(publishedToWire),
          ageMs: Date.now() - report.at,
        })
      }
    }
    return out
  }
  const immediate = collect()
  if (immediate.length === serverNames.length) return immediate
  return await new Promise(resolvePromise => {
    const finish = (): void => {
      stopTimeout(timer)
      unsubscribe()
      resolvePromise(collect())
    }
    const timer = startTimeout(finish, deadlineMs)
    const unsubscribe = registry.subscribePublishedReports(event => {
      if (!serverNames.includes(event.serverName)) return
      const plain = event.file.uri.startsWith('file://')
        ? event.file.uri.slice('file://'.length)
        : event.file.uri
      if (registry.foldDriveCase(plain) !== registry.foldDriveCase(abs)) return
      if (collect().length === serverNames.length) finish()
    })
  })
}

export async function pullFileDiagnostics(
  manager: LSPServerManager,
  absolutePath: string,
): Promise<PullDiagnosticsOutcome> {
  const claimants = manager.getServersForFile(absolutePath)
  if (claimants.length === 0) {
    return { kind: 'no-claimant' }
  }
  const uri = pathToFileURL(resolve(absolutePath)).href
  const docVersion = manager.getDocumentVersion(absolutePath)
  const pulledItems: LspWireDiagnostic[] = []
  const pulledFrom: string[] = []
  const pulledByServer: Array<{ serverName: string; items: LspWireDiagnostic[] }> = []
  const pushOnlyNames: string[] = []
  const failed: ClaimantFailure[] = []
  let anyFresh = false
  let violation: string | null = null
  for (const server of claimants) {
    if (server.state === 'stopped' || server.state === 'error') {
      try {
        await server.start()
      } catch (err) {
        failed.push({ server, stage: 'start', cause: isLspStartFailure(err) ? err.lspCause : startFailureCause(server.name, err), ...(isLspStartFailure(err) ? { startFailure: err } : {}) })
        continue
      }
    }
    const capabilities = server.capabilities as ServerCapabilities | undefined
    if (!capabilities?.diagnosticProvider) {
      pushOnlyNames.push(server.name)
      continue
    }
    const generationKey = `${server.name}#${server.generation}`
    const baselineKey = `${server.name}::${uri}`
    const baseline = diagnosticsBaselines.get(baselineKey)
    const baselineUsable =
      baseline !== undefined &&
      baseline.generationKey === generationKey &&
      baseline.docVersion === docVersion &&
      baseline.resultId !== undefined
    const params: Record<string, unknown> = { textDocument: { uri } }
    if (baselineUsable) params.previousResultId = baseline.resultId
    let response: { kind?: string; resultId?: string; items?: LspWireDiagnostic[] } | undefined | null
    try {
      response = await server.sendRequest<{
        kind?: string
        resultId?: string
        items?: LspWireDiagnostic[]
      }>('textDocument/diagnostic', params)
    } catch (err) {
      logForDebugging(`lsp ops: pull from ${server.name} failed: ${String(err)}`)
      failed.push({ server, stage: 'pull', cause: requestFailureCause(server, 'textDocument/diagnostic', err) })
      continue
    }
    if (response === undefined || response === null) continue
    if (response.kind === 'unchanged') {
      if (!baselineUsable) {
        violation = `${server.name} answered 'unchanged' without a baseline to be unchanged against (protocol violation)`
        continue
      }
      pulledItems.push(...baseline.items)
      pulledFrom.push(server.name)
      pulledByServer.push({ serverName: server.name, items: baseline.items })
      continue
    }
    const items = Array.isArray(response.items) ? response.items : []
    diagnosticsBaselines.set(baselineKey, {
      generationKey,
      docVersion,
      resultId: response.resultId,
      items,
    })
    pulledItems.push(...items)
    pulledFrom.push(server.name)
    pulledByServer.push({ serverName: server.name, items })
    anyFresh = true
  }
  const pushed = await harvestPublishedReports(
    absolutePath,
    pushOnlyNames,
    pulledFrom.length > 0 ? 1_500 : 5_000,
  )
  const pushedNames = pushed.map(p =>
    p.ageMs > 5_000 ? `${p.serverName} (${Math.round(p.ageMs / 1000)}s ago)` : p.serverName,
  )
  for (const p of pushed) pulledItems.push(...p.items)
  if (pulledFrom.length === 0 && pushed.length === 0) {
    if (violation) return { kind: 'protocol-violation', detail: violation }
    if (failed.length > 0) return { kind: 'unavailable', failed }
    return { kind: 'unsupported', pushOnly: pushOnlyNames }
  }
  return {
    kind: anyFresh || pushed.length > 0 ? 'fresh' : 'unchanged',
    items: pulledItems,
    docVersion,
    ...(pulledFrom.length > 0 ? { pulledFrom, pulledByServer } : {}),
    ...(pushedNames.length > 0 ? { pushed: pushedNames } : {}),
    ...(failed.length > 0 ? { failed } : {}),
  }
}

export function unavailableWords(failed: ClaimantFailure[], path: string, cwd: string): { what: string; remedy: string; servers: Array<{ server: string; cause: string }> } {
  const words = failed.map(failure => claimantFailureWords(failure, path, cwd))
  const remedies = [...new Set(words.map(w => w.remedy).filter(r => r !== ''))]
  return { what: words.map(w => w.what).join('; '), remedy: remedies.join('; '), servers: failed.map(f => ({ server: f.server.name, cause: f.cause })) }
}
