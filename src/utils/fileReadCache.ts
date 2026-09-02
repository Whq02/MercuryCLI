import { detectFileEncoding, needsPowerShellBom } from './file.js'
import { getFsImplementation } from './fsOperations.js'


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
    mtimeMs = fsImpl.statSync(path).mtimeMs
  } catch (err) {
    entries.delete(path)
    throw err
  }
  const cached = entries.get(path)
  if (cached && cached.mtimeMs === mtimeMs) {
    return { content: cached.content, encoding: cached.encoding }
  }
  const encoding = detectFileEncoding(path)
  let content = fsImpl.readFileSync(path, { encoding }).replaceAll('\r\n', '\n')
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
