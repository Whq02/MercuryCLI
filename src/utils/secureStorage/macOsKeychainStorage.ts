import { execFile, spawnSync } from 'node:child_process'
import { subprocessEnv } from '../subprocessEnv.js'

import { logForDebugging } from '../debug.js'
import {
  CREDENTIALS_SERVICE_SUFFIX,
  clearKeychainCache,
  getLegacyMacOsKeychainStorageServiceName,
  getMacOsKeychainStorageServiceName,
  getRawSpellingKeychainStorageServiceName,
  getUsername,
  KEYCHAIN_CACHE_TTL_MS,
  keychainCacheState,
} from './macOsKeychainHelpers.js'
import type { SecureStorage, SecureStorageData } from './types.js'

/**
 * macOS keychain credential store: dual-read migration, honest delete exit
 * codes, and stale-while-error over the shared cache.
 */

type SecurityResult = { exitCode: number; stdout: string; stderr: string }

function runSecurity(args: string[], input?: string): SecurityResult {
  const result = spawnSync('security', args, {
    windowsHide: true,
    encoding: 'utf8',
    // Bounded like the boot prefetch beside it: over SSH a keychain
    // authorization dialog can never be answered, and an unbounded sync
    // spawn freezes the whole process with ctrl-c dead.
    timeout: 10_000,
    env: { ...subprocessEnv() },
    ...(input !== undefined ? { input } : {}),
  })
  return { exitCode: result.status ?? 1, stdout: result.stdout ?? '', stderr: result.stderr ?? '' }
}

function credentialServiceNames(): string[] {
  return [
    getMacOsKeychainStorageServiceName(CREDENTIALS_SERVICE_SUFFIX),
    getLegacyMacOsKeychainStorageServiceName(CREDENTIALS_SERVICE_SUFFIX),
  ]
}

function readServiceSync(serviceName: string): string | null {
  const result = runSecurity(['find-generic-password', '-a', getUsername(), '-w', '-s', serviceName])
  if (result.exitCode !== 0) return null
  const trimmed = result.stdout.trim()
  return trimmed === '' ? null : trimmed
}

function readServiceAsync(serviceName: string): Promise<string | null> {
  return new Promise(resolve => {
    execFile(
      'security',
      ['find-generic-password', '-a', getUsername(), '-w', '-s', serviceName],
      { windowsHide: true, env: { ...subprocessEnv() } },
      (error, stdout) => {
        if (error) {
          resolve(null)
          return
        }
        const trimmed = stdout.trim()
        resolve(trimmed === '' ? null : trimmed)
      },
    )
  })
}

function parseData(raw: string): SecureStorageData | null {
  try {
    return JSON.parse(raw) as SecureStorageData
  } catch {
    return null
  }
}

/**
 * MIGRATE-AND-DELETE for a raw-spelling-keyed entry (the F-11 home
 * canonicalisation orphaned it): write the credential under the canonical
 * service first, and only a SUCCESSFUL write deletes the raw entry — a
 * failed write must leave the one surviving copy where it was. Runs at most
 * once per home: after it, the canonical read hits and the raw entry is
 * gone (a dormant credential nothing would ever clean is its own exposure).
 */
function migrateRawKeyedEntry(data: SecureStorageData, rawServiceName: string): void {
  const written = macOsKeychainStorage.update(data)
  if (!written.success) return
  const result = runSecurity(['delete-generic-password', '-a', getUsername(), '-s', rawServiceName])
  if (result.exitCode !== 0 && result.exitCode !== 44) {
    logForDebugging(
      `raw-spelling keychain migration: canonical write landed but the raw-keyed delete failed for ${rawServiceName}: exit ${result.exitCode}`,
      { level: 'warn' as never },
    )
  }
}

// The interactive `security -i` reader takes one line at a time through a
// fixed 4096-byte buffer; a longer line is cut mid-argument, the tool exits
// non-zero, NOTHING is written, and the previously stored entry survives —
// which the fallback store then serves as stale. The comparison keeps 64
// bytes of headroom rather than being exactly right about the terminator.
const STDIN_LINE_LIMIT = 4096 - 64

export const macOsKeychainStorage: SecureStorage = {
  name: 'keychain',

  read(): SecureStorageData | null {
    const state = keychainCacheState
    if (state.cached.cachedAt !== 0 && Date.now() - state.cached.cachedAt < KEYCHAIN_CACHE_TTL_MS) {
      return state.cached.data
    }
    const previous = state.cached.data
    for (const serviceName of credentialServiceNames()) {
      try {
        const raw = readServiceSync(serviceName)
        if (raw === null) continue
        const parsed = parseData(raw)
        if (parsed === null) continue
        state.cached = { data: parsed, cachedAt: Date.now() }
        return parsed
      } catch {
        // Fall through to the next spelling.
      }
    }
    // The raw-spelling fallback (F-11 aftermath): a credential stored under
    // the pre-canonicalisation dirHash is read once and migrated across.
    const rawService = getRawSpellingKeychainStorageServiceName(CREDENTIALS_SERVICE_SUFFIX)
    if (rawService !== null) {
      try {
        const raw = readServiceSync(rawService)
        const parsed = raw === null ? null : parseData(raw)
        if (parsed !== null) {
          migrateRawKeyedEntry(parsed, rawService)
          state.cached = { data: parsed, cachedAt: Date.now() }
          return parsed
        }
      } catch {
        // Fall through to stale-while-error.
      }
    }
    // Stale-while-error: this store is re-read constantly (the auth memo
    // drops per request on this platform), and a single transient
    // subprocess failure caching null would read as a logged-out session
    // everywhere. Explicit invalidation nulls the DATA, so logout and
    // delete still read through instead of resurrecting the old value.
    if (previous !== null) {
      logForDebugging('keychain read failed on both spellings; serving the previous value', {
        level: 'warn' as never,
      })
      state.cached = { data: previous, cachedAt: Date.now() }
      return previous
    }
    state.cached = { data: null, cachedAt: Date.now() }
    return null
  },

  async readAsync(): Promise<SecureStorageData | null> {
    const state = keychainCacheState
    if (state.cached.cachedAt !== 0 && Date.now() - state.cached.cachedAt < KEYCHAIN_CACHE_TTL_MS) {
      return state.cached.data
    }
    if (state.readInFlight !== null) return state.readInFlight
    const generation = state.generation
    const readPromise = (async (): Promise<SecureStorageData | null> => {
      let parsed: SecureStorageData | null = null
      for (const serviceName of credentialServiceNames()) {
        const raw = await readServiceAsync(serviceName)
        if (raw === null) continue
        parsed = parseData(raw)
        if (parsed !== null) break
      }
      if (parsed === null) {
        // The raw-spelling fallback, same law as the synchronous read.
        const rawService = getRawSpellingKeychainStorageServiceName(CREDENTIALS_SERVICE_SUFFIX)
        if (rawService !== null) {
          const raw = await readServiceAsync(rawService)
          parsed = raw === null ? null : parseData(raw)
          if (parsed !== null) migrateRawKeyedEntry(parsed, rawService)
        }
      }
      if (state.generation !== generation) {
        // Superseded by an update/invalidation: return the raw result
        // without touching the cache.
        return parsed
      }
      const previous = state.cached.data
      if (parsed === null && previous !== null) {
        logForDebugging('keychain async read failed; serving the previous value', {
          level: 'warn' as never,
        })
        state.cached = { data: previous, cachedAt: Date.now() }
        state.readInFlight = null
        return previous
      }
      state.cached = { data: parsed, cachedAt: Date.now() }
      state.readInFlight = null
      return parsed
    })()
    state.readInFlight = readPromise
    return readPromise
  },

  update(data: SecureStorageData): { success: boolean; warning?: string } {
    clearKeychainCache()
    try {
      // Hex-encoding the UTF-8 bytes avoids all escaping issues.
      const hex = Buffer.from(JSON.stringify(data), 'utf8').toString('hex')
      const serviceName = getMacOsKeychainStorageServiceName(CREDENTIALS_SERVICE_SUFFIX)
      const username = getUsername()
      // Hex-encoded password DATA (`-X`): the literal-password form would
      // store the hex TEXT itself and every later read would JSON-parse-fail.
      const commandLine = `add-generic-password -U -a "${username}" -s "${serviceName}" -X ${hex}\n`
      let result: SecurityResult
      if (commandLine.length <= STDIN_LINE_LIMIT) {
        // Preferred: the payload rides stdin, so process monitors see only
        // `security -i` and never the value.
        result = runSecurity(['-i'], commandLine)
      } else {
        // Hex in the argument vector is recoverable by a determined
        // observer but beats silent credential corruption.
        logForDebugging(
          `keychain payload of ${commandLine.length} bytes exceeds the stdin line limit; using the argument vector`,
          { level: 'warn' as never },
        )
        result = runSecurity(['add-generic-password', '-U', '-a', username, '-s', serviceName, '-X', hex])
      }
      if (result.exitCode !== 0) return { success: false }
      keychainCacheState.cached = { data, cachedAt: Date.now() }
      return { success: true }
    } catch {
      return { success: false }
    }
  },

  delete(): boolean {
    clearKeychainCache()
    // Every spelling of the credentials service is deleted (a pre-rename or
    // raw-spelling entry left behind would resurrect through its read
    // fallback after logout); the un-suffixed legacy API-key entry is NOT
    // touched.
    let allSucceeded = true
    const rawService = getRawSpellingKeychainStorageServiceName(CREDENTIALS_SERVICE_SUFFIX)
    const serviceNames = [
      getMacOsKeychainStorageServiceName(CREDENTIALS_SERVICE_SUFFIX),
      getLegacyMacOsKeychainStorageServiceName(CREDENTIALS_SERVICE_SUFFIX),
      ...(rawService !== null ? [rawService] : []),
    ]
    for (const serviceName of serviceNames) {
      const result = runSecurity(['delete-generic-password', '-a', getUsername(), '-s', serviceName])
      // Exit 44 (item not found) is idempotent success; any other non-zero
      // exit is a real failure. (The earlier string-exec wrapper never
      // threw, so logout reported success with the token still stored.)
      if (result.exitCode !== 0 && result.exitCode !== 44) {
        logForDebugging(
          `keychain delete failed for ${serviceName}: exit ${result.exitCode}, ${result.stderr.slice(0, 200)}`,
        )
        allSucceeded = false
      }
    }
    return allSucceeded
  },
}

// Memoized in a slot distinguishable from "not yet asked": the probe is a
// blocking spawn reached from render, and the keychain's lock state does
// not change under the session.
let keychainLockedMemo: boolean | null = null

/** Whether the macOS keychain is locked (common over SSH). Exit code 36 means locked; a thrown error reads as unlocked. */
export function isMacOsKeychainLocked(): boolean {
  if (process.platform !== 'darwin') return false
  if (keychainLockedMemo !== null) return keychainLockedMemo
  try {
    const result = runSecurity(['show-keychain-info'])
    keychainLockedMemo = result.exitCode === 36
  } catch {
    keychainLockedMemo = false
  }
  return keychainLockedMemo
}
