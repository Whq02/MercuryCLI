import { detectFileEncoding, needsPowerShellBom } from './file.js'
import { getFsImplementation } from './fsOperations.js'

/**
 * A process-wide mtime-keyed cache of decoded file contents for the edit
 * path, keyed by the path string EXACTLY as given (no normalisation — two
 * spellings of one file are two entries, unlike the read-state cache).
 */

const MAX_ENTRIES = 1000

type CacheEntry = {
  content: string
  encoding: BufferEncoding
  mtimeMs: number
}

const entries = new Map<string, CacheEntry>()

function readFile(path: string): { content: string; encoding: BufferEncoding } {
  const fsImpl = getFsImplementation()
  let mtimeMs: number
  try {
    // Stat on the given path — no symlink resolution.
    mtimeMs = fsImpl.statSync(path).mtimeMs
  } catch (err) {
    // The file was deleted: evict and rethrow.
    entries.delete(path)
    throw err
  }
  const cached = entries.get(path)
  if (cached && cached.mtimeMs === mtimeMs) {
    return { content: cached.content, encoding: cached.encoding }
  }
  // The LOGGING detector owned by the general file module.
  const encoding = detectFileEncoding(path)
  let content = fsImpl.readFileSync(path, { encoding }).replaceAll('\r\n', '\n')
  // Only files the PowerShell lane round-trips with a BOM have it stripped
  // here (the write side re-adds it), keeping an edit anchored at the first
  // character matching what the display shows.
  if (needsPowerShellBom(path) && content.startsWith('\uFEFF')) {
    content = content.slice(1)
  }
  entries.set(path, { content, encoding, mtimeMs })
  if (entries.size > MAX_ENTRIES) {
    const oldest = entries.keys().next().value
    if (oldest !== undefined) entries.delete(oldest)
  }
  return { content, encoding }
}

export const fileReadCache = {
  readFile,
  clear(): void {
    entries.clear()
  },
  invalidate(path: string): void {
    entries.delete(path)
  },
  getStats(): { size: number; entries: string[] } {
    return { size: entries.size, entries: [...entries.keys()] }
  },
}
