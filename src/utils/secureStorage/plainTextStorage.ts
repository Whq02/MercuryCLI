import { chmodSync, copyFileSync, mkdirSync, readFileSync, unlinkSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

import { DurablePublishError, durableAtomicPublishSync } from '../../substrate/durablePublish.js'
import { logForDebugging } from '../debug.js'
import { getAuthConfigHomeDir } from '../envUtils.js'
import { getErrnoCode } from '../errors.js'
import { safeParseJSON } from '../json.js'
import type { SecureStorage, SecureStorageData } from './types.js'


const CREDENTIALS_FILENAME = '.credentials.json'

function credentialsPath(): string {
  return join(getAuthConfigHomeDir(), CREDENTIALS_FILENAME)
}

function parseData(raw: string): SecureStorageData | null {
  const parsed = safeParseJSON(raw)
  return typeof parsed === 'object' && parsed !== null ? (parsed as SecureStorageData) : null
}

function noteUnreadable(error: unknown): void {
  const code = getErrnoCode(error)
  if (code === 'ENOENT' || code === 'ENOTDIR') return
  logForDebugging(
    `credential store: ${credentialsPath()} exists but could not be read (${code ?? 'unknown'}): ${
      error instanceof Error ? error.message : String(error)
    }`,
    { level: 'error' },
  )
}

type StoreProbe =
  | { state: 'absent' }
  | { state: 'ok' }
  | { state: 'unparseable' }
  | { state: 'unreadable'; code: string; message: string }

function probeStore(path: string): StoreProbe {
  let raw: string
  try {
    raw = readFileSync(path, 'utf8')
  } catch (error) {
    const code = getErrnoCode(error)
    if (code === 'ENOENT' || code === 'ENOTDIR') return { state: 'absent' }
    return {
      state: 'unreadable',
      code: code ?? 'EUNKNOWN',
      message: error instanceof Error ? error.message : String(error),
    }
  }
  return parseData(raw) === null ? { state: 'unparseable' } : { state: 'ok' }
}

function quarantineUnparseable(path: string): void {
  const copy = `${path}.corrupt.${Date.now()}`
  try {
    copyFileSync(path, copy)
    try {
      chmodSync(copy, 0o600)
    } catch {
    }
    logForDebugging(`credential store: unparseable bytes at ${path} quarantined to ${copy} before the rewrite`, {
      level: 'error',
    })
  } catch (error) {
    logForDebugging(`credential store: quarantine of ${path} failed: ${String(error)}`, { level: 'error' })
  }
}

export const plainTextStorage: SecureStorage = {
  name: 'plaintext',

  read(): SecureStorageData | null {
    try {
      return parseData(readFileSync(credentialsPath(), 'utf8'))
    } catch (error) {
      noteUnreadable(error)
      return null
    }
  },

  async readAsync(): Promise<SecureStorageData | null> {
    try {
      return parseData(await readFile(credentialsPath(), 'utf8'))
    } catch (error) {
      noteUnreadable(error)
      return null
    }
  },

  update(data: SecureStorageData): { success: boolean; warning?: string; code?: string } {
    try {
      try {
        mkdirSync(getAuthConfigHomeDir())
      } catch (error) {
        if ((error as { code?: string }).code !== 'EEXIST') throw error
      }
      const path = credentialsPath()
      const probe = probeStore(path)
      if (probe.state === 'unreadable') {
        logForDebugging(
          `credential store: refusing to replace ${path} — it exists but could not be read (${probe.code}): ${probe.message}`,
          { level: 'error' },
        )
        return {
          success: false,
          warning: `The credential store at ${path} exists but could not be read (${probe.code}); nothing was written.`,
          code: probe.code,
        }
      }
      if (probe.state === 'unparseable') {
        quarantineUnparseable(path)
      }
      durableAtomicPublishSync(path, JSON.stringify(data), { mode: 0o600 })
      try {
        chmodSync(path, 0o600)
      } catch {
      }
      return { success: true, warning: 'Credentials are stored in plaintext on disk' }
    } catch (error) {
      const code = error instanceof DurablePublishError ? error.fsCode : getErrnoCode(error)
      logForDebugging(
        `credential store: write refused${code ? ` (${code})` : ''}: ${error instanceof Error ? error.message : String(error)}`,
        { level: 'error' },
      )
      return { success: false, ...(code ? { code } : {}) }
    }
  },

  delete(): boolean {
    try {
      unlinkSync(credentialsPath())
      return true
    } catch (error) {
      return (error as { code?: string }).code === 'ENOENT'
    }
  },
}
