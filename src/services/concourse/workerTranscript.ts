import { join } from 'node:path'
import { transcriptIo, transcriptLineBytes } from '../../utils/sessionStorage/transcriptBytes.js'
import { getProjectDir } from '../../utils/sessionStorage/paths.js'

export function workerTranscriptPath(rec: { sessionId: string; workspaceId: string }): string {
  return join(getProjectDir(rec.workspaceId), `${rec.sessionId}.jsonl`)
}

export interface TranscriptCursor {
  path: string
  offset: number
  carry: string
  partialStart?: number
}

export interface TranscriptReadResult {
  records: unknown[]
  cursor: TranscriptCursor
  rewound: boolean
  malformed: number
}

type Receive = (records: Iterable<unknown>, rewound: boolean) => void

export function openWorkerTranscript(path: string, receive?: Receive): TranscriptReadResult {
  return readAfterCursor({ path, offset: 0, carry: '' }, receive)
}

export function readAfterCursor(cursor: TranscriptCursor, receive?: Receive): TranscriptReadResult {
  const path = cursor.path
  const end = transcriptIo.statSync(path)?.size ?? 0
  const rewound = end < cursor.offset
  if (end === cursor.offset) return { records: [], cursor, rewound, malformed: 0 }
  const start = rewound ? 0 : cursor.partialStart ?? cursor.offset
  const next: TranscriptCursor = { path, offset: end, carry: '' }
  let malformed = 0
  function* decoded(): Generator<unknown> {
    let at = start
    for (const bytes of transcriptLineBytes(path, { start, end })) {
      const line = bytes.toString('utf8')
      if (bytes.at(-1) !== 0x0a) {
        next.partialStart = at
        next.carry = line
        break
      }
      at += bytes.length
      if (!line.trim()) continue
      let record: unknown
      try {
        record = JSON.parse(line)
      } catch {
        malformed++
        continue
      }
      yield record
    }
  }
  const records = receive === undefined ? [...decoded()] : []
  if (receive !== undefined) receive(decoded(), rewound)
  return { records, cursor: next, rewound, malformed }
}
