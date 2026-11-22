import type { Stats } from 'fs'
import { logForDebugging } from './debug.js'
import { getFsImplementation, safeResolvePath, type FsOperations } from './fsOperations.js'
import { passedOver } from './passedOver.js'
import { notBuilt } from '../pi/holes.js'


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
  return notBuilt('src/utils/fileRead.ts:38')
}

export function detectLineEndingsForString(content: string): LineEndingType {
  return notBuilt('src/utils/fileRead.ts:46')
}

export function readFileSyncWithMetadata(filePath: string): {
  content: string
  rawContent: string
  encoding: BufferEncoding
  lineEndings: LineEndingType
  losslessDecode: boolean
} {
  return notBuilt('src/utils/fileRead.ts:58')
}

export function readFileSync(filePath: string): string {
  return notBuilt('src/utils/fileRead.ts:88')
}
