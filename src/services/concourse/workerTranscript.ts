// ============================================================================
//  services/concourse/workerTranscript — the renderer's
// READ-ONLY worker-transcript projection (handoff, F-28).
//
//  THE NO-ADOPTION LAW, mechanized: entering a live worker's full session
//  NEVER rides the REPL switch machinery (that re-points the session file
//  pointer — the cross-process corruption class the resume guard refuses).
//  Instead the renderer opens the worker's transcript READ-ONLY and folds
//  records through a byte cursor: first paint reads history once; every
//  re-attach folds ONLY records after the cursor, exactly once.
//  The worker keeps appending regardless of what is on screen.
//
//  Torn-tail law (the resumeSnapshot O(tail) discipline): the worker's
//  in-flight append can leave a partial last line — it is CARRIED, never
//  parsed, never dropped; the next read completes it. A shrunken file
//  (replaced transcript) rewinds honestly to a full refold with a flag —
//  never a silent half-view. The snapshot fast-paint integration for big
// transcripts joins the performance slice against the budgets
//  (recorded); the cursor contract here is what it composes onto.
// ============================================================================
import { join } from 'node:path'
// THE ONE READER: the suffix read, the torn-tail carry and the shrink
// rewind are the transcript reader's byte-cursor contract; this module
// keeps the mirror family's record shape over it.
import { readTranscriptBytesAfter } from '../../utils/sessionStorage/transcriptReader.js'
// THE WRITER'S OWN derivation: the -p worker
// writes its transcript under sessionStorage/paths.ts getProjectDir — a
// plain sanitize join. The portable module exports a SAME-NAMED variant
// that prefers a hashed slug and probes existence (memoized): on a FRESH
// session it resolves a directory the worker never creates, so the attach
// watched an empty path forever. One writer, one derivation — the reader
// imports the writer's.
import { getProjectDir } from '../../utils/sessionStorage/paths.js'

/**
 * The transcript path for a WORKER's session — derived from the worker's
 * canonical workspace (the supervisor record), never from this process's
 * originalCwd (paths.ts's other-session caveat: the caller must supply the
 * right project home; identical sessionIds in different workspaces resolve
 * to distinct files by construction).
 */
export function workerTranscriptPath(rec: { sessionId: string; workspaceId: string }): string {
  return join(getProjectDir(rec.workspaceId), `${rec.sessionId}.jsonl`)
}

export interface TranscriptCursor {
  path: string
  /** Byte offset of the first UNREAD byte (complete-line boundary + carry). */
  offset: number
  /** The torn tail carried from the last read (never parsed, never lost). */
  carry: string
}

export interface TranscriptReadResult {
  records: unknown[]
  cursor: TranscriptCursor
  /** True when the file SHRANK under the cursor (replaced transcript) — the
   *  read rewound to a full refold; the consumer repaints from scratch. */
  rewound: boolean
  /** Complete lines that failed to parse (fail-soft, counted honestly). */
  malformed: number
}

/** Open a worker transcript at its beginning (the first-paint read). */
export function openWorkerTranscript(path: string): TranscriptReadResult {
  return readAfterCursor({ path, offset: 0, carry: '' })
}

/**
 * Fold every record appended after the cursor, exactly once. Reads only the
 * suffix bytes (O(tail)); a missing file answers empty at offset 0 (the
 * worker may not have written yet — honest, not an error).
 */
export function readAfterCursor(cursor: TranscriptCursor): TranscriptReadResult {
  // A missing file answers empty at offset 0; a file that shrank under the
  // cursor rewinds to a full refold with the flag; an unterminated last
  // line rides the carry — all the reader's byte-cursor contract.
  const bytes = readTranscriptBytesAfter(cursor.path, { offset: cursor.offset, carry: cursor.carry })
  const records: unknown[] = []
  let malformed = 0
  for (const rawLine of bytes.text.split('\n')) {
    // CRLF hardening: a Windows-side writer's
    // \r tail must not turn every record into 'malformed'.
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
