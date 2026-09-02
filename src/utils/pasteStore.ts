
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

export function hashPastedText(content: string): string {
  return createHash('sha256').update(content).digest('hex').slice(0, 16)
}

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
    }
  }
}
