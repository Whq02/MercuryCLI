import { type ChildProcess, type ChildProcessWithoutNullStreams, spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
import type { Writable } from 'node:stream'

import { type CancellationToken, type GenericNotificationHandler, type GenericRequestHandler, type Message, type MessageWriter } from 'vscode-jsonrpc'
import {
  createMessageConnection,
  type MessageConnection,
  StreamMessageReader,
  StreamMessageWriter,
  Trace,
} from 'vscode-jsonrpc/node.js'
import type { InitializeParams, InitializeResult, ServerCapabilities } from 'vscode-languageserver-protocol'

import { logForDebugging } from '../../platform/logs/debugLog.js'
import { logError } from '../../platform/logs/errorLog.js'
import { endProcessTree, endProcessTreeSurvivors } from '../../platform/processes/processGroup.js'
import { passedOver } from '../../platform/errors/passedOver.js'
import { withDeadline } from '../../platform/async/deadline.js'
import { wasEndedByProcessTreeKill } from '../../platform/host-os/processes.js'
import { isBatchShim } from '../../platform/host-os/spawn.js'


export type LSPStopResult = {
  outcome: 'exited' | 'killed'
  elapsedMs: number
  exitCode: number | null
  survivors: number[]
}

export type LSPClient = {
  readonly capabilities: ServerCapabilities | undefined
  readonly isInitialized: boolean
  start(command: string, args: string[], options?: { env?: NodeJS.ProcessEnv; cwd?: string }): Promise<void>
  initialize(params: InitializeParams): Promise<InitializeResult>
  sendRequest<T = unknown>(method: string, params: unknown, token?: CancellationToken): Promise<T>
  sendNotification(method: string, params: unknown): Promise<void>
  onNotification<T = unknown>(method: string, handler: (params: T) => void | Promise<void>): void
  onRequest<T = unknown, R = unknown>(method: string, handler: (params: T) => R | Promise<R>): void
  stop(options?: { gracefulTimeoutMs?: number }): Promise<LSPStopResult | undefined>
}

type QueuedNotification = { method: string; handler: GenericNotificationHandler }
type QueuedRequest = { method: string; handler: GenericRequestHandler<unknown, unknown> }

export function createLspMessageWriter(output: Writable): MessageWriter {
  const writer = new StreamMessageWriter(output)
  const write = writer.write.bind(writer)
  writer.write = async (message: Message) => {
    if (output.destroyed || output.writableEnded) return
    try {
      await write(message)
    } catch (error) {
      const code = (error as NodeJS.ErrnoException)?.code
      if ((output.destroyed || output.writableEnded) && (code === 'ERR_STREAM_DESTROYED' || code === 'ERR_STREAM_WRITE_AFTER_END' || code === 'EPIPE')) return
      throw error
    }
  }
  return writer
}

function tailStderr(proc: ChildProcessWithoutNullStreams, serverName: string, stderrTail: string[]): void {
  const lines = createInterface({ input: proc.stderr })
  lines.on('line', line => {
    const trimmed = line.trim()
    if (trimmed !== '') {
      logForDebugging(`[lsp:${serverName}] ${trimmed}`)
      stderrTail.push(trimmed.slice(0, 200))
      if (stderrTail.length > 5) stderrTail.shift()
    }
  })
}

function applyQueuedHandlers(conn: MessageConnection, serverName: string, notificationHandlers: QueuedNotification[], requestHandlers: QueuedRequest[]): void {
  for (const entry of notificationHandlers) {
    conn.onNotification(entry.method, entry.handler)
    logForDebugging(`LSP server ${serverName}: applied notification handler ${entry.method}`)
  }
  for (const entry of requestHandlers) {
    conn.onRequest(entry.method, entry.handler)
    logForDebugging(`LSP server ${serverName}: applied request handler ${entry.method}`)
  }
}

const DEFAULT_GRACEFUL_TIMEOUT_MS = 2_000

type LspClientState = {
  readonly serverName: string
  readonly onCrash?: (error: Error) => void
  childProcess: ChildProcess | null
  connection: MessageConnection | null
  capabilities: ServerCapabilities | undefined
  isInitialized: boolean
  startFailed: boolean
  startError: Error | undefined
  isStopping: boolean
  crashNotified: boolean
  onChildError: ((error: Error) => void) | null
  onChildExit: ((code: number | null, signal: NodeJS.Signals | null) => void) | null
  onStdinError: ((error: Error) => void) | null
  readonly notificationHandlers: QueuedNotification[]
  readonly requestHandlers: QueuedRequest[]
  readonly stderrTail: string[]
  processDeathPromise: Promise<never> | null
  rejectOnDeath: ((error: Error) => void) | null
}

function notifyClientCrash(state: LspClientState, error: Error): void {
  if (state.isStopping || state.crashNotified) return
  state.crashNotified = true
  logError(error)
  state.onCrash?.(error)
}

function requireClientConnection(state: LspClientState): MessageConnection {
  if (state.connection === null) {
    throw new Error(`LSP server ${state.serverName} not started`)
  }
  if (state.startFailed) {
    throw state.startError ?? new Error(`LSP server ${state.serverName} failed to start`)
  }
  return state.connection
}

async function startClient(
  state: LspClientState,
  command: string,
  args: string[],
  options?: { env?: NodeJS.ProcessEnv; cwd?: string },
): Promise<void> {
  const { serverName } = state
  state.startFailed = false
  state.startError = undefined
  state.crashNotified = false
  state.stderrTail.length = 0
  state.processDeathPromise = new Promise<never>((_, reject) => {
    state.rejectOnDeath = reject
  })
  state.processDeathPromise.catch(passedOver)

  try {
    const proc = spawn(command, args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: options?.env,
      cwd: options?.cwd,
      windowsHide: true,
      shell: isBatchShim(command.trim()),
    })
    state.childProcess = proc

    if (!proc.stdin || !proc.stdout) {
      throw new Error(`LSP server ${serverName}: stdio streams are not available`)
    }

    await new Promise<void>((resolve, reject) => {
      const handleSpawn = (): void => {
        proc.off('error', handleError)
        resolve()
      }
      const handleError = (error: Error): void => {
        proc.off('spawn', handleSpawn)
        reject(error)
      }
      proc.once('spawn', handleSpawn)
      proc.once('error', handleError)
    })

    tailStderr(proc, serverName, state.stderrTail)

    state.onChildError = (error: Error): void => {
      if (state.childProcess !== proc || state.isStopping) return
      state.startFailed = true
      state.startError = error
      logForDebugging(`LSP server ${serverName} process error: ${error.message}`, { level: 'error' })
    }
    proc.on('error', state.onChildError)
    state.onChildExit = (code: number | null, signal: NodeJS.Signals | null): void => {
      if (state.childProcess !== proc || state.isStopping) return
      state.isInitialized = false
      const baseMessage =
        code !== null && code !== 0
          ? `LSP server ${serverName} crashed with exit code ${code}`
          : `LSP server ${serverName} exited unexpectedly (code ${code}, signal ${signal ?? 'none'})`
      const tail = state.stderrTail.length > 0 ? ` — server said: ${state.stderrTail.join(' | ')}` : ''
      const exitError = new Error(`${baseMessage}${tail}`)
      state.startFailed = true
      state.startError = exitError
      state.rejectOnDeath?.(exitError)
      notifyClientCrash(state, new Error(baseMessage))
    }
    proc.on('exit', state.onChildExit)

    state.onStdinError = (error: Error): void => {
      if (!state.isStopping) {
        logForDebugging(`LSP server ${serverName} stdin error: ${error.message}`)
      }
    }
    proc.stdin.on('error', state.onStdinError)

    const reader = new StreamMessageReader(proc.stdout)
    const writer = createLspMessageWriter(proc.stdin)
    const conn = createMessageConnection(reader, writer)
    state.connection = conn

    conn.onError(([error]: [Error, Message | undefined, number | undefined]) => {
      if (state.connection !== conn || state.isStopping) return
      if (!state.isInitialized) {
        state.startFailed = true
        state.startError = error
      }
      logForDebugging(`LSP server ${serverName} connection error: ${error.message}`, { level: 'error' })
    })

    conn.onClose(() => {
      if (state.connection !== conn || state.isStopping) return
      logForDebugging(`LSP server ${serverName} connection closed`)
      if (state.isInitialized) {
        state.isInitialized = false
        notifyClientCrash(state, new Error(`LSP server ${serverName} connection closed`))
      }
    })

    conn.listen()
    try {
      await conn.trace(Trace.Verbose, {
        log(message: string, data?: string) {
          logForDebugging(`[lsp-trace:${serverName}] ${message}${data ? ` ${data}` : ''}`)
        },
      })
    } catch (error) {
      logForDebugging(
        `LSP server ${serverName} trace enable failed: ${error instanceof Error ? error.message : String(error)}`,
      )
    }

    applyQueuedHandlers(conn, serverName, state.notificationHandlers, state.requestHandlers)
  } catch (error) {
    const err = error instanceof Error ? error : new Error(String(error))
    state.startFailed = true
    state.startError = err
    logForDebugging(`LSP server ${serverName} failed to start: ${err.message}`, { level: 'error' })
    throw err
  }
}

async function stopClient(
  state: LspClientState,
  options?: { gracefulTimeoutMs?: number },
): Promise<LSPStopResult | undefined> {
  const { serverName } = state
  state.isStopping = true
  const startedAt = performance.now()
  let gracefulError: Error | undefined = undefined
  const budget = options?.gracefulTimeoutMs ?? DEFAULT_GRACEFUL_TIMEOUT_MS

  try {
    const proc = state.childProcess
    const conn = state.connection
    const listening =
      proc !== null &&
      proc.exitCode === null &&
      proc.signalCode === null &&
      proc.stdin !== null &&
      proc.stdin.writable &&
      !proc.stdin.destroyed

    if (conn !== null) {
      if (!listening) {
        logForDebugging(`LSP server ${serverName} is already gone; no shutdown handshake`)
      } else {
        try {
          const shutdownReq = conn.sendRequest('shutdown', null)
          shutdownReq.catch(passedOver)
          await withDeadline(shutdownReq, budget, () => {
            throw new Error(`LSP server ${serverName} shutdown timed out after ${budget}ms`)
          })
          await conn.sendNotification('exit', null)
        } catch (error) {
          gracefulError = error instanceof Error ? error : new Error(String(error))
        }
      }

      try {
        conn.dispose()
      } catch (error) {
        logForDebugging(
          `LSP server ${serverName} connection dispose failed: ${error instanceof Error ? error.message : String(error)}`,
        )
      }
      state.connection = null
    }

    if (proc !== null) {
      if (state.onChildError !== null) proc.off('error', state.onChildError)
      if (state.onChildExit !== null) proc.off('exit', state.onChildExit)
      if (state.onStdinError !== null && proc.stdin !== null) proc.stdin.off('error', state.onStdinError)
      proc.stderr?.removeAllListeners()

      const wasLive = proc.exitCode === null && proc.signalCode === null
      let firstEnded = 0
      let survivors: number[] = []

      if (proc.pid !== undefined) {
        const first = await endProcessTree(proc, 'SIGTERM')
        firstEnded = first.ended
        survivors = first.survivors
        if (survivors.length > 0) {
          const second = await endProcessTreeSurvivors(proc.pid, survivors, 'SIGKILL')
          survivors = second.survivors
        }
      }

      const killed = wasLive && wasEndedByProcessTreeKill(proc.signalCode, firstEnded, proc.exitCode)
      return {
        outcome: killed ? 'killed' : 'exited',
        elapsedMs: Math.round(performance.now() - startedAt),
        exitCode: proc.exitCode,
        survivors,
      }
    }

    return undefined
  } finally {
    state.childProcess = null
    state.onChildError = null
    state.onChildExit = null
    state.onStdinError = null
    state.processDeathPromise = null
    state.rejectOnDeath = null
    state.isInitialized = false
    state.capabilities = undefined
    state.isStopping = false
    if (gracefulError !== undefined) {
      state.startFailed = true
      state.startError = gracefulError
      logForDebugging(`LSP server ${serverName} graceful shutdown failed: ${gracefulError.message}`)
    }
  }
}

export function createLSPClient(serverName: string, onCrash?: (error: Error) => void): LSPClient {
  const state: LspClientState = {
    serverName,
    onCrash,
    childProcess: null,
    connection: null,
    capabilities: undefined,
    isInitialized: false,
    startFailed: false,
    startError: undefined,
    isStopping: false,
    crashNotified: false,
    onChildError: null,
    onChildExit: null,
    onStdinError: null,
    notificationHandlers: [],
    requestHandlers: [],
    stderrTail: [],
    processDeathPromise: null,
    rejectOnDeath: null,
  }

  return {
    get capabilities() {
      return state.capabilities
    },
    get isInitialized() {
      return state.isInitialized
    },
    start(command, args, options) {
      return startClient(state, command, args, options)
    },
    async initialize(params) {
      const conn = requireClientConnection(state)
      try {
        const initPromise: Promise<InitializeResult> = conn.sendRequest('initialize', params)
        initPromise.catch(passedOver)
        const result =
          state.processDeathPromise !== null
            ? await Promise.race([initPromise, state.processDeathPromise])
            : await initPromise
        state.capabilities = result.capabilities
        await conn.sendNotification('initialized', {})
        state.isInitialized = true
        logForDebugging(`LSP server ${serverName} initialized`)
        return result
      } catch (error) {
        const err = error instanceof Error ? error : new Error(String(error))
        logForDebugging(`LSP server ${serverName} initialize failed: ${err.message}`, { level: 'error' })
        throw error
      }
    },
    async sendRequest<T = unknown>(method: string, params: unknown, token?: CancellationToken): Promise<T> {
      const conn = requireClientConnection(state)
      if (!state.isInitialized) {
        throw new Error(`LSP server ${serverName} not initialized`)
      }
      try {
        return token !== undefined
          ? await conn.sendRequest(method, params, token)
          : await conn.sendRequest(method, params)
      } catch (error) {
        const err = error instanceof Error ? error : new Error(String(error))
        logForDebugging(`LSP server ${serverName} request ${method} failed: ${err.message}`, { level: 'error' })
        throw error
      }
    },
    async sendNotification(method, params) {
      const conn = requireClientConnection(state)
      try {
        await conn.sendNotification(method, params)
      } catch (error) {
        const err = error instanceof Error ? error : new Error(String(error))
        logForDebugging(`LSP server ${serverName} notification ${method} failed: ${err.message}`, { level: 'error' })
        throw error
      }
    },
    onNotification<T = unknown>(method: string, handler: (params: T) => void | Promise<void>) {
      state.notificationHandlers.push({ method, handler })
      if (state.connection === null) {
        logForDebugging(`LSP server ${serverName}: queued notification handler ${method} (no connection yet)`)
        return
      }
      if (state.startFailed) {
        throw state.startError ?? new Error(`LSP server ${serverName} failed to start`)
      }
      state.connection.onNotification(method, handler)
    },
    onRequest<T = unknown, R = unknown>(method: string, handler: (params: T) => R | Promise<R>) {
      state.requestHandlers.push({ method, handler })
      if (state.connection === null) {
        logForDebugging(`LSP server ${serverName}: queued request handler ${method} (no connection yet)`)
        return
      }
      if (state.startFailed) {
        throw state.startError ?? new Error(`LSP server ${serverName} failed to start`)
      }
      state.connection.onRequest(method, handler)
    },
    stop(options) {
      return stopClient(state, options)
    },
  }
}
