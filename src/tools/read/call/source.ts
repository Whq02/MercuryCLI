import { closeSync, readSync } from 'node:fs'
import type { ToolUseContext } from '../../kit/tool.js'
import { ideReadTextAvailable, readRangeViaIde } from '../../../integrations/acp/ideToolBridge.js'
import { isRemotePath, markRemoteRead } from '../../../platform/remote-file-target/target.js'
import { FileTooLargeError, readFileInRange, type ReadFileRangeResult } from '../../../platform/files/readFileInRange.js'
import { openRegularFileSync } from '../regularFile.js'

export const UTF16_BE_REFUSAL =
  'File is UTF-16BE (big-endian BOM): reading it as text yields replacement characters, and the edit doors refuse its lossy decode. Convert it first (for example `iconv -f utf-16be -t utf-8`), or read it with a shell command.'

export function readsElsewhere(path: string): boolean {
  return isRemotePath(path) || ideReadTextAvailable()
}

export async function readRangeElsewhere(
  path: string,
  offset: number,
  maxLines: number | undefined,
  maxBytes: number | undefined,
  signal: AbortSignal,
): Promise<ReadFileRangeResult | null> {
  if (!isRemotePath(path)) return readRangeViaIde(path, offset, maxLines, maxBytes, signal)
  const { readRangeViaRemote } = await import('../../../platform/remote-files/bridge.js')
  const range = await readRangeViaRemote(path, offset, maxLines, maxBytes, signal)
  if (range.lead.startsWith('feff')) throw new Error(UTF16_BE_REFUSAL)
  return range
}

export function noteRemoteRead(context: ToolUseContext, path: string, whole = false): void {
  markRemoteRead(context.readFileState, path, whole)
}

export function realLineTotal(range: ReadFileRangeResult): number {
  if (range.endsWithNewline) return range.totalLines - 1
  return range.totalBytes === 0 ? 0 : range.totalLines
}

function phantomPieceInWindow(range: ReadFileRangeResult, lineOffset: number): boolean {
  return range.endsWithNewline && range.lineCount > 0 && lineOffset + range.lineCount === range.totalLines
}

export function shownWindow(range: ReadFileRangeResult, lineOffset: number): { content: string; count: number } {
  if (!phantomPieceInWindow(range, lineOffset)) return { content: range.content, count: range.lineCount }
  return { content: range.content.slice(0, -1), count: range.lineCount - 1 }
}

export async function countedSizeRefusal(refusal: FileTooLargeError, resolvedPath: string, signal: AbortSignal): Promise<Error> {
  try {
    const counted = await readFileInRange(resolvedPath, 0, 0, undefined, signal)
    return new FileTooLargeError(refusal.sizeInBytes, refusal.maxSizeBytes, realLineTotal(counted))
  } catch {
    return refusal
  }
}

export function readTailLinesReverse(
  resolvedPath: string,
  tailCount: number,
  maxLines?: number,
): ReadFileRangeResult {
  const { fd, stats: st } = openRegularFileSync(resolvedPath)
  try {
    const totalBytes = st.size
    const mtimeMs = st.mtimeMs
    if (totalBytes === 0) {
      return {
        content: '',
        lineCount: 1,
        totalLines: 1,
        totalBytes: 0,
        readBytes: 0,
        mtimeMs,
        endsWithNewline: false,
      }
    }
    const chunkSize = 65536
    const chunks: Buffer[] = []
    let pos = totalBytes
    let newlinesSeen = 0
    const neededNewlines = tailCount + 1
    const maxBackwardBytes = Math.min(totalBytes, Math.max(256 * 1024, tailCount * 4096))
    const minPos = totalBytes - maxBackwardBytes
    while (pos > minPos && newlinesSeen <= neededNewlines) {
      const readLen = Math.min(chunkSize, pos - minPos)
      pos -= readLen
      const buf = Buffer.alloc(readLen)
      const got = readSync(fd, buf, 0, readLen, pos)
      const slice = got < readLen ? buf.subarray(0, got) : buf
      for (let i = slice.length - 1; i >= 0; i--) {
        if (slice[i] === 0x0a) newlinesSeen++
      }
      chunks.unshift(slice)
    }
    const tailBuf = Buffer.concat(chunks)
    let text = tailBuf.toString('utf8')
    if (pos === 0 && text.charCodeAt(0) === 0xfeff) text = text.slice(1)
    const endsWithNewline = text.endsWith('\n')
    const rawLines = text.split('\n').map(l => (l.endsWith('\r') ? l.slice(0, -1) : l))
    const completeLines = pos > 0 ? rawLines.slice(1) : rawLines
    const realLines = endsWithNewline ? completeLines.slice(0, -1) : completeLines
    let totalRealLines = realLines.length
    if (pos > 0) {
      const avgLineBytes = Math.max(1, Math.floor(tailBuf.length / Math.max(1, realLines.length)))
      const estimatedPrior = Math.max(1, Math.round(pos / avgLineBytes))
      totalRealLines = estimatedPrior + realLines.length
    }
    const startIdx = Math.max(0, realLines.length - tailCount)
    const count = maxLines !== undefined ? Math.min(maxLines, tailCount) : tailCount
    const selected = realLines.slice(startIdx, startIdx + count)
    const content = selected.join('\n')
    const totalLines = endsWithNewline ? totalRealLines + 1 : Math.max(1, totalRealLines)
    const takesToEnd = startIdx + selected.length >= realLines.length
    return {
      content: takesToEnd && endsWithNewline ? `${content}\n` : content,
      lineCount: takesToEnd && endsWithNewline ? selected.length + 1 : selected.length,
      totalLines,
      totalBytes,
      readBytes: Buffer.byteLength(content),
      mtimeMs,
      endsWithNewline,
    }
  } finally {
    closeSync(fd)
  }
}

export function inMemoryRangeSlice(
  fullText: string,
  lineOffset: number,
  maxLines: number,
  mtimeMs: number,
  totalBytes: number,
): ReadFileRangeResult {
  const normalized = fullText.replace(/\r\n/g, '\n')
  const lines = normalized.split('\n')
  const totalLines = lines.length
  const end = Math.min(lineOffset + maxLines, totalLines)
  const selected = lines.slice(lineOffset, Math.max(end, lineOffset))
  const content = selected.join('\n')
  return {
    content,
    lineCount: selected.length,
    totalLines,
    totalBytes,
    readBytes: Buffer.byteLength(content),
    mtimeMs,
    endsWithNewline: normalized.endsWith('\n'),
  }
}
