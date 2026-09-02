import { logForDebugging } from '../../utils/debug.js'
import { isBareMode } from '../../utils/envUtils.js'
import { logError } from '../../utils/log.js'
import { createLSPServerManager, type LSPServerManager } from './LSPServerManager.js'
import { registerLSPNotificationHandlers } from './passiveFeedback.js'

/**
 * Process-singleton owner of the manager: async init with generation
 * guarding, status reporting, re-init on an extensions reload, shutdown, and the
 * context-release document sweep.
 */

type InitState = 'not-started' | 'pending' | 'success' | 'failed'

let instance: LSPServerManager | undefined
let initState: InitState = 'not-started'
let initError: Error | undefined
let initGeneration = 0
let initPromise: Promise<void> | undefined

export function initializeLspServerManager(): void {
  // Scripted non-interactive runs have no use for editor integration.
  if (isBareMode()) return
  if (instance !== undefined && initState !== 'failed') return
  if (initState === 'failed') {
    // The retry path.
    instance = undefined
    initError = undefined
  }
  const manager = createLSPServerManager()
  instance = manager
  initState = 'pending'
  const generation = ++initGeneration
  // Async init without blocking startup; the promise is stored for callers.
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
      initState = 'failed'
      initError = err instanceof Error ? err : new Error(String(err))
      // A broken instance is never handed out.
      instance = undefined
      logError(initError)
      logForDebugging(`LSP manager initialisation failed: ${initError.message}`)
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
  if (initState !== 'pending') return
  if (initPromise === undefined) return
  await initPromise.catch(() => {})
}

export function isLspConnected(): boolean {
  if (initState === 'failed') return false
  if (instance === undefined) return false
  const servers = instance.getAllServers()
  if (servers.size === 0) return false
  for (const server of servers.values()) {
    if (server.state !== 'error') return true
  }
  return false
}

/** The tool roster's mount predicate (FN-015 rank 56): the LSP tool stays
 *  listed whenever the manager exists and any server is configured,
 *  whatever its state. Gating the tool on isLspConnected made code
 *  intelligence vanish from the model's tool surface the moment every
 *  claimant reached error — taking serverStatus, the surface built to
 *  report the failure and trigger the lazy restart, with it. A diagnostic
 *  surface is never gated on the health of the thing it diagnoses: the
 *  per-server operations report the failure themselves. isLspConnected
 *  keeps its meaning (any server not in error) for the readers that want
 *  health. */
export function isLspToolMounted(): boolean {
  if (initState === 'failed') return false
  if (instance === undefined) return false
  return instance.getAllServers().size > 0
}

/** Forced re-init after the extensions reload. */
export function reinitializeLspServerManager(): void {
  // A headless subcommand path must not be made to start LSP.
  if (initState === 'not-started') return
  const old = instance
  if (old !== undefined) {
    // Fire-and-forget: an extensions reload must not leak child processes.
    old.shutdown().catch(err => {
      logForDebugging(`LSP manager re-init: old instance shutdown failed: ${String(err)}`)
    })
  }
  instance = undefined
  initState = 'not-started'
  initError = undefined
  // The generation bump (inside the initializer) invalidates any in-flight init.
  initializeLspServerManager()
}

/** Never propagates errors. */
export async function shutdownLspServerManager(): Promise<void> {
  if (instance !== undefined) {
    try {
      await instance.shutdown()
      logForDebugging('LSP manager shut down')
    } catch (err) {
      logError(err)
      logForDebugging(`LSP manager shutdown failed: ${String(err)}`)
    }
  }
  instance = undefined
  initState = 'not-started'
  initError = undefined
  initPromise = undefined
  initGeneration++
}

/**
 * The compaction integration: when context is released, servers drop their
 * open documents too. AWAITS the sweep (so the next turn cannot open a
 * document the sweep then closes), then clears the pull-diagnostic
 * baselines unconditionally. Never throws.
 */
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
    // Lazily imported to avoid a cycle with the LSP tool's ops module.
    const ops = await import('../../tools/LSPTool/mercuryOps.js')
    ops.clearDiagnosticsBaselines()
  } catch (err) {
    logForDebugging(`LSP: baseline clear failed (${reason}): ${String(err)}`)
  }
  return closed
}

/** Test-only: makes the next re-init take the never-started early return. */
export function _resetLspManagerForTesting(): void {
  initState = 'not-started'
  initError = undefined
  initPromise = undefined
  initGeneration++
}
