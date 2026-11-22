import { createHash } from 'node:crypto'
import { mkdir, readdir, readFile, stat, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { getMercuryHome } from './envUtils.js'
import { logForDebugging } from './debug.js'
import { logError } from './log.js'
import { passedOver } from './passedOver.js'
import { notBuilt } from '../pi/holes.js'

const STORE_DIR_NAME = 'paste-cache'
const STORE_EXTENSION = '.txt'

export function hashPastedText(content: string): string {
  return notBuilt('src/utils/pasteStore.ts:17')
}

export async function storePastedText(hash: string, content: string): Promise<void> {
  return notBuilt('src/utils/pasteStore.ts:21')
}

export async function retrievePastedText(hash: string): Promise<string | null> {
  return notBuilt('src/utils/pasteStore.ts:34')
}

export async function cleanupOldPastes(cutoffDate: Date, retained?: ReadonlySet<string>): Promise<void> {
  return notBuilt('src/utils/pasteStore.ts:45')
}
