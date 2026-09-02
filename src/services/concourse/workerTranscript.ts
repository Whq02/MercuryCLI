import { openSync, closeSync, readSync, statSync } from 'node:fs'
import { join } from 'node:path'
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
  let size: number
  try {
    size = statSync(cursor.path).size
  } catch {
    return { records: [], cursor: { path: cursor.path, offset: 0, carry: '' }, rewound: cursor.offset > 0, malformed: 0 }
  }
  let from = cursor.offset
  let carry = cursor.carry
  let rewound = false
  if (size < cursor.offset) {
    from = 0
    carry = ''
    rewound = true
  }
  if (size === from) {
    return { records: [], cursor: { path: cursor.path, offset: from, carry }, rewound, malformed: 0 }
  }
  const fd = openSync(cursor.path, 'r')
  let text: string
  try {
    const buf = Buffer.alloc(size - from)
    const n = readSync(fd, buf, 0, buf.length, from)
    text = buf.subarray(0, n).toString('utf8')
  } finally {
    closeSync(fd)
  }
  const combined = carry + text
  const lastNewline = combined.lastIndexOf('\n')
  const complete = lastNewline === -1 ? '' : combined.slice(0, lastNewline)
  const nextCarry = lastNewline === -1 ? combined : combined.slice(lastNewline + 1)
  const records: unknown[] = []
  let malformed = 0
  for (const rawLine of complete.split('\n')) {
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
    cursor: { path: cursor.path, offset: size, carry: nextCarry },
    rewound,
    malformed,
  }
}
