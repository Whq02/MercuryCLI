import { APIError } from '../utils/api/sdkErrors.js'

import {
  applyMockHeaders,
  shouldProcessMockLimits,
} from './mockRateLimits.js'
import { notBuilt } from '../pi/holes.js'


export { shouldProcessMockLimits }

export function processRateLimitHeaders(headers: Headers): Headers {
  return notBuilt('src/services/rateLimitMocking.ts:11')
}

export function shouldProcessRateLimits(isSubscriber: boolean): boolean {
  return notBuilt('src/services/rateLimitMocking.ts:16')
}

export function isMockRateLimitError(error: unknown): boolean {
  return notBuilt('src/services/rateLimitMocking.ts:20')
}
