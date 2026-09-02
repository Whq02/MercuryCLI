import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'

import { logForDebugging } from './debug.js'
import { hasNodeOption } from './envUtils.js'
import { logError } from './log.js'

/**
 * Resolve the CA certificate list for TLS from runtime flags and the
 * extra-certs env var.
 *
 * This module reads ONLY `NODE_EXTRA_CA_CERTS` and the runtime flags
 * `--use-system-ca` / `--use-openssl-ca`. It must not import config or
 * settings: the config module transitively pulls in the whole REPL and
 * command graph, and the proxy/mTLS modules that depend on this resolver
 * must stay outside that graph or the SDK bundle balloons by an order of
 * magnitude. (The one sanctioned config bridge lives in caCertsConfig.ts.)
 *
 * The TLS module load is deferred until after the early return, and is
 * synchronous (this resolver is synchronous): Bun eagerly materialises
 * roughly 150 Mozilla root certificates (~750 KB heap) on import even when
 * the root list is never accessed, and most users take the early return.
 */

type TlsModule = {
  rootCertificates: readonly string[]
  getCACertificates?: (type: string) => string[]
}

const requireModule = createRequire(import.meta.url)

function loadTlsSync(): TlsModule {
  return requireModule('node:tls') as TlsModule
}

function resolveCACertificates(): string[] | undefined {
  const useSystemCa = hasNodeOption('--use-system-ca') || hasNodeOption('--use-openssl-ca')
  const extraCertsPath = process.env.NODE_EXTRA_CA_CERTS

  if (!useSystemCa && !extraCertsPath) {
    logForDebugging('caCerts: no system-CA flag and no NODE_EXTRA_CA_CERTS; using runtime defaults')
    return undefined
  }

  const tls = loadTlsSync()
  const certificates: string[] = []

  if (useSystemCa) {
    if (typeof tls.getCACertificates === 'function') {
      const systemCerts = tls.getCACertificates('system')
      if (systemCerts.length > 0) {
        logForDebugging(`caCerts: using ${systemCerts.length} system CA certificates`)
        certificates.push(...systemCerts)
      } else {
        // Accessor present but empty: fall back to the bundled roots as the
        // base — an explicit certificate list is the WHOLE trust store for
        // an HTTPS agent, not an addition to the built-in one.
        logForDebugging('caCerts: system CA accessor returned nothing; falling back to bundled roots')
        certificates.push(...tls.rootCertificates)
      }
    } else if (!extraCertsPath) {
      // Plain Node.js honours the system-CA flag on its own; with no extra
      // certs to merge there is nothing for us to override.
      logForDebugging('caCerts: no system CA accessor and no extra certs; deferring to the runtime')
      return undefined
    } else {
      logForDebugging('caCerts: no system CA accessor; using bundled roots as the base')
      certificates.push(...tls.rootCertificates)
    }
  } else {
    // Extra certs only: the bundled Mozilla roots plus the file contents.
    logForDebugging('caCerts: extra certs only; using bundled roots as the base')
    certificates.push(...tls.rootCertificates)
  }

  if (extraCertsPath) {
    try {
      // The whole file text as a single entry — deliberately not split into
      // individual certificates.
      certificates.push(readFileSync(extraCertsPath, 'utf8'))
      logForDebugging(`caCerts: appended extra certificates from ${extraCertsPath}`)
      extraCertsOutcome = { path: extraCertsPath, loaded: true }
    } catch (err) {
      logError(err)
      // Recorded beside the memoised list (FN-015 rank 73): the bundle was
      // dropped silently while /status and the TLS advice kept reporting the
      // variable as configured — the operator was pointed at the one setting
      // that was already right.
      extraCertsOutcome = { path: extraCertsPath, loaded: false, error: err instanceof Error ? err.message : String(err) }
    }
  }

  if (certificates.length === 0) {
    // Never install an empty list on an HTTPS agent — it would reject every
    // certificate. Undefined lets the caller fall back to the runtime store.
    logForDebugging('caCerts: every source failed or returned nothing; using runtime defaults')
    return undefined
  }
  return certificates
}

let cachedResult: { value: string[] | undefined } | null = null

/** What became of NODE_EXTRA_CA_CERTS at the last resolution: the path and
 *  whether its bytes were read (the error when not). Null when the variable
 *  is unset or nothing resolved yet. */
export type ExtraCaCertsOutcome = { path: string; loaded: boolean; error?: string }
let extraCertsOutcome: ExtraCaCertsOutcome | null = null

/** Memoised on the single no-argument call. */
export function getCACertificates(): string[] | undefined {
  if (cachedResult) return cachedResult.value
  extraCertsOutcome = null
  const value = resolveCACertificates()
  cachedResult = { value }
  return value
}

/** The extra-CA outcome for the surfaces that report the variable: resolves
 *  first so the answer reflects the live environment (FN-015 rank 73). */
export function getExtraCaCertsOutcome(): ExtraCaCertsOutcome | null {
  getCACertificates()
  if (extraCertsOutcome === null && process.env.NODE_EXTRA_CA_CERTS) {
    // The variable is set but the resolver never reached it (no runtime path
    // needs it): report it as configured, unread by this process.
    return { path: process.env.NODE_EXTRA_CA_CERTS, loaded: true }
  }
  return extraCertsOutcome
}

/** One sentence for /status and the doctor: the path, and NOT READ with the
 *  error when the bundle could not be read (then the bundled roots alone
 *  are in use, and a TLS failure behind interception is this, not a
 *  missing variable). */
export function extraCaCertsStatusLine(): string | null {
  const outcome = getExtraCaCertsOutcome()
  if (outcome === null) return null
  return outcome.loaded
    ? outcome.path
    : `${outcome.path} — NOT READ (${outcome.error ?? 'unreadable'}); the bundled roots alone are in use`
}

/**
 * Clear the memoised result — used after the trust dialog applies settings
 * that change the environment.
 */
export function clearCACertsCache(): void {
  cachedResult = null
  extraCertsOutcome = null
}
