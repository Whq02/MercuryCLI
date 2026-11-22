import { notBuilt, type Unbuilt } from '../pi/holes.js'

export function getProductUserAgent(): string {
  return notBuilt('src/utils/http.ts:18')
}

export function getUserAgent(): string {
  return notBuilt('src/utils/http.ts:23')
}

export function getMCPUserAgent(): string {
  return notBuilt('src/utils/http.ts:27')
}

export { webUserAgent as getWebFetchUserAgent } from './webUserAgent.js'

type AuthHeaders = Unbuilt

export function getAuthHeaders(): AuthHeaders {
  return notBuilt('src/utils/http.ts:40')
}
