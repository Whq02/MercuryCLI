import { readFileSync } from 'node:fs'
import { Agent as HttpsAgent } from 'node:https'
import type * as tls from 'node:tls'

import { memoize } from 'lodash-es'
import { Agent, type Dispatcher } from 'undici'

import { flagEnv } from '../substrate/flagRegistry.js'
import { getCACertificates } from './caCerts.js'
import { logForDebugging } from './debug.js'


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

export const getMTLSAgent = memoize((): HttpsAgent | undefined => {
  const config = getMTLSConfig()
  const ca = getCACertificates()
  if (!config && !ca) return undefined
  return new HttpsAgent({ ...config, ...(ca ? { ca } : {}), keepAlive: true })
})

export function getWebSocketTLSOptions(): tls.SecureContextOptions | undefined {
  const config = getMTLSConfig()
  const ca = getCACertificates()
  if (!config && !ca) return undefined
  return { ...config, ...(ca ? { ca } : {}) }
}

export function getTLSFetchOptions(): { tls?: TLSConfig; dispatcher?: Dispatcher } {
  const config = getMTLSConfig()
  const ca = getCACertificates()
  if (!config && !ca) return {}
  const tlsConfig: TLSConfig = { ...config, ...(ca ? { ca } : {}) }
  if (typeof (globalThis as { Bun?: unknown }).Bun !== 'undefined') return { tls: tlsConfig }
  const dispatcher = new Agent({
    connect: {
      cert: tlsConfig.cert,
      key: tlsConfig.key,
      passphrase: tlsConfig.passphrase,
      ...(tlsConfig.ca ? { ca: tlsConfig.ca } : {}),
    },
    pipelining: 1,
    allowH2: false,
  })
  return { dispatcher }
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
    const key = `${failure.variable}:${failure.path}:${failure.error}`
    if (mtlsReportedStartup.has(key)) continue
    mtlsReportedStartup.add(key)
    process.stderr.write(`${mtlsReadFailureSentence(failure)}\n`)
  }
  if (!config) return
  logForDebugging('mtls: client certificate configured; NODE_EXTRA_CA_CERTS (if set) is appended to the trust store by the runtime')
}
