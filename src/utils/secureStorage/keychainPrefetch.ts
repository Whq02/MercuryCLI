import { execFile } from 'node:child_process'
import { subprocessEnv } from '../subprocessEnv.js'

import { isBareMode } from '../envUtils.js'
import {
  CREDENTIALS_SERVICE_SUFFIX,
  getLegacyMacOsKeychainStorageServiceName,
  getMacOsKeychainStorageServiceName,
  getRawSpellingKeychainStorageServiceName,
  getUsername,
  keychainReachable,
  primeKeychainCacheFromPrefetch,
} from './macOsKeychainHelpers.js'

/**
 * Fires macOS keychain reads in parallel with entry-module evaluation.
 * The downstream eligibility check reads two keychain entries through
 * blocking subprocesses on every macOS startup's critical path; started
 * early and awaited late, their cost largely disappears behind the entry
 * module's own imports.
 */

type PrefetchLookupResult = { stdout: string | null; timedOut: boolean }

let prefetchInFlight: Promise<void> | null = null
let legacyApiKeyResult: { stdout: string | null } | null = null

function lookup(serviceName: string): Promise<PrefetchLookupResult> {
  return new Promise(resolve => {
    execFile(
      'security',
      ['find-generic-password', '-a', getUsername(), '-w', '-s', serviceName],
      { windowsHide: true, timeout: 10_000, env: { ...subprocessEnv() } },
      (error, stdout) => {
        if (error) {
          resolve({ stdout: null, timedOut: (error as { killed?: boolean }).killed === true })
          return
        }
        const trimmed = stdout.trim()
        resolve({ stdout: trimmed === '' ? null : trimmed, timedOut: false })
      },
    )
  })
}

/**
 * Four concurrent lookups: the Mercury credentials service, the PRE-RENAME
 * credentials service, the RAW-SPELLING credentials service (the F-11 home
 * canonicalisation moved a pinned home's dirHash — without this lookup a
 * raw-keyed install would be shadowed by a primed null for a whole cache
 * TTL and boot looking signed out), and the Mercury-named legacy API-key
 * service (no suffix). A raw-spelling hit primes the cache only; the
 * migrate-and-delete belongs to the store's own read and runs at the first
 * TTL-expired miss.
 */
export function startKeychainPrefetch(): void {
  // The one rule: off darwin, or with the credential store pinned to the
  // file backend, the boot never reaches the keychain tool — a scratch-home
  // proof booting the artifact must not read the machine's keychain.
  if (!keychainReachable()) return
  if (prefetchInFlight !== null) return
  if (isBareMode()) return
  prefetchInFlight = (async () => {
    const rawService = getRawSpellingKeychainStorageServiceName(CREDENTIALS_SERVICE_SUFFIX)
    const [primary, legacy, raw, apiKey] = await Promise.all([
      lookup(getMacOsKeychainStorageServiceName(CREDENTIALS_SERVICE_SUFFIX)),
      lookup(getLegacyMacOsKeychainStorageServiceName(CREDENTIALS_SERVICE_SUFFIX)),
      rawService !== null
        ? lookup(rawService)
        : Promise.resolve<PrefetchLookupResult>({ stdout: null, timedOut: false }),
      lookup(getMacOsKeychainStorageServiceName()),
    ])
    // A TIMED-OUT read never primes: the keychain may hold a key that
    // could not be fetched, and priming null would shadow it from the
    // synchronous retry. The first FOUND spelling primes; a completed
    // all-spellings miss primes null (the signed-out boot skips the
    // synchronous retry).
    const credentialReads = [primary, legacy, raw]
    const found = credentialReads.find(r => !r.timedOut && r.stdout !== null)
    if (found !== undefined) {
      primeKeychainCacheFromPrefetch(found.stdout)
    } else if (credentialReads.every(r => !r.timedOut)) {
      primeKeychainCacheFromPrefetch(null)
    }
    if (!apiKey.timedOut) {
      legacyApiKeyResult = { stdout: apiKey.stdout }
    }
  })()
}

/** Resolves the in-flight prefetch, or immediately (including on every non-macOS platform). */
export async function ensureKeychainPrefetchCompleted(): Promise<void> {
  if (prefetchInFlight !== null) await prefetchInFlight
}

/**
 * Three-state contract: `null` means the prefetch has not completed;
 * `{ stdout: null }` means it completed and there is no key. Only a
 * completed prefetch may be trusted by the synchronous reader.
 */
export function getLegacyApiKeyPrefetchResult(): { stdout: string | null } | null {
  return legacyApiKeyResult
}

/** Must be called alongside the corresponding cache invalidation so a stale prefetch cannot shadow a fresh write. */
export function clearLegacyApiKeyPrefetch(): void {
  legacyApiKeyResult = null
}
