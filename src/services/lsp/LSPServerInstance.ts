import { basename } from 'node:path'
import { pathToFileURL } from 'node:url'

import type { InitializeParams, ServerCapabilities } from 'vscode-languageserver-protocol'

import { getCwd } from '../../utils/cwd.js'
import { logForDebugging } from '../../utils/debug.js'
import { logError } from '../../utils/log.js'
import { languageServerEnv } from '../../utils/subprocessEnv.js'
import type { ExecutionState } from '../../utils/primitives/execution.js'
import { projectExternalState } from '../../utils/primitives/externalProjection.js'
import { processMainOwner } from '../../utils/run/resolveOwner.js'
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
  sendRequest<T = unknown>(method: string, params: unknown): Promise<T>
  sendNotification(method: string, params: unknown): Promise<void>
  onNotification(method: string, handler: (params: unknown) => void): void
  onRequest<TParams = unknown, TResult = unknown>(
    method: string,
    handler: (params: TParams) => TResult | Promise<TResult>,
  ): void
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


function buildInitializeParams(workspaceFolder: string, initializationOptions: unknown): InitializeParams {
  const rootUri = pathToFileURL(workspaceFolder).href
  const bridge = mercuryLspEnabled()
  return {
    processId: process.pid,
    initializationOptions: initializationOptions ?? {},
    workspaceFolders: [{ uri: rootUri, name: basename(workspaceFolder) }],
    rootPath: workspaceFolder,
    rootUri,
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
        hover: {
          dynamicRegistration: false,
          contentFormat: ['markdown', 'plaintext'],
        },
        definition: {
          dynamicRegistration: false,
          linkSupport: true,
        },
        references: {
          dynamicRegistration: false,
        },
        documentSymbol: {
          dynamicRegistration: false,
          hierarchicalDocumentSymbolSupport: true,
        },
        callHierarchy: {
          dynamicRegistration: false,
        },
        ...(bridge
          ? {
              implementation: {
                dynamicRegistration: false,
                linkSupport: true,
              },
              rename: {
                dynamicRegistration: false,
                prepareSupport: true,
              },
              codeAction: {
                dynamicRegistration: false,
                codeActionLiteralSupport: {
                  codeActionKind: {
                    valueSet: ['quickfix', 'refactor', 'source'],
                  },
                },
                resolveSupport: {
                  properties: ['edit'],
                },
              },
              diagnostic: {
                dynamicRegistration: false,
              },
            }
          : {}),
      },
      general: {
        positionEncodings: ['utf-16'],
      },
    },
  }
}

function initBackoffMs(failures: number): number {
  return Math.min(INIT_BACKOFF_BASE_MS * 2 ** Math.max(0, failures - 1), INIT_BACKOFF_MAX_MS)
}

function waitWithCallerAbort(flight: Promise<void>): Promise<void> {
  const signal = currentLspAbortSignal()
  if (signal === undefined) return flight
  return withDeadline(flight, Number.POSITIVE_INFINITY, () => undefined, { signal })
}

function assertStartAllowed(name: string, config: ScopedLspServerConfig, server: LspServerRecord): void {
  const lastFailure = server.lastError
  const isMissingComponent =
    lastFailure !== undefined &&
    isLspStartFailure(lastFailure) &&
    missingRustAnalyzerComponent(lastFailure.lspCause)

  if (isMissingComponent) {
    const call = currentLspCall()
    if (call !== undefined && server.missingComponentCall === call) {
      throw lastFailure
    }
  } else if (server.initFailures > 0) {
    const retryAt = server.lastInitFailureAt + initBackoffMs(server.initFailures)
    if (lspLedgerNow() < retryAt) {
      const refused = startFailure(name, server.initFailures, server.lastError ?? 'previous start failed')
      refused.refused = true
      refused.retryAt = retryAt
      throw refused
    }
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
    const maxRestarts = config.maxRestarts ?? DEFAULT_MAX_RESTARTS
    if (server.crashRecoveries > maxRestarts) {
      const error = new Error(`LSP server ${name} exceeded the crash-restart cap (${maxRestarts})`)
      logError(error)
      throw error
    }
  }
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

  function setState(next: LspServerState): void {
    server.state = next
    projectState(name, next, server.lastError)
  }

  function ensureClient(): Promise<LSPClient> {
    if (server.client !== null) return Promise.resolve(server.client)
    if (server.clientPromise === null) {
      server.clientPromise = import('./LSPClient.js').then(({ createLSPClient }) => {
        const created = createLSPClient(name, (error: Error) => {
          server.lastError = error
          server.crashRecoveries++
          setState('error')
        })
        server.client = created
        return created
      })
    }
    return server.clientPromise
  }

  function clearIdleTimer(): void {
    if (server.idleTimer !== null) {
      stopTimeout(server.idleTimer)
      server.idleTimer = null
    }
  }

  function armIdleTimer(): void {
    clearIdleTimer()
    const idleMs = config.idleTimeoutMs
    if (idleMs === undefined || idleMs <= 0) return
    server.idleTimer = startTimeout(() => {
      server.idleTimer = null
      if (server.state !== 'running') return
      const limit = config.idleTimeoutMs
      if (limit === undefined || limit <= 0) return
      const idleElapsed = Date.now() - server.lastActivityAt
      if (idleElapsed < limit) {
        armIdleTimer()
        return
      }
      logForDebugging(`LSP ${name}: idle for ${idleElapsed}ms — stopping (lazy restart on next use)`)
      void stop().catch((err: unknown) => {
        logForDebugging(`LSP ${name}: idle stop failed: ${err instanceof Error ? err.message : String(err)}`)
      })
    }, idleMs)
    server.idleTimer.unref?.()
  }

  function touchActivity(): void {
    server.lastActivityAt = Date.now()
    if (
      server.state === 'running' &&
      server.idleTimer === null &&
      config.idleTimeoutMs !== undefined &&
      config.idleTimeoutMs > 0
    ) {
      armIdleTimer()
    }
  }

  function isHealthy(): boolean {
    return server.state === 'running' && server.client !== null && server.client.isInitialized
  }

  async function start(): Promise<void> {
    if (server.state === 'running') return
    if (server.inFlightStart !== null) return waitWithCallerAbort(server.inFlightStart)

    assertStartAllowed(name, config, server)

    let settled = false
    let flight: Promise<void> | undefined
    flight = (async () => {
      setState('starting')
      try {
        const client = await ensureClient()
        let spawned = false
        try {
          const workspaceFolder = config.workspaceFolder ?? getCwd()
          const env = { ...languageServerEnv(), ...(config.env ?? {}) }
          await client.start(config.command, config.args ?? [], { env, cwd: workspaceFolder })
          spawned = true
          const initParams = buildInitializeParams(workspaceFolder, config.initializationOptions)
          const initPromise = client.initialize(initParams)
          if (config.startupTimeout !== undefined && config.startupTimeout > 0) {
            await withDeadline(initPromise, config.startupTimeout, () => {
              throw new Error(`LSP server ${name} did not initialize within ${config.startupTimeout}ms`)
            })
          } else {
            await initPromise
          }
          server.startTime = Date.now()
          server.lastActivityAt = server.startTime
          server.initFailures = 0
          server.lastInitFailureAt = 0
          server.crashRecoveries = 0
          server.missingComponentCall = undefined
          server.generation++
          setState('running')
          armIdleTimer()
        } catch (err) {
          if (spawned) {
            try {
              await client.stop()
            } catch (stopErr) {
              passedOver(stopErr)
            }
          }
          server.initFailures++
          server.lastInitFailureAt = lspLedgerNow()
          const wrapped = startFailure(name, server.initFailures, err)
          if (missingRustAnalyzerComponent(wrapped.lspCause)) {
            server.missingComponentCall = currentLspCall()
            server.crashRecoveries = 0
          } else {
            wrapped.retryAt = server.lastInitFailureAt + initBackoffMs(server.initFailures)
          }
          server.lastError = wrapped
          setState('error')
          logError(wrapped)
          throw wrapped
        }
      } finally {
        settled = true
        if (flight !== undefined && server.inFlightStart === flight) server.inFlightStart = null
      }
    })()

    if (!settled) server.inFlightStart = flight
    flight.catch(passedOver)
    return waitWithCallerAbort(flight)
  }

  function stop(): Promise<LSPStopResult | undefined> {
    if (server.state === 'stopped') return Promise.resolve(undefined)
    if (server.inFlightStop !== null) return server.inFlightStop
    clearIdleTimer()
    setState('stopping')
    let settled = false
    let stopFlight: Promise<LSPStopResult | undefined> | undefined
    stopFlight = (async (): Promise<LSPStopResult | undefined> => {
      try {
        const stopOpts =
          config.shutdownTimeout !== undefined ? { gracefulTimeoutMs: config.shutdownTimeout } : undefined
        const result = server.client !== null ? await server.client.stop(stopOpts) : undefined
        setState('stopped')
        return result
      } catch (err) {
        const error = err instanceof Error ? err : new Error(String(err))
        server.lastError = error
        setState('error')
        throw error
      } finally {
        settled = true
        if (stopFlight !== undefined && server.inFlightStop === stopFlight) server.inFlightStop = null
      }
    })()
    if (!settled) server.inFlightStop = stopFlight
    return stopFlight
  }

  async function restart(): Promise<LSPStopResult | undefined> {
    server.initFailures = 0
    server.lastInitFailureAt = 0
    server.missingComponentCall = undefined
    let stopResult: LSPStopResult | undefined
    try {
      stopResult = await stop()
      if (stopResult !== undefined && stopResult.survivors.length > 0) {
        throw new Error(`Processes still running: ${stopResult.survivors.join(', ')}`)
      }
    } catch (err) {
      throw new Error(
        `Failed to stop LSP server ${name} for restart: ${err instanceof Error ? err.message : String(err)}`,
      )
    }
    server.restartCount++
    try {
      await start()
      return stopResult
    } catch (err) {
      throw new Error(
        `Failed to restart LSP server ${name} (restart ${server.restartCount}): ${err instanceof Error ? err.message : String(err)}`,
      )
    }
  }

  const sendRequest = sendRequestOf(server, { name, config, isHealthy, touchActivity })
  const sendNotification = sendNotificationOf(server, { name, isHealthy, touchActivity })

  function onNotification(method: string, handler: (params: unknown) => void): void {
    if (server.client !== null) {
      server.client.onNotification(method, handler)
      return
    }
    void ensureClient().then(client => {
      client.onNotification(method, handler)
    }, passedOver)
  }

  function onRequest<TParams = unknown, TResult = unknown>(
    method: string,
    handler: (params: TParams) => TResult | Promise<TResult>,
  ): void {
    if (server.client !== null) {
      server.client.onRequest(method, handler)
      return
    }
    void ensureClient().then(client => {
      client.onRequest(method, handler)
    }, passedOver)
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
