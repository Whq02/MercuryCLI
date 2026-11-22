import { readFileSync, statSync } from 'node:fs'
import { extname, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { logForDebugging } from '../../utils/debug.js'
import { logError } from '../../utils/log.js'
import { getAllLspServers } from './config.js'
import type { LSPStopResult } from './LSPClient.js'
import { noteOutOfBandWrite } from './LSPDiagnosticRegistry.js'
import { createLSPServerInstance, isLspStartFailure, type LSPServerInstance } from './LSPServerInstance.js'
import { MERCURY_PYRIGHT_SERVER_NAME, pyrightWorkspaceConfiguration } from './pyrightLane.js'
import { passedOver } from '../../utils/passedOver.js'
import { notBuilt, type Unbuilt } from '../../pi/holes.js'


type LspRevalidationReport = {
  checked: number
  resynced: string[]
  closed: string[]
  failed: string[]
}

export type LSPShutdownResult = Array<{ serverName: string; stop: LSPStopResult | undefined }>

export type LSPServerManager = Unbuilt

type DocumentTracking = {
  openGeneration: number
  version: number
  disk?: { mtimeMs: number; size: number }
}

async function forEachClaimantOf(
  getServersForFile: (path: string) => LSPServerInstance[],
  getServerForFile: (path: string) => LSPServerInstance | undefined,
  operation: string,
  path: string,
  action: (server: LSPServerInstance, primary: boolean) => Promise<void>,
): Promise<void> {
  const claimants = getServersForFile(path)
  if (claimants.length === 0) return
  const primary = getServerForFile(path)!
  try {
    await action(primary, true)
  } catch (err) {
    if ((err as { code?: unknown } | null)?.code === 'ABORT_ERR') throw err
    const wrapped = new Error(
      `LSP ${operation} failed for ${path}: ${err instanceof Error ? err.message : String(err)}`,
    )
    if (isLspStartFailure(err)) {
      Object.assign(wrapped, { server: err.server, attempts: err.attempts, lspCause: err.lspCause, retryAt: err.retryAt, ...(err.refused === true ? { refused: true } : {}) })
      wrapped.name = err.name
    }
    logError(wrapped)
    throw wrapped
  }
  const companions = claimants.filter(server => server !== primary)
  if (companions.length === 0) return
  await Promise.all(
    companions.map(async server => {
      try {
        await action(server, false)
      } catch (err) {
        logForDebugging(
          `LSP ${operation} on companion ${server.name} for ${path} failed (continuing): ${String(err)}`,
        )
      }
    }),
  )
}

async function revalidateOpenDocumentsOf(
  tracking: Map<string, Map<string, DocumentTracking>>,
  closeFile: (path: string) => Promise<void>,
  clearTrackingForUri: (uri: string) => void,
  REVALIDATE_MAX_BYTES: number,
  changeFile: (path: string, content: string) => Promise<void>,
): Promise<LspRevalidationReport> {
  const report: LspRevalidationReport = { checked: 0, resynced: [], closed: [], failed: [] }
  const entries = [...tracking.entries()].map(
    ([uri, perDocument]) => [uri, [...perDocument.entries()].map(([serverName, entry]) => ({ serverName, ...entry }))] as const,
  )
  for (const [uri, perServer] of entries) {
    let path: string
    try {
      path = fileURLToPath(uri)
    } catch (error) {
      passedOver(error)
      continue
    }
    report.checked++
    let stat: { mtimeMs: number; size: number }
    try {
      stat = statSync(path)
    } catch (err) {
      if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') {
        try {
          await closeFile(path)
          report.closed.push(path)
        } catch {
          clearTrackingForUri(uri)
          report.closed.push(path)
        }
      } else {
        report.failed.push(path)
      }
      continue
    }
    const unchanged =
      perServer.length > 0 &&
      perServer.every(
        entry => entry.disk !== undefined && entry.disk.mtimeMs === stat.mtimeMs && entry.disk.size === stat.size,
      )
    if (unchanged) continue
    if (stat.size > REVALIDATE_MAX_BYTES) {
      report.failed.push(path)
      continue
    }
    try {
      const text = readFileSync(path, 'utf8')
      const versions = perServer.map(entry => ({ serverName: entry.serverName, docVersion: entry.version }))
      await changeFile(path, text)
      noteOutOfBandWrite(path, versions)
      report.resynced.push(path)
    } catch {
      report.failed.push(path)
    }
  }
  if (report.resynced.length > 0 || report.closed.length > 0) {
    logForDebugging(
      `LSP revalidation: ${report.resynced.length} resynced, ${report.closed.length} closed, ${report.failed.length} failed of ${report.checked} open document(s)`,
    )
  }
  return report
}

export function createLSPServerManager(): LSPServerManager {
  return notBuilt('src/services/lsp/LSPServerManager.ts:153')
}
