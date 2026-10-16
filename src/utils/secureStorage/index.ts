import { resolve } from 'node:path'
import { signInHome } from '../accounts/signInPockets.js'
import { clearAuthScope, getAuthConfigHomeDir, getAuthScope, setAuthScope } from '../envUtils.js'
import { createFallbackStorage } from './fallbackStorage.js'
import { clearKeychainCache, keychainReachable } from './macOsKeychainHelpers.js'
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

export function getSecureStorage(family?: 'anthropic'): SecureStorage {
  const base = keychainReachable() ? createFallbackStorage(macOsKeychainStorage, plainTextStorage) : plainTextStorage
  if (family === undefined) return base
  const pocket = signInHome(family)
  return resolve(pocket) === resolve(getAuthConfigHomeDir()) ? base : pocketBoundStorage(pocket, base)
}

function inPocket<T>(pocket: string, run: () => T): T {
  const previous = getAuthScope()
  try {
    setAuthScope(pocket)
    clearKeychainCache()
    return run()
  } finally {
    if (previous === undefined) clearAuthScope()
    else setAuthScope(previous)
    clearKeychainCache()
  }
}

function pocketBoundStorage(pocket: string, base: SecureStorage): SecureStorage {
  return {
    name: `${base.name} (sign-in pocket)`,
    read: () => inPocket(pocket, () => base.read()),
    readAsync: () => Promise.resolve(inPocket(pocket, () => base.read())),
    update: data => inPocket(pocket, () => base.update(data)),
    delete: () => inPocket(pocket, () => base.delete()),
  }
}

export function removeSecureStorageField<K extends keyof SecureStorageData>(
  field: K,
  family?: 'anthropic',
): { removed: boolean; kept: number; success: boolean } {
  const storage = getSecureStorage(family)
  const current = storage.read()
  const keys = current === null ? [] : (Object.keys(current) as Array<keyof SecureStorageData>)
  const kept = current === null ? 0 : keys.filter(key => key !== field && current[key] !== undefined).length
  if (current === null || current[field] === undefined) return { removed: false, kept, success: true }
  const next: SecureStorageData = { ...current }
  delete next[field]
  if (kept === 0) return { removed: true, kept, success: storage.delete() }
  return { removed: true, kept, success: storage.update(next).success }
}
