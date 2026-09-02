import { basename } from 'node:path'
import { pathToFileURL } from 'node:url'

import { CancellationTokenSource } from 'vscode-jsonrpc'

import type { InitializeParams, ServerCapabilities } from 'vscode-languageserver-protocol'

import { getCwd } from '../../utils/cwd.js'
import { logForDebugging } from '../../utils/debug.js'
import { logError } from '../../utils/log.js'
import { sleep } from '../../utils/sleep.js'
import { languageServerEnv } from '../../utils/subprocessEnv.js'
import type { ExecutionState } from '../primitives/execution.js'
import { registerExecutionDomain } from '../primitives/executionPlane.js'
import { projectExternalState } from '../primitives/externalProjection.js'
import { processMainOwner } from '../run/resolveOwner.js'
import type { LSPClient } from './LSPClient.js'
import { currentLspAbortSignal } from './lspAbort.js'
import { mercuryLspEnabled } from './mercuryLsp.js'
import type { LspServerState, ScopedLspServerConfig } from './types.js'

/**
 * One language server's lifecycle state machine + the `initialize`
 * client-capability declaration, crash-recovery caps, transient-error retry,
 * generation counter, execution-plane projection.
 */

export type LSPServerInstance = {
  readonly name: string
  readonly config: ScopedLspServerConfig
  readonly state: LspServerState
  readonly capabilities: ServerCapabilities | undefined
  readonly startTime: number | undefined
  readonly lastError: Error | undefined
  readonly restartCount: number
  readonly generation: number
  start(): Promise<void>
  stop(): Promise<void>
  restart(): Promise<void>
  isHealthy(): boolean
  sendRequest<T>(method: string, params: unknown): Promise<T>
  sendNotification(method: string, params: unknown): Promise<void>
  onNotification(method: string, handler: (params: unknown) => void): void
  onRequest<P, R>(method: string, handler: (params: P) => R | Promise<R>): void
}

const DEFAULT_MAX_RESTARTS = 3
/** The per-request deadline when a server's config names none. One budget
 *  covers a whole call, the ContentModified ladder included. */
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000
const CONTENT_MODIFIED_CODE = -32801

/** The deadline's settlement: typed, and it says what was being waited on. */
function timedOutRequest(method: string, server: string, budgetMs: number): Error {
  const error = new Error(
    `LSP request ${method} to server ${server} got no answer within ${(budgetMs / 1000).toFixed(1)}s — the request was cancelled; the server may be busy indexing (retry, or restart it from /capabilities)`,
  )
  error.name = 'LspRequestTimeout'
  return error
}

/** The abort's settlement: named AbortError so the tool layer's
 *  isAbortError reads an INTERRUPT, never an is_error tool result — the
 *  same naming the search wrapper uses for a cancelled walk. */
function abortedRequest(method: string, server: string): Error {
  const error = new Error(`LSP request ${method} to server ${server} was interrupted before it finished.`)
  error.name = 'AbortError'
  return error
}

/** Either bounded settlement — never re-wrapped, never retried. */
function isLspRequestSettlement(err: unknown): boolean {
  return err instanceof Error && (err.name === 'LspRequestTimeout' || err.name === 'AbortError')
}
const TRANSIENT_RETRIES = 3
const TRANSIENT_BASE_DELAY_MS = 500
/** Init-failure backoff: a failed start refuses fast for this long per
 *  consecutive failure (capped), so a doomed spawn cannot thrash. An
 *  explicit restart() — the reload path — clears it. */
const INIT_BACKOFF_BASE_MS = 15_000
const INIT_BACKOFF_MAX_MS = 5 * 60_000

// ---------------------------------------------------------------------------
// Execution-plane projection (domain: language-server)
// ---------------------------------------------------------------------------

/** Process-global, keyed by server name, populated at construction, never pruned. */
const liveStateReaders = new Map<string, () => LspServerState>()

function planeState(state: LspServerState): ExecutionState {
  return state === 'error' ? 'failed' : state
}

registerExecutionDomain('language-server', {
  reconcile(record) {
    const serverName = record.spec.metadata?.serverName
    if (typeof serverName !== 'string') return null
    const reader = liveStateReaders.get(serverName)
    if (reader === undefined) {
      return { state: 'stopped', outcome: { reason: 'language-server instance is gone from this process' } }
    }
    return { state: planeState(reader()) }
  },
})

function projectState(name: string, state: LspServerState, error?: Error): void {
  projectExternalState(
    processMainOwner(),
    {
      id: `language-server:${name}`,
      kind: 'language-server',
      label: `language server ${name}`,
      lifecycle: 'session',
      metadata: { serverName: name },
    },
    planeState(state),
    error !== undefined && state === 'error' ? { outcome: { reason: error.message } } : {},
  )
}

// ---------------------------------------------------------------------------
// The initialize payload
// ---------------------------------------------------------------------------

function buildInitializeParams(config: ScopedLspServerConfig): InitializeParams {
  const folder = config.workspaceFolder ?? getCwd()
  const uri = pathToFileURL(folder).href
  const bridge = mercuryLspEnabled()
  return {
    processId: process.pid,
    // Default to an empty object rather than omitting: some servers require
    // the field to exist.
    initializationOptions: config.initializationOptions ?? {},
    workspaceFolders: [{ uri, name: basename(folder) }],
    rootPath: folder,
    rootUri: uri,
    capabilities: {
      workspace: {
        // TRUE (FC-050): the manager registers a live workspace/configuration
        // handler (null-per-item default; pyrightLane answers python.* with
        // the resolved interpreter) — advertising false meant pyright never
        // ASKED, so the interpreter wiring sat unexercised.
        configuration: true,
        workspaceFolders: false,
        ...(bridge ? { symbol: { dynamicRegistration: false } } : {}),
      },
      textDocument: {
        synchronization: {
          dynamicRegistration: false,
          willSave: false,
          willSaveWaitUntil: false,
          didSave: true,
        },
        publishDiagnostics: {
          relatedInformation: true,
          tagSupport: { valueSet: [1, 2] },
          versionSupport: false,
          codeDescriptionSupport: true,
          dataSupport: false,
        },
        hover: { dynamicRegistration: false, contentFormat: ['markdown', 'plaintext'] },
        definition: { dynamicRegistration: false, linkSupport: true },
        references: { dynamicRegistration: false },
        documentSymbol: { dynamicRegistration: false, hierarchicalDocumentSymbolSupport: true },
        callHierarchy: { dynamicRegistration: false },
        ...(mercuryLspEnabled()
          ? {
              implementation: { dynamicRegistration: false, linkSupport: true },
              rename: { dynamicRegistration: false, prepareSupport: true },
              codeAction: {
                dynamicRegistration: false,
                codeActionLiteralSupport: {
                  codeActionKind: { valueSet: ['quickfix', 'refactor', 'source'] },
                },
                resolveSupport: { properties: ['edit'] },
              },
              diagnostic: { dynamicRegistration: false },
            }
          : {}),
      },
      general: { positionEncodings: ['utf-16'] },
    },
  } as InitializeParams
}

// ---------------------------------------------------------------------------
// The instance
// ---------------------------------------------------------------------------

export function createLSPServerInstance(name: string, config: ScopedLspServerConfig): LSPServerInstance {
  let state: LspServerState = 'stopped'
  let client: LSPClient | null = null
  let clientPromise: Promise<LSPClient> | null = null
  let startTime: number | undefined
  let lastError: Error | undefined
  let restartCount = 0
  let crashRecoveries = 0
  let generation = 0
  let inFlightStart: Promise<void> | null = null
  /** Consecutive INIT failures (spawn/initialize — not crashes) + the time
   *  of the last one; drives the fast-refusal backoff window. */
  let initFailures = 0
  let lastInitFailureAt = 0
  let idleTimer: NodeJS.Timeout | null = null
  let lastActivityAt = 0

  liveStateReaders.set(name, () => state)

  function clearIdleTimer(): void {
    if (idleTimer !== null) {
      clearTimeout(idleTimer)
      idleTimer = null
    }
  }

  /** Idle shutdown: after idleTimeoutMs with no requests/notifications the
   *  server stops; the next use restarts it lazily (ensureServerStarted
   *  already starts stopped servers). Unref'd — never holds the process. */
  function armIdleTimer(): void {
    const timeout = config.idleTimeoutMs
    if (timeout === undefined) return
    clearIdleTimer()
    idleTimer = setTimeout(() => {
      idleTimer = null
      const idleFor = Date.now() - lastActivityAt
      if (state === 'running' && idleFor >= timeout) {
        logForDebugging(`LSP ${name}: idle for ${idleFor}ms — stopping (lazy restart on next use)`)
        void stop().catch(err => logForDebugging(`LSP ${name}: idle stop failed: ${String(err)}`))
      } else if (state === 'running') {
        armIdleTimer()
      }
    }, timeout)
    idleTimer.unref?.()
  }

  function touchActivity(): void {
    lastActivityAt = Date.now()
    if (state === 'running' && config.idleTimeoutMs !== undefined && idleTimer === null) {
      armIdleTimer()
    }
  }

  function setState(next: LspServerState, error?: Error): void {
    state = next
    projectState(name, next, error)
  }

  function maxRestarts(): number {
    return config.maxRestarts ?? DEFAULT_MAX_RESTARTS
  }

  function ensureClient(): Promise<LSPClient> {
    if (clientPromise !== null) return clientPromise
    // Lazy: the JSON-RPC library loads only when a server is instantiated.
    // The promise is memoised so concurrent callers share ONE client.
    clientPromise = import('./LSPClient.js').then(({ createLSPClient }) => {
      client = createLSPClient(name, error => {
        // Crash: the manager restarts a dead server on next use instead of
        // leaving a zombie in `running`.
        lastError = error
        crashRecoveries++
        setState('error', error)
      })
      return client
    })
    return clientPromise
  }

  async function runStart(): Promise<void> {
    setState('starting')
    const lsp = await ensureClient()
    let spawned = false
    try {
      await lsp.start(config.command, config.args ?? [], {
        env: { ...languageServerEnv(), ...(config.env ?? {}) },
        cwd: config.workspaceFolder,
      })
      spawned = true
      const initialize = lsp.initialize(buildInitializeParams(config))
      if (config.startupTimeout !== undefined) {
        let timer: NodeJS.Timeout | null = null
        try {
          await Promise.race([
            initialize,
            new Promise<never>((_, reject) => {
              timer = setTimeout(
                () => reject(new Error(`LSP server ${name} did not initialize within ${config.startupTimeout}ms`)),
                config.startupTimeout,
              )
            }),
          ])
        } finally {
          if (timer !== null) clearTimeout(timer)
        }
      } else {
        await initialize
      }
      setState('running')
      startTime = Date.now()
      crashRecoveries = 0
      initFailures = 0
      generation++
      lastActivityAt = Date.now()
      armIdleTimer()
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err))
      if (spawned) {
        // Best-effort teardown; the abandoned initialize promise is
        // neutralised by the client's own catch paths.
        await lsp.stop().catch(() => {})
      }
      initFailures++
      lastInitFailureAt = Date.now()
      lastError = error
      setState('error', error)
      logError(error)
      throw error
    }
  }

  function initBackoffRemainingMs(): number {
    if (initFailures === 0) return 0
    const window = Math.min(INIT_BACKOFF_BASE_MS * 2 ** (initFailures - 1), INIT_BACKOFF_MAX_MS)
    return Math.max(0, lastInitFailureAt + window - Date.now())
  }

  async function start(): Promise<void> {
    if (state === 'running') return
    if (state === 'starting' && inFlightStart !== null) {
      // Join the in-flight start — a concurrent caller must not proceed
      // against a half-initialised server.
      return inFlightStart
    }
    const backoffMs = initBackoffRemainingMs()
    if (backoffMs > 0) {
      // A doomed spawn refuses FAST inside the backoff window instead of
      // paying the whole startup timeout again. restart() clears it.
      throw new Error(
        `LSP server ${name} failed to initialize ${initFailures} time(s) (${lastError?.message ?? 'no error recorded'}) — backing off ${Math.ceil(backoffMs / 1000)}s more; an explicit restart clears the backoff`,
      )
    }
    if (state === 'error' && crashRecoveries > 0) {
      if (config.restartOnCrash === false) {
        const error = new Error(
          `LSP server ${name} crashed and will not respawn (restartOnCrash is false): ${lastError?.message ?? 'no error recorded'}`,
        )
        lastError = error
        logError(error)
        throw error
      }
      if (crashRecoveries > maxRestarts()) {
        const error = new Error(`LSP server ${name} exceeded the crash-restart cap (${maxRestarts()})`)
        logError(error)
        throw error
      }
    }
    inFlightStart = runStart().finally(() => {
      inFlightStart = null
    })
    return inFlightStart
  }

  /** The stop in flight, so a concurrent stop() JOINS it instead of
   *  answering at once while the child is still alive — the manager's
   *  shutdown waits a stopping server out (FN-015 rank 54). */
  let inFlightStop: Promise<void> | null = null

  async function stop(): Promise<void> {
    if (state === 'stopped') return
    if (state === 'stopping') return inFlightStop ?? undefined
    inFlightStop = runStop().finally(() => {
      inFlightStop = null
    })
    return inFlightStop
  }

  async function runStop(): Promise<void> {
    clearIdleTimer()
    setState('stopping')
    try {
      if (client !== null) {
        await client.stop(
          config.shutdownTimeout !== undefined ? { gracefulTimeoutMs: config.shutdownTimeout } : undefined,
        )
      }
      setState('stopped')
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err))
      lastError = error
      setState('error', error)
      throw error
    }
  }

  async function restart(): Promise<void> {
    // The explicit reload path clears the init-failure backoff — a human
    // asked for a fresh attempt NOW.
    initFailures = 0
    lastInitFailureAt = 0
    try {
      await stop()
    } catch (err) {
      throw new Error(`Failed to stop LSP server ${name} for restart: ${err instanceof Error ? err.message : String(err)}`)
    }
    restartCount++
    if (restartCount > maxRestarts()) {
      throw new Error(`LSP server ${name} exceeded the restart cap (${maxRestarts()})`)
    }
    try {
      await start()
    } catch (err) {
      throw new Error(
        `Failed to restart LSP server ${name} (attempt ${restartCount} of ${maxRestarts()}): ${
          err instanceof Error ? err.message : String(err)
        }`,
      )
    }
  }

  function isHealthy(): boolean {
    return state === 'running' && client !== null && client.isInitialized
  }

  function isContentModified(err: unknown): boolean {
    // Numeric code, never class identity: more than one copy of the
    // JSON-RPC library may be present.
    return typeof (err as { code?: unknown } | null)?.code === 'number' && (err as { code: number }).code === CONTENT_MODIFIED_CODE
  }

  /**
   * Every request is BOUNDED and CANCELLABLE. A server that accepts a
   * request and never answers (clangd or pyright wedged mid-reindex, a
   * sidecar loading a large program off a spinning disk) used to hold the
   * tool call forever: nothing observed the operator's abort, and the turn
   * machine's own abort check runs only after tool results settle, so the
   * one recovery was killing Mercury — which on Windows takes the in-flight
   * transcript with it.
   *
   * ONE deadline covers the whole call, retries included (a per-attempt
   * timer would multiply the budget by the ladder). Both ends — the
   * deadline and the ambient abort signal — cancel the request on the WIRE
   * (`$/cancelRequest`, through the connection's own token) before
   * rejecting locally, so the server stops working on an answer nobody
   * will read. The abort's rejection is named AbortError so the tool layer
   * reads an interrupt, never a tool failure.
   */
  async function sendRequest<T>(method: string, params: unknown): Promise<T> {
    if (!isHealthy() || client === null) {
      throw new Error(
        `LSP server ${name} is not healthy (state: ${state}${lastError ? `, last error: ${lastError.message}` : ''})`,
      )
    }
    touchActivity()
    const budgetMs = config.requestTimeout ?? DEFAULT_REQUEST_TIMEOUT_MS
    const deadlineAt = Date.now() + budgetMs
    const signal = currentLspAbortSignal()
    if (signal?.aborted === true) throw abortedRequest(method, name)
    let lastFailure: unknown
    for (let attempt = 0; attempt <= TRANSIENT_RETRIES; attempt++) {
      const remaining = deadlineAt - Date.now()
      if (remaining <= 0) throw timedOutRequest(method, name, budgetMs)
      const source = new CancellationTokenSource()
      let timer: ReturnType<typeof setTimeout> | undefined
      const onAbort = (): void => source.cancel()
      try {
        return await new Promise<T>((resolve, reject) => {
          timer = setTimeout(() => {
            source.cancel()
            reject(timedOutRequest(method, name, budgetMs))
          }, remaining)
          if (signal !== undefined) {
            signal.addEventListener('abort', onAbort, { once: true })
            // The local rejection races the cancel: an abort must settle the
            // turn even if the server never answers the cancellation.
            signal.addEventListener('abort', () => reject(abortedRequest(method, name)), { once: true })
          }
          client!.sendRequest<T>(method, params, source.token).then(resolve, reject)
        })
      } catch (err) {
        lastFailure = err
        if (isLspRequestSettlement(err)) throw err
        if (isContentModified(err) && attempt < TRANSIENT_RETRIES) {
          const backoff = Math.min(TRANSIENT_BASE_DELAY_MS * 2 ** attempt, Math.max(0, deadlineAt - Date.now()))
          await sleep(backoff)
          continue
        }
        break
      } finally {
        if (timer !== undefined) clearTimeout(timer)
        signal?.removeEventListener('abort', onAbort)
        source.dispose()
      }
    }
    throw new Error(
      `LSP request ${method} to server ${name} failed: ${lastFailure instanceof Error ? lastFailure.message : String(lastFailure)}`,
    )
  }

  async function sendNotification(method: string, params: unknown): Promise<void> {
    if (!isHealthy() || client === null) {
      throw new Error(`Cannot send notification ${method}: LSP server ${name} is not healthy`)
    }
    touchActivity()
    try {
      await client.sendNotification(method, params)
    } catch (err) {
      throw new Error(
        `LSP notification ${method} to server ${name} failed: ${err instanceof Error ? err.message : String(err)}`,
      )
    }
  }

  // No health/state check: registration on a stopped instance is what lets
  // the passive pass and the configuration handler queue at construction.
  function onNotification(method: string, handler: (params: unknown) => void): void {
    void ensureClient().then(lsp => lsp.onNotification(method, handler))
  }

  function onRequest<P, R>(method: string, handler: (params: P) => R | Promise<R>): void {
    void ensureClient().then(lsp => lsp.onRequest(method, handler))
  }

  return {
    get name() {
      return name
    },
    get config() {
      return config
    },
    get state() {
      return state
    },
    get capabilities() {
      return client?.capabilities
    },
    get startTime() {
      return startTime
    },
    get lastError() {
      return lastError
    },
    get restartCount() {
      return restartCount
    },
    get generation() {
      return generation
    },
    start,
    stop,
    restart,
    isHealthy,
    sendRequest,
    sendNotification,
    onNotification,
    onRequest,
  }
}
