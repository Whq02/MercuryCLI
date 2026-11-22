import { readFileSync } from 'node:fs'
import { Agent as HttpsAgent } from 'node:https'
import type * as tls from 'node:tls'

import { memoize } from 'lodash-es'
import { Agent, type Dispatcher } from 'undici'

import { flagEnv } from '../substrate/flagRegistry.js'
import { getCACertificates } from './caCerts.js'
import { logForDebugging } from './debug.js'
import { notBuilt, unbuilt, type Unbuilt } from '../pi/holes.js'


type MTLSConfig = { cert?: string; key?: string; passphrase?: string }
type TLSConfig = MTLSConfig & { ca?: string[] }
type MTLSVariable = 'MERCURY_CLIENT_CERT' | 'MERCURY_CLIENT_KEY'
type MTLSReadError = { variable: MTLSVariable; path: string; error: string }

const mtlsReadErrors = new Map<MTLSVariable, MTLSReadError>()
const mtlsReportedStartup = new Set<string>()

export function mtlsReadFailureSentence(failure: MTLSReadError): string {
  return `${failure.variable} is set to ${failure.path}, which could not be read (${failure.error}), so requests go out without the client certificate — fix the path or unset it.`
}

function readMaterial(variable: MTLSVariable): string | undefined {
  const path = flagEnv(variable)
  if (!path) {
    mtlsReadErrors.delete(variable)
    return undefined
  }
  try {
    const content = readFileSync(path, 'utf8')
    mtlsReadErrors.delete(variable)
    logForDebugging(`mtls: loaded ${variable}`)
    return content
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err)
    mtlsReadErrors.set(variable, { variable, path, error })
    logForDebugging(`mtls: failed to read ${variable}: ${String(err)}`)
    return undefined
  }
}

export const getMTLSConfig: Unbuilt = unbuilt('src/utils/mtls.ts:44')

export function getMTLSReadErrors(): MTLSReadError[] {
  getMTLSConfig()
  return [...mtlsReadErrors.values()]
}

export const getMTLSAgent: Unbuilt = unbuilt('src/utils/mtls.ts:61')

export function getWebSocketTLSOptions(): tls.SecureContextOptions | undefined {
  return notBuilt('src/utils/mtls.ts:68')
}

export function getTLSFetchOptions(): { tls?: TLSConfig; dispatcher?: Dispatcher } {
  return notBuilt('src/utils/mtls.ts:75')
}

export function clearMTLSCache(): void {
  return notBuilt('src/utils/mtls.ts:94')
}

export function configureGlobalMTLS(): void {
  return notBuilt('src/utils/mtls.ts:102')
}
