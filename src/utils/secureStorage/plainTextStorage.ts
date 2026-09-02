import { chmodSync, copyFileSync, mkdirSync, readFileSync, unlinkSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

import { DurablePublishError, durableAtomicPublishSync } from '../../substrate/durablePublish.js'
import { logForDebugging } from '../debug.js'
import { getAuthConfigHomeDir } from '../envUtils.js'
import { getErrnoCode } from '../errors.js'
import { safeParseJSON } from '../json.js'
import type { SecureStorage, SecureStorageData } from './types.js'

/**
 * File-backed credential store. The file lives in the AUTH config home —
 * deliberately the auth scope rather than the session home: a scoped
 * bracket (the board's reauth/read) touches only this store, so a scope's
 * credentials are read, refreshed and rewritten where they live while
 * session state stays put. At rest the two homes are the same directory.
 *
 * Durability laws (release-hardening audit rank 15):
 *  · update() publishes through the durable atomic writer — a flushed temp
 *    sibling created at mode 0600, then the bounded win32-retry rename —
 *    so an interrupted write (the window closed, a machine reset, a
 *    scanner's transient refusal) leaves the previous store intact instead
 *    of a truncated file that reads as "no sign-in, no MCP sessions, no
 *    extension secrets" on the next launch. It was a truncating in-place
 *    writeFileSync with flushing disabled.
 *  · Every writer of this store is a read-modify-write over read(), which
 *    answers null for ABSENT, UNREADABLE and UNPARSEABLE alike — so
 *    update() is the one owner of "never replace contents you could not
 *    establish": when the file exists but cannot be read it refuses (the
 *    errno rides back on `code`), and when it exists but does not parse it
 *    quarantines the bytes beside the store before replacing them.
 */

const CREDENTIALS_FILENAME = '.credentials.json'

function credentialsPath(): string {
  return join(getAuthConfigHomeDir(), CREDENTIALS_FILENAME)
}

function parseData(raw: string): SecureStorageData | null {
  const parsed = safeParseJSON(raw)
  return typeof parsed === 'object' && parsed !== null ? (parsed as SecureStorageData) : null
}

/** A failed read that is not the absent class is worth a debug line — the
 *  readers' null answer paints "signed out" over a store that is there. */
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

/** The bytes at rest, read fresh and classified: what a writer may replace. */
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

/** Keep unparseable bytes (a torn write, a hand-edit) beside the store so a
 *  refresh token or an MCP session is recoverable by hand. Best-effort. */
function quarantineUnparseable(path: string): void {
  const copy = `${path}.corrupt.${Date.now()}`
  try {
    copyFileSync(path, copy)
    try {
      chmodSync(copy, 0o600)
    } catch {
      /* best-effort on non-POSIX */
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
      // A SINGLE-LEVEL directory create: an existing directory is success,
      // but a missing parent of the auth home surfaces as a failed update,
      // not as a silently created tree.
      try {
        mkdirSync(getAuthConfigHomeDir())
      } catch (error) {
        if ((error as { code?: string }).code !== 'EEXIST') throw error
      }
      const path = credentialsPath()
      const probe = probeStore(path)
      if (probe.state === 'unreadable') {
        // The writer's view came from a read that failed the same way: the
        // data it hands us is one field over an empty store. Publishing it
        // would drop the sign-in, every MCP session and every extension
        // secret at once. Refuse, and say which errno.
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
      // Atomic: the temp is created at 0600 (no default-mode window), the
      // bytes are flushed, the rename is the publish.
      durableAtomicPublishSync(path, JSON.stringify(data), { mode: 0o600 })
      try {
        chmodSync(path, 0o600)
      } catch {
        /* best-effort on non-POSIX */
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
      // Already absent counts as success.
      return (error as { code?: string }).code === 'ENOENT'
    }
  },
}
