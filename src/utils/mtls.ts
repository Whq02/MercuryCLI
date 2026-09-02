import { readFileSync } from 'node:fs'
import { Agent as HttpsAgent } from 'node:https'
import type * as tls from 'node:tls'

import { memoize } from 'lodash-es'
import { Agent, type Dispatcher } from 'undici'

import { getCACertificates } from './caCerts.js'
import { logForDebugging } from './debug.js'


export type MTLSConfig = { cert?: string; key?: string; passphrase?: string }
export type TLSConfig = MTLSConfig & { ca?: string[] }

function readMaterial(variable: string): string | undefined {
  const path = process.env[variable]
  if (!path) return undefined
  try {
    const content = readFileSync(path, 'utf8')
    logForDebugging(`mtls: loaded ${variable}`)
    return content
  } catch (err) {
    logForDebugging(`mtls: failed to read ${variable}: ${String(err)}`)
    return undefined
  }
}

export const getMTLSConfig = memoize((): MTLSConfig | undefined => {
  const cert = readMaterial('MERCURY_CLIENT_CERT')
  const key = readMaterial('MERCURY_CLIENT_KEY')
  const passphrase = process.env.MERCURY_CLIENT_KEY_PASSPHRASE || undefined
  if (cert === undefined && key === undefined && passphrase === undefined) return undefined
  const config: MTLSConfig = {}
  if (cert !== undefined) config.cert = cert
  if (key !== undefined) config.key = key
  if (passphrase !== undefined) config.passphrase = passphrase
  return config
})

export const getMTLSAgent = memoize((): HttpsAgent | undefined => {
  const config = getMTLSConfig()
  const ca = getCACertificates()
  if (!config && !ca) return undefined
  return new HttpsAgent({ ...config, ...(ca ? { ca } : {}), keepAlive: true })
})

export function getWebSocketTLSOptions(): tls.ConnectionOptions | undefined {
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
  })
  return { dispatcher }
}

export function clearMTLSCache(): void {
  getMTLSConfig.cache.clear?.()
  getMTLSAgent.cache.clear?.()
  logForDebugging('mtls: caches cleared')
}

export function configureGlobalMTLS(): void {
  if (!getMTLSConfig()) return
  logForDebugging('mtls: client certificate configured; NODE_EXTRA_CA_CERTS (if set) is appended to the trust store by the runtime')
}
