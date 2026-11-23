import { closeSync, fstatSync, openSync, readSync } from 'node:fs'
import { join } from 'node:path'

export const FILE_READER_CHUNK_BYTES = 256 * 1024
export type FileReaderDocument = { path: string; text: string; truncated: boolean; error?: string }

export function readFilesMenuMarkdown(root: string, path: string): FileReaderDocument {
  let fd: number | undefined
  try {
    fd = openSync(join(root, path), 'r')
    const stat = fstatSync(fd)
    if (!stat.isFile()) throw new Error('Not a regular file')
    const buffer = Buffer.alloc(Math.min(stat.size, FILE_READER_CHUNK_BYTES) + 1)
    let bytes = 0
    while (bytes < buffer.length) {
      const read = readSync(fd, buffer, bytes, buffer.length - bytes, bytes)
      if (read === 0) break
      bytes += read
    }
    const truncated = bytes > FILE_READER_CHUNK_BYTES
    const text = new TextDecoder().decode(buffer.subarray(0, Math.min(bytes, FILE_READER_CHUNK_BYTES)), { stream: truncated })
    return { path, text, truncated }
  } catch (error) {
    return { path, text: '', truncated: false, error: error instanceof Error ? error.message : String(error) }
  } finally {
    if (fd !== undefined) closeSync(fd)
  }
}

let openState = false
let version = 0
const listeners = new Set<() => void>()

function notify(): void {
  version += 1
  for (const listener of listeners) listener()
}

export function openFilesMenu(): void {
  if (openState) return
  openState = true
  notify()
}

export function closeFilesMenu(): void {
  if (!openState) return
  openState = false
  notify()
}

export function isFilesMenuOpen(): boolean {
  return openState
}

export function filesMenuVersion(): number {
  return version
}

export function subscribeFilesMenu(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}
