import { APIError } from '@anthropic-ai/sdk'

import {
  applyMockHeaders,
  getMockHeaderless429Message,
  getMockHeaders,
  shouldProcessMockLimits,
} from './mockRateLimits.js'

/**
 * The thin facade isolating mock-limit logic from the production quota
 * path, including synthesised 429s. This file is one of the three
 * fence-listed provider-SDK importers of the slice.
 */

export { shouldProcessMockLimits }

/** Apply the mock overlay when active, else pass through. */
export function processRateLimitHeaders(headers: Headers): Headers {
  if (!shouldProcessMockLimits()) return headers
  return applyMockHeaders(headers)
}

/** Header processing is gated on subscriber-or-mocks. */
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

/**
 * Decide whether a request should fail with a fabricated rate-limit error.
 * Model scoping reproduces the real API: an Opus-window mock lets a
 * non-Opus model through (fallback succeeds), and likewise for Fable —
 * substring matching covers aliases and dated variants.
 */
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

/** True for a fabricated 429, so the retry layer never retries it. */
export function isMockRateLimitError(error: unknown): boolean {
  if (!shouldProcessMockLimits()) return false
  return error instanceof APIError && error.status === 429
}
