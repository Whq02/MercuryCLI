import { createFallbackStorage } from './fallbackStorage.js'
import { keychainReachable } from './macOsKeychainHelpers.js'
import { macOsKeychainStorage } from './macOsKeychainStorage.js'
import { plainTextStorage } from './plainTextStorage.js'
import type { SecureStorage, SecureStorageData } from './types.js'


export { createFallbackStorage } from './fallbackStorage.js'
export {
  clearKeychainCache,
  CREDENTIALS_SERVICE_SUFFIX,
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

export function getSecureStorage(): SecureStorage {
  if (keychainReachable()) {
    return createFallbackStorage(macOsKeychainStorage, plainTextStorage)
  }
  return plainTextStorage
}

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
