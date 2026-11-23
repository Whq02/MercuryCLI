import { historyHead } from '../historyParts.js'
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
import type { MercuryRecord } from '../../../fabric/record.js'
import { logForDebugging } from '../../debug.js'
import { getErrnoCode } from '../../errors.js'
import { formatFileSize } from '../../format.js'
import { LITE_READ_BUF_SIZE } from '../../sessionStoragePortable.js'
import { jsonParse } from '../../slowOperations.js'
import type { QueuePart } from './queue.js'
import { passedOver } from '../../passedOver.js'

const MAX_REWRITE_BYTES = 50 * 1024 * 1024

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isMercuryRecord(parsed: Record<string, unknown>): parsed is MercuryRecord {
  return (
    typeof parsed.schemaVersion === 'number' &&
    typeof parsed.payload === 'object' &&
    parsed.payload !== null
  )
}

function storedLineUuid(parsed: Record<string, unknown>): unknown {
  const entry = isMercuryRecord(parsed) ? recordToEntry(parsed) : parsed
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
        const sessionFile = this.project.sessionFile
        if (sessionFile === null) return
        await this.needs._drainWriteQueueInner()
        try {
          const header = historyHead(sessionFile)
          let fileSize = 0
          const fd = openSync(sessionFile, 'r+')
          try {
            fileSize = fstatSync(fd).size
            if (fileSize === 0 || fileSize <= header.start) return
            const readLen = Math.min(fileSize - header.start, LITE_READ_BUF_SIZE)
            const readStart = fileSize - readLen
            const buf = Buffer.allocUnsafe(readLen)
            let totalRead = 0
            while (totalRead < readLen) {
              const n = readSync(fd, buf, totalRead, readLen - totalRead, readStart + totalRead)
              if (n === 0) break
              totalRead += n
            }
            const view = totalRead < readLen ? buf.subarray(0, totalRead) : buf
            const needle = Buffer.from(`"uuid":"${targetUuid}"`, 'utf8')
            const hit = view.lastIndexOf(needle)
            if (hit !== -1) {
              const prevNl = hit > 0 ? view.lastIndexOf(0x0a, hit - 1) : -1
              const lineStartInBuf =
                prevNl !== -1 ? prevNl + 1 : readStart === 0 || readStart === header.start ? 0 : -1
              if (lineStartInBuf !== -1) {
                const absLineStart = readStart + lineStartInBuf
                if (absLineStart >= header.start) {
                  const nextNl = view.indexOf(0x0a, hit + needle.length)
                  const trailing = nextNl !== -1 ? view.subarray(nextNl + 1) : null
                  ftruncateSync(fd, absLineStart)
                  if (trailing !== null && trailing.length > 0) {
                    let written = 0
                    while (written < trailing.length) {
                      written += writeSync(fd, trailing, written, trailing.length - written, absLineStart + written)
                    }
                  }
                  return
                }
              }
            }
          } finally {
            closeSync(fd)
          }

          if (fileSize > MAX_REWRITE_BYTES) {
            logForDebugging(
              `The removed row's bytes stay in the session file: it is ${formatFileSize(fileSize)}, past the rewrite ceiling`,
              { level: 'warn' },
            )
            return
          }

          const raw = readFileSync(sessionFile)
          const prefix = header.start > 0 ? raw.subarray(0, header.start) : Buffer.alloc(0)
          const body = raw.subarray(header.start).toString('utf8')
          const kept = body.split('\n').filter(line => {
            if (line.length === 0) return true
            try {
              const parsed: unknown = jsonParse(line)
              if (!isRecord(parsed)) return true
              return storedLineUuid(parsed) !== targetUuid
            } catch (error) {
              passedOver(error)
              return true
            }
          })
          const nextBody = Buffer.from(kept.join('\n'), 'utf8')
          writeFileSync(sessionFile, prefix.length > 0 ? Buffer.concat([prefix, nextBody]) : nextBody)
        } catch (error) {
          const code = getErrnoCode(error)
          if (code === 'ENOENT' || code === 'ENOTDIR') return
          throw error
        }
      }),
    )
  }
}
