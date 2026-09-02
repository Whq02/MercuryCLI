// ============================================================================
//  Content-addressed on-disk store for large pasted text, one file per
//  paste, plus an age-based cleanup. The on-disk layout is data other
//  Mercury versions must keep reading: `paste-cache` under the Mercury
//  home, entries named `<hash>.txt`.
// ============================================================================

import { createHash } from 'node:crypto'
import { mkdir, readdir, readFile, stat, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { getMercuryHome } from './envUtils.js'
import { logForDebugging } from './debug.js'
import { logError } from './log.js'

const STORE_DIR_NAME = 'paste-cache'
const STORE_EXTENSION = '.txt'

function storeDir(): string {
  return join(getMercuryHome(), STORE_DIR_NAME)
}

/** SHA-256, hex, truncated to 16 characters — exported so a caller can mint
 *  the reference-chip id SYNCHRONOUSLY without awaiting the write. */
export function hashPastedText(content: string): string {
  return createHash('sha256').update(content).digest('hex').slice(0, 16)
}

/** Store pasted content under its hash. Content-addressed, so overwriting
 *  an existing file is always safe; failures are logged and swallowed — a
 *  failed paste cache must never break a submission. */
export async function storePastedText(hash: string, content: string): Promise<void> {
  try {
    const dir = storeDir()
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, `${hash}${STORE_EXTENSION}`), content, {
      encoding: 'utf8',
      mode: 0o600,
    })
  } catch (error) {
    logError(error)
  }
}

/** The stored content, or null. A missing file is the expected case and
 *  must not log; other errors log. */
export async function retrievePastedText(hash: string): Promise<string | null> {
  try {
    return await readFile(join(storeDir(), `${hash}${STORE_EXTENSION}`), 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException | null)?.code !== 'ENOENT') {
      logError(error)
    }
    return null
  }
}

/** Delete store entries older than the cutoff. A missing or unreadable
 *  directory means there is nothing to do; per-file errors are ignored so
 *  one bad entry cannot abort the sweep. Entries are processed one at a
 *  time. */
export async function cleanupOldPastes(cutoffDate: Date): Promise<void> {
  const dir = storeDir()
  let entries: string[]
  try {
    entries = await readdir(dir)
  } catch {
    return
  }
  for (const entry of entries) {
    if (!entry.endsWith(STORE_EXTENSION)) continue
    const path = join(dir, entry)
    try {
      const info = await stat(path)
      if (info.mtime.getTime() < cutoffDate.getTime()) {
        await unlink(path)
        logForDebugging(`pasteStore: cleaned up old paste ${entry}`)
      }
    } catch {
      // One bad entry never aborts the sweep.
    }
  }
}
