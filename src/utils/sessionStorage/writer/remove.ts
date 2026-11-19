import type { UUID } from 'crypto'
import {
  closeSync,
  fstatSync,
  ftruncateSync,
  openSync,
  readFileSync,
  readSync,
  writeFileSync,
  writeSync,
} from 'fs'
import { recordToEntry } from '../../../fabric/entryCodec.js'
import { logForDebugging } from '../../debug.js'
import { formatFileSize } from '../../format.js'
import { LITE_READ_BUF_SIZE } from '../../sessionStoragePortable.js'
import { jsonParse } from '../../slowOperations.js'
import type { QueuePart } from './queue.js'

const MAX_TOMBSTONE_REWRITE_BYTES = 50 * 1024 * 1024

function lineAround(tail: Buffer, matchIdx: number, matchLength: number, bytesRead: number, windowAtFileStart: boolean): { start: number; end: number } | null {
  const prevNl = tail.lastIndexOf(0x0a, matchIdx)
  if (prevNl < 0 && !windowAtFileStart) return null
  const nextNl = tail.indexOf(0x0a, matchIdx + matchLength)
  return { start: prevNl + 1, end: nextNl >= 0 ? nextNl + 1 : bytesRead }
}

function storedLineUuid(parsed: Record<string, unknown>): unknown {
  const envelope =
    typeof parsed.schemaVersion === 'number' &&
    typeof parsed.payload === 'object' &&
    parsed.payload !== null
  const entry = envelope ? recordToEntry(parsed as never) : parsed
  return entry.uuid
}

interface RemoveNeeds {
  trackWrite: QueuePart['trackWrite']
  serializeWrite: QueuePart['serializeWrite']
  _drainWriteQueueInner(): Promise<void>
}

export class RemovePart {
  constructor(
    private readonly project: { readonly sessionFile: string | null },
    private readonly needs: RemoveNeeds,
  ) {}

  async removeMessageByUuid(targetUuid: UUID): Promise<void> {
    return this.needs.trackWrite(() =>
      this.needs.serializeWrite(async () => {
        if (this.project.sessionFile === null) return
        await this.needs._drainWriteQueueInner()
        try {
          let fileSize = 0
          const fd = openSync(this.project.sessionFile, 'r+')
          try {
            const { size } = fstatSync(fd)
            fileSize = size
            if (size === 0) return

            const chunkLen = Math.min(size, LITE_READ_BUF_SIZE)
            const tailStart = size - chunkLen
            const buf = Buffer.allocUnsafe(chunkLen)
            const bytesRead = readSync(fd, buf, 0, chunkLen, tailStart)
            const tail = buf.subarray(0, bytesRead)

            const needle = `"uuid":"${targetUuid}"`
            const matchIdx = tail.lastIndexOf(needle)
            const line = matchIdx >= 0 ? lineAround(tail, matchIdx, needle.length, bytesRead, tailStart === 0) : null
            if (line) {
              const { start: lineStart, end: lineEnd } = line
              const absLineStart = tailStart + lineStart
              const afterLen = bytesRead - lineEnd
              ftruncateSync(fd, absLineStart)
              if (afterLen > 0) writeSync(fd, tail, lineEnd, afterLen, absLineStart)
              return
            }
          } finally {
            closeSync(fd)
          }

          if (fileSize > MAX_TOMBSTONE_REWRITE_BYTES) {
            logForDebugging(
              `The removed row's bytes stay in the session file: it is ${formatFileSize(fileSize)}, past the rewrite ceiling`,
              { level: 'warn' },
            )
            return
          }
          const content = readFileSync(this.project.sessionFile, { encoding: 'utf-8' })
          const lines = content.split('\n').filter((line: string) => {
            if (!line.trim()) return true
            try {
              return storedLineUuid(jsonParse(line)) !== targetUuid
            } catch {
              return true
            }
          })
          writeFileSync(this.project.sessionFile, lines.join('\n'), {
            encoding: 'utf8',
          })
        } catch {
        }
      }),
    )
  }
}
