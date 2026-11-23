import { createHash } from 'node:crypto'
import { mkdir, readdir, readFile, stat, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { getMercuryHome } from '../platform/environment/envUtils.js'
import { logForDebugging } from '../platform/logs/debugLog.js'
import { logError } from '../platform/logs/errorLog.js'
import { passedOver } from '../platform/errors/passedOver.js'
import { isENOENT } from '../platform/errors/errors.js'

const STORE_DIR_NAME = 'paste-cache'
const STORE_EXTENSION = '.txt'

function storeDir(): string {
  return join(getMercuryHome(), STORE_DIR_NAME)
}

function isPasteHash(hash: string): boolean {
  return /^[0-9a-f]{16}$/.test(hash)
}

export function hashPastedText(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex').slice(0, 16)
}

export async function storePastedText(hash: string, content: string): Promise<void> {
  if (!isPasteHash(hash)) return
  try {
    const dir = storeDir()
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, hash + STORE_EXTENSION), content, { encoding: 'utf8', mode: 0o600 })
  } catch (error) {
    logError(error)
  }
}

export async function retrievePastedText(hash: string): Promise<string | null> {
  if (!isPasteHash(hash)) return null
  try {
    return await readFile(join(storeDir(), hash + STORE_EXTENSION), 'utf8')
  } catch (error) {
    if (!isENOENT(error)) logError(error)
    return null
  }
}

export async function cleanupOldPastes(cutoffDate: Date, retained?: ReadonlySet<string>): Promise<void> {
  try {
    const dir = storeDir()
    for (const name of await readdir(dir)) {
      if (!name.endsWith(STORE_EXTENSION) || retained?.has(name.slice(0, -STORE_EXTENSION.length))) continue
      try {
        const path = join(dir, name)
        if ((await stat(path)).mtime < cutoffDate) {
          await unlink(path)
          logForDebugging(`pasteStore: cleaned up old paste ${name}`)
        }
      } catch (error) {
        passedOver(error)
      }
    }
  } catch (error) {
    passedOver(error)
  }
}
