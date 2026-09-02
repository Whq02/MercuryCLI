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

/**
 * JSON-RPC-over-stdio wrapper around one language-server child process:
 * spawn, handshake plumbing, request/notification send, handler queueing,
 * bounded graceful stop, crash notification.
 */

export type LSPClient = {
  readonly capabilities: ServerCapabilities | undefined
  readonly isInitialized: boolean
  start(command: string, args: string[], options?: { env?: NodeJS.ProcessEnv; cwd?: string }): Promise<void>
  initialize(params: InitializeParams): Promise<InitializeResult>
  /** `token` rides the connection: cancelling it emits `$/cancelRequest`
   *  to the server, so an abandoned request is abandoned on the WIRE too. */
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
  // Start-failure latch (flag + stored error) and the crash-notified latch;
  // both belong to ONE process generation and are cleared at the next start.
  let startFailed = false
  let startError: Error | undefined
  let crashNotified = false
  /** The child's last stderr lines — a dying server's own explanation (a
   *  rustup shim for an uninstalled component, a missing runtime) is the
   *  best failure evidence there is. Bounded ring, cleared per generation. */
  const stderrTail: string[] = []
  /** Rejects the moment the child dies — the initialize race arm that makes
   *  a doomed spawn fail in milliseconds instead of the whole startup
   *  timeout. Re-armed per generation; the rejection is pre-observed so a
   *  generation that never initializes cannot leak an unhandled rejection. */
  let deathReject: ((err: Error) => void) | null = null
  let deathPromise: Promise<never> | null = null

  function armDeathPromise(): void {
    deathPromise = new Promise<never>((_, reject) => {
      deathReject = reject
    })
    deathPromise.catch(() => {
      /* observed — the race in initialize() is the consumer */
    })
  }

  function signalDeath(message: string): void {
    const tail = stderrTail.length > 0 ? ` — server said: ${stderrTail.join(' | ')}` : ''
    deathReject?.(new Error(`${message}${tail}`))
    deathReject = null
  }
  // The DURABLE handler registries (release-hardening audit rank 19): every
  // handler ever registered on this client, replayed onto each new
  // MessageConnection inside start(). They were one-shot queues drained and
  // cleared by the first start, so a crash respawn or an idle stop + lazy
  // restart built a fresh connection with no handlers at all — push
  // diagnostics went quiet for the rest of the session and
  // workspace/configuration was never answered again, with no surface
  // saying so. A handler registered while connected is applied at once AND
  // remembered for the next generation.
  const notificationHandlers: QueuedNotification[] = []
  const requestHandlers: QueuedRequest[] = []
  // Process listeners kept so stop() can remove exactly them.
  let processErrorListener: ((err: Error) => void) | null = null
  let processExitListener: ((code: number | null, signal: NodeJS.Signals | null) => void) | null = null
  let stdinErrorListener: ((err: Error) => void) | null = null
  let stderrDataListener: ((chunk: Buffer) => void) | null = null

  function notifyCrash(error: Error): void {
    // Latched once per generation; suppressed entirely during an intentional
    // stop. A dying server usually trips both close and exit, and without
    // the latch the owner would charge one death twice.
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
      // 1. Clear latched error state from any previous generation FIRST.
      startFailed = false
      startError = undefined
      crashNotified = false
      stderrTail.length = 0
      armDeathPromise()

      // 2. Spawn. On win32 an npm-installed server is a .cmd shim — the
      // runtime refuses batch files shell-less (EINVAL on the resolved
      // path, ENOENT on the bare name), and the strict adapter schema
      // offers no shell escape hatch, so `npm i -g pyright` (the remedy
      // Mercury itself prints) produced a server that could never start
      // (FC-051). The shell ride is keyed to the batch-shim SHAPE, never
      // blanket: a real .exe keeps the direct spawn.
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

      // 3. Await a successful spawn before touching the streams: the failure
      // event fires asynchronously.
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

      // 4. stderr line drain.
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
          // The readline interface owns the drain; this listener exists so
          // stop() has a handle to remove.
        }
        proc.stderr.on('data', stderrDataListener)
      }

      // 5. Post-spawn process error handler.
      processErrorListener = (err: Error) => {
        if (stopping) return
        startFailed = true
        startError = err
        logForDebugging(`LSP server ${serverName} process error: ${err.message}`, { level: 'error' })
      }
      proc.on('error', processErrorListener)

      // 6. Process exit: ANY unexpected exit counts as a crash — including
      // status 0, which many servers use the moment stdin closes.
      processExitListener = (code, signal) => {
        if (stopping) return
        initialized = false
        startFailed = false
        startError = undefined
        const message =
          code !== null && code !== 0
            ? `LSP server ${serverName} crashed with exit code ${code}`
            : `LSP server ${serverName} exited unexpectedly (code ${String(code)}, signal ${signal ?? 'none'})`
        // A pending initialize fails NOW with the child's own last words,
        // never by burning the whole startup timeout.
        signalDeath(message)
        notifyCrash(new Error(message))
      }
      proc.on('exit', processExitListener)

      // 7. stdin error handler: log only; the connection reports.
      stdinErrorListener = (err: Error) => {
        if (!stopping) logForDebugging(`LSP server ${serverName} stdin error: ${err.message}`)
      }
      proc.stdin.on('error', stdinErrorListener)

      // 8. The message connection.
      const conn = createMessageConnection(
        new StreamMessageReader(proc.stdout),
        new StreamMessageWriter(proc.stdin),
      )
      connection = conn

      // 9. Error/close handlers BEFORE listening.
      conn.onError(([err]: [Error]) => {
        if (stopping) return
        logForDebugging(`LSP server ${serverName} connection error: ${err.message}`, { level: 'error' })
        // Latch only before the handshake completed, so the handshake's
        // failure check sees it; a post-init latch would leave a healthy-
        // looking client whose every request rejects on a stale error.
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

      // 10. Listen.
      conn.listen()

      // 11. Verbose tracing; the enable sends a notification that can fail
      // if the process already exited.
      conn
        .trace(Trace.Verbose, {
          log: (message: string, data?: string) => {
            logForDebugging(`[lsp-trace:${serverName}] ${message}${data ? ` ${data}` : ''}`)
          },
        })
        .catch((err: unknown) => {
          logForDebugging(`LSP server ${serverName} trace enable failed: ${String(err)}`)
        })

      // 12. Replay EVERY registered handler onto this generation's
      // connection — the registries are durable, never drained, so a
      // restart keeps its diagnostics and its configuration answers.
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
      // Race the handshake against the child's death: a shim that prints an
      // error and exits fails HERE in milliseconds, carrying its stderr.
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
    // Only the forwarded send's own failure is swallowed — notifications are
    // fire-and-forget; the two pre-checks above still reject.
    try {
      await connection.sendNotification(method, params)
    } catch (err) {
      logForDebugging(`LSP server ${serverName} notification ${method} failed: ${String(err)}`, { level: 'error' })
      logForDebugging(`LSP server ${serverName}: continuing after failed notification ${method}`)
    }
  }

  function onNotification(method: string, handler: (params: unknown) => void): void {
    // Remembered for every later generation, applied now when connected.
    notificationHandlers.push({ method, handler })
    if (connection === null) {
      logForDebugging(`LSP server ${serverName}: queued notification handler ${method} (no connection yet)`)
      return
    }
    checkStartFailure()
    connection.onNotification(method, handler)
  }

  function onRequest<P, R>(method: string, handler: (params: P) => R | Promise<R>): void {
    // Remembered for every later generation, applied now when connected.
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
    // Quiet the error handlers during teardown.
    stopping = true
    let gracefulFailed: unknown = null
    if (connection !== null) {
      const conn = connection
      let deadline: NodeJS.Timeout | null = null
      try {
        // shutdown (request) bounded by the budget, then exit (notification).
        // A server that never answers must not take the process down.
        const shutdown = conn.sendRequest('shutdown', null)
        shutdown.catch(() => {
          // The abandoned promise's eventual rejection is swallowed.
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
    // Cleanup runs regardless of the handshake outcome.
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
      // The TREE, not the leader: a .cmd shim rides shell:true, so the direct
      // child is cmd.exe and a bare kill() left the real server resident with
      // its workspace index — every idle-stop/lazy-restart cycle stacked
      // another copy that outlived Mercury (FN-015 rank 20). The one
      // tree-kill owner (bounded reap, never rejects), then a by-pid second
      // strike for anything the first pass reported alive.
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
      // Re-latch for diagnostics; stop() itself resolves by contract.
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
