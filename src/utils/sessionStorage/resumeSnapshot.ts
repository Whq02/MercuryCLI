// ============================================================================
//  sessionStorage/resumeSnapshot — snapshot-plus-tail transcript resume
// A resume that re-parses an entire large history is
//  O(history); this store makes it O(tail): after a full load, the fold
//  state is written behind as a versioned snapshot beside the transcript;
//  the next load deserializes the snapshot and parses ONLY the bytes
//  appended past the covered cursor.
//
// Cursor law: the byte cursor and the state it covers publish
//  TOGETHER (one atomic temp+rename file) and are trusted only after
//  proof-on-read: the covered prefix must still be there (size >= cursor)
//  and its tail bytes must digest-match — a tombstone truncation, rewind,
//  or any prefix rewrite invalidates the snapshot and the loader falls
//  back to the full parse. Corruption in the snapshot itself falls back
//  the same way. The RE-RECORDED-PREFIX class is closed by construction:
//  the snapshot never re-records anything — it only ever reads.
//
//  Kill switch: MERCURY_RESUME_SNAPSHOT=0 (registered, default-on).
// ============================================================================
import { createHash } from 'node:crypto'
import { closeSync, existsSync, openSync, readSync, statSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { durableAtomicPublishSync } from '../../substrate/durablePublish.js'
import { flagEnv } from '../../substrate/flagRegistry.js'
import { jsonParse, jsonStringify } from '../slowOperations.js'
import { emptyFoldState, type TranscriptFoldState } from './fold.js'

const SNAPSHOT_SCHEMA = 1
/** Digest the last N bytes of the covered prefix — cheap, catches
 *  truncation-and-rewrite at the same size boundary. */
const DIGEST_TAIL_BYTES = 4096
/** Don't bother snapshotting small transcripts — the full parse is cheap. */
export const SNAPSHOT_MIN_BYTES = 256 * 1024

export function resumeSnapshotEnabled(): boolean {
  return flagEnv('MERCURY_RESUME_SNAPSHOT') !== '0'
}

export const snapshotPathFor = (transcriptPath: string): string =>
  `${transcriptPath}.resume-snapshot.json`

function digestPrefixTail(filePath: string, cursor: number): string {
  const start = Math.max(0, cursor - DIGEST_TAIL_BYTES)
  const len = cursor - start
  const buf = Buffer.allocUnsafe(len)
  const fd = openSync(filePath, 'r')
  try {
    let read = 0
    while (read < len) {
      const n = readSync(fd, buf, read, len - read, start + read)
      if (n === 0) break
      read += n
    }
    return createHash('sha256').update(buf.subarray(0, read)).digest('hex')
  } finally {
    closeSync(fd)
  }
}

type SerializedFold = Record<string, unknown>

function serializeFold(st: TranscriptFoldState): SerializedFold {
  const out: SerializedFold = {}
  for (const [k, v] of Object.entries(st)) {
    out[k] = v instanceof Map ? { '«map»': [...v.entries()] } : v
  }
  return out
}

function deserializeFold(raw: SerializedFold): TranscriptFoldState {
  const st = emptyFoldState() as unknown as Record<string, unknown>
  for (const [k, v] of Object.entries(raw)) {
    if (!(k in st)) continue
    if (v !== null && typeof v === 'object' && '«map»' in (v as object)) {
      st[k] = new Map((v as { '«map»': [unknown, unknown][] })['«map»'])
    } else {
      st[k] = v
    }
  }
  return st as unknown as TranscriptFoldState
}

/** Write the snapshot atomically (temp+rename), fire-and-forget safe. */
export function writeResumeSnapshot(
  transcriptPath: string,
  fold: TranscriptFoldState,
  byteCursor: number,
): void {
  try {
    const payload = jsonStringify({
      schemaVersion: SNAPSHOT_SCHEMA,
      byteCursor,
      prefixDigest: digestPrefixTail(transcriptPath, byteCursor),
      fold: serializeFold(fold),
    })
    // Durable publication: collision-free temp + win32 bounded
    // retry; the old shared `.tmp-<pid>` name could collide between two
    // same-process snapshot writers.
    durableAtomicPublishSync(snapshotPathFor(transcriptPath), payload)
  } catch {
    // Best-effort acceleration — never let a snapshot failure affect a load.
  }
}

export type SnapshotHit = {
  fold: TranscriptFoldState
  /** Bytes of transcript appended past the snapshot's cursor. */
  tail: Buffer
  byteCursor: number
  fileSize: number
}

/** Load the snapshot when it provably still covers the file's prefix. */
export async function tryLoadResumeSnapshot(transcriptPath: string): Promise<SnapshotHit | null> {
  if (!resumeSnapshotEnabled()) return null
  const snapPath = snapshotPathFor(transcriptPath)
  if (!existsSync(snapPath)) return null
  try {
    const raw = jsonParse(await readFile(snapPath, 'utf8')) as {
      schemaVersion?: number
      byteCursor?: number
      prefixDigest?: string
      fold?: SerializedFold
    } | null
    if (!raw || raw.schemaVersion !== SNAPSHOT_SCHEMA) return null
    const cursor = raw.byteCursor
    if (typeof cursor !== 'number' || cursor <= 0 || !raw.fold || !raw.prefixDigest) return null
    const { size } = statSync(transcriptPath)
    // Truncation/rewind: the covered prefix is absent — full reload.
    if (size < cursor) return null
    // Prefix rewrite at same-or-larger size: digest the covered tail.
    if (digestPrefixTail(transcriptPath, cursor) !== raw.prefixDigest) return null
    // O(tail) I/O: read ONLY the appended bytes.
    const tailLen = size - cursor
    const tail = Buffer.allocUnsafe(tailLen)
    const fd = openSync(transcriptPath, 'r')
    let read = 0
    try {
      while (read < tailLen) {
        const n = readSync(fd, tail, read, tailLen - read, cursor + read)
        if (n === 0) break
        read += n
      }
    } finally {
      closeSync(fd)
    }
    // A short read — the transcript shrank or became unreadable between the
    // stat and the positional loop — invalidates the hit (release-hardening
    // audit rank 51): the bytes past `read` are whatever the unsafe
    // allocation held, never transcript content, and handing them to the
    // decoder minted spurious "tail degraded" errors or, when the memory
    // happened to parse, a fabricated entry in the resumed conversation.
    // The plain roads reload the file from its real bytes.
    if (read < tailLen) return null
    return {
      fold: deserializeFold(raw.fold),
      tail,
      byteCursor: cursor,
      fileSize: size,
    }
  } catch {
    return null
  }
}
