import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'

import { logForDebugging } from './debug.js'
import { hasNodeOption } from './envUtils.js'
import { logError } from './log.js'


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
        logForDebugging('caCerts: system CA accessor returned nothing; falling back to bundled roots')
        certificates.push(...tls.rootCertificates)
      }
    } else if (!extraCertsPath) {
      logForDebugging('caCerts: no system CA accessor and no extra certs; deferring to the runtime')
      return undefined
    } else {
      logForDebugging('caCerts: no system CA accessor; using bundled roots as the base')
      certificates.push(...tls.rootCertificates)
    }
  } else {
    logForDebugging('caCerts: extra certs only; using bundled roots as the base')
    certificates.push(...tls.rootCertificates)
  }

  if (extraCertsPath) {
    try {
      certificates.push(readFileSync(extraCertsPath, 'utf8'))
      logForDebugging(`caCerts: appended extra certificates from ${extraCertsPath}`)
      extraCertsOutcome = { path: extraCertsPath, loaded: true }
    } catch (err) {
      logError(err)
      extraCertsOutcome = { path: extraCertsPath, loaded: false, error: err instanceof Error ? err.message : String(err) }
    }
  }

  if (certificates.length === 0) {
    logForDebugging('caCerts: every source failed or returned nothing; using runtime defaults')
    return undefined
  }
  return certificates
}

let cachedResult: { value: string[] | undefined } | null = null

export type ExtraCaCertsOutcome = { path: string; loaded: boolean; error?: string }
let extraCertsOutcome: ExtraCaCertsOutcome | null = null

export function getCACertificates(): string[] | undefined {
  if (cachedResult) return cachedResult.value
  extraCertsOutcome = null
  const value = resolveCACertificates()
  cachedResult = { value }
  return value
}

export function getExtraCaCertsOutcome(): ExtraCaCertsOutcome | null {
  getCACertificates()
  if (extraCertsOutcome === null && process.env.NODE_EXTRA_CA_CERTS) {
    return { path: process.env.NODE_EXTRA_CA_CERTS, loaded: true }
  }
  return extraCertsOutcome
}

export function extraCaCertsStatusLine(): string | null {
  const outcome = getExtraCaCertsOutcome()
  if (outcome === null) return null
  return outcome.loaded
    ? outcome.path
    : `${outcome.path} — NOT READ (${outcome.error ?? 'unreadable'}); the bundled roots alone are in use`
}

export function clearCACertsCache(): void {
  cachedResult = null
  extraCertsOutcome = null
}
