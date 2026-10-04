import { APIError } from '@anthropic-ai/sdk'

import {
  applyMockHeaders,
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

export function isMockRateLimitError(error: unknown): boolean {
  if (!shouldProcessMockLimits()) return false
  return error instanceof APIError && error.status === 429
}
