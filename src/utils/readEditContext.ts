import { open, type FileHandle } from 'node:fs/promises'

import { isENOENT } from './errors.js'

export const CHUNK_SIZE = 8 * 1024

const MAX_SCAN_BYTES = 10 * 1024 * 1024
const MAX_READ_BYTES = 10 * 1024 * 1024

type EditContext = {
  content: string
  lineOffset: number
  truncated: boolean
}

export async function openForScan(path: string): Promise<FileHandle | null> {
  try {
    return await open(path, 'r')
  } catch (error) {
    if (isENOENT(error)) return null
    return null
  }
}

export async function scanForContext(handle: FileHandle, needle: string, contextLines: number): Promise<EditContext> {
  if (needle.length === 0) return { content: '', lineOffset: 1, truncated: false }
  const needleBuf = Buffer.from(needle, 'utf8')
  const safeContext = Math.max(0, contextLines)
  const keepNewlines = safeContext + 1
  const recentNewlines: number[] = []
  let totalNewlines = 0
  let position = 0
  let carry = Buffer.alloc(0)
  let matchByte = -1
  let truncated = false
  const readChunkSize = Math.max(CHUNK_SIZE, needleBuf.length)
  const readBuf = Buffer.allocUnsafe(readChunkSize)

  while (position < MAX_SCAN_BYTES) {
    const remaining = MAX_SCAN_BYTES - position
    const toRead = Math.min(readChunkSize, remaining)
    const { bytesRead } = await handle.read(readBuf, 0, toRead, position)
    if (bytesRead === 0) break
    const chunk = readBuf.subarray(0, bytesRead)
    const buf = carry.length > 0 ? Buffer.concat([carry, chunk]) : chunk
    const bufStart = position - carry.length
    const idx = buf.indexOf(needleBuf)
    if (idx !== -1) {
      matchByte = bufStart + idx
      for (let i = 0; i < idx; i++) {
        if (buf[i] === 10) {
          totalNewlines++
          recentNewlines.push(bufStart + i)
          if (recentNewlines.length > keepNewlines) recentNewlines.shift()
        }
      }
      break
    }
    const keepLen = Math.min(buf.length, Math.max(0, needleBuf.length - 1))
    const advance = buf.length - keepLen
    for (let i = 0; i < advance; i++) {
      if (buf[i] === 10) {
        totalNewlines++
        recentNewlines.push(bufStart + i)
        if (recentNewlines.length > keepNewlines) recentNewlines.shift()
      }
    }
    carry = keepLen > 0 ? Buffer.from(buf.subarray(advance)) : Buffer.alloc(0)
    position += bytesRead
  }

  if (matchByte === -1) {
    if (position >= MAX_SCAN_BYTES) {
      const probe = Buffer.allocUnsafe(1)
      const { bytesRead } = await handle.read(probe, 0, 1, position)
      if (bytesRead > 0) truncated = true
    }
    return { content: '', lineOffset: 1, truncated }
  }

  const matchLine = totalNewlines + 1
  const lineOffset = Math.max(1, matchLine - safeContext)
  const windowStartByte = totalNewlines <= safeContext ? 0 : (recentNewlines[0] ?? 0) + 1
  const matchEndByte = matchByte + needleBuf.length
  const neededAfter = needle.endsWith('\n') ? safeContext : safeContext + 1

  let windowEndByte = matchEndByte
  if (neededAfter > 0) {
    let seenAfter = 0
    let scanPos = matchEndByte
    const afterCap = matchEndByte + MAX_READ_BYTES
    while (scanPos < afterCap && seenAfter < neededAfter) {
      const toRead = Math.min(CHUNK_SIZE, afterCap - scanPos)
      const { bytesRead } = await handle.read(readBuf, 0, toRead, scanPos)
      if (bytesRead === 0) break
      for (let i = 0; i < bytesRead; i++) {
        if (readBuf[i] === 10) {
          seenAfter++
          if (seenAfter === neededAfter) {
            windowEndByte = scanPos + i
            break
          }
        }
      }
      if (seenAfter < neededAfter) {
        scanPos += bytesRead
        windowEndByte = scanPos
      }
    }
  }

  const rawSpan = windowEndByte - windowStartByte
  if (rawSpan > MAX_READ_BYTES) return { content: '', lineOffset: 1, truncated: true }
  const outBuf = Buffer.allocUnsafe(rawSpan)
  let collected = 0
  while (collected < rawSpan) {
    const { bytesRead } = await handle.read(outBuf, collected, rawSpan - collected, windowStartByte + collected)
    if (bytesRead === 0) break
    collected += bytesRead
  }
  const decoded = outBuf.subarray(0, collected).toString('utf8')
  const content = decoded.slice(0, bytesToChars(decoded, collected))
  return { content, lineOffset, truncated: false }
}

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

export async function readCapped(handle: FileHandle): Promise<string | null> {
  const info = await handle.stat()
  if (info.size > MAX_READ_BYTES) return null
  const chunks: Buffer[] = []
  let total = 0
  let position = 0
  const buffer = Buffer.allocUnsafe(CHUNK_SIZE)
  while (true) {
    const { bytesRead } = await handle.read(buffer, 0, CHUNK_SIZE, position)
    if (bytesRead === 0) break
    total += bytesRead
    if (total > MAX_READ_BYTES) return null
    chunks.push(Buffer.from(buffer.subarray(0, bytesRead)))
    position += bytesRead
  }
  return Buffer.concat(chunks, total).toString('utf8')
}
