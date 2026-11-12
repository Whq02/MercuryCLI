import type { Stats } from 'node:fs'
import { stat } from 'node:fs/promises'

type NotAFile = 'a named pipe' | 'a socket' | 'a device'

export function notAFileKind(st: Stats): NotAFile | null {
  if (st.isFile() || st.isDirectory()) return null
  return st.isFIFO() ? 'a named pipe' : st.isSocket() ? 'a socket' : 'a device'
}

export async function notAFileOrFolder(path: string): Promise<NotAFile | null> {
  try {
    return notAFileKind(await stat(path))
  } catch {
    return null
  }
}

export function notAFileRefusal(displayPath: string, kind: NotAFile): string {
  return `Reading ${displayPath} is not allowed: it is ${kind}, not a file or a folder, and reading it could hang or never end; use a shell command with a timeout or a byte limit instead.`
}
