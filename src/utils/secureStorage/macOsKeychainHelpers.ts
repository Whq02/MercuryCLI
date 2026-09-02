import { createHash } from 'node:crypto'
import { homedir, userInfo } from 'node:os'
import { join } from 'node:path'

import { fileSuffixForOauthConfig } from '../../constants/oauth.js'
import { getAuthConfigHomeDir, getAuthScope, rawConfigHomePinSpelling } from '../envUtils.js'
import type { SecureStorageData } from './types.js'


export const CREDENTIALS_SERVICE_SUFFIX = '-credentials'

export function getMacOsKeychainStorageServiceName(serviceSuffix: string = ''): string {
  const configDir = getAuthConfigHomeDir().normalize('NFC')
  const isDefaultDir = configDir === join(homedir(), '.claude').normalize('NFC')
  const dirHash = isDefaultDir ? '' : `-${createHash('sha256').update(configDir).digest('hex').slice(0, 8)}`
  return `Mercury${fileSuffixForOauthConfig()}${serviceSuffix}${dirHash}`
}

export function getLegacyMacOsKeychainStorageServiceName(serviceSuffix: string = ''): string {
  const configDir = getAuthConfigHomeDir().normalize('NFC')
  const isDefaultDir = configDir === join(homedir(), '.claude').normalize('NFC')
  const dirHash = isDefaultDir ? '' : `-${createHash('sha256').update(configDir).digest('hex').slice(0, 8)}`
  return `Claude Code${fileSuffixForOauthConfig()}${serviceSuffix}${dirHash}`
}

export function getRawSpellingKeychainStorageServiceName(serviceSuffix: string = ''): string | null {
  if (getAuthScope() !== undefined) return null
  const raw = rawConfigHomePinSpelling()
  if (raw === null) return null
  if (raw === getAuthConfigHomeDir().normalize('NFC')) return null
  const dirHash = `-${createHash('sha256').update(raw).digest('hex').slice(0, 8)}`
  return `Mercury${fileSuffixForOauthConfig()}${serviceSuffix}${dirHash}`
}

export const KEYCHAIN_FALLBACK_USERNAME = 'mercury-user'

export function getUsername(): string {
  const fromEnv = process.env.USER
  if (fromEnv) return fromEnv
  try {
    return userInfo().username
  } catch {
    return KEYCHAIN_FALLBACK_USERNAME
  }
}

export const KEYCHAIN_CACHE_TTL_MS = 30_000

export type KeychainCacheState = {
  cached: { data: SecureStorageData | null; cachedAt: number }
  generation: number
  readInFlight: Promise<SecureStorageData | null> | null
}

export const keychainCacheState: KeychainCacheState = {
  cached: { data: null, cachedAt: 0 },
  generation: 0,
  readInFlight: null,
}

export function clearKeychainCache(): void {
  keychainCacheState.cached = { data: null, cachedAt: 0 }
  keychainCacheState.generation++
  keychainCacheState.readInFlight = null
}

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
  }
}
