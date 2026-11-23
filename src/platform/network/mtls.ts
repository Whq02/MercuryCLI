import { readFileSync } from 'node:fs'
import { Agent as HttpsAgent } from 'node:https'
import type * as tls from 'node:tls'

import { memoize } from 'lodash-es'
import { Agent, type Dispatcher } from 'undici'

import { flagEnv } from '../substrate/flagRegistry.js'
import { getCACertificates } from './caCerts.js'
import { logForDebugging } from '../logs/debugLog.js'

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

export const getMTLSConfig = memoize((): MTLSConfig | undefined => {
  const cert = readMaterial('MERCURY_CLIENT_CERT')
  const key = readMaterial('MERCURY_CLIENT_KEY')
  const passphrase = flagEnv('MERCURY_CLIENT_KEY_PASSPHRASE') || undefined
  if (cert === undefined && key === undefined && passphrase === undefined) return undefined
  const config: MTLSConfig = {}
  if (cert !== undefined) config.cert = cert
  if (key !== undefined) config.key = key
  if (passphrase !== undefined) config.passphrase = passphrase
  return config
})

export function getMTLSReadErrors(): MTLSReadError[] {
  getMTLSConfig()
  return [...mtlsReadErrors.values()]
}

function tlsOptions(): TLSConfig | undefined {
  const config = getMTLSConfig()
  const ca = getCACertificates()
  if (!config && !ca?.length) return undefined
  return ca?.length ? { ...config, ca } : { ...config }
}

export const getMTLSAgent = memoize((): HttpsAgent | undefined => {
  const options = tlsOptions()
  return options && new HttpsAgent({ ...options, keepAlive: true })
})

export function getWebSocketTLSOptions(): tls.SecureContextOptions | undefined {
  return tlsOptions()
}

export function getTLSFetchOptions(): { tls?: TLSConfig; dispatcher?: Dispatcher } {
  const options = tlsOptions()
  if (!options) return {}
  if (typeof Bun !== 'undefined') return { tls: options }
  return { dispatcher: new Agent({ connect: options, pipelining: 1, allowH2: false }) }
}

export function clearMTLSCache(): void {
  getMTLSConfig.cache.clear?.()
  getMTLSAgent.cache.clear?.()
  mtlsReadErrors.clear()
  mtlsReportedStartup.clear()
  logForDebugging('mtls: caches cleared')
}

export function configureGlobalMTLS(): void {
  const config = getMTLSConfig()
  for (const failure of mtlsReadErrors.values()) {
    const mark = `${failure.variable}:${failure.path}:${failure.error}`
    if (mtlsReportedStartup.has(mark)) continue
    mtlsReportedStartup.add(mark)
    process.stderr.write(`${mtlsReadFailureSentence(failure)}\n`)
  }
  if (config) logForDebugging('mtls: client certificate configured; NODE_EXTRA_CA_CERTS (if set) is appended to the trust store by the runtime')
}
