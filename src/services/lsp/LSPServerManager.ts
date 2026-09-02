import { readFileSync, statSync } from 'node:fs'
import { extname, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { logForDebugging } from '../../utils/debug.js'
import { logError } from '../../utils/log.js'
import { getAllLspServers } from './config.js'
import { createLSPServerInstance, type LSPServerInstance } from './LSPServerInstance.js'
import { MERCURY_PYRIGHT_SERVER_NAME, pyrightWorkspaceConfiguration } from './pyrightLane.js'


export type LspRevalidationReport = {
  checked: number
  resynced: string[]
  closed: string[]
  failed: string[]
}

export type LSPServerManager = {
  initialize(): Promise<void>
  shutdown(): Promise<void>
  getServerForFile(path: string): LSPServerInstance | undefined
  getServersForFile(path: string): LSPServerInstance[]
  ensureServerStarted(path: string): Promise<LSPServerInstance | undefined>
  sendRequest<T>(path: string, method: string, params: unknown): Promise<T | undefined>
  getAllServers(): Map<string, LSPServerInstance>
  openFile(path: string, content: string): Promise<void>
  changeFile(path: string, content: string): Promise<void>
  saveFile(path: string): Promise<void>
  closeFile(path: string): Promise<void>
  changeAndSaveFile(path: string, content: string): Promise<void>
  getDocumentVersion(path: string): number | undefined
  closeAllFiles(): Promise<number>
  isFileOpen(path: string): boolean
  revalidateOpenDocuments(): Promise<LspRevalidationReport>
}

type DocumentTracking = {
  openGeneration: number
  version: number
  disk?: { mtimeMs: number; size: number }
}

export function createLSPServerManager(): LSPServerManager {
  const servers = new Map<string, LSPServerInstance>()
  const extensionIndex = new Map<string, LSPServerInstance[]>()
  const tracking = new Map<string, Map<string, DocumentTracking>>()

  function uriFor(path: string): string {
    return pathToFileURL(resolve(path)).href
  }

  function trackingFor(uri: string, serverName: string): DocumentTracking | undefined {
    return tracking.get(uri)?.get(serverName)
  }

  function setTracking(uri: string, serverName: string, entry: DocumentTracking): void {
    let perDocument = tracking.get(uri)
    if (perDocument === undefined) {
      perDocument = new Map()
      tracking.set(uri, perDocument)
    }
    perDocument.set(serverName, entry)
  }

  function clearTracking(uri: string, serverName: string): void {
    const perDocument = tracking.get(uri)
    if (perDocument === undefined) return
    perDocument.delete(serverName)
    if (perDocument.size === 0) tracking.delete(uri)
  }

  function isOpenOnCurrentGeneration(uri: string, server: LSPServerInstance): boolean {
    const entry = trackingFor(uri, server.name)
    return entry !== undefined && entry.openGeneration === server.generation
  }

  function languageIdFor(path: string, server: LSPServerInstance): string {
    const ext = extname(path).toLowerCase()
    const map = server.config.extensionToLanguage as Record<string, string>
    for (const [key, language] of Object.entries(map)) {
      if (key.toLowerCase() === ext) return language
    }
    return 'plaintext'
  }

  async function initialize(): Promise<void> {
    const { servers: configured } = await getAllLspServers()
    for (const [name, config] of Object.entries(configured)) {
      if (!config.command) {
        logError(new Error(`LSP server ${name} skipped: no command configured`))
        continue
      }
      const extensions = Object.keys(config.extensionToLanguage ?? {})
      if (extensions.length === 0) {
        logError(new Error(`LSP server ${name} skipped: no extension→language map`))
        continue
      }
      const instance = createLSPServerInstance(name, config)
      servers.set(name, instance)
      for (const ext of extensions) {
        const key = ext.toLowerCase()
        const claimants = extensionIndex.get(key) ?? []
        claimants.push(instance)
        extensionIndex.set(key, claimants)
      }
      instance.onRequest<{ items?: Array<{ section?: string }> }, unknown[]>('workspace/configuration', params => {
        const items = params?.items ?? []
        if (name === MERCURY_PYRIGHT_SERVER_NAME) {
          return items.map(item => pyrightWorkspaceConfiguration(item.section))
        }
        return items.map(() => null)
      })
    }
  }

  async function shutdown(): Promise<void> {
    const targets = [...servers.values()].filter(server => server.state !== 'stopped')
    const settled = await Promise.allSettled(targets.map(server => server.stop()))
    servers.clear()
    extensionIndex.clear()
    tracking.clear()
    const failures: string[] = []
    settled.forEach((result, index) => {
      if (result.status === 'rejected') {
        const server = targets[index] as LSPServerInstance
        failures.push(`${server.name}: ${result.reason instanceof Error ? result.reason.message : String(result.reason)}`)
      }
    })
    if (failures.length > 0) {
      throw new Error(`${failures.length} LSP server(s) failed to stop: ${failures.join('; ')}`)
    }
  }

  function getServersForFile(path: string): LSPServerInstance[] {
    return extensionIndex.get(extname(path).toLowerCase()) ?? []
  }

  function getServerForFile(path: string): LSPServerInstance | undefined {
    const claimants = getServersForFile(path)
    return claimants.find(s => s.config.diagnosticsOnly !== true) ?? claimants[0]
  }

  async function readyFor(server: LSPServerInstance): Promise<void> {
    if (server.state === 'running') return
    if (server.state === 'stopping') await server.stop()
    await server.start()
  }

  async function ensureServerStarted(path: string): Promise<LSPServerInstance | undefined> {
    const server = getServerForFile(path)
    if (server === undefined) return undefined
    await readyFor(server)
    return server
  }

  async function sendRequest<T>(path: string, method: string, params: unknown): Promise<T | undefined> {
    const server = await ensureServerStarted(path)
    if (server === undefined) return undefined
    return server.sendRequest<T>(method, params)
  }

  async function forEachClaimant(
    operation: string,
    path: string,
    action: (server: LSPServerInstance, primary: boolean) => Promise<void>,
  ): Promise<void> {
    const claimants = getServersForFile(path)
    if (claimants.length === 0) return
    const primary = claimants[0] as LSPServerInstance
    try {
      await action(primary, true)
    } catch (err) {
      const wrapped = new Error(
        `LSP ${operation} failed for ${path}: ${err instanceof Error ? err.message : String(err)}`,
      )
      logError(wrapped)
      throw wrapped
    }
    const companions = claimants.slice(1)
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

  function diskStampFor(path: string): { mtimeMs: number; size: number } | undefined {
    try {
      const stat = statSync(path)
      return { mtimeMs: stat.mtimeMs, size: stat.size }
    } catch {
      return undefined
    }
  }

  async function openOn(server: LSPServerInstance, path: string, content: string): Promise<void> {
    await readyFor(server)
    const uri = uriFor(path)
    if (isOpenOnCurrentGeneration(uri, server)) {
      logForDebugging(`LSP ${server.name}: ${path} already open on generation ${server.generation}`)
      return
    }
    await server.sendNotification('textDocument/didOpen', {
      textDocument: { uri, languageId: languageIdFor(path, server), version: 1, text: content },
    })
    const disk = diskStampFor(path)
    setTracking(uri, server.name, { openGeneration: server.generation, version: 1, ...(disk ? { disk } : {}) })
  }

  async function openFile(path: string, content: string): Promise<void> {
    await forEachClaimant('openFile', path, server => openOn(server, path, content))
  }

  async function changeOn(server: LSPServerInstance, path: string, content: string): Promise<void> {
    const uri = uriFor(path)
    if (server.state !== 'running' || !isOpenOnCurrentGeneration(uri, server)) {
      await openOn(server, path, content)
      return
    }
    const entry = trackingFor(uri, server.name)
    const version = (entry?.version ?? 1) + 1
    await server.sendNotification('textDocument/didChange', {
      textDocument: { uri, version },
      contentChanges: [{ text: content }],
    })
    const disk = diskStampFor(path)
    setTracking(uri, server.name, { openGeneration: server.generation, version, ...(disk ? { disk } : {}) })
  }

  async function changeFile(path: string, content: string): Promise<void> {
    await forEachClaimant('changeFile', path, server => changeOn(server, path, content))
  }

  async function saveOn(server: LSPServerInstance, path: string): Promise<void> {
    const uri = uriFor(path)
    if (server.state !== 'running' || !isOpenOnCurrentGeneration(uri, server)) return
    await server.sendNotification('textDocument/didSave', { textDocument: { uri } })
  }

  async function saveFile(path: string): Promise<void> {
    await forEachClaimant('saveFile', path, server => saveOn(server, path))
  }

  async function changeAndSaveFile(path: string, content: string): Promise<void> {
    await changeFile(path, content)
    await saveFile(path)
  }

  async function closeFile(path: string): Promise<void> {
    await forEachClaimant('closeFile', path, async server => {
      const uri = uriFor(path)
      try {
        if (server.state === 'running' && isOpenOnCurrentGeneration(uri, server)) {
          await server.sendNotification('textDocument/didClose', { textDocument: { uri } })
        }
      } finally {
        clearTracking(uri, server.name)
      }
    })
  }

  async function closeAllFiles(): Promise<number> {
    const work: Array<Promise<boolean>> = []
    for (const [uri, perDocument] of tracking) {
      for (const [serverName, entry] of perDocument) {
        const server = servers.get(serverName)
        work.push(
          (async () => {
            let closed = false
            try {
              if (server !== undefined && server.state === 'running' && entry.openGeneration === server.generation) {
                await server.sendNotification('textDocument/didClose', { textDocument: { uri } })
                closed = true
              }
            } catch (err) {
              logForDebugging(`LSP closeAllFiles: ${serverName} refused didClose for ${uri}: ${String(err)}`)
            } finally {
              clearTracking(uri, serverName)
            }
            return closed
          })(),
        )
      }
    }
    const results = await Promise.allSettled(work)
    let count = 0
    for (const result of results) if (result.status === 'fulfilled' && result.value) count++
    return count
  }

  function isFileOpen(path: string): boolean {
    const primary = getServerForFile(path)
    if (primary === undefined) return false
    return isOpenOnCurrentGeneration(uriFor(path), primary)
  }

  const REVALIDATE_MAX_BYTES = 10_000_000

  async function revalidateOpenDocuments(): Promise<LspRevalidationReport> {
    const report: LspRevalidationReport = { checked: 0, resynced: [], closed: [], failed: [] }
    const entries = [...tracking.entries()].map(
      ([uri, perDocument]) => [uri, [...perDocument.values()]] as const,
    )
    for (const [uri, perServer] of entries) {
      let path: string
      try {
        path = fileURLToPath(uri)
      } catch {
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
        await changeFile(path, text)
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

  function clearTrackingForUri(uri: string): void {
    const perDocument = tracking.get(uri)
    if (!perDocument) return
    for (const serverName of [...perDocument.keys()]) clearTracking(uri, serverName)
  }

  function getDocumentVersion(path: string): number | undefined {
    const primary = getServerForFile(path)
    if (primary === undefined) return undefined
    const uri = uriFor(path)
    if (!isOpenOnCurrentGeneration(uri, primary)) return undefined
    return trackingFor(uri, primary.name)?.version ?? 1
  }

  return {
    initialize,
    shutdown,
    getServerForFile,
    getServersForFile,
    ensureServerStarted,
    sendRequest,
    getAllServers: () => servers,
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
