import { stat, type FileHandle } from 'node:fs/promises'
import { StringDecoder } from 'node:string_decoder'

import { formatFileSize } from './format.js'
import { openRegularFile } from './regularFile.js'
import { passedOverAs } from './passedOver.js'

export type ReadFileRangeResult = {
  content: string
  lineCount: number
  totalLines: number
  totalBytes: number
  readBytes: number
  mtimeMs: number
  endsWithNewline: boolean
  truncatedByBytes?: boolean
}

function formatFileTooLargeMessage(
  sizeInBytes: number,
  maxSizeBytes: number,
  lineCount?: number,
): string {
  const size = formatFileSize(sizeInBytes)
  const maxSize = formatFileSize(maxSizeBytes)
  if (lineCount === undefined) {
    return `File content (${size}) exceeds the maximum allowed size (${maxSize}). Use offset and limit to read portions of the file, or search for content instead of reading the whole file.`
  }
  const linesWord = lineCount === 1 ? '1 line' : `${lineCount} lines`
  const sliceAdvice =
    lineCount > 100
      ? `Read(offset: 1, limit: 100) reads the first 100 lines, Read(offset: ${lineCount - 99}, limit: 100) the last 100`
      : `Read(offset: 1, limit: ${lineCount}) reads all of it, each line cut at 2000 characters`
  return `File content (${size}, ${linesWord}) exceeds the maximum allowed size (${maxSize}) for a Read without a limit. Pass offset and limit to read a slice — ${sliceAdvice} — or search for content instead of reading the whole file.`
}

export class FileTooLargeError extends Error {
  readonly sizeInBytes: number
  readonly maxSizeBytes: number
  readonly lineCount: number | undefined

  constructor(sizeInBytes: number, maxSizeBytes: number, lineCount?: number) {
    super(formatFileTooLargeMessage(sizeInBytes, maxSizeBytes, lineCount))
    this.name = 'FileTooLargeError'
    this.sizeInBytes = sizeInBytes
    this.maxSizeBytes = maxSizeBytes
    this.lineCount = lineCount
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

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw signal.reason instanceof Error ? signal.reason : new Error('Read aborted')
  }
}

function makeEisdirError(filePath: string): NodeJS.ErrnoException {
  const err = new Error(`EISDIR: illegal operation on a directory, read '${filePath}'`) as NodeJS.ErrnoException
  err.code = 'EISDIR'
  err.errno = -21
  err.syscall = 'read'
  err.path = filePath
  return err
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

function fastPathTruncated(
  text: string,
  offset: number,
  maxLines: number | undefined,
  maxBytes: number,
  mtimeMs: number,
  totalBytes: number,
): ReadFileRangeResult {
  const lines = stripBom(text).split('\n')
  const totalLines = lines.length
  const end = maxLines === undefined ? totalLines : Math.min(offset + maxLines, totalLines)
  const selected: string[] = []
  let readBytes = 0
  let truncatedByBytes = false
  for (let i = offset; i < end; i++) {
    const line = normalizeLine(lines[i]!)
    const lineBytes = Buffer.byteLength(line, 'utf8')
    const sepBytes = selected.length > 0 ? 1 : 0
    if (readBytes + sepBytes + lineBytes > maxBytes) {
      truncatedByBytes = true
      break
    }
    selected.push(line)
    readBytes += sepBytes + lineBytes
  }
  const content = selected.join('\n')
  return {
    content,
    lineCount: selected.length,
    totalLines,
    totalBytes,
    readBytes,
    mtimeMs,
    endsWithNewline: text.endsWith('\n'),
    ...(truncatedByBytes ? { truncatedByBytes: true } : {}),
  }
}

async function streamPath(
  handle: FileHandle,
  startOffset: number,
  maxLines: number | undefined,
  maxBytes: number | undefined,
  truncate: boolean,
  mtimeMs: number,
  statSize: number,
  signal?: AbortSignal,
): Promise<ReadFileRangeResult> {
  const endLine = maxLines === undefined ? Infinity : startOffset + maxLines
  const buffer = Buffer.allocUnsafe(STREAM_BUFFER_SIZE)
  const selected: string[] = []
  let readBytes = 0
  let truncatedByBytes = false
  let streamedBytes = 0
  let currentLineIndex = 0
  let pending = ''
  let endsWithNewline = false
  let bomHandled = false
  let decoder: StringDecoder | null = null
  let position = 0

  const acceptLine = (rawLine: string): void => {
    const line = normalizeLine(rawLine)
    if (truncate && maxBytes !== undefined) {
      const lineBytes = Buffer.byteLength(line, 'utf8')
      const sepBytes = selected.length > 0 ? 1 : 0
      if (readBytes + sepBytes + lineBytes > maxBytes) {
        truncatedByBytes = true
        return
      }
      selected.push(line)
      readBytes += sepBytes + lineBytes
      return
    }
    selected.push(line)
  }

  const processChunk = (rawText: string): void => {
    let text = rawText
    if (!bomHandled && text.length > 0) {
      bomHandled = true
      text = stripBom(text)
    }
    if (text.length === 0) return
    streamedBytes += Buffer.byteLength(text, 'utf8')
    if (!truncate && maxBytes !== undefined && streamedBytes > maxBytes) {
      throw new FileTooLargeError(Math.max(statSize, streamedBytes), maxBytes)
    }
    endsWithNewline = text.charCodeAt(text.length - 1) === 10
    let pos = 0
    while (true) {
      const nl = text.indexOf('\n', pos)
      if (nl === -1) break
      if (currentLineIndex >= startOffset && currentLineIndex < endLine && !truncatedByBytes) {
        const piece = pending.length > 0 ? pending + text.slice(pos, nl) : text.slice(pos, nl)
        pending = ''
        acceptLine(piece)
      } else {
        pending = ''
      }
      currentLineIndex++
      pos = nl + 1
    }
    if (pos < text.length) {
      if (currentLineIndex >= startOffset && currentLineIndex < endLine && !truncatedByBytes) {
        pending += text.slice(pos)
      }
    }
  }

  while (true) {
    throwIfAborted(signal)
    const { bytesRead } = await handle.read(buffer, 0, STREAM_BUFFER_SIZE, position)
    if (bytesRead === 0) break
    position += bytesRead
    const slice = bytesRead < STREAM_BUFFER_SIZE ? buffer.subarray(0, bytesRead) : buffer
    if (decoder === null) {
      const encoding = encodingForLeadingBytes(
        bytesRead >= 1 ? slice[0] : undefined,
        bytesRead >= 2 ? slice[1] : undefined,
      )
      decoder = new StringDecoder(encoding)
    }
    processChunk(decoder.write(slice))
  }

  throwIfAborted(signal)
  if (decoder !== null) {
    processChunk(decoder.end())
  }

  if (currentLineIndex >= startOffset && currentLineIndex < endLine && !truncatedByBytes) {
    acceptLine(pending)
  }
  const totalLines = currentLineIndex + 1
  const content = selected.join('\n')
  return {
    content,
    lineCount: selected.length,
    totalLines,
    totalBytes: streamedBytes,
    readBytes: truncate && maxBytes !== undefined ? readBytes : Buffer.byteLength(content, 'utf8'),
    mtimeMs,
    endsWithNewline,
    ...(truncatedByBytes ? { truncatedByBytes: true } : {}),
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
  throwIfAborted(signal)
  const startOffset = Math.max(0, offset ?? 0)
  const limit = maxLines === undefined ? undefined : Math.max(0, maxLines)
  const truncate = options?.truncateOnByteLimit === true

  const initialStats = await stat(filePath)
  throwIfAborted(signal)
  if (initialStats.isDirectory()) {
    throw makeEisdirError(filePath)
  }

  const { handle, stats } = await openRegularFile(filePath, initialStats)
  try {
    throwIfAborted(signal)
    if (stats.isDirectory()) {
      throw makeEisdirError(filePath)
    }
    if (!truncate && maxBytes !== undefined && stats.size > maxBytes) {
      throw new FileTooLargeError(stats.size, maxBytes)
    }
    if (stats.size < FAST_PATH_MAX_BYTES) {
      let buffer: Buffer
      try {
        buffer = await handle.readFile(signal ? { signal } : {})
      } catch (error) {
        throwIfAborted(signal)
        throw error
      }
      throwIfAborted(signal)
      const text = decodeWhole(buffer)
      if (truncate && maxBytes !== undefined) {
        return fastPathTruncated(text, startOffset, limit, maxBytes, stats.mtimeMs, stats.size)
      }
      return fastPath(text, startOffset, limit, stats.mtimeMs, stats.size)
    }
    return await streamPath(handle, startOffset, limit, maxBytes, truncate, stats.mtimeMs, stats.size, signal)
  } finally {
    await handle.close().catch(passedOverAs(undefined))
  }
}
