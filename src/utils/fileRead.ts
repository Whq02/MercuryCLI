import type { Stats } from 'fs'
import { logForDebugging } from './debug.js'
import { getFsImplementation, safeResolvePath, type FsOperations } from './fsOperations.js'


export type LineEndingType = 'CRLF' | 'LF'

const SNIFF_BYTES = 4096

export class NotARegularFileError extends Error {
  readonly code = 'ENOTREG'
  constructor(filePath: string, kind: string) {
    super(`${filePath} is ${kind}, not a regular file, and is not read`)
    this.name = 'NotARegularFileError'
  }
}

function specialFileKind(stats: Stats): string | null {
  if (stats.isFIFO()) return 'a named pipe'
  if (stats.isSocket()) return 'a socket'
  if (stats.isCharacterDevice() || stats.isBlockDevice()) return 'a device'
  return null
}

export function specialFileKindAt(fsImpl: FsOperations, resolvedPath: string): string | null {
  try {
    return specialFileKind(fsImpl.statSync(resolvedPath))
  } catch {
    return null
  }
}

export function detectEncodingForResolvedPath(resolvedPath: string): BufferEncoding {
  const { buffer, bytesRead } = getFsImplementation().readSync(resolvedPath, { length: SNIFF_BYTES })
  if (bytesRead === 0) return 'utf8'
  if (bytesRead >= 2 && buffer[0] === 0xff && buffer[1] === 0xfe) return 'utf16le'
  if (bytesRead >= 3 && buffer[0] === 0xef && buffer[1] === 0xbb && buffer[2] === 0xbf) return 'utf8'
  return 'utf8'
}

export function detectLineEndingsForString(content: string): LineEndingType {
  let crlf = 0
  let lf = 0
  for (let i = 0; i < content.length; i++) {
    if (content.charCodeAt(i) === 10) {
      if (i > 0 && content.charCodeAt(i - 1) === 13) crlf++
      else lf++
    }
  }
  return crlf > lf ? 'CRLF' : 'LF'
}

export function readFileSyncWithMetadata(filePath: string): {
  content: string
  rawContent: string
  encoding: BufferEncoding
  lineEndings: LineEndingType
  losslessDecode: boolean
} {
  const fsImpl = getFsImplementation()
  const { resolvedPath, isSymlink } = safeResolvePath(fsImpl, filePath)
  if (isSymlink) {
    logForDebugging(`fileRead: reading ${filePath} through symlink at ${resolvedPath}`)
  }
  const kind = specialFileKindAt(fsImpl, resolvedPath)
  if (kind !== null) {
    throw new NotARegularFileError(filePath, kind)
  }
  const encoding = detectEncodingForResolvedPath(resolvedPath)
  const bytes = fsImpl.readFileBytesSync(resolvedPath)
  const rawContent = bytes.toString(encoding)
  const losslessDecode = Buffer.from(rawContent, encoding).equals(bytes)
  const lineEndings = detectLineEndingsForString(rawContent.slice(0, SNIFF_BYTES))
  return {
    content: rawContent.replaceAll('\r\n', '\n'),
    rawContent,
    encoding,
    lineEndings,
    losslessDecode,
  }
}

export function readFileSync(filePath: string): string {
  return readFileSyncWithMetadata(filePath).content
}
