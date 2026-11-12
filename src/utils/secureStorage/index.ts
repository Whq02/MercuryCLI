import { flagEnv } from '../../substrate/flagRegistry.js'
import { createFallbackStorage } from './fallbackStorage.js'
import { fileStorageFor } from './fileStorage.js'
import { keychainReachable } from './macOsKeychainHelpers.js'
import { macOsKeychainStorage } from './macOsKeychainStorage.js'
import { plainTextStorage } from './plainTextStorage.js'
import { sealsUnder, systemProtectorFor } from './systemProtector.js'
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
  const storeFlag = flagEnv('MERCURY_CREDENTIAL_STORE')
  return fileStorageFor(systemProtectorFor(process.platform, storeFlag), sealsUnder(storeFlag))
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
