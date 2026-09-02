import { APIError } from '@anthropic-ai/sdk'

import {
  applyMockHeaders,
  getMockHeaderless429Message,
  getMockHeaders,
  shouldProcessMockLimits,
} from './mockRateLimits.js'


export { shouldProcessMockLimits }

export function processRateLimitHeaders(headers: Headers): Headers {
  if (!shouldProcessMockLimits()) return headers
  return applyMockHeaders(headers)
}

export function shouldProcessRateLimits(isSubscriber: boolean): boolean {
  return isSubscriber || shouldProcessMockLimits()
}

const RATE_LIMIT_BODY = (message: string): object => ({
  type: 'error',
  error: { type: 'rate_limit_error', message },
})

function headersFromMockMap(map: Record<string, string | undefined>): Headers {
  const headers = new Headers()
  for (const [key, value] of Object.entries(map)) {
    if (value !== undefined) headers.set(key, value)
  }
  return headers
}

export function checkMockRateLimitError(currentModel: string): APIError | null {
  if (!shouldProcessMockLimits()) return null
  const headerlessMessage = getMockHeaderless429Message()
  if (headerlessMessage !== null) {
    return new APIError(429, RATE_LIMIT_BODY(headerlessMessage), headerlessMessage, new Headers())
  }
  const mockMap = getMockHeaders()
  if (mockMap === null) return null
  const claim = mockMap['anthropic-ratelimit-unified-representative-claim']
  if (claim === 'seven_day_opus' && !currentModel.includes('opus')) return null
  if (claim === 'seven_day_fable' && !currentModel.includes('fable')) return null
  const status = mockMap['anthropic-ratelimit-unified-status']
  const overage = mockMap['anthropic-ratelimit-unified-overage-status']
  if (status === 'rejected' && (overage === undefined || overage === 'rejected')) {
    const message = 'Rate limit exceeded'
    return new APIError(429, RATE_LIMIT_BODY(message), message, headersFromMockMap(mockMap))
  }
  return null
}

export function isMockRateLimitError(error: unknown): boolean {
  if (!shouldProcessMockLimits()) return false
  return error instanceof APIError && error.status === 429
}
