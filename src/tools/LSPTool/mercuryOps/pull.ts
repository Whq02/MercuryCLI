import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { ServerCapabilities } from 'vscode-languageserver-protocol'
import { lspStartFailureWords, remedyForLanguageServer, serverTitle, startFailureCause, unclaimedCause } from '../../../services/lsp/failureWords.js'
import { isLspStartFailure, type LSPServerInstance, type LspStartFailure } from '../../../services/lsp/LSPServerInstance.js'
import type { LSPServerManager } from '../../../services/lsp/LSPServerManager.js'
import { type LspRangeLike } from '../../../services/lsp/workspaceEditApply.js'
import { logForDebugging } from '../../../utils/debug.js'
import type { LspWireDiagnostic } from './shared.js'
import { passedOver } from '../../../utils/passedOver.js'
import { startTimeout, stopTimeout } from '../../../utils/timers.js'
import { notBuilt } from '../../../pi/holes.js'

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
      pushed?: string[]
      failed?: ClaimantFailure[]
    }
  | {
      kind: 'unchanged'
      items: LspWireDiagnostic[]
      docVersion: number | undefined
      pulledFrom?: string[]
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
      const { probeBuiltinPyright } = require('../../../services/lsp/pyrightLane.js') as typeof import('../../../services/lsp/pyrightLane.js')
      const { probeRuff } = require('../../../services/lsp/ruffLane.js') as typeof import('../../../services/lsp/ruffLane.js')
      const reasons = [probeBuiltinPyright(), probeRuff()]
        .map(p => ('reason' in p ? p.reason : undefined))
        .filter((r): r is string => r !== undefined && r.length > 0)
      if (reasons.length > 0) return `Arm the Python lanes: ${reasons.join(' — and: ')}`
    }
    const { SERVER_CATALOGUE } = require('../../../services/lsp/serverCatalogue.js') as typeof import('../../../services/lsp/serverCatalogue.js')
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
  const registry = await import('../../../services/lsp/LSPDiagnosticRegistry.js')
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
  return notBuilt('src/tools/LSPTool/mercuryOps/pull.ts:150')
}

export function unavailableWords(failed: ClaimantFailure[], path: string, cwd: string): { what: string; remedy: string; servers: Array<{ server: string; cause: string }> } {
  const words = failed.map(failure => claimantFailureWords(failure, path, cwd))
  const remedies = [...new Set(words.map(w => w.remedy).filter(r => r !== ''))]
  return { what: words.map(w => w.what).join('; '), remedy: remedies.join('; '), servers: failed.map(f => ({ server: f.server.name, cause: f.cause })) }
}
