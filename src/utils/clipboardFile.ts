import { writeFileSync } from 'node:fs'
import { flagEnv } from '../substrate/flagRegistry.js'

export const CLIPBOARD_FILE_ROUTE = 'file' as const

export function clipboardFilePath(): string | null {
  const file = flagEnv('MERCURY_CLIPBOARD_FILE')
  return file !== undefined && file.trim() !== '' ? file : null
}

export function writeClipboardFile(text: string): 'written' | 'failed' | null {
  const file = clipboardFilePath()
  if (file === null) return null
  try {
    writeFileSync(file, text, 'utf8')
    return 'written'
  } catch {
    return 'failed'
  }
}
