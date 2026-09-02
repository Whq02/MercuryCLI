import { createFallbackStorage } from './fallbackStorage.js'
import { keychainReachable } from './macOsKeychainHelpers.js'
import { macOsKeychainStorage } from './macOsKeychainStorage.js'
import { plainTextStorage } from './plainTextStorage.js'
import type { SecureStorage, SecureStorageData } from './types.js'

/**
 * Platform selection of the credential store, reading the environment LIVE
 * on every call.
 */

export { createFallbackStorage } from './fallbackStorage.js'
export {
  clearKeychainCache,
  CREDENTIALS_SERVICE_SUFFIX,
  getLegacyMacOsKeychainStorageServiceName,
  getMacOsKeychainStorageServiceName,
  getUsername,
  KEYCHAIN_CACHE_TTL_MS,
  keychainCacheState,
  keychainReachable,
  primeKeychainCacheFromPrefetch,
} from './macOsKeychainHelpers.js'
export { isMacOsKeychainLocked, macOsKeychainStorage } from './macOsKeychainStorage.js'
export { plainTextStorage } from './plainTextStorage.js'
export {
  clearLegacyApiKeyPrefetch,
  ensureKeychainPrefetchCompleted,
  getLegacyApiKeyPrefetchResult,
  startKeychainPrefetch,
} from './keychainPrefetch.js'
export type { SecureStorage, SecureStorageData } from './types.js'

/**
 * `MERCURY_CREDENTIAL_STORE=file` pins the file-backed store — the
 * hermeticity seam for captures and proofs: the file store's location
 * derives from the auth config home, so a child process started against a
 * scratch home has no path to the real machine's OS keychain. Otherwise
 * macOS gets the keychain composed over the file store, and every other
 * platform the file store alone. The factory reads the same rule every
 * `security` spawn reads (keychainReachable) — one fact, one owner.
 */
export function getSecureStorage(): SecureStorage {
  if (keychainReachable()) {
    return createFallbackStorage(macOsKeychainStorage, plainTextStorage)
  }
  return plainTextStorage
}

/**
 * Remove ONE field from the credential store and write the rest back. The
 * store is shared by every SecureStorageData field — the MCP server
 * sessions, the IDP sessions, the extension secrets, the trusted-device
 * token — so a per-slot sign-out must never reach for `delete()`, which is
 * the whole-store verb /logout owns. A store that cannot be read is never
 * rewritten (nothing to remove, nothing clobbered); a store the removal
 * empties leaves the disk, the extension-uninstall idiom.
 */
export function removeSecureStorageField<K extends keyof SecureStorageData>(
  field: K,
): { removed: boolean; kept: number; success: boolean } {
  const storage = getSecureStorage()
  const current = storage.read()
  const keys = current === null ? [] : (Object.keys(current) as Array<keyof SecureStorageData>)
  const kept = current === null ? 0 : keys.filter(key => key !== field && current[key] !== undefined).length
  if (current === null || current[field] === undefined) return { removed: false, kept, success: true }
  const next: SecureStorageData = { ...current }
  delete next[field]
  if (kept === 0) return { removed: true, kept, success: storage.delete() }
  return { removed: true, kept, success: storage.update(next).success }
}
