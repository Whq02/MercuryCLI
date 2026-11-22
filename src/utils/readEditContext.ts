import { open, type FileHandle } from 'node:fs/promises'

import { isENOENT } from './errors.js'
import { notBuilt, unbuilt, type Unbuilt } from '../pi/holes.js'


export const CHUNK_SIZE: Unbuilt = unbuilt('src/utils/readEditContext.ts:6')

type EditContext = Unbuilt

function countNewlines(text: string): number {
  let count = 0
  for (let index = 0; index < text.length; index++) {
    if (text.charCodeAt(index) === 10) count++
  }
  return count
}

export async function openForScan(path: string): Promise<FileHandle | null> {
  return notBuilt('src/utils/readEditContext.ts:23')
}

export async function scanForContext(handle: FileHandle, needle: string, contextLines: number): Promise<EditContext> {
  return notBuilt('src/utils/readEditContext.ts:32')
}

function bytesToChars(text: string, bytes: number): number {
  if (bytes <= 0) return 0
  let count = 0
  let index = 0
  while (index < text.length && count < bytes) {
    const code = text.codePointAt(index) as number
    const width = code < 0x80 ? 1 : code < 0x800 ? 2 : code < 0x10000 ? 3 : 4
    if (count + width > bytes) break
    count += width
    index += code >= 0x10000 ? 2 : 1
  }
  return index
}

export async function readCapped(handle: FileHandle): Promise<string | null> {
  return notBuilt('src/utils/readEditContext.ts:160')
}
