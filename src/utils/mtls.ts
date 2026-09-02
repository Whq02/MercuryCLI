import { readFileSync } from 'node:fs'
import { Agent as HttpsAgent } from 'node:https'
import type * as tls from 'node:tls'

import { memoize } from 'lodash-es'
import { Agent, type Dispatcher } from 'undici'

import { getCACertificates } from './caCerts.js'
import { logForDebugging } from './debug.js'

/**
 * Client-certificate material from the environment and the agents/fetch
 * options that carry it. The additional-CA variable (`NODE_EXTRA_CA_CERTS`)
 * is deliberately NOT loaded here: the runtime appends it to the built-in
 * trust store itself.
 */

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
    // Reported, then ignored — a certificate without its key is a reachable state.
    logForDebugging(`mtls: failed to read ${variable}: ${String(err)}`)
    return undefined
  }
}

/** Absent (not an empty object) when none of the three variables produced a value; memoised. */
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

/** An HTTPS agent with keep-alive; nothing when neither client material nor a CA bundle exists. Memoised. */
export const getMTLSAgent = memoize((): HttpsAgent | undefined => {
  const config = getMTLSConfig()
  const ca = getCACertificates()
  if (!config && !ca) return undefined
  return new HttpsAgent({ ...config, ...(ca ? { ca } : {}), keepAlive: true })
})

/** TLS options for WebSocket connections, or nothing when neither exists. */
export function getWebSocketTLSOptions(): tls.ConnectionOptions | undefined {
  const config = getMTLSConfig()
  const ca = getCACertificates()
  if (!config && !ca) return undefined
  return { ...config, ...(ca ? { ca } : {}) }
}

/**
 * Fetch options: an EMPTY object when neither exists (callers spread it
 * unconditionally); under Bun the TLS configuration under `tls`; otherwise a
 * freshly built request dispatcher (the package is ~1.5 MB and loads lazily,
 * only when custom certificates are configured).
 */
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

/** Empties both memoised caches; called whenever settings-sourced environment changes. */
export function clearMTLSCache(): void {
  getMTLSConfig.cache.clear?.()
  getMTLSAgent.cache.clear?.()
  logForDebugging('mtls: caches cleared')
}

/** Only notes that the runtime appends the extra-CA file itself; nothing else. */
export function configureGlobalMTLS(): void {
  if (!getMTLSConfig()) return
  logForDebugging('mtls: client certificate configured; NODE_EXTRA_CA_CERTS (if set) is appended to the trust store by the runtime')
}
