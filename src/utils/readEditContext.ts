import { open, type FileHandle } from 'node:fs/promises'

import { isENOENT } from './errors.js'

/**
 * Streaming needle search returning a line-aligned context window, plus a
 * capped whole-file read over a caller-owned handle.
 */

export const CHUNK_SIZE = 8 * 1024
export const MAX_SCAN_BYTES = 10 * 1024 * 1024

export type EditContext = {
  content: string
  /** 1-based line number of the slice's first line in the original file. */
  lineOffset: number
  truncated: boolean
}

function countNewlines(text: string): number {
  let count = 0
  for (let index = 0; index < text.length; index++) {
    if (text.charCodeAt(index) === 10) count++
  }
  return count
}

/** Returns nothing on a missing file; the caller closes. */
export async function openForScan(path: string): Promise<FileHandle | null> {
  try {
    return await open(path, 'r')
  } catch (err) {
    if (isENOENT(err)) return null
    throw err
  }
}

/**
 * Chunked scan at 8 KB with a straddle overlap sized for the LONGER needle
 * form; the CRLF form is materialised and searched only when the LF form
 * missed and the needle contains newlines. Both context walks are bounded to
 * one chunk — a match surrounded by very long lines yields less context than
 * requested rather than growing the read (behaviour, not optimisation).
 */
export async function scanForContext(handle: FileHandle, needle: string, contextLines: number): Promise<EditContext> {
  if (needle === '') return { content: '', lineOffset: 1, truncated: false }
  const needleLf = needle
  const needleCr = needle.includes('\n') ? needle.replace(/\n/g, '\r\n') : null
  const overlap = Buffer.byteLength(needleCr ?? needleLf)

  let position = 0
  let scanned = 0
  let newlinesBefore = 0
  let window = ''
  let windowStartByte = 0
  const buffer = Buffer.allocUnsafe(CHUNK_SIZE)

  const findInWindow = (): { index: number; length: number } | null => {
    const lfIndex = window.indexOf(needleLf)
    if (lfIndex !== -1) return { index: lfIndex, length: needleLf.length }
    if (needleCr) {
      const crIndex = window.indexOf(needleCr)
      if (crIndex !== -1) return { index: crIndex, length: needleCr.length }
    }
    return null
  }

  for (;;) {
    if (scanned >= MAX_SCAN_BYTES) return { content: '', lineOffset: 1, truncated: true }
    const { bytesRead } = await handle.read(buffer, 0, CHUNK_SIZE, position)
    if (bytesRead === 0) {
      // Ran out of file inside the cap: an empty slice WITHOUT the flag.
      return { content: '', lineOffset: 1, truncated: false }
    }
    position += bytesRead
    scanned += bytesRead
    window += buffer.toString('utf8', 0, bytesRead)

    const match = findInWindow()
    if (match) {
      const matchByteStart = windowStartByte + Buffer.byteLength(window.slice(0, match.index))
      const matchByteEnd = matchByteStart + Buffer.byteLength(window.slice(match.index, match.index + match.length))

      // Backward: one more newline than the context count; that final
      // newline is NOT included, so the slice begins at the first byte of
      // the earliest context line. Bounded to one chunk before the match.
      const backStart = Math.max(0, matchByteStart - CHUNK_SIZE)
      const backLength = matchByteStart - backStart
      const backBuffer = Buffer.allocUnsafe(backLength)
      if (backLength > 0) await handle.read(backBuffer, 0, backLength, backStart)
      const backText = backBuffer.toString('utf8', 0, backLength)
      let sliceStartByte = backStart
      {
        let seen = 0
        let index = backText.length - 1
        for (; index >= 0; index--) {
          if (backText.charCodeAt(index) === 10) {
            seen++
            if (seen > contextLines) break
          }
        }
        if (index >= 0) {
          sliceStartByte = backStart + Buffer.byteLength(backText.slice(0, index + 1))
        } else if (backStart > 0) {
          sliceStartByte = backStart
        } else {
          sliceStartByte = 0
        }
      }

      // Forward: one more than the trailing count, that last newline BEING
      // included. Bounded to one chunk after the match end.
      const forwardBuffer = Buffer.allocUnsafe(CHUNK_SIZE)
      const { bytesRead: forwardRead } = await handle.read(forwardBuffer, 0, CHUNK_SIZE, matchByteEnd)
      const forwardText = forwardBuffer.toString('utf8', 0, forwardRead)
      let sliceEndByte = matchByteEnd + Buffer.byteLength(forwardText)
      {
        let seen = 0
        for (let index = 0; index < forwardText.length; index++) {
          if (forwardText.charCodeAt(index) === 10) {
            seen++
            if (seen > contextLines) {
              sliceEndByte = matchByteEnd + Buffer.byteLength(forwardText.slice(0, index + 1))
              break
            }
          }
        }
      }

      // One positional read of exactly the slice range.
      const sliceLength = sliceEndByte - sliceStartByte
      const sliceBuffer = sliceLength <= CHUNK_SIZE ? buffer : Buffer.allocUnsafe(sliceLength)
      const { bytesRead: sliceRead } = await handle.read(sliceBuffer, 0, sliceLength, sliceStartByte)
      let content = sliceBuffer.toString('utf8', 0, sliceRead)
      // Normalise CRLF only when a carriage return is actually present.
      if (content.includes('\r')) content = content.replace(/\r\n/g, '\n')

      // Newlines before the slice start, without double-counting the
      // straddle: newlines in [0, windowStart) are the discarded count;
      // newlines in [windowStart, matchStart) are counted over the window
      // prefix; newlines in [sliceStart, matchStart) — counted over the
      // backward read's tail — are then subtracted.
      const newlinesToMatch = newlinesBefore + countNewlines(window.slice(0, match.index))
      const backTailChars = bytesToChars(backText, sliceStartByte - backStart)
      const newlinesSliceToMatch = countNewlines(backText.slice(backTailChars))
      const lineOffset = 1 + newlinesToMatch - newlinesSliceToMatch
      return { content, lineOffset, truncated: false }
    }

    // Shift the straddle window, counting newlines in the discarded bytes
    // exactly once.
    if (window.length > overlap) {
      const keepChars = charsForTailBytes(window, overlap)
      const discard = window.slice(0, window.length - keepChars)
      newlinesBefore += countNewlines(discard)
      windowStartByte += Buffer.byteLength(discard)
      window = window.slice(window.length - keepChars)
    }
  }
}

/** Chars corresponding to the first `bytes` bytes of `text` (ASCII-safe approximation refined by scan). */
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

/** Chars in `text`'s tail covering `bytes` bytes. */
function charsForTailBytes(text: string, bytes: number): number {
  let count = 0
  let index = text.length
  while (index > 0 && count < bytes) {
    const code = text.codePointAt(index - 1) as number
    const width = code < 0x80 ? 1 : code < 0x800 ? 2 : code < 0x10000 ? 3 : 4
    count += width
    index -= 1
  }
  return text.length - index
}

/** The convenience entry: opens, scans, closes. Nothing on a missing file. */
export async function readEditContext(path: string, needle: string, contextLines: number = 3): Promise<EditContext | null> {
  const handle = await openForScan(path)
  if (!handle) return null
  try {
    return await scanForContext(handle, needle, contextLines)
  } finally {
    await handle.close()
  }
}

/**
 * The whole file through a caller-owned handle, up to the 10 MB cap
 * (nothing past it), CR-normalised; one doubling buffer, so growth is
 * logarithmic.
 */
export async function readCapped(handle: FileHandle): Promise<string | null> {
  let buffer = Buffer.allocUnsafe(CHUNK_SIZE)
  let total = 0
  for (;;) {
    if (total + CHUNK_SIZE > buffer.length) {
      const grown = Buffer.allocUnsafe(Math.min(buffer.length * 2, MAX_SCAN_BYTES + CHUNK_SIZE))
      buffer.copy(grown, 0, 0, total)
      buffer = grown
    }
    const { bytesRead } = await handle.read(buffer, total, CHUNK_SIZE, total)
    if (bytesRead === 0) break
    total += bytesRead
    if (total > MAX_SCAN_BYTES) return null
  }
  let content = buffer.toString('utf8', 0, total)
  if (content.includes('\r')) content = content.replace(/\r\n/g, '\n')
  return content
}
