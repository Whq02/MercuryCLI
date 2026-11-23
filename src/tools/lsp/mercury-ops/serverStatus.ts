import type { ServerCapabilities } from 'vscode-languageserver-protocol'
import { builtinImplementationInfo } from '../../../integrations/lsp/builtinServers.js'
import type { LSPServerManager } from '../../../integrations/lsp/LSPServerManager.js'
import type { MercuryLspOpOutput, OpEnv } from './types.js'

type LspServerStatusRow = {
  name: string
  state: string
  generation: number
  restartCount: number
  lastError: string | null
  claimsFile: boolean
  implementation?: { source: string; version?: string }
  capabilities: {
    rename: boolean
    codeActions: boolean
    pullDiagnostics: boolean
    typeDefinition: boolean
    pathRename: boolean
    callHierarchy: boolean
  }
}

function statusRowsFor(manager: LSPServerManager, filePath?: string): LspServerStatusRow[] {
  const claimant = filePath ? manager.getServerForFile(filePath) : undefined
  const rows: LspServerStatusRow[] = []
  for (const server of manager.getAllServers().values()) {
    const capabilities = server.capabilities as ServerCapabilities | undefined
    const configSource = (server.config as { source?: string } | undefined)?.source
    const implementation =
      builtinImplementationInfo(server.name) ??
      (configSource === 'mercury-env' ? { source: 'operator-configured' } : undefined)
    rows.push({
      name: server.name,
      state: server.state,
      generation: server.generation,
      restartCount: server.restartCount,
      lastError: server.lastError ? server.lastError.message : null,
      claimsFile: claimant !== undefined && claimant.name === server.name,
      ...(implementation ? { implementation } : {}),
      capabilities: {
        rename: Boolean(capabilities?.renameProvider),
        codeActions: Boolean(capabilities?.codeActionProvider),
        pullDiagnostics: Boolean(capabilities?.diagnosticProvider),
        typeDefinition: Boolean(capabilities?.typeDefinitionProvider),
        pathRename: Boolean(
          (capabilities?.workspace as { fileOperations?: { willRename?: unknown } } | undefined)
            ?.fileOperations?.willRename,
        ),
        callHierarchy: Boolean(capabilities?.callHierarchyProvider),
      },
    })
  }
  return rows
}

export const NO_LSP_SERVERS_CONFIGURED = 'No LSP servers are configured for this workspace.'

export function serverStatusLines(manager: LSPServerManager, filePath?: string): string[] {
  return statusRowsFor(manager, filePath).map(row => {
    const claims = row.claimsFile ? ' · claims this file' : ''
    const impl = row.implementation
      ? ` · impl: ${row.implementation.source}${row.implementation.version ? ` ${row.implementation.version}` : ''}`
      : ''
    const lastError = row.lastError ? ` · lastError: ${row.lastError.slice(0, 80)}` : ''
    const enabled = Object.entries(row.capabilities)
      .filter(([, on]) => on)
      .map(([name]) => name)
    const capabilitiesLine =
      row.state === 'running'
        ? `    capabilities: ${enabled.length > 0 ? enabled.join(', ') : '(none advertised)'}`
        : '    capabilities: (none until running)'
    return `${row.name} — ${row.state} (gen ${row.generation}, restarts ${row.restartCount})${claims}${impl}${lastError}\n${capabilitiesLine}`
  })
}

export async function opServerStatus(env: OpEnv): Promise<MercuryLspOpOutput> {
  const filePath = env.input.filePath ? env.absolutePath : undefined
  const rows = statusRowsFor(env.manager, filePath)
  if (rows.length === 0) {
    return {
      result: NO_LSP_SERVERS_CONFIGURED,
      resultCount: 0,
      fileCount: 0,
      effect: {
        outcome: 'no-change',
        changedPaths: [],
        evidence: 'no servers configured',
      },
    }
  }
  return {
    result: serverStatusLines(env.manager, filePath).join('\n'),
    resultCount: rows.length,
    fileCount: 0,
    effect: {
      outcome: 'succeeded',
      changedPaths: [],
      evidence: `${rows.length} server row(s)`,
      details: { servers: rows },
    },
  }
}
