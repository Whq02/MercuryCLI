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
import { notBuilt } from '../../../pi/holes.js'

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
    return notBuilt('src/utils/sessionStorage/writer/remove.ts:57')
  }
}
