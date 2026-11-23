import { flagEnv } from '../substrate/flagRegistry.js'
import { getWorkload } from './workloadContext.js'
import { notBuilt } from '../pi/holes.js'

function hostHints(): string[] {
  const hints: string[] = []
  const entrypoint = flagEnv('MERCURY_ENTRYPOINT')
  const version = flagEnv('MERCURY_HOST_VERSION')
  const app = flagEnv('MERCURY_HOST_CLIENT_APP')
  if (entrypoint) hints.push(entrypoint)
  if (version) hints.push(`host/${version}`)
  if (app) hints.push(`host-app/${app}`)
  return hints
}

function identity(hints: string[]): string {
  return `mercury/${MACRO.VERSION}${hints.length ? ` (${hints.join(', ')})` : ''}`
}

export function getProductUserAgent(): string {
  const hints = hostHints()
  const workload = getWorkload()
  if (workload) hints.push(`workload/${workload}`)
  return identity(hints)
}

export function getUserAgent(): string {
  return getProductUserAgent()
}

export function getMCPUserAgent(): string {
  return identity(hostHints())
}

export { webUserAgent as getWebFetchUserAgent } from './webUserAgent.js'

type AuthHeaders = { headers: Record<string, string>; error?: string }

export function getAuthHeaders(): AuthHeaders {
  return notBuilt('src/utils/http.ts:40')
}
