import { basename } from 'node:path'
import { pathToFileURL } from 'node:url'

import 'vscode-jsonrpc'

import type { InitializeParams, ServerCapabilities } from 'vscode-languageserver-protocol'

import { getCwd } from '../../utils/cwd.js'
import { logForDebugging } from '../../utils/debug.js'
import { logError } from '../../utils/log.js'
import { languageServerEnv } from '../../utils/subprocessEnv.js'
import type { ExecutionState } from '../primitives/execution.js'
import { projectExternalState } from '../primitives/externalProjection.js'
import { processMainOwner } from '../run/resolveOwner.js'
import { lspLedgerNow } from './failureLedger.js'
import { missingRustAnalyzerComponent, startFailureCause } from './failureWords.js'
import type { LSPClient, LSPStopResult } from './LSPClient.js'
import { currentLspAbortSignal, currentLspCall } from './lspAbort.js'
import { mercuryLspEnabled } from './mercuryLsp.js'
import type { LspServerState, ScopedLspServerConfig } from './types.js'
import type { LspServerRecord } from './LSPServerInstance/record.js'
import { sendNotificationOf, sendRequestOf } from './LSPServerInstance/requests.js'
import { withDeadline } from '../../utils/deadline.js'
import { passedOver } from '../../utils/passedOver.js'
import { startTimeout, stopTimeout } from '../../utils/timers.js'


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
  stop(): Promise<LSPStopResult | undefined>
  restart(): Promise<LSPStopResult | undefined>
  isHealthy(): boolean
  sendRequest<T>(method: string, params: unknown): Promise<T>
  sendNotification(method: string, params: unknown): Promise<void>
  onNotification(method: string, handler: (params: unknown) => void): void
  onRequest<P, R>(method: string, handler: (params: P) => R | Promise<R>): void
}

const DEFAULT_MAX_RESTARTS = 3

export type LspStartFailure = Error & { server: string; attempts: number; lspCause: string; refused?: boolean; retryAt?: number }

function startFailure(server: string, attempts: number, cause: unknown): LspStartFailure {
  const lspCause = startFailureCause(server, cause)
  const error: LspStartFailure = Object.assign(
    new Error(`LSP server ${server} did not start (${attempts} attempt${attempts === 1 ? '' : 's'} this session): ${lspCause}`),
    { server, attempts, lspCause },
  )
  error.name = 'LspStartFailure'
  return error
}

export function isLspStartFailure(err: unknown): err is LspStartFailure {
  return err instanceof Error && err.name === 'LspStartFailure'
}

const INIT_BACKOFF_BASE_MS = 15_000
const INIT_BACKOFF_MAX_MS = 5 * 60_000


function planeState(state: LspServerState): ExecutionState {
  return state === 'error' ? 'failed' : state
}

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


function buildInitializeParams(config: ScopedLspServerConfig): InitializeParams {
  const folder = config.workspaceFolder ?? getCwd()
  const uri = pathToFileURL(folder).href
  const bridge = mercuryLspEnabled()
  return {
    processId: process.pid,
    initializationOptions: config.initializationOptions ?? {},
    workspaceFolders: [{ uri, name: basename(folder) }],
    rootPath: folder,
    rootUri: uri,
    capabilities: {
      workspace: {
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


export function createLSPServerInstance(name: string, config: ScopedLspServerConfig): LSPServerInstance {
  const server: LspServerRecord = {
    state: 'stopped',
    client: null,
    clientPromise: null,
    startTime: undefined,
    lastError: undefined,
    restartCount: 0,
    crashRecoveries: 0,
    generation: 0,
    inFlightStart: null,
    initFailures: 0,
    lastInitFailureAt: 0,
    missingComponentCall: undefined,
    idleTimer: null,
    lastActivityAt: 0,
    inFlightStop: null,
  }

  function clearIdleTimer(): void {
    if (server.idleTimer !== null) {
      stopTimeout(server.idleTimer)
      server.idleTimer = null
    }
  }

  function armIdleTimer(): void {
    const timeout = config.idleTimeoutMs
    if (timeout === undefined) return
    clearIdleTimer()
    server.idleTimer = startTimeout(() => {
      server.idleTimer = null
      const idleFor = Date.now() - server.lastActivityAt
      if (server.state === 'running' && idleFor >= timeout) {
        logForDebugging(`LSP ${name}: idle for ${idleFor}ms — stopping (lazy restart on next use)`)
        void stop().catch(err => logForDebugging(`LSP ${name}: idle stop failed: ${String(err)}`))
      } else if (server.state === 'running') {
        armIdleTimer()
      }
    }, timeout)
    server.idleTimer.unref?.()
  }

  function touchActivity(): void {
    server.lastActivityAt = Date.now()
    if (server.state === 'running' && config.idleTimeoutMs !== undefined && server.idleTimer === null) {
      armIdleTimer()
    }
  }

  function setState(next: LspServerState, error?: Error): void {
    server.state = next
    projectState(name, next, error)
  }

  function maxRestarts(): number {
    return config.maxRestarts ?? DEFAULT_MAX_RESTARTS
  }

  function ensureClient(): Promise<LSPClient> {
    if (server.clientPromise !== null) return server.clientPromise
    server.clientPromise = import('./LSPClient.js').then(({ createLSPClient }) => {
      server.client = createLSPClient(name, error => {
        server.lastError = error
        server.crashRecoveries++
        setState('error', error)
      })
      return server.client
    })
    return server.clientPromise
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
        const timeout = config.startupTimeout
        await withDeadline(initialize, timeout, () => {
          throw new Error(`LSP server ${name} did not initialize within ${timeout}ms`)
        })
      } else {
        await initialize
      }
      setState('running')
      server.startTime = Date.now()
      server.crashRecoveries = 0
      server.initFailures = 0
      server.missingComponentCall = undefined
      server.generation++
      server.lastActivityAt = Date.now()
      armIdleTimer()
    } catch (err) {
      if (spawned) {
        await lsp.stop().catch(passedOver)
      }
      server.initFailures++
      server.lastInitFailureAt = lspLedgerNow()
      const error = startFailure(name, server.initFailures, err)
      if (missingRustAnalyzerComponent(error.lspCause)) {
        server.missingComponentCall = currentLspCall()
        server.crashRecoveries = 0
      } else {
        error.retryAt = server.lastInitFailureAt + Math.min(INIT_BACKOFF_BASE_MS * 2 ** (server.initFailures - 1), INIT_BACKOFF_MAX_MS)
      }
      server.lastError = error
      setState('error', error)
      logError(error)
      throw error
    }
  }

  function initBackoffRemainingMs(): number {
    if (server.initFailures === 0 || server.lastError && missingRustAnalyzerComponent(server.lastError.message)) return 0
    const window = Math.min(INIT_BACKOFF_BASE_MS * 2 ** (server.initFailures - 1), INIT_BACKOFF_MAX_MS)
    return Math.max(0, server.lastInitFailureAt + window - lspLedgerNow())
  }

  function waitStart(flight: Promise<void>): Promise<void> {
    const signal = currentLspAbortSignal()
    if (signal === undefined) return flight
    flight.catch(passedOver)
    return withDeadline(flight, Number.POSITIVE_INFINITY, () => undefined, { signal })
  }

  async function start(): Promise<void> {
    if (server.state === 'running') return
    if (server.state === 'starting' && server.inFlightStart !== null) {
      return waitStart(server.inFlightStart)
    }
    if (server.lastError && missingRustAnalyzerComponent(server.lastError.message) && server.missingComponentCall !== undefined && server.missingComponentCall === currentLspCall()) throw server.lastError
    const backoffMs = initBackoffRemainingMs()
    if (backoffMs > 0) {
      const error = startFailure(name, server.initFailures, server.lastError ?? 'no error recorded')
      error.refused = true
      error.retryAt = lspLedgerNow() + backoffMs
      throw error
    }
    if (server.state === 'error' && server.crashRecoveries > 0) {
      if (config.restartOnCrash === false) {
        const error = new Error(
          `LSP server ${name} crashed and will not respawn (restartOnCrash is false): ${server.lastError?.message ?? 'no error recorded'}`,
        )
        server.lastError = error
        logError(error)
        throw error
      }
      if (server.crashRecoveries > maxRestarts()) {
        const error = new Error(`LSP server ${name} exceeded the crash-restart cap (${maxRestarts()})`)
        logError(error)
        throw error
      }
    }
    server.inFlightStart = runStart().finally(() => {
      server.inFlightStart = null
    })
    return waitStart(server.inFlightStart)
  }

  async function stop(): Promise<LSPStopResult | undefined> {
    if (server.state === 'stopped') return
    if (server.state === 'stopping') return server.inFlightStop ?? undefined
    server.inFlightStop = runStop().finally(() => {
      server.inFlightStop = null
    })
    return server.inFlightStop
  }

  async function runStop(): Promise<LSPStopResult | undefined> {
    clearIdleTimer()
    setState('stopping')
    try {
      const result = await server.client?.stop(
        config.shutdownTimeout !== undefined ? { gracefulTimeoutMs: config.shutdownTimeout } : undefined,
      )
      setState('stopped')
      return result
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err))
      server.lastError = error
      setState('error', error)
      throw error
    }
  }

  async function restart(): Promise<LSPStopResult | undefined> {
    server.initFailures = 0
    server.lastInitFailureAt = 0
    server.missingComponentCall = undefined
    let stopped: LSPStopResult | undefined
    try {
      stopped = await stop()
      if (stopped?.survivors.length) throw new Error(`Processes still running: ${stopped.survivors.join(', ')}`)
    } catch (err) {
      throw new Error(`Failed to stop LSP server ${name} for restart: ${err instanceof Error ? err.message : String(err)}`)
    }
    server.restartCount++
    try {
      await start()
      return stopped
    } catch (err) {
      throw new Error(
        `Failed to restart LSP server ${name} (restart ${server.restartCount}): ${
          err instanceof Error ? err.message : String(err)
        }`,
      )
    }
  }

  function isHealthy(): boolean {
    return server.state === 'running' && server.client !== null && server.client.isInitialized
  }

  const sendRequest = sendRequestOf(server, { name, config, isHealthy, touchActivity })
  const sendNotification = sendNotificationOf(server, { name, isHealthy, touchActivity })

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
      return server.state
    },
    get capabilities() {
      return server.client?.capabilities
    },
    get startTime() {
      return server.startTime
    },
    get lastError() {
      return server.lastError
    },
    get restartCount() {
      return server.restartCount
    },
    get generation() {
      return server.generation
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
