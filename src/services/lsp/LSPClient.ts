import { type ChildProcess, spawn } from 'node:child_process'
import { createInterface } from 'node:readline'

import { type CancellationToken } from 'vscode-jsonrpc'
import {
  createMessageConnection,
  type MessageConnection,
  StreamMessageReader,
  StreamMessageWriter,
  Trace,
} from 'vscode-jsonrpc/node.js'
import type { InitializeParams, InitializeResult, ServerCapabilities } from 'vscode-languageserver-protocol'

import { logForDebugging } from '../../utils/debug.js'
import { logError } from '../../utils/log.js'
import { endProcessTree, endProcessTreeSurvivors } from '../../utils/processGroup.js'


export type LSPClient = {
  readonly capabilities: ServerCapabilities | undefined
  readonly isInitialized: boolean
  start(command: string, args: string[], options?: { env?: NodeJS.ProcessEnv; cwd?: string }): Promise<void>
  initialize(params: InitializeParams): Promise<InitializeResult>
  sendRequest<T>(method: string, params: unknown, token?: CancellationToken): Promise<T>
  sendNotification(method: string, params: unknown): Promise<void>
  onNotification(method: string, handler: (params: unknown) => void): void
  onRequest<P, R>(method: string, handler: (params: P) => R | Promise<R>): void
  stop(opts?: { gracefulTimeoutMs?: number }): Promise<void>
}

const DEFAULT_GRACEFUL_TIMEOUT_MS = 2000

type QueuedNotification = { method: string; handler: (params: unknown) => void }
type QueuedRequest = { method: string; handler: (params: never) => unknown }

export function createLSPClient(serverName: string, onCrash?: (error: Error) => void): LSPClient {
  let child: ChildProcess | null = null
  let connection: MessageConnection | null = null
  let capabilities: ServerCapabilities | undefined
  let initialized = false
  let stopping = false
  let startFailed = false
  let startError: Error | undefined
  let crashNotified = false
  const stderrTail: string[] = []
  let deathReject: ((err: Error) => void) | null = null
  let deathPromise: Promise<never> | null = null

  function armDeathPromise(): void {
    deathPromise = new Promise<never>((_, reject) => {
      deathReject = reject
    })
    deathPromise.catch(() => {
    })
  }

  function signalDeath(message: string): void {
    const tail = stderrTail.length > 0 ? ` — server said: ${stderrTail.join(' | ')}` : ''
    deathReject?.(new Error(`${message}${tail}`))
    deathReject = null
  }
  const notificationHandlers: QueuedNotification[] = []
  const requestHandlers: QueuedRequest[] = []
  let processErrorListener: ((err: Error) => void) | null = null
  let processExitListener: ((code: number | null, signal: NodeJS.Signals | null) => void) | null = null
  let stdinErrorListener: ((err: Error) => void) | null = null
  let stderrDataListener: ((chunk: Buffer) => void) | null = null

  function notifyCrash(error: Error): void {
    if (crashNotified || stopping) return
    crashNotified = true
    initialized = false
    logError(error)
    onCrash?.(error)
  }

  function checkStartFailure(): void {
    if (startFailed) {
      throw startError ?? new Error(`LSP server ${serverName} failed to start`)
    }
  }

  async function start(
    command: string,
    args: string[],
    options?: { env?: NodeJS.ProcessEnv; cwd?: string },
  ): Promise<void> {
    try {
      startFailed = false
      startError = undefined
      crashNotified = false
      stderrTail.length = 0
      armDeathPromise()

      const isWindowsBatchShim =
        process.platform === 'win32' && /\.(cmd|bat)$/i.test(command.trim())
      const proc = spawn(command, args, {
        stdio: ['pipe', 'pipe', 'pipe'],
        env: options?.env,
        cwd: options?.cwd,
        windowsHide: true,
        ...(isWindowsBatchShim ? { shell: true } : {}),
      })
      if (!proc.stdout || !proc.stdin) {
        throw new Error(`LSP server ${serverName}: stdio streams are not available`)
      }
      child = proc

      await new Promise<void>((resolve, reject) => {
        const onSpawn = (): void => {
          proc.off('error', onError)
          resolve()
        }
        const onError = (err: Error): void => {
          proc.off('spawn', onSpawn)
          reject(err)
        }
        proc.once('spawn', onSpawn)
        proc.once('error', onError)
      })

      if (proc.stderr) {
        const lines = createInterface({ input: proc.stderr })
        lines.on('line', line => {
          const trimmed = line.trim()
          if (trimmed !== '') {
            logForDebugging(`[lsp:${serverName}] ${trimmed}`)
            stderrTail.push(trimmed.slice(0, 200))
            if (stderrTail.length > 5) stderrTail.shift()
          }
        })
        stderrDataListener = () => {
        }
        proc.stderr.on('data', stderrDataListener)
      }

      processErrorListener = (err: Error) => {
        if (stopping) return
        startFailed = true
        startError = err
        logForDebugging(`LSP server ${serverName} process error: ${err.message}`, { level: 'error' })
      }
      proc.on('error', processErrorListener)

      processExitListener = (code, signal) => {
        if (stopping) return
        initialized = false
        startFailed = false
        startError = undefined
        const message =
          code !== null && code !== 0
            ? `LSP server ${serverName} crashed with exit code ${code}`
            : `LSP server ${serverName} exited unexpectedly (code ${String(code)}, signal ${signal ?? 'none'})`
        signalDeath(message)
        notifyCrash(new Error(message))
      }
      proc.on('exit', processExitListener)

      stdinErrorListener = (err: Error) => {
        if (!stopping) logForDebugging(`LSP server ${serverName} stdin error: ${err.message}`)
      }
      proc.stdin.on('error', stdinErrorListener)

      const conn = createMessageConnection(
        new StreamMessageReader(proc.stdout),
        new StreamMessageWriter(proc.stdin),
      )
      connection = conn

      conn.onError(([err]: [Error]) => {
        if (stopping) return
        logForDebugging(`LSP server ${serverName} connection error: ${err.message}`, { level: 'error' })
        if (!initialized) {
          startFailed = true
          startError = err
        }
      })
      conn.onClose(() => {
        if (stopping) return
        if (initialized) {
          notifyCrash(new Error(`LSP server ${serverName} connection closed`))
        }
        initialized = false
        logForDebugging(`LSP server ${serverName} connection closed`)
      })

      conn.listen()

      conn
        .trace(Trace.Verbose, {
          log: (message: string, data?: string) => {
            logForDebugging(`[lsp-trace:${serverName}] ${message}${data ? ` ${data}` : ''}`)
          },
        })
        .catch((err: unknown) => {
          logForDebugging(`LSP server ${serverName} trace enable failed: ${String(err)}`)
        })

      for (const entry of notificationHandlers) {
        conn.onNotification(entry.method, entry.handler)
        logForDebugging(`LSP server ${serverName}: applied notification handler ${entry.method}`)
      }
      for (const entry of requestHandlers) {
        conn.onRequest(entry.method, entry.handler as never)
        logForDebugging(`LSP server ${serverName}: applied request handler ${entry.method}`)
      }
    } catch (err) {
      logForDebugging(`LSP server ${serverName} failed to start: ${String(err)}`, { level: 'error' })
      throw err
    }
  }

  async function initialize(params: InitializeParams): Promise<InitializeResult> {
    if (connection === null) throw new Error(`LSP server ${serverName} not started`)
    checkStartFailure()
    try {
      const request = connection.sendRequest('initialize', params) as Promise<InitializeResult>
      const result = deathPromise !== null ? await Promise.race([request, deathPromise]) : await request
      capabilities = result.capabilities
      await connection.sendNotification('initialized', {})
      initialized = true
      logForDebugging(`LSP server ${serverName} initialized`)
      return result
    } catch (err) {
      logForDebugging(`LSP server ${serverName} initialize failed: ${String(err)}`, { level: 'error' })
      throw err
    }
  }

  async function sendRequest<T>(method: string, params: unknown, token?: CancellationToken): Promise<T> {
    if (connection === null) throw new Error(`LSP server ${serverName} not started`)
    checkStartFailure()
    if (!initialized) throw new Error(`LSP server ${serverName} not initialized`)
    try {
      return (await connection.sendRequest(method, params, token)) as T
    } catch (err) {
      logForDebugging(`LSP server ${serverName} request ${method} failed: ${String(err)}`, { level: 'error' })
      throw err
    }
  }

  async function sendNotification(method: string, params: unknown): Promise<void> {
    if (connection === null) throw new Error(`LSP server ${serverName} not started`)
    checkStartFailure()
    try {
      await connection.sendNotification(method, params)
    } catch (err) {
      logForDebugging(`LSP server ${serverName} notification ${method} failed: ${String(err)}`, { level: 'error' })
      logForDebugging(`LSP server ${serverName}: continuing after failed notification ${method}`)
    }
  }

  function onNotification(method: string, handler: (params: unknown) => void): void {
    notificationHandlers.push({ method, handler })
    if (connection === null) {
      logForDebugging(`LSP server ${serverName}: queued notification handler ${method} (no connection yet)`)
      return
    }
    checkStartFailure()
    connection.onNotification(method, handler)
  }

  function onRequest<P, R>(method: string, handler: (params: P) => R | Promise<R>): void {
    requestHandlers.push({ method, handler: handler as (params: never) => unknown })
    if (connection === null) {
      logForDebugging(`LSP server ${serverName}: queued request handler ${method} (no connection yet)`)
      return
    }
    checkStartFailure()
    connection.onRequest(method, handler as never)
  }

  async function stop(opts?: { gracefulTimeoutMs?: number }): Promise<void> {
    const budget = opts?.gracefulTimeoutMs ?? DEFAULT_GRACEFUL_TIMEOUT_MS
    stopping = true
    let gracefulFailed: unknown = null
    if (connection !== null) {
      const conn = connection
      let deadline: NodeJS.Timeout | null = null
      try {
        const shutdown = conn.sendRequest('shutdown', null)
        shutdown.catch(() => {
        })
        await Promise.race([
          shutdown,
          new Promise<never>((_, reject) => {
            deadline = setTimeout(
              () => reject(new Error(`LSP server ${serverName} shutdown timed out after ${budget}ms`)),
              budget,
            )
          }),
        ])
        await conn.sendNotification('exit', null)
      } catch (err) {
        gracefulFailed = err
      } finally {
        if (deadline !== null) clearTimeout(deadline)
      }
    }
    if (connection !== null) {
      try {
        connection.dispose()
      } catch (err) {
        logForDebugging(`LSP server ${serverName} connection dispose failed: ${String(err)}`)
      }
      connection = null
    }
    if (child !== null) {
      if (processErrorListener) child.off('error', processErrorListener)
      if (processExitListener) child.off('exit', processExitListener)
      if (stdinErrorListener) child.stdin?.off('error', stdinErrorListener)
      if (stderrDataListener) child.stderr?.off('data', stderrDataListener)
      const receipt = await endProcessTree(child, 'SIGTERM')
      if (receipt.survivors.length > 0 && child.pid) {
        await endProcessTreeSurvivors(child.pid, receipt.survivors, 'SIGKILL')
      }
      child = null
    }
    processErrorListener = null
    processExitListener = null
    stdinErrorListener = null
    stderrDataListener = null
    initialized = false
    capabilities = undefined
    stopping = false
    if (gracefulFailed !== null) {
      startFailed = true
      startError = gracefulFailed instanceof Error ? gracefulFailed : new Error(String(gracefulFailed))
      logForDebugging(`LSP server ${serverName} graceful shutdown failed: ${String(gracefulFailed)}`)
    }
  }

  return {
    get capabilities() {
      return capabilities
    },
    get isInitialized() {
      return initialized
    },
    start,
    initialize,
    sendRequest,
    sendNotification,
    onNotification,
    onRequest,
    stop,
  }
}
