import { join } from 'node:path'
import { readTranscriptBytesAfter } from '../../utils/sessionStorage/transcriptReader.js'
import { getProjectDir } from '../../utils/sessionStorage/paths.js'

export function workerTranscriptPath(rec: { sessionId: string; workspaceId: string }): string {
  return join(getProjectDir(rec.workspaceId), `${rec.sessionId}.jsonl`)
}

export interface TranscriptCursor {
  path: string
  offset: number
  carry: string
}

export interface TranscriptReadResult {
  records: unknown[]
  cursor: TranscriptCursor
  rewound: boolean
  malformed: number
}

export function openWorkerTranscript(path: string): TranscriptReadResult {
  return readAfterCursor({ path, offset: 0, carry: '' })
}

export function readAfterCursor(cursor: TranscriptCursor): TranscriptReadResult {
  const bytes = readTranscriptBytesAfter(cursor.path, { offset: cursor.offset, carry: cursor.carry })
  const records: unknown[] = []
  let malformed = 0
  for (const rawLine of bytes.text.split('\n')) {
    const line = rawLine.replace(/\r$/, '')
    if (!line.trim()) continue
    try {
      records.push(JSON.parse(line))
    } catch {
      malformed++
    }
  }
  return {
    records,
    cursor: { path: cursor.path, offset: bytes.cursor.offset, carry: bytes.cursor.carry },
    rewound: bytes.rewound,
    malformed,
  }
}
