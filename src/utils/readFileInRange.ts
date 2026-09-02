import { open, readFile, stat } from 'node:fs/promises'

import { formatFileSize } from './format.js'

/**
 * Line-range file reading with a fast in-memory path (regular files under
 * 10 MB — a single read plus split beats a stream by about half the wall
 * time) and a bounded streaming path for everything else.
 *
 * Line accounting: the text after the last line feed is ALWAYS a line, even
 * when empty — the total is exactly one greater than the line-feed count,
 * and a file ending in a line feed has an extra empty last line which is
 * SELECTED when in range. The file-read tool's totals and offsets are
 * calibrated to this.
 */

export type ReadFileRangeResult = {
  content: string
  lineCount: number
  totalLines: number
  totalBytes: number
  readBytes: number
  mtimeMs: number
  truncatedByBytes?: boolean
}

export class FileTooLargeError extends Error {
  readonly sizeInBytes: number
  readonly maxSizeBytes: number

  constructor(sizeInBytes: number, maxSizeBytes: number) {
    super(
      `File content (${formatFileSize(sizeInBytes)}) exceeds the maximum allowed size (${formatFileSize(maxSizeBytes)}). ` +
        `Use offset and limit to read portions of the file, or search for content instead of reading the whole file.`,
    )
    this.name = 'FileTooLargeError'
    this.sizeInBytes = sizeInBytes
    this.maxSizeBytes = maxSizeBytes
  }
}

const FAST_PATH_MAX_BYTES = 10 * 1024 * 1024
const STREAM_BUFFER_SIZE = 512 * 1024

type RangeOptions = { truncateOnByteLimit?: boolean }

function stripBom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text
}

/**
 * The decode is chosen by the byte-order mark, the way the edit-side read
 * (fileRead.detectEncodingForResolvedPath) already chooses it: FF FE ⇒
 * UTF-16LE, anything else ⇒ UTF-8. This reader decoded every file as UTF-8,
 * so a UTF-16LE file came back as NUL-laced mojibake and an Edit built from
 * what Read returned was refused (TASK-014 w4-f02-01); two sinks, one law.
 */
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
  }
}

export async function readFileInRange(
  filePath: string,
  offset: number = 0,
  maxLines?: number,
  maxBytes?: number,
  signal?: AbortSignal,
  options: RangeOptions = {},
): Promise<ReadFileRangeResult> {
  if (signal?.aborted) throw signal.reason instanceof Error ? signal.reason : new Error('Read aborted')
  const truncateMode = options.truncateOnByteLimit === true
  const stats = await stat(filePath)
  if (stats.isDirectory()) {
    throw new Error(`EISDIR: illegal operation on a directory, read '${filePath}'`)
  }
  if (stats.isFile() && stats.size < FAST_PATH_MAX_BYTES) {
    // Throwing mode guards entirely by the pre-read stat; the fast path
    // passes no limit downstream and can never truncate.
    if (!truncateMode && maxBytes !== undefined && stats.size > maxBytes) {
      throw new FileTooLargeError(stats.size, maxBytes)
    }
    const text = decodeWhole(await readFile(filePath, signal ? { signal } : {}))
    if (truncateMode && maxBytes !== undefined) {
      return truncateSelect(stripBom(text).split('\n'), offset, maxLines, maxBytes, stats.mtimeMs, stats.size)
    }
    return fastPath(text, offset, maxLines, stats.mtimeMs, stats.size)
  }
  return streamingPath(filePath, offset, maxLines, maxBytes, signal, truncateMode, stats.size)
}

/** Truncate mode over an already-split line list (fast path). */
function truncateSelect(
  lines: string[],
  offset: number,
  maxLines: number | undefined,
  maxBytes: number,
  mtimeMs: number,
  totalBytes: number,
): ReadFileRangeResult {
  const totalLines = lines.length
  const end = maxLines === undefined ? totalLines : Math.min(offset + maxLines, totalLines)
  const selected: string[] = []
  let used = 0
  let truncated = false
  for (let index = offset; index < end; index++) {
    const line = normalizeLine(lines[index] as string)
    const cost = Buffer.byteLength(line) + (selected.length > 0 ? 1 : 0)
    if (used + cost > maxBytes) {
      truncated = true
      break
    }
    selected.push(line)
    used += cost
  }
  const content = selected.join('\n')
  return {
    content,
    lineCount: selected.length,
    totalLines,
    totalBytes,
    readBytes: Buffer.byteLength(content),
    mtimeMs,
    ...(truncated ? { truncatedByBytes: true } : {}),
  }
}

async function streamingPath(
  filePath: string,
  offset: number,
  maxLines: number | undefined,
  maxBytes: number | undefined,
  signal: AbortSignal | undefined,
  truncateMode: boolean,
  statSizeBytes?: number,
): Promise<ReadFileRangeResult> {
  const handle = await open(filePath, 'r')
  // The time comes from the already-open descriptor — no second open; a stat
  // failure yields 0 rather than failing the read.
  const mtimePromise = handle
    .stat()
    .then(stats => stats.mtimeMs)
    .catch(() => 0)
  // Two bytes through the same descriptor decide the stream's decode.
  const lead = Buffer.alloc(2)
  const { bytesRead: leadRead } = await handle.read(lead, 0, 2, 0)
  const encoding = encodingForLeadingBytes(leadRead > 0 ? lead[0] : undefined, leadRead > 1 ? lead[1] : undefined)
  const stream = handle.createReadStream({
    highWaterMark: STREAM_BUFFER_SIZE,
    encoding,
    autoClose: true,
    ...(signal ? { signal } : {}),
  } as Parameters<typeof handle.createReadStream>[0])

  const end = maxLines === undefined ? Infinity : offset + maxLines
  return new Promise<ReadFileRangeResult>((resolve, reject) => {
    const selected: string[] = []
    let selectedBytes = 0
    let lineIndex = 0
    let carried = ''
    let first = true
    let streamedBytes = 0
    let truncated = false
    let budgetLeft = truncateMode && maxBytes !== undefined ? maxBytes : Infinity

    const fail = (err: unknown): void => {
      stream.destroy(err instanceof Error ? err : new Error(String(err)))
    }

    const acceptLine = (rawLine: string): void => {
      if (lineIndex >= offset && lineIndex < end && !truncated) {
        const line = normalizeLine(rawLine)
        const cost = Buffer.byteLength(line) + (selected.length > 0 ? 1 : 0)
        if (cost <= budgetLeft) {
          selected.push(line)
          selectedBytes += cost
          budgetLeft -= cost
        } else if (truncateMode) {
          truncated = true
        }
      }
      lineIndex++
    }

    stream.on('data', (chunk: string | Buffer) => {
      let text = typeof chunk === 'string' ? chunk : chunk.toString(encoding)
      streamedBytes += Buffer.byteLength(text)
      if (!truncateMode && maxBytes !== undefined && streamedBytes > maxBytes) {
        // The REAL size when the pre-read stat carried it (regular
        // files always do here) — the streamed watermark alone made every
        // oversized file report roughly the same wrong figure (~one chunk
        // past the cap); the watermark stays the fallback for statless
        // streams.
        fail(new FileTooLargeError(statSizeBytes ?? streamedBytes, maxBytes))
        return
      }
      if (first) {
        text = stripBom(text)
        first = false
      }
      carried += text
      for (;;) {
        const newline = carried.indexOf('\n')
        if (newline === -1) break
        acceptLine(carried.slice(0, newline))
        carried = carried.slice(newline + 1)
      }
      // Never retain content for out-of-range lines: with no line break in
      // sight, a fragment we can never select must not accumulate.
      if (carried.length > 0) {
        const inRange = lineIndex >= offset && lineIndex < end && !truncated
        if (!inRange) {
          // Keep nothing but the knowledge that the line continues; an empty
          // carry still terminates the current line correctly at the next \n.
          carried = ''
        } else if (truncateMode && Buffer.byteLength(carried) + (selected.length > 0 ? 1 : 0) > budgetLeft) {
          // A single line spanning many chunks must not grow unboundedly.
          truncated = true
          carried = ''
        }
      }
    })
    stream.on('error', err => reject(err))
    stream.on('end', () => {
      // The text after the last line feed is always a final line.
      acceptLine(carried)
      const content = selected.join('\n')
      void mtimePromise.then(mtimeMs => {
        resolve({
          content,
          lineCount: selected.length,
          totalLines: lineIndex,
          totalBytes: streamedBytes,
          readBytes: selectedBytes,
          mtimeMs,
          ...(truncated ? { truncatedByBytes: true } : {}),
        })
      })
    })
  })
}
