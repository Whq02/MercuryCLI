import { spawnSync } from 'node:child_process'
import { getErrnoCode } from '../../../platform/errors/errors.js'
import { execFileNoThrow } from '../../../platform/processes/execFileNoThrow.js'
import {
  getMacOsKeychainStorageServiceName,
  getUsername,
  keychainReachable,
} from '../../../platform/secure-storage/index.js'
import { subprocessEnv } from '../../../platform/processes/subprocessEnv.js'

function keychainDeleteRefusal(exitCode: number, stderr: string, error?: unknown): Error {
  const errCode = error !== undefined ? (getErrnoCode(error) ?? 'ESPAWN') : undefined
  const code = errCode ?? (exitCode === 36 ? 'KEYCHAIN_LOCKED' : `KEYCHAIN_EXIT_${exitCode}`)
  const detail =
    error instanceof Error
      ? error.message
      : stderr.trim().slice(0, 200) || (exitCode === 36 ? 'keychain is locked' : `exit ${exitCode}`)
  return Object.assign(
    new Error(
      `the API key could not be removed from the keychain (${detail}) — it is still stored; unlock the keychain and remove it again`,
    ),
    { code },
  )
}

export async function maybeRemoveApiKeyFromMacOSKeychainThrows(): Promise<void> {
  if (!keychainReachable()) return
  const result = await execFileNoThrow('security', [
    'delete-generic-password',
    '-a',
    getUsername(),
    '-s',
    getMacOsKeychainStorageServiceName(),
  ])
  if (result.code === 0 || result.code === 44) return
  throw keychainDeleteRefusal(result.code, result.stderr)
}

export function maybeRemoveApiKeyFromMacOSKeychainSyncThrows(): void {
  if (!keychainReachable()) return
  const result = spawnSync(
    'security',
    ['delete-generic-password', '-a', getUsername(), '-s', getMacOsKeychainStorageServiceName()],
    {
      windowsHide: true,
      encoding: 'utf8',
      timeout: 10_000,
      env: { ...subprocessEnv() },
    },
  )
  if (result.error) throw keychainDeleteRefusal(result.status ?? 1, result.stderr ?? '', result.error)
  if (result.status === 0 || result.status === 44) return
  throw keychainDeleteRefusal(result.status ?? 1, result.stderr ?? '')
}

export function normalizeApiKeyForConfig(key: string): string {
  return key.slice(-20)
}
