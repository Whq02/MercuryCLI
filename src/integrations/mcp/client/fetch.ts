import { getClaudeAIOAuthTokens } from '../../../models/sign-in/credentials/auth.js'
import { checkAndRefreshOAuthTokenIfNeeded, handleOAuth401Error } from '../../../models/sign-in/lifecycle/oauthLifecycle.js'
import { getMCPUserAgent } from '../../../models/roads/requestHeaders.js'
import { toolTimeoutMs } from './limits.js'
import { passedOver } from '../../../platform/errors/passedOver.js'
import { startTimeout, stopTimeout } from '../../../platform/async/timers.js'

const REQUEST_TIMEOUT_MS = 60_000
const MAX_TIMER_MS = 2_147_483_647

export type FetchLike = (input: string | URL, init?: RequestInit) => Promise<Response>


function jsonRpcMethodOf(body: unknown): string | null {
  if (typeof body !== 'string') return null
  const head = body.slice(0, 2048)
  const match = /"method"\s*:\s*"([^"\\]+)"/.exec(head)
  if (match) return match[1]!
  try {
    const parsed = JSON.parse(body) as { method?: unknown } | Array<{ method?: unknown }>
    const first = Array.isArray(parsed) ? parsed[0] : parsed
    return typeof first?.method === 'string' ? first.method : null
  } catch (error) {
    passedOver(error)
    return null
  }
}

function mcpRequestBudgetMs(body: unknown): number {
  return jsonRpcMethodOf(body) === 'tools/call' ? toolTimeoutMs() : REQUEST_TIMEOUT_MS
}

export function wrapFetchWithTimeout(baseFetch: FetchLike): FetchLike {
  return async (input, init) => {
    const method = (init?.method ?? 'GET').toUpperCase()
    if (method === 'GET') return baseFetch(input, init)
    const budgetMs = mcpRequestBudgetMs(init?.body)
    const controller = new AbortController()
    const callerSignal = init?.signal
    const onCallerAbort = (): void => {
      controller.abort(callerSignal?.reason)
    }
    if (callerSignal) {
      if (callerSignal.aborted) {
        controller.abort(callerSignal.reason)
      } else {
        callerSignal.addEventListener('abort', onCallerAbort, { once: true })
      }
    }
    const headers = new Headers(init?.headers)
    if (!headers.has('Accept')) headers.set('Accept', 'application/json, text/event-stream')
    const timer = startTimeout(() => {
      controller.abort(new DOMException('MCP request timed out', 'TimeoutError'))
    }, Math.min(budgetMs, MAX_TIMER_MS))
    timer.unref?.()
    try {
      return await baseFetch(input, { ...init, headers, signal: controller.signal })
    } finally {
      stopTimeout(timer)
      callerSignal?.removeEventListener('abort', onCallerAbort)
    }
  }
}

export function loggedHeadersOf(headers: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(headers).map(([key, value]) => [key, key.toLowerCase() === 'user-agent' && value === getMCPUserAgent() ? value : '[REDACTED]']))
}


export function createAnthropicProxyFetch(innerFetch: FetchLike): FetchLike {
  const withAuth = (initHeaders: RequestInit['headers'], accessToken: string): Headers => {
    const headers = new Headers(initHeaders)
    headers.set('Authorization', `Bearer ${accessToken}`)
    return headers
  }

  return async (input, init) => {
    await checkAndRefreshOAuthTokenIfNeeded()
    const sentToken = getClaudeAIOAuthTokens()?.accessToken
    if (!sentToken) {
      throw new Error('No claude.ai OAuth token available for the MCP proxy')
    }
    const response = await innerFetch(input, {
      ...init,
      headers: withAuth(init?.headers, sentToken),
    })
    if (response.status !== 401) return response
    const refreshed = await handleOAuth401Error(sentToken)
    const nextToken = getClaudeAIOAuthTokens()?.accessToken
    if (!nextToken || (!refreshed && nextToken === sentToken)) return response
    try {
      return await innerFetch(input, {
        ...init,
        headers: withAuth(init?.headers, nextToken),
      })
    } catch (error) {
      passedOver(error)
      return response
    }
  }
}
