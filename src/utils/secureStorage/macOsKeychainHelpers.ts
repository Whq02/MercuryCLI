import { createHash } from 'node:crypto'
import { homedir, userInfo } from 'node:os'
import { join } from 'node:path'

import { fileSuffixForOauthConfig } from '../../constants/oauth.js'
import { getAuthConfigHomeDir, getAuthScope, rawConfigHomePinSpelling } from '../envUtils.js'
import type { SecureStorageData } from './types.js'

/**
 * Keychain service-name derivation and the shared read cache.
 *
 * IMPORT CONSTRAINT: none of the process-execution helper libraries may
 * appear here, directly or transitively. The prefetch module reaches this
 * file at the very start of the entry module, ahead of the imports the
 * prefetch exists to overlap with; a heavy transitive import would pay its
 * evaluation cost before the prefetch fires — exactly the cost the
 * prefetch was written to hide.
 */

/**
 * Distinguishes the OAuth credentials entry from the legacy API-key entry
 * (which uses no suffix). This value must NEVER change — it is part of the
 * lookup key, and changing it orphans stored credentials.
 */
export const CREDENTIALS_SERVICE_SUFFIX = '-credentials'

/**
 * Identity follows the RESOLVED auth config home, matching the file store:
 * keying on the presence of a config-dir variable instead would give the
 * same home two different credential identities depending on how it was
 * launched (cross-account bleed).
 */
export function getMacOsKeychainStorageServiceName(serviceSuffix: string = ''): string {
  const configDir = getAuthConfigHomeDir().normalize('NFC')
  const isDefaultDir = configDir === join(homedir(), '.claude').normalize('NFC')
  const dirHash = isDefaultDir ? '' : `-${createHash('sha256').update(configDir).digest('hex').slice(0, 8)}`
  return `Mercury${fileSuffixForOauthConfig()}${serviceSuffix}${dirHash}`
}

/**
 * The pre-rename service spelling, read as a single bounded migration
 * fallback. Writes go to the Mercury name only, so the first token refresh
 * after an upgrade carries the credential across.
 */
export function getLegacyMacOsKeychainStorageServiceName(serviceSuffix: string = ''): string {
  const configDir = getAuthConfigHomeDir().normalize('NFC')
  const isDefaultDir = configDir === join(homedir(), '.claude').normalize('NFC')
  const dirHash = isDefaultDir ? '' : `-${createHash('sha256').update(configDir).digest('hex').slice(0, 8)}`
  return `Claude Code${fileSuffixForOauthConfig()}${serviceSuffix}${dirHash}`
}

/**
 * The RAW-SPELLING service name: the home canonicalisation
 * (canonicalHomeSpelling inside getMercuryHome) moved the dirHash for every
 * non-canonical MERCURY_CONFIG_DIR/MERCURY_HOME pin — a trailing separator,
 * forward slashes, a lower-case drive letter — orphaning the credential
 * stored under the earlier hash. Read as a bounded migration fallback when the
 * canonical read finds nothing; the first successful read MIGRATES — write
 * canonical, DELETE the raw-keyed entry, because a dormant credential
 * nothing would ever clean is its own exposure — and writes never target
 * this name. Null when no pin exists, when an auth scope overrides the home
 * (the scope was never canonicalised, so nothing moved), or when the pin is
 * already spelled canonically.
 */
export function getRawSpellingKeychainStorageServiceName(serviceSuffix: string = ''): string | null {
  if (getAuthScope() !== undefined) return null
  const raw = rawConfigHomePinSpelling()
  if (raw === null) return null
  if (raw === getAuthConfigHomeDir().normalize('NFC')) return null
  const dirHash = `-${createHash('sha256').update(raw).digest('hex').slice(0, 8)}`
  return `Mercury${fileSuffixForOauthConfig()}${serviceSuffix}${dirHash}`
}

/** The fallback account name for the keychain entry — applies ONLY when
 *  reading the OS user info throws (a truthy USER wins first, then the OS
 *  username). The product's own spelling. */
export const KEYCHAIN_FALLBACK_USERNAME = 'mercury-user'

/** A truthy USER wins; then the OS user-info username; the literal fallback applies only when reading user info THROWS. */
export function getUsername(): string {
  const fromEnv = process.env.USER
  if (fromEnv) return fromEnv
  try {
    return userInfo().username
  } catch {
    return KEYCHAIN_FALLBACK_USERNAME
  }
}

/**
 * 30 seconds bounds how stale a cross-process change can be. The length is
 * deliberate: a synchronous keychain read is a subprocess in the
 * half-second class, and a startup burst of connector authentications must
 * not outlive the cache and repeat the reads. The cached tokens live for
 * hours; the only other writer is a login/refresh in a second instance.
 */
export const KEYCHAIN_CACHE_TTL_MS = 30_000

export type KeychainCacheState = {
  /** `cachedAt === 0` means the cache has never been touched (invalid). */
  cached: { data: SecureStorageData | null; cachedAt: number }
  /** Incremented on every invalidation; async reads capture-and-compare so a stale subprocess result cannot overwrite fresher data. */
  generation: number
  /** Deduplicates concurrent async reads so a TTL expiry under load spawns one subprocess, not N. */
  readInFlight: Promise<SecureStorageData | null> | null
}

/**
 * A single MUTABLE exported object, forced by module semantics: a
 * re-assignable binding exported from one module cannot be written from
 * another, and both this module and the store module must mutate all three
 * fields.
 */
export const keychainCacheState: KeychainCacheState = {
  cached: { data: null, cachedAt: 0 },
  generation: 0,
  readInFlight: null,
}

/** Resets the pair, bumps the generation, and clears the in-flight read (so fresh reads do not join a stale one). */
export function clearKeychainCache(): void {
  keychainCacheState.cached = { data: null, cachedAt: 0 }
  keychainCacheState.generation++
  keychainCacheState.readInFlight = null
}

/**
 * Primes from raw prefetch stdout ONLY when the cache has never been
 * touched — a synchronous read or an update that already ran is
 * authoritative. Null/empty stdout primes a null entry with a fresh
 * timestamp; malformed JSON primes nothing and lets the synchronous read
 * re-fetch. The runtime's built-in JSON parser is used deliberately (the
 * shared helper carries import weight this module must not).
 */
export function primeKeychainCacheFromPrefetch(stdout: string | null): void {
  if (keychainCacheState.cached.cachedAt !== 0) return
  if (stdout === null || stdout === '') {
    keychainCacheState.cached = { data: null, cachedAt: Date.now() }
    return
  }
  try {
    const parsed = JSON.parse(stdout) as SecureStorageData
    keychainCacheState.cached = { data: parsed, cachedAt: Date.now() }
  } catch {
    // Malformed prefetch output primes nothing at all.
  }
}
