import { checkAndRefreshOAuthTokenIfNeeded, getClaudeAIOAuthTokens, handleOAuth401Error } from '../../../utils/auth.js'
import { getMCPUserAgent } from '../../../utils/http.js'
import { toolTimeoutMs } from './limits.js'

const REQUEST_TIMEOUT_MS = 60_000

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
  } catch {
    return null
  }
}

export function mcpRequestBudgetMs(body: unknown): number {
  return jsonRpcMethodOf(body) === 'tools/call' ? toolTimeoutMs() : REQUEST_TIMEOUT_MS
}

export function wrapFetchWithTimeout(baseFetch: FetchLike): FetchLike {
  return async (input, init) => {
    const method = (init?.method ?? 'GET').toUpperCase()
    if (method === 'GET') return baseFetch(input, init)
    const controller = new AbortController()
    const timer = setTimeout(
      () => controller.abort(new DOMException('MCP request timed out', 'TimeoutError')),
      mcpRequestBudgetMs(init?.body),
    )
    timer.unref?.()
    const callerSignal = init?.signal ?? undefined
    const onCallerAbort = (): void => controller.abort(callerSignal?.reason)
    if (callerSignal) {
      if (callerSignal.aborted) controller.abort(callerSignal.reason)
      else callerSignal.addEventListener('abort', onCallerAbort, { once: true })
    }
    const headers = new Headers(init?.headers)
    if (!headers.has('accept')) headers.set('Accept', 'application/json, text/event-stream')
    try {
      return await baseFetch(input, { ...init, headers, signal: controller.signal })
    } finally {
      clearTimeout(timer)
      callerSignal?.removeEventListener('abort', onCallerAbort)
    }
  }
}

export function loggedHeadersOf(headers: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(headers).map(([key, value]) => [key, key.toLowerCase() === 'user-agent' && value === getMCPUserAgent() ? value : '[REDACTED]']))
}


export function createAnthropicProxyFetch(innerFetch: FetchLike): FetchLike {
  return async (input, init) => {
    const send = async (): Promise<{ response: Response; sentToken: string }> => {
      await checkAndRefreshOAuthTokenIfNeeded()
      const token = getClaudeAIOAuthTokens()?.accessToken
      if (!token) throw new Error('No claude.ai OAuth token available for the MCP proxy')
      const headers = new Headers(init?.headers)
      headers.set('Authorization', `Bearer ${token}`)
      return { response: await innerFetch(input, { ...init, headers }), sentToken: token }
    }
    const first = await send()
    if (first.response.status !== 401) return first.response
    const changed = await handleOAuth401Error(first.sentToken)
    if (!changed) {
      const current = getClaudeAIOAuthTokens()?.accessToken
      if (!current || current === first.sentToken) return first.response
    }
    try {
      return (await send()).response
    } catch {
      return first.response
    }
  }
}
