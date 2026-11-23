import { closeSync, openSync } from 'node:fs'
import { rangeFromFd } from '../../sessions/transcripts/transcriptBytes.js'
import { foldWorkerRecord } from '../../sessions/transcripts/mirrorRecord.js'
import { join } from 'node:path'
import { historyHead, historyLines, sealedExtents, historyIndex } from '../../sessions/transcripts/historyParts.js'
import { getProjectDir } from '../../sessions/transcripts/paths.js'

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

type Receive = (records: Iterable<unknown>, rewound: boolean, alreadyShed?: number) => void

export function openWorkerTranscript(path: string, receive?: Receive, cap?: number): TranscriptReadResult {
  return readAfterCursor({ path, offset: 0, carry: '' }, receive, cap)
}

export function readAfterCursor(cursor: TranscriptCursor, receive?: Receive, cap?: number): TranscriptReadResult {
  const path = cursor.path
  const head = historyHead(path)
  const end = head.before + head.end - head.start
  const rewound = end < cursor.offset
  if (end === cursor.offset) return { records: [], cursor, rewound, malformed: 0 }
  const start = rewound ? 0 : cursor.partialStart ?? cursor.offset
  const next: TranscriptCursor = { path, offset: end, carry: '' }
  let malformed = 0
  function* decoded(from = start): Generator<unknown> {
    let at = from
    for (const bytes of historyLines(path, from, end, head)) {
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
  if (receive && cap !== undefined && start === 0 && head.before) {
    const held = new Map<string, { record: unknown } | { path: string; at: number; len: number }>()
    const shed = new Set<string>()
    const keep = (id: string, row: NonNullable<ReturnType<typeof held.get>>): void => {
      if (shed.has(id)) return
      held.set(id, row)
      if (held.size <= cap) return
      const first = held.keys().next().value!
      held.delete(first)
      shed.add(first)
    }
    for (const part of sealedExtents(head)) {
      for (const [id, , at, len, uuid] of historyIndex(part)) {
        if (!id) malformed++
        if (uuid !== null) keep(uuid, { path: part.path, at, len })
      }
    }
    let n = 0
    for (const record of decoded(head.before)) {
      const uuid = foldWorkerRecord(record, `attach-e${n++}`)?.uuid
      if (uuid !== undefined) keep(uuid, { record })
    }
    function* selected(): Generator<unknown> {
      const files = new Map<string, number>()
      try {
        for (const row of held.values()) {
          if ('record' in row) { yield row.record; continue }
          let fd = files.get(row.path)
          if (fd === undefined) { fd = openSync(row.path, 'r'); files.set(row.path, fd) }
          const bytes = rangeFromFd(fd, row.at, row.at + row.len)
          if (bytes.length !== row.len) throw new Error(`History part changed: ${row.path}`)
          yield JSON.parse(bytes.toString('utf8'))
        }
      } finally { for (const fd of files.values()) closeSync(fd) }
    }
    receive(selected(), rewound, shed.size)
    return { records: [], cursor: next, rewound, malformed }
  }
  const records = receive === undefined ? [...decoded()] : []
  if (receive !== undefined) receive(decoded(), rewound)
  return { records, cursor: next, rewound, malformed }
}
