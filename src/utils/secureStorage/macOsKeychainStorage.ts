import { execFile, spawnSync } from 'node:child_process'
import { subprocessEnv } from '../subprocessEnv.js'

import { logForDebugging } from '../debug.js'
import {
  CREDENTIALS_SERVICE_SUFFIX,
  clearKeychainCache,
  getMacOsKeychainStorageServiceName,
  getRawSpellingKeychainStorageServiceName,
  getUsername,
  KEYCHAIN_CACHE_TTL_MS,
  keychainCacheState,
  keychainReachable,
} from './macOsKeychainHelpers.js'
import type { SecureStorage, SecureStorageData } from './types.js'


type SecurityResult = { exitCode: number; stdout: string; stderr: string }

const KEYCHAIN_UNREACHABLE: SecurityResult = {
  exitCode: 1,
  stdout: '',
  stderr: 'the credential store is pinned to the file backend; the keychain tool is not spawned',
}

function runSecurity(args: string[], input?: string): SecurityResult {
  if (!keychainReachable()) return KEYCHAIN_UNREACHABLE
  const result = spawnSync('security', args, {
    windowsHide: true,
    encoding: 'utf8',
    timeout: 10_000,
    env: { ...subprocessEnv() },
    ...(input !== undefined ? { input } : {}),
  })
  return { exitCode: result.status ?? 1, stdout: result.stdout ?? '', stderr: result.stderr ?? '' }
}

function credentialServiceNames(): string[] {
  return [getMacOsKeychainStorageServiceName(CREDENTIALS_SERVICE_SUFFIX)]
}

export function readKeychainServiceSync(serviceName: string): string | null {
  const result = runSecurity(['find-generic-password', '-a', getUsername(), '-w', '-s', serviceName])
  if (result.exitCode !== 0) return null
  const trimmed = result.stdout.trim()
  return trimmed === '' ? null : trimmed
}

function readServiceAsync(serviceName: string): Promise<string | null> {
  if (!keychainReachable()) return Promise.resolve(null)
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
        const raw = readKeychainServiceSync(serviceName)
        if (raw === null) continue
        const parsed = parseData(raw)
        if (parsed === null) continue
        state.cached = { data: parsed, cachedAt: Date.now() }
        return parsed
      } catch {
      }
    }
    const rawService = getRawSpellingKeychainStorageServiceName(CREDENTIALS_SERVICE_SUFFIX)
    if (rawService !== null) {
      try {
        const raw = readKeychainServiceSync(rawService)
        const parsed = raw === null ? null : parseData(raw)
        if (parsed !== null) {
          migrateRawKeyedEntry(parsed, rawService)
          state.cached = { data: parsed, cachedAt: Date.now() }
          return parsed
        }
      } catch {
      }
    }
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
        const rawService = getRawSpellingKeychainStorageServiceName(CREDENTIALS_SERVICE_SUFFIX)
        if (rawService !== null) {
          const raw = await readServiceAsync(rawService)
          parsed = raw === null ? null : parseData(raw)
          if (parsed !== null) migrateRawKeyedEntry(parsed, rawService)
        }
      }
      if (state.generation !== generation) {
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
      const hex = Buffer.from(JSON.stringify(data), 'utf8').toString('hex')
      const serviceName = getMacOsKeychainStorageServiceName(CREDENTIALS_SERVICE_SUFFIX)
      const username = getUsername()
      const commandLine = `add-generic-password -U -a "${username}" -s "${serviceName}" -X ${hex}\n`
      let result: SecurityResult
      if (commandLine.length <= STDIN_LINE_LIMIT) {
        result = runSecurity(['-i'], commandLine)
      } else {
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
    let allSucceeded = true
    const rawService = getRawSpellingKeychainStorageServiceName(CREDENTIALS_SERVICE_SUFFIX)
    const serviceNames = [
      getMacOsKeychainStorageServiceName(CREDENTIALS_SERVICE_SUFFIX),
      ...(rawService !== null ? [rawService] : []),
    ]
    for (const serviceName of serviceNames) {
      const result = runSecurity(['delete-generic-password', '-a', getUsername(), '-s', serviceName])
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

let keychainLockedMemo: boolean | null = null

export function isMacOsKeychainLocked(): boolean {
  if (!keychainReachable()) return false
  if (keychainLockedMemo !== null) return keychainLockedMemo
  try {
    const result = runSecurity(['show-keychain-info'])
    keychainLockedMemo = result.exitCode === 36
  } catch {
    keychainLockedMemo = false
  }
  return keychainLockedMemo
}
