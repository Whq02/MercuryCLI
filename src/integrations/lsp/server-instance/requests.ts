import { CancellationTokenSource } from 'vscode-jsonrpc'

import { sleep } from '../../../platform/async/sleep.js'
import { currentLspAbortSignal, noteLspRequestFault } from '../lspAbort.js'
import type { ScopedLspServerConfig } from '../types.js'
import type { LspServerRecord } from './record.js'
import { startTimeout, stopTimeout } from '../../../platform/async/timers.js'

const DEFAULT_REQUEST_TIMEOUT_MS = 30_000
const CONTENT_MODIFIED_CODE = -32801
const TRANSIENT_RETRIES = 3
const TRANSIENT_BASE_DELAY_MS = 500

function timedOutRequest(method: string, server: string, budgetMs: number): Error {
  const error = new Error(
    `LSP request ${method} to server ${server} got no answer within ${(budgetMs / 1000).toFixed(1)}s — the request was cancelled; the server may be busy with a large project`,
  )
  error.name = 'LspRequestTimeout'
  return error
}

function abortedRequest(method: string, server: string): Error {
  const error = new Error(`LSP request ${method} to server ${server} was interrupted before it finished.`)
  error.name = 'AbortError'
  return error
}

function isLspRequestSettlement(err: unknown): boolean {
  return err instanceof Error && (err.name === 'LspRequestTimeout' || err.name === 'AbortError')
}

function isContentModified(err: unknown): boolean {
  return typeof (err as { code?: unknown } | null)?.code === 'number' && (err as { code: number }).code === CONTENT_MODIFIED_CODE
}

interface RequestNeeds {
  name: string
  config: ScopedLspServerConfig
  isHealthy: () => boolean
  touchActivity: () => void
}

export function sendRequestOf(server: LspServerRecord, { name, config, isHealthy, touchActivity }: RequestNeeds) {
  async function sendRequest<T>(method: string, params: unknown): Promise<T> {
    if (!isHealthy() || server.client === null) {
      noteLspRequestFault()
      throw new Error(
        `LSP server ${name} is not healthy (state: ${server.state}${server.lastError ? `, last error: ${server.lastError.message}` : ''})`,
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
      if (remaining <= 0) {
        noteLspRequestFault()
        throw timedOutRequest(method, name, budgetMs)
      }
      const source = new CancellationTokenSource()
      let timer: ReturnType<typeof setTimeout> | undefined
      let onAbort: (() => void) | undefined
      try {
        return await new Promise<T>((resolve, reject) => {
          timer = startTimeout(() => {
            source.cancel()
            reject(timedOutRequest(method, name, budgetMs))
          }, remaining)
          if (signal !== undefined) {
            onAbort = () => { source.cancel(); reject(abortedRequest(method, name)) }
            signal.addEventListener('abort', onAbort, { once: true })
          }
          server.client!.sendRequest<T>(method, params, source.token).then(resolve, reject)
        })
      } catch (err) {
        lastFailure = err
        if (isLspRequestSettlement(err)) {
          if (err instanceof Error && err.name !== 'AbortError') noteLspRequestFault()
          throw err
        }
        if (isContentModified(err) && attempt < TRANSIENT_RETRIES) {
          const backoff = Math.min(TRANSIENT_BASE_DELAY_MS * 2 ** attempt, Math.max(0, deadlineAt - Date.now()))
          await sleep(backoff)
          continue
        }
        break
      } finally {
        if (timer !== undefined) stopTimeout(timer)
        if (onAbort) signal?.removeEventListener('abort', onAbort)
        source.dispose()
      }
    }
    noteLspRequestFault()
    throw new Error(
      `LSP request ${method} to server ${name} failed: ${lastFailure instanceof Error ? lastFailure.message : String(lastFailure)}`,
    )
  }
  return sendRequest
}

export function sendNotificationOf(server: LspServerRecord, { name, isHealthy, touchActivity }: Omit<RequestNeeds, 'config'>) {
  async function sendNotification(method: string, params: unknown): Promise<void> {
    if (!isHealthy() || server.client === null) {
      throw new Error(`Cannot send notification ${method}: LSP server ${name} is not healthy`)
    }
    touchActivity()
    try {
      await server.client.sendNotification(method, params)
    } catch (err) {
      throw new Error(
        `LSP notification ${method} to server ${name} failed: ${err instanceof Error ? err.message : String(err)}`,
      )
    }
  }
  return sendNotification
}
