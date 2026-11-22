import type { Stats } from 'fs'
import { logForDebugging } from './debug.js'
import { getFsImplementation, safeResolvePath, type FsOperations } from './fsOperations.js'
import { passedOver } from './passedOver.js'

export type LineEndingType = 'CRLF' | 'LF'

export const LOSSY_DECODE_MESSAGE =
  'File is not valid UTF-8 (or UTF-16LE): editing would rewrite the undecodable bytes as replacement characters (U+FFFD), destroying content the edit never touches. Convert it first (for example `iconv -f cp1252 -t utf-8`), or change it with a shell command that preserves its encoding.'

const SNIFF_BYTES = 4096

class NotARegularFileError extends Error {
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

function specialFileKindAt(fsImpl: FsOperations, resolvedPath: string): string | null {
  try {
    return specialFileKind(fsImpl.statSync(resolvedPath))
  } catch (error) {
    passedOver(error)
    return null
  }
}

export function detectEncodingForResolvedPath(resolvedPath: string): BufferEncoding {
  const { buffer, bytesRead } = getFsImplementation().readSync(resolvedPath, { length: SNIFF_BYTES })
  return bytesRead >= 2 && buffer[0] === 0xff && buffer[1] === 0xfe ? 'utf16le' : 'utf8'
}

export function detectLineEndingsForString(content: string): LineEndingType {
  let balance = 0
  for (let i = 0; i < content.length; i++) {
    if (content[i] === '\n') balance += content[i - 1] === '\r' ? 1 : -1
  }
  return balance > 0 ? 'CRLF' : 'LF'
}

export function readFileSyncWithMetadata(filePath: string): {
  content: string
  rawContent: string
  encoding: BufferEncoding
  lineEndings: LineEndingType
  losslessDecode: boolean
} {
  const fs = getFsImplementation()
  const { resolvedPath, isSymlink } = safeResolvePath(fs, filePath)
  if (isSymlink) logForDebugging(`fileRead: reading ${filePath} through symlink at ${resolvedPath}`)
  const kind = specialFileKindAt(fs, resolvedPath)
  if (kind) throw new NotARegularFileError(filePath, kind)
  const encoding = detectEncodingForResolvedPath(resolvedPath)
  const bytes = fs.readFileBytesSync(resolvedPath)
  const rawContent = bytes.toString(encoding)
  return {
    content: rawContent.replaceAll('\r\n', '\n'),
    encoding,
    lineEndings: detectLineEndingsForString(rawContent.slice(0, SNIFF_BYTES)),
    losslessDecode: Buffer.from(rawContent, encoding).equals(bytes),
    rawContent,
  }
}

export function readFileSync(filePath: string): string {
  return readFileSyncWithMetadata(filePath).content
}
