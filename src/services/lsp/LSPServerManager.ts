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


type LspRevalidationReport = {
  checked: number
  resynced: string[]
  closed: string[]
  failed: string[]
}

export type LSPShutdownResult = Array<{ serverName: string; stop: LSPStopResult | undefined }>

export type LSPServerManager = {
  initialize(): Promise<void>
  shutdown(): Promise<LSPShutdownResult>
  getServerForFile(filePath: string): LSPServerInstance | undefined
  getServersForFile(filePath: string): LSPServerInstance[]
  ensureServerStarted(filePath: string): Promise<LSPServerInstance | undefined>
  sendRequest<T = unknown>(filePath: string, method: string, params: unknown): Promise<T | undefined>
  getAllServers(): Map<string, LSPServerInstance>
  openFile(filePath: string, fileContent: string): Promise<void>
  changeFile(filePath: string, fileContent: string): Promise<void>
  saveFile(filePath: string): Promise<void>
  closeFile(filePath: string): Promise<void>
  changeAndSaveFile(filePath: string, fileContent: string): Promise<void>
  getDocumentVersion(filePath: string): number | undefined
  closeAllFiles(): Promise<number>
  isFileOpen(filePath: string): boolean
  revalidateOpenDocuments(): Promise<LspRevalidationReport>
}

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

const REVALIDATE_MAX_BYTES = 10_000_000

function fileUri(filePath: string): string {
  return pathToFileURL(resolve(filePath)).href
}

function languageIdFor(server: LSPServerInstance, filePath: string): string {
  const ext = extname(filePath).toLowerCase()
  for (const [key, language] of Object.entries(server.config.extensionToLanguage)) {
    if (key.toLowerCase() === ext) return language
  }
  return 'plaintext'
}

function diskHintOf(filePath: string): { mtimeMs: number; size: number } | undefined {
  try {
    const stat = statSync(resolve(filePath))
    return { mtimeMs: stat.mtimeMs, size: stat.size }
  } catch (error) {
    passedOver(error)
    return undefined
  }
}

async function readyFor(server: LSPServerInstance): Promise<LSPServerInstance> {
  if (server.state === 'running') return server
  if (server.state === 'stopping') await server.stop()
  await server.start()
  return server
}

async function shutdownServersOf(
  servers: Map<string, LSPServerInstance>,
  extensionToServers: Map<string, string[]>,
  openDocuments: Map<string, Map<string, DocumentTracking>>,
): Promise<LSPShutdownResult> {
  const targets = [...servers.entries()].filter(([, server]) => server.state !== 'stopped')
  const settled = await Promise.allSettled(
    targets.map(async ([serverName, server]) => ({
      serverName,
      stop: await server.stop(),
    })),
  )
  servers.clear()
  extensionToServers.clear()
  openDocuments.clear()

  const results: LSPShutdownResult = []
  const failures: string[] = []
  for (let i = 0; i < targets.length; i++) {
    const serverName = targets[i]![0]
    const outcome = settled[i]!
    if (outcome.status === 'rejected') {
      const reason = outcome.reason
      failures.push(`${serverName}: ${reason instanceof Error ? reason.message : String(reason)}`)
    } else {
      const stopResult = outcome.value.stop
      if (stopResult !== undefined && stopResult.survivors.length > 0) {
        failures.push(`${serverName}: processes still running: ${stopResult.survivors.join(', ')}`)
      } else {
        results.push(outcome.value)
      }
    }
  }
  if (failures.length > 0) {
    throw new Error(`${failures.length} LSP server(s) failed to stop: ${failures.join('; ')}`)
  }
  return results
}

export function createLSPServerManager(): LSPServerManager {
  const servers = new Map<string, LSPServerInstance>()
  const extensionToServers = new Map<string, string[]>()
  const openDocuments = new Map<string, Map<string, DocumentTracking>>()

  function getTracking(uri: string, serverName: string): DocumentTracking | undefined {
    return openDocuments.get(uri)?.get(serverName)
  }

  function setTracking(uri: string, serverName: string, entry: DocumentTracking): void {
    let perDoc = openDocuments.get(uri)
    if (perDoc === undefined) {
      perDoc = new Map()
      openDocuments.set(uri, perDoc)
    }
    perDoc.set(serverName, entry)
  }

  function deleteTracking(uri: string, serverName: string): void {
    const perDoc = openDocuments.get(uri)
    if (perDoc === undefined) return
    perDoc.delete(serverName)
    if (perDoc.size === 0) openDocuments.delete(uri)
  }

  function clearTrackingForUri(uri: string): void {
    openDocuments.delete(uri)
  }

  function isTrackedCurrent(uri: string, server: LSPServerInstance): boolean {
    const entry = getTracking(uri, server.name)
    return entry !== undefined && entry.openGeneration === server.generation
  }

  async function initialize(): Promise<void> {
    const { servers: configured } = await getAllLspServers()
    for (const [name, config] of Object.entries(configured)) {
      if (!config.command) {
        logForDebugging(`LSP server ${name} skipped: no command configured`)
        continue
      }
      const extensions = Object.keys(config.extensionToLanguage ?? {})
      if (extensions.length === 0) {
        logForDebugging(`LSP server ${name} skipped: no extension→language map`)
        continue
      }
      const instance = createLSPServerInstance(name, config)
      servers.set(name, instance)
      for (const ext of extensions) {
        const normalized = ext.toLowerCase()
        const list = extensionToServers.get(normalized)
        if (list === undefined) {
          extensionToServers.set(normalized, [name])
        } else if (!list.includes(name)) {
          list.push(name)
        }
      }
      instance.onRequest<{ items?: Array<{ section?: string }> }, unknown[]>(
        'workspace/configuration',
        params => {
          const items = Array.isArray(params?.items) ? params.items : []
          if (name === MERCURY_PYRIGHT_SERVER_NAME) {
            return items.map(item => pyrightWorkspaceConfiguration(item?.section))
          }
          return items.map(() => null)
        },
      )
    }
  }

  function shutdown(): Promise<LSPShutdownResult> {
    return shutdownServersOf(servers, extensionToServers, openDocuments)
  }

  function getServersForFile(filePath: string): LSPServerInstance[] {
    const ext = extname(filePath).toLowerCase()
    if (ext === '') return []
    const names = extensionToServers.get(ext)
    if (names === undefined) return []
    const result: LSPServerInstance[] = []
    for (const name of names) {
      const server = servers.get(name)
      if (server !== undefined) result.push(server)
    }
    return result
  }

  function getServerForFile(filePath: string): LSPServerInstance | undefined {
    const claimants = getServersForFile(filePath)
    if (claimants.length === 0) return undefined
    return claimants.find(server => server.config.diagnosticsOnly !== true) ?? claimants[0]
  }

  async function ensureServerStarted(filePath: string): Promise<LSPServerInstance | undefined> {
    const server = getServerForFile(filePath)
    if (server === undefined) return undefined
    return readyFor(server)
  }

  async function sendRequest<T = unknown>(
    filePath: string,
    method: string,
    params: unknown,
  ): Promise<T | undefined> {
    const server = await ensureServerStarted(filePath)
    if (server === undefined) return undefined
    return server.sendRequest<T>(method, params)
  }

  function getAllServers(): Map<string, LSPServerInstance> {
    return servers
  }

  async function openOnServer(
    server: LSPServerInstance,
    filePath: string,
    fileContent: string,
  ): Promise<void> {
    await readyFor(server)
    const uri = fileUri(filePath)
    if (isTrackedCurrent(uri, server)) {
      logForDebugging(`LSP ${server.name}: ${filePath} already open on generation ${server.generation}`)
      return
    }
    const languageId = languageIdFor(server, filePath)
    await server.sendNotification('textDocument/didOpen', {
      textDocument: {
        uri,
        languageId,
        version: 1,
        text: fileContent,
      },
    })
    const disk = diskHintOf(filePath)
    setTracking(uri, server.name, {
      openGeneration: server.generation,
      version: 1,
      ...(disk !== undefined ? { disk } : {}),
    })
  }

  async function openFile(filePath: string, fileContent: string): Promise<void> {
    await forEachClaimantOf(getServersForFile, getServerForFile, 'openFile', filePath, server =>
      openOnServer(server, filePath, fileContent),
    )
  }

  async function changeFile(filePath: string, fileContent: string): Promise<void> {
    const uri = fileUri(filePath)
    await forEachClaimantOf(getServersForFile, getServerForFile, 'changeFile', filePath, async server => {
      if (server.state !== 'running' || !isTrackedCurrent(uri, server)) {
        await openOnServer(server, filePath, fileContent)
        return
      }
      const existing = getTracking(uri, server.name)
      const nextVersion = (existing?.version ?? 1) + 1
      await server.sendNotification('textDocument/didChange', {
        textDocument: {
          uri,
          version: nextVersion,
        },
        contentChanges: [{ text: fileContent }],
      })
      const disk = diskHintOf(filePath)
      setTracking(uri, server.name, {
        openGeneration: server.generation,
        version: nextVersion,
        ...(disk !== undefined ? { disk } : {}),
      })
    })
  }

  async function saveFile(filePath: string): Promise<void> {
    const uri = fileUri(filePath)
    await forEachClaimantOf(getServersForFile, getServerForFile, 'saveFile', filePath, async server => {
      if (server.state !== 'running' || !isTrackedCurrent(uri, server)) return
      await server.sendNotification('textDocument/didSave', {
        textDocument: { uri },
      })
    })
  }

  async function closeFile(filePath: string): Promise<void> {
    const uri = fileUri(filePath)
    await forEachClaimantOf(getServersForFile, getServerForFile, 'closeFile', filePath, async server => {
      try {
        if (server.state === 'running' && isTrackedCurrent(uri, server)) {
          await server.sendNotification('textDocument/didClose', {
            textDocument: { uri },
          })
        }
      } finally {
        deleteTracking(uri, server.name)
      }
    })
  }

  async function changeAndSaveFile(filePath: string, fileContent: string): Promise<void> {
    await changeFile(filePath, fileContent)
    await saveFile(filePath)
  }

  function getDocumentVersion(filePath: string): number | undefined {
    const server = getServerForFile(filePath)
    if (server === undefined) return undefined
    const entry = getTracking(fileUri(filePath), server.name)
    if (entry === undefined || entry.openGeneration !== server.generation) return undefined
    return entry.version ?? 1
  }

  async function closeAllFiles(): Promise<number> {
    const pairs: Array<{ uri: string; serverName: string; entry: DocumentTracking }> = []
    for (const [uri, perDoc] of openDocuments) {
      for (const [serverName, entry] of perDoc) {
        pairs.push({ uri, serverName, entry })
      }
    }
    let closed = 0
    await Promise.all(
      pairs.map(async ({ uri, serverName, entry }) => {
        const server = servers.get(serverName)
        try {
          if (server !== undefined && server.state === 'running' && entry.openGeneration === server.generation) {
            await server.sendNotification('textDocument/didClose', {
              textDocument: { uri },
            })
            closed++
          }
        } catch (err) {
          logForDebugging(
            `LSP closeAllFiles: ${serverName} refused didClose for ${uri}: ${err instanceof Error ? err.message : String(err)}`,
          )
        } finally {
          deleteTracking(uri, serverName)
        }
      }),
    )
    return closed
  }

  function isFileOpen(filePath: string): boolean {
    const server = getServerForFile(filePath)
    if (server === undefined) return false
    return isTrackedCurrent(fileUri(filePath), server)
  }

  function revalidateOpenDocuments(): Promise<LspRevalidationReport> {
    return revalidateOpenDocumentsOf(
      openDocuments,
      closeFile,
      clearTrackingForUri,
      REVALIDATE_MAX_BYTES,
      changeFile,
    )
  }

  return {
    initialize,
    shutdown,
    getServerForFile,
    getServersForFile,
    ensureServerStarted,
    sendRequest,
    getAllServers,
    openFile,
    changeFile,
    saveFile,
    closeFile,
    changeAndSaveFile,
    getDocumentVersion,
    closeAllFiles,
    isFileOpen,
    revalidateOpenDocuments,
  }
}
