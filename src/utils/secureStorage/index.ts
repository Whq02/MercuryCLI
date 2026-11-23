import { flagEnv } from '../../substrate/flagRegistry.js'
import { logForDebugging } from '../debug.js'
import { getErrnoCode } from '../errors.js'
import { createFallbackStorage } from './fallbackStorage.js'
import { fileStorageFor } from './fileStorage.js'
import { keychainReachable } from './macOsKeychainHelpers.js'
import { macOsKeychainStorage } from './macOsKeychainStorage.js'
import { credentialStoreUnread as plainTextCredentialStoreUnread, plainTextStorage } from './plainTextStorage.js'
import { sealsUnder, systemProtectorFor } from './systemProtector.js'
import type { CredentialStoreUnread, SecureStorage, SecureStorageData } from './types.js'
import { keysOf } from '../entriesOf.js'


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
export { credentialsPath, plainTextStorage } from './plainTextStorage.js'
export {
  clearLegacyApiKeyPrefetch,
  ensureKeychainPrefetchCompleted,
  getLegacyApiKeyPrefetchResult,
  startKeychainPrefetch,
} from './keychainPrefetch.js'
export type { SecureStorage, SecureStorageData } from './types.js'

let lastReadError: CredentialStoreUnread | null = null

export function noteCredentialStoreReadError(error: unknown): void {
  const code = getErrnoCode(error) ?? 'EUNKNOWN'
  const message = error instanceof Error ? error.message : String(error)
  const warning = `The credential store could not be read (${code}): ${message}`
  if (lastReadError !== null && lastReadError.code === code && lastReadError.message === message) return
  lastReadError = { warning, code, message }
  logForDebugging(`credential store: ${warning}`, { level: 'error' })
}

export function clearCredentialStoreReadError(): void {
  if (lastReadError === null) return
  lastReadError = null
  logForDebugging('credential store: read recovered')
}

export function credentialStoreUnread(): CredentialStoreUnread | null {
  if (lastReadError !== null) return lastReadError
  const storage = getSecureStorage()
  if (storage.unread !== undefined) return storage.unread()
  return plainTextCredentialStoreUnread()
}

export function getSecureStorage(): SecureStorage {
  if (keychainReachable()) {
    return createFallbackStorage(macOsKeychainStorage, plainTextStorage)
  }
  const storeFlag = flagEnv('MERCURY_CREDENTIAL_STORE')
  return fileStorageFor(systemProtectorFor(process.platform, storeFlag), sealsUnder(storeFlag))
}

export function deleteCredentialStores(): Array<'keychain' | 'file'> {
  const left: Array<'keychain' | 'file'> = []
  if (keychainReachable() && !macOsKeychainStorage.delete()) left.push('keychain')
  if (!plainTextStorage.delete()) left.push('file')
  return left
}

export function removeSecureStorageField<K extends keyof SecureStorageData>(
  field: K,
): { removed: boolean; kept: number; success: boolean; code?: string; left?: Array<'keychain' | 'file'> } {
  const storage = getSecureStorage()
  const current = storage.read()
  const keys = current === null ? [] : keysOf(current)
  const kept = current === null ? 0 : keys.filter(key => key !== field && current[key] !== undefined).length
  if (current === null || current[field] === undefined) return { removed: false, kept, success: true }
  const next: SecureStorageData = { ...current }
  delete next[field]
  if (kept === 0) {
    const left = deleteCredentialStores()
    return { removed: true, kept, success: left.length === 0, ...(left.length > 0 ? { left } : {}) }
  }
  const written = storage.update(next)
  return { removed: true, kept, success: written.success, ...(written.code !== undefined ? { code: written.code } : {}) }
}
