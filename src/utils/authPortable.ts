import { execFileNoThrow } from './execFileNoThrow.js'
import {
  getMacOsKeychainStorageServiceName,
  getUsername,
} from './secureStorage/index.js'

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

export function normalizeApiKeyForConfig(key: string): string {
  return key.slice(-20)
}
