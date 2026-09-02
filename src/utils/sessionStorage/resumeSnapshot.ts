import { createHash } from 'node:crypto'
import { closeSync, existsSync, openSync, readSync, statSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { durableAtomicPublishSync } from '../../substrate/durablePublish.js'
import { flagEnv } from '../../substrate/flagRegistry.js'
import { jsonParse, jsonStringify } from '../slowOperations.js'
import type { TranscriptFoldState } from './loading.js'
import { emptyFoldState } from './loading.js'

const SNAPSHOT_SCHEMA = 1
const DIGEST_TAIL_BYTES = 4096
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
    durableAtomicPublishSync(snapshotPathFor(transcriptPath), payload)
  } catch {
  }
}

export type SnapshotHit = {
  fold: TranscriptFoldState
  tail: Buffer
  byteCursor: number
  fileSize: number
}

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
    if (size < cursor) return null
    if (digestPrefixTail(transcriptPath, cursor) !== raw.prefixDigest) return null
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
