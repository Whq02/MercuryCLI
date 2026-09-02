/**
 * Two platform-portable auth helpers, kept dependency-light so both the CLI
 * and the bridge can import them.
 */
import { execFileNoThrow } from './execFileNoThrow.js'
import {
  getMacOsKeychainStorageServiceName,
  getUsername,
} from './secureStorage/index.js'

/**
 * Delete the login-managed API key's keychain entry. macOS only (a no-op
 * elsewhere); THROWS on a non-zero exit so callers can distinguish "removed"
 * from "still present".
 */
export async function maybeRemoveApiKeyFromMacOSKeychainThrows(): Promise<void> {
  if (process.platform !== 'darwin') return
  const result = await execFileNoThrow('security', [
    'delete-generic-password',
    '-a',
    getUsername(),
    '-s',
    getMacOsKeychainStorageServiceName(),
  ])
  if (result.code !== 0) {
    throw new Error(`Failed to remove the API key from the keychain (exit ${result.code})`)
  }
}

/** Normalize an API key for config storage: keep only the last 20 characters. */
export function normalizeApiKeyForConfig(key: string): string {
  return key.slice(-20)
}
