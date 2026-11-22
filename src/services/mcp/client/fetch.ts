import { getClaudeAIOAuthTokens } from '../../../utils/auth.js'
import { checkAndRefreshOAuthTokenIfNeeded, handleOAuth401Error } from '../../auth/oauthLifecycle.js'
import { getMCPUserAgent } from '../../../utils/http.js'
import { toolTimeoutMs } from './limits.js'
import { passedOver } from '../../../utils/passedOver.js'
import { startTimeout, stopTimeout } from '../../../utils/timers.js'
import { notBuilt } from '../../../pi/holes.js'

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
  } catch (error) {
    passedOver(error)
    return null
  }
}

export function mcpRequestBudgetMs(body: unknown): number {
  return jsonRpcMethodOf(body) === 'tools/call' ? toolTimeoutMs() : REQUEST_TIMEOUT_MS
}

export function wrapFetchWithTimeout(baseFetch: FetchLike): FetchLike {
  return notBuilt('src/services/mcp/client/fetch.ts:32')
}

export function loggedHeadersOf(headers: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(headers).map(([key, value]) => [key, key.toLowerCase() === 'user-agent' && value === getMCPUserAgent() ? value : '[REDACTED]']))
}


export function createAnthropicProxyFetch(innerFetch: FetchLike): FetchLike {
  return notBuilt('src/services/mcp/client/fetch.ts:64')
}
