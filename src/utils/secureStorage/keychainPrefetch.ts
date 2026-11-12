import { execFile } from 'node:child_process'
import { subprocessEnv } from '../subprocessEnv.js'

import { flagEnv } from '../../substrate/flagRegistry.js'
import { isBareMode } from '../envUtils.js'
import { sealedFileStoreFor } from './fileStorage.js'
import {
  CREDENTIALS_SERVICE_SUFFIX,
  getMacOsKeychainStorageServiceName,
  getRawSpellingKeychainStorageServiceName,
  getUsername,
  keychainReachable,
  primeKeychainCacheFromPrefetch,
} from './macOsKeychainHelpers.js'
import { otherBuildAlive } from './otherBuilds.js'
import { plainTextStorage } from './plainTextStorage.js'
import { startSealedStore } from './sealedStoreStart.js'
import { sealsUnder, systemProtectorFor } from './systemProtector.js'


type PrefetchLookupResult = { stdout: string | null; timedOut: boolean }

let prefetchInFlight: Promise<void> | null = null
let legacyApiKeyResult: { stdout: string | null } | null = null

function lookup(serviceName: string): Promise<PrefetchLookupResult> {
  return new Promise(resolve => {
    execFile(
      'security',
      ['find-generic-password', '-a', getUsername(), '-w', '-s', serviceName],
      { windowsHide: true, timeout: 10_000, env: { ...subprocessEnv() } },
      (error, stdout) => {
        if (error) {
          resolve({ stdout: null, timedOut: (error as { killed?: boolean }).killed === true })
          return
        }
        const trimmed = stdout.trim()
        resolve({ stdout: trimmed === '' ? null : trimmed, timedOut: false })
      },
    )
  })
}

export function sealedStoreStartFor(
  platform: NodeJS.Platform,
  storeFlag: string | undefined,
): { warmed: Promise<void>; settled: Promise<string> } | null {
  const protector = systemProtectorFor(platform, storeFlag)
  if (protector === null) return null
  return startSealedStore({ file: plainTextStorage, custody: sealedFileStoreFor(protector).custody, otherBuildAlive, seals: sealsUnder(storeFlag) })
}

export function startKeychainPrefetch(): void {
  if (prefetchInFlight !== null) return
  if (isBareMode()) return
  if (!keychainReachable()) {
    prefetchInFlight = sealedStoreStartFor(process.platform, flagEnv('MERCURY_CREDENTIAL_STORE'))?.warmed ?? null
    return
  }
  prefetchInFlight = (async () => {
    const rawService = getRawSpellingKeychainStorageServiceName(CREDENTIALS_SERVICE_SUFFIX)
    const [primary, raw, apiKey] = await Promise.all([
      lookup(getMacOsKeychainStorageServiceName(CREDENTIALS_SERVICE_SUFFIX)),
      rawService !== null
        ? lookup(rawService)
        : Promise.resolve<PrefetchLookupResult>({ stdout: null, timedOut: false }),
      lookup(getMacOsKeychainStorageServiceName()),
    ])
    const credentialReads = [primary, raw]
    const found = credentialReads.find(r => !r.timedOut && r.stdout !== null)
    if (found !== undefined) {
      primeKeychainCacheFromPrefetch(found.stdout)
    } else if (credentialReads.every(r => !r.timedOut)) {
      primeKeychainCacheFromPrefetch(null)
    }
    if (!apiKey.timedOut) {
      legacyApiKeyResult = { stdout: apiKey.stdout }
    }
  })()
}

export async function ensureKeychainPrefetchCompleted(): Promise<void> {
  if (prefetchInFlight !== null) await prefetchInFlight
}

export function getLegacyApiKeyPrefetchResult(): { stdout: string | null } | null {
  return legacyApiKeyResult
}

export function clearLegacyApiKeyPrefetch(): void {
  legacyApiKeyResult = null
}
