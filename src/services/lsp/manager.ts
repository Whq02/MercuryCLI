import { logForDebugging } from '../../utils/debug.js'
import { isBareMode } from '../../utils/envUtils.js'
import { logError } from '../../utils/log.js'
import { resetLspFailureLedger } from './failureLedger.js'
import { createLSPServerManager, type LSPServerManager, type LSPShutdownResult } from './LSPServerManager.js'
import { registerLSPNotificationHandlers } from './passiveFeedback.js'
import { passedOver } from '../../utils/passedOver.js'


type InitState = 'not-started' | 'pending' | 'success' | 'failed'

let instance: LSPServerManager | undefined
let initState: InitState = 'not-started'
let initError: Error | undefined
let initGeneration = 0
let initPromise: Promise<void> | undefined
let restartPromise: Promise<LSPShutdownResult | undefined> | undefined

export function initializeLspServerManager(): void {
  if (isBareMode()) return
  if (initState === 'pending') return
  if (initState !== 'failed' && instance !== undefined) return
  if (initState === 'failed') {
    instance = undefined
    initError = undefined
  }
  const manager = createLSPServerManager()
  const generation = ++initGeneration
  instance = manager
  initState = 'pending'
  initPromise = manager
    .initialize()
    .then(() => {
      if (generation !== initGeneration) return
      initState = 'success'
      logForDebugging('LSP manager initialised')
      registerLSPNotificationHandlers(manager)
    })
    .catch((err: unknown) => {
      if (generation !== initGeneration) return
      const error = err instanceof Error ? err : new Error(String(err))
      initState = 'failed'
      initError = error
      instance = undefined
      logError(error)
      logForDebugging(`LSP manager initialisation failed: ${error.message}`)
    })
}

export function getLspServerManager(): LSPServerManager | undefined {
  if (initState === 'failed') return undefined
  return instance
}

export function getInitializationStatus():
  | { status: 'not-started' }
  | { status: 'pending' }
  | { status: 'success' }
  | { status: 'failed'; error: Error } {
  if (initState === 'failed') {
    return { status: 'failed', error: initError ?? new Error('LSP initialisation failed') }
  }
  return { status: initState }
}

export async function waitForInitialization(): Promise<void> {
  if (initState !== 'pending' || initPromise === undefined) return
  try {
    await initPromise
  } catch (err) {
    passedOver(err)
  }
}

export function isLspConnected(): boolean {
  if (initState === 'failed' || instance === undefined) return false
  const servers = instance.getAllServers()
  if (servers.size === 0) return false
  for (const server of servers.values()) {
    if (server.state !== 'error') return true
  }
  return false
}

export function isLspToolMounted(): boolean {
  if (initState === 'failed') return false
  if (instance === undefined) return false
  return instance.getAllServers().size > 0
}

export function reinitializeLspServerManager(): Promise<LSPShutdownResult | undefined> {
  if (restartPromise !== undefined) return restartPromise
  if (initState === 'not-started') return Promise.resolve(undefined)
  const old = instance
  const initializing = initPromise
  const generation = ++initGeneration
  instance = undefined
  initState = 'pending'
  initError = undefined
  resetLspFailureLedger()
  restartPromise = (async () => {
    await initializing
    const stopped = await old?.shutdown()
    if (generation !== initGeneration) return stopped
    initState = 'not-started'
    initializeLspServerManager()
    await waitForInitialization()
    return stopped
  })().catch((err: unknown) => {
    if (generation === initGeneration) {
      initState = 'failed'
      initError = err instanceof Error ? err : new Error(String(err))
      logError(initError)
      logForDebugging(`LSP manager restart failed: ${initError.message}`)
    }
    return undefined
  }).finally(() => {
    restartPromise = undefined
  })
  initPromise = restartPromise.then(() => {})
  return restartPromise
}

export async function shutdownLspServerManager(): Promise<void> {
  const old = instance
  const initializing = initPromise
  initGeneration++
  instance = undefined
  initState = 'not-started'
  initError = undefined
  initPromise = undefined
  try {
    await initializing
    await old?.shutdown()
    logForDebugging('LSP manager shut down')
  } catch (err) {
    logError(err)
    logForDebugging(`LSP manager shutdown failed: ${String(err)}`)
  }
  resetLspFailureLedger()
}

export async function releaseLspDocumentsForContext(reason: string): Promise<number> {
  const manager = getLspServerManager()
  if (manager === undefined) return 0
  let closed = 0
  try {
    closed = await manager.closeAllFiles()
    if (closed > 0) {
      logForDebugging(`LSP: released ${closed} document(s) for context (${reason})`)
    }
  } catch (err) {
    logForDebugging(`LSP: document release failed (${reason}): ${String(err)}`)
  }
  try {
    const ops = await import('../../tools/LSPTool/mercuryOps.js')
    ops.clearDiagnosticsBaselines()
  } catch (err) {
    logForDebugging(`LSP: baseline clear failed (${reason}): ${String(err)}`)
  }
  return closed
}
