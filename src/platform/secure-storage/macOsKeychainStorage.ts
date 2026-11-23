import { execFile, spawnSync } from 'node:child_process'
import { subprocessEnv } from '../processes/subprocessEnv.js'

import { logForDebugging } from '../logs/debugLog.js'
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
import { getErrnoCode } from '../errors/errors.js'
import type { CredentialStoreUnread, SecureStorage, SecureStorageData } from './types.js'
import { passedOver } from '../errors/passedOver.js'


type SecurityResult = {
  exitCode: number
  stdout: string
  stderr: string
  errorCode?: string
  errorMessage?: string
}

type KeychainReadOutcome =
  | { kind: 'ok'; raw: string | null }
  | { kind: 'absent' }
  | { kind: 'failed'; code: string; message: string }

type ParseOutcome =
  | { ok: true; data: SecureStorageData }
  | { ok: false; code: string; message: string }

let keychainUnread: CredentialStoreUnread | null = null

function setKeychainUnread(next: { code: string; message: string } | null): void {
  if (next === null) {
    if (keychainUnread !== null) {
      logForDebugging('credential store: macOS keychain read recovered')
      keychainUnread = null
    }
    return
  }
  const warning = `The macOS keychain could not be read (${next.code}): ${next.message}`
  if (keychainUnread !== null && keychainUnread.code === next.code && keychainUnread.message === next.message) {
    return
  }
  keychainUnread = { warning, code: next.code, message: next.message }
  logForDebugging(`credential store: ${warning}`, { level: 'error' })
}

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
  const errorCode = result.error ? (getErrnoCode(result.error) ?? 'ESPAWN') : undefined
  const errorMessage = result.error ? result.error.message : undefined
  return {
    exitCode: result.status ?? 1,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    ...(errorCode !== undefined ? { errorCode } : {}),
    ...(errorMessage !== undefined ? { errorMessage } : {}),
  }
}

function credentialServiceNames(): string[] {
  return [getMacOsKeychainStorageServiceName(CREDENTIALS_SERVICE_SUFFIX)]
}

function classifySyncRead(result: SecurityResult): KeychainReadOutcome {
  if (result.exitCode === 0) {
    const trimmed = result.stdout.trim()
    return { kind: 'ok', raw: trimmed === '' ? null : trimmed }
  }
  if (result.exitCode === 44) return { kind: 'absent' }
  const code = result.errorCode ?? (result.exitCode === 36 ? 'KEYCHAIN_LOCKED' : `KEYCHAIN_EXIT_${result.exitCode}`)
  const stderr = result.stderr.trim().slice(0, 200)
  const message =
    result.errorMessage ??
    (stderr !== '' ? stderr : result.exitCode === 36 ? 'keychain is locked' : `security exited with code ${result.exitCode}`)
  return { kind: 'failed', code, message }
}

function readKeychainServiceOutcomeSync(serviceName: string): KeychainReadOutcome {
  if (!keychainReachable()) return { kind: 'absent' }
  const result = runSecurity(['find-generic-password', '-a', getUsername(), '-w', '-s', serviceName])
  return classifySyncRead(result)
}

export function readKeychainServiceSync(serviceName: string): string | null {
  const outcome = readKeychainServiceOutcomeSync(serviceName)
  if (outcome.kind === 'failed') {
    setKeychainUnread(outcome)
    return null
  }
  if (outcome.kind === 'ok') {
    if (keychainUnread !== null && keychainUnread.code !== 'KEYCHAIN_CORRUPT') {
      setKeychainUnread(null)
    }
    return outcome.raw
  }
  return null
}

function readServiceOutcomeAsync(serviceName: string): Promise<KeychainReadOutcome> {
  if (!keychainReachable()) return Promise.resolve({ kind: 'absent' })
  return new Promise(resolve => {
    execFile(
      'security',
      ['find-generic-password', '-a', getUsername(), '-w', '-s', serviceName],
      { windowsHide: true, env: { ...subprocessEnv() } },
      (error, stdout, stderr) => {
        if (error) {
          const rawCode = (error as { code?: unknown }).code
          if (rawCode === 44) {
            resolve({ kind: 'absent' })
            return
          }
          const code =
            typeof rawCode === 'string' && rawCode !== ''
              ? rawCode
              : rawCode === 36
                ? 'KEYCHAIN_LOCKED'
                : typeof rawCode === 'number'
                  ? `KEYCHAIN_EXIT_${rawCode}`
                  : 'KEYCHAIN_ERROR'
          const stderrText = (stderr ?? '').trim().slice(0, 200)
          const message =
            stderrText !== '' ? stderrText : rawCode === 36 ? 'keychain is locked' : error.message
          resolve({ kind: 'failed', code, message })
          return
        }
        const trimmed = stdout.trim()
        resolve({ kind: 'ok', raw: trimmed === '' ? null : trimmed })
      },
    )
  })
}

function parseData(raw: string): ParseOutcome {
  try {
    const parsed: unknown = JSON.parse(raw)
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      return { ok: false, code: 'KEYCHAIN_CORRUPT', message: 'keychain entry is not a JSON object' }
    }
    return { ok: true, data: parsed as SecureStorageData }
  } catch (error) {
    passedOver(error)
    return { ok: false, code: 'KEYCHAIN_CORRUPT', message: 'keychain entry is not valid JSON' }
  }
}

function failureFromError(error: unknown): { code: string; message: string } {
  return {
    code: getErrnoCode(error) ?? 'KEYCHAIN_ERROR',
    message: error instanceof Error ? error.message : String(error),
  }
}

function migrateRawKeyedEntry(data: SecureStorageData, rawServiceName: string): void {
  const written = macOsKeychainStorage.update(data)
  if (!written.success) return
  const result = runSecurity(['delete-generic-password', '-a', getUsername(), '-s', rawServiceName])
  if (result.exitCode !== 0 && result.exitCode !== 44) {
    logForDebugging(
      `raw-spelling keychain migration: canonical write landed but the raw-keyed delete failed for ${rawServiceName}: exit ${result.exitCode}`,
      { level: 'warn' },
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
    let lastFailure: { code: string; message: string } | null = null
    for (const serviceName of credentialServiceNames()) {
      try {
        const outcome = readKeychainServiceOutcomeSync(serviceName)
        if (outcome.kind === 'failed') {
          lastFailure = outcome
          continue
        }
        if (outcome.kind === 'absent' || outcome.raw === null) continue
        const parsed = parseData(outcome.raw)
        if (!parsed.ok) {
          lastFailure = parsed
          continue
        }
        setKeychainUnread(null)
        state.cached = { data: parsed.data, cachedAt: Date.now() }
        return parsed.data
      } catch (error) {
        passedOver(error)
        lastFailure = failureFromError(error)
      }
    }
    const rawService = getRawSpellingKeychainStorageServiceName(CREDENTIALS_SERVICE_SUFFIX)
    if (rawService !== null) {
      try {
        const outcome = readKeychainServiceOutcomeSync(rawService)
        if (outcome.kind === 'failed') {
          lastFailure ??= outcome
        } else if (outcome.kind === 'ok' && outcome.raw !== null) {
          const parsed = parseData(outcome.raw)
          if (parsed.ok) {
            setKeychainUnread(null)
            migrateRawKeyedEntry(parsed.data, rawService)
            state.cached = { data: parsed.data, cachedAt: Date.now() }
            return parsed.data
          }
          lastFailure ??= parsed
        }
      } catch (error) {
        passedOver(error)
        lastFailure ??= failureFromError(error)
      }
    }
    setKeychainUnread(lastFailure)
    if (previous !== null) {
      logForDebugging('keychain read failed on both spellings; serving the previous value', {
        level: 'warn',
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
      let data: SecureStorageData | null = null
      let lastFailure: { code: string; message: string } | null = null
      for (const serviceName of credentialServiceNames()) {
        const outcome = await readServiceOutcomeAsync(serviceName)
        if (outcome.kind === 'failed') {
          lastFailure = outcome
          continue
        }
        if (outcome.kind === 'absent' || outcome.raw === null) continue
        const parsed = parseData(outcome.raw)
        if (!parsed.ok) {
          lastFailure = parsed
          continue
        }
        data = parsed.data
        break
      }
      if (data === null) {
        const rawService = getRawSpellingKeychainStorageServiceName(CREDENTIALS_SERVICE_SUFFIX)
        if (rawService !== null) {
          const outcome = await readServiceOutcomeAsync(rawService)
          if (outcome.kind === 'failed') {
            lastFailure ??= outcome
          } else if (outcome.kind === 'ok' && outcome.raw !== null) {
            const parsed = parseData(outcome.raw)
            if (parsed.ok) {
              data = parsed.data
              migrateRawKeyedEntry(data, rawService)
            } else {
              lastFailure ??= parsed
            }
          }
        }
      }
      setKeychainUnread(data !== null ? null : lastFailure)
      if (state.generation !== generation) {
        return data
      }
      const previous = state.cached.data
      if (data === null && previous !== null) {
        logForDebugging('keychain async read failed; serving the previous value', {
          level: 'warn',
        })
        state.cached = { data: previous, cachedAt: Date.now() }
        state.readInFlight = null
        return previous
      }
      state.cached = { data, cachedAt: Date.now() }
      state.readInFlight = null
      return data
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
          { level: 'warn' },
        )
        result = runSecurity(['add-generic-password', '-U', '-a', username, '-s', serviceName, '-X', hex])
      }
      if (result.exitCode !== 0) return { success: false }
      setKeychainUnread(null)
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

  unread(): CredentialStoreUnread | null {
    return keychainUnread
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
