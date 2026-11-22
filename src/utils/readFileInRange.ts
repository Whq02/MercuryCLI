import { stat, type FileHandle } from 'node:fs/promises'

import { formatFileSize } from './format.js'
import { openRegularFile } from './regularFile.js'
import { passedOverAs } from './passedOver.js'
import { notBuilt, type Unbuilt } from '../pi/holes.js'


export type ReadFileRangeResult = Unbuilt

export class FileTooLargeError extends Error {
  readonly sizeInBytes: number
  readonly maxSizeBytes: number
  readonly lineCount: number | undefined

  constructor(sizeInBytes: number, maxSizeBytes: number, lineCount?: number) {
    notBuilt('src/utils/readFileInRange.ts:43')
    super(...(notBuilt('src/utils/readFileInRange.ts:43') as ConstructorParameters<typeof Error>))
  }
}

const FAST_PATH_MAX_BYTES = 10 * 1024 * 1024
const STREAM_BUFFER_SIZE = 512 * 1024

type RangeOptions = { truncateOnByteLimit?: boolean }

export function stripBom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text
}

function encodingForLeadingBytes(b0: number | undefined, b1: number | undefined): 'utf8' | 'utf16le' {
  return b0 === 0xff && b1 === 0xfe ? 'utf16le' : 'utf8'
}

function decodeWhole(buffer: Buffer): string {
  return buffer.toString(encodingForLeadingBytes(buffer[0], buffer[1]))
}

function normalizeLine(line: string): string {
  return line.endsWith('\r') ? line.slice(0, -1) : line
}

function fastPath(
  text: string,
  offset: number,
  maxLines: number | undefined,
  mtimeMs: number,
  totalBytes: number,
): ReadFileRangeResult {
  const lines = stripBom(text).split('\n')
  const totalLines = lines.length
  const end = maxLines === undefined ? totalLines : Math.min(offset + maxLines, totalLines)
  const selected = lines.slice(offset, Math.max(end, offset)).map(normalizeLine)
  const content = selected.join('\n')
  return {
    content,
    lineCount: selected.length,
    totalLines,
    totalBytes,
    readBytes: Buffer.byteLength(content),
    mtimeMs,
    endsWithNewline: text.endsWith('\n'),
  }
}

export async function readFileInRange(
  filePath: string,
  offset?: number,
  maxLines?: number,
  maxBytes?: number,
  signal?: AbortSignal,
  options?: RangeOptions,
): Promise<ReadFileRangeResult> {
  return notBuilt('src/utils/readFileInRange.ts:96')
}
