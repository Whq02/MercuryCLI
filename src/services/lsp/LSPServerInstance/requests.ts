import { CancellationTokenSource } from 'vscode-jsonrpc'

import { sleep } from '../../../utils/sleep.js'
import { currentLspAbortSignal, noteLspRequestFault } from '../lspAbort.js'
import type { ScopedLspServerConfig } from '../types.js'
import type { LspServerRecord } from './record.js'
import { startTimeout, stopTimeout } from '../../../utils/timers.js'
import { notBuilt, type Unbuilt } from '../../../pi/holes.js'

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

export function sendRequestOf(server: LspServerRecord, arg1: RequestNeeds): Unbuilt {
  return notBuilt('src/services/lsp/LSPServerInstance/requests.ts:43')
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
