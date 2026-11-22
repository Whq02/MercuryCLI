import { logForDebugging } from '../../utils/debug.js'
import { isBareMode } from '../../utils/envUtils.js'
import { logError } from '../../utils/log.js'
import { resetLspFailureLedger } from './failureLedger.js'
import { createLSPServerManager, type LSPServerManager, type LSPShutdownResult } from './LSPServerManager.js'
import { registerLSPNotificationHandlers } from './passiveFeedback.js'
import { passedOver } from '../../utils/passedOver.js'
import { notBuilt, unbuilt, type Unbuilt } from '../../pi/holes.js'


type InitState = Unbuilt

let instance: LSPServerManager | undefined
let initState: InitState = unbuilt('src/services/lsp/manager.ts:13')
let initError: Error | undefined
let initGeneration: number = unbuilt('src/services/lsp/manager.ts:15')
let initPromise: Promise<void> | undefined
let restartPromise: Promise<LSPShutdownResult | undefined> | undefined

export function initializeLspServerManager(): void {
  return notBuilt('src/services/lsp/manager.ts:19')
}

export function getLspServerManager(): LSPServerManager | undefined {
  return notBuilt('src/services/lsp/manager.ts:48')
}

export function getInitializationStatus():
  | { status: 'not-started' }
  | { status: 'pending' }
  | { status: 'success' }
  | { status: 'failed'; error: Error } {
  return notBuilt('src/services/lsp/manager.ts:53')
}

export async function waitForInitialization(): Promise<void> {
  return notBuilt('src/services/lsp/manager.ts:64')
}

export function isLspConnected(): boolean {
  return notBuilt('src/services/lsp/manager.ts:70')
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
