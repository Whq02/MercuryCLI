import { randomUUID } from 'node:crypto'
import { appendFileSync, closeSync, openSync, readFileSync, statSync, unlinkSync, writeFileSync, writeSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import {
  decodeTranscriptBuffer,
  TRANSCRIPT_FORMAT_REFUSAL,
} from '../fabric/transcriptDecode.js'
import { historyHead, historyLines } from '../transcripts/historyParts.js'
import { applyTranscriptEntry, emptyFoldState } from '../transcripts/fold.js'
import { materializationDigest } from '../transcripts/materialize.js'
import { encodeTranscriptLine } from '../transcripts/vnext.js'
import type { Entry } from '../transcripts/transcriptEntries.js'
import { isENOENT } from '../../platform/errors/errors.js'
import { passedOver } from '../../platform/errors/passedOver.js'

export interface BranchManifest {
  v: 1
  branchSessionId: string
  parentSessionId: string
  forkOrdinal: number
  boundaryKind: 'fork' | 'rewind'
  sourceSnapshotDigest: string
  project: { cwd: string; worktree?: string }
  providerOrigin: string
  createdAt: number
  receipt: string
}

type BranchResult =
  | { ok: true; manifest: BranchManifest; branchTranscriptPath: string; manifestPath: string }
  | { ok: false; reason: string }

const branchManifestPathFor = (branchTranscriptPath: string): string =>
  `${branchTranscriptPath}.branch-manifest.json`

function isRecordTranscript(rawText: string): boolean {
  const nl = rawText.indexOf('\n')
  const first = (nl === -1 ? rawText : rawText.slice(0, nl)).trim()
  if (!first) return false
  try {
    const o = JSON.parse(first) as Record<string, unknown>
    return (
      o !== null &&
      typeof o === 'object' &&
      typeof o.schemaVersion === 'number' &&
      typeof o.recordId === 'string' &&
      typeof o.payload === 'object'
    )
  } catch (error) {
    passedOver(error)
    return false
  }
}

export function createBranchSession(args: {
  sourceTranscriptPath: string
  forkOrdinal: number
  boundaryKind: 'fork' | 'rewind'
  cwd: string
  worktree?: string
  providerOrigin: string
  now?: () => number
}): BranchResult {
  const now = args.now ?? Date.now
  const fold = emptyFoldState()
  let prefixEnd = 0, needsNewline = false, total = 0, first = true
  let head: ReturnType<typeof historyHead>
  try {
    statSync(args.sourceTranscriptPath)
    head = historyHead(args.sourceTranscriptPath)
    for (const row of historyLines(args.sourceTranscriptPath, 0, Infinity, head)) {
      if (first && !isRecordTranscript(row.toString('utf8'))) break
      first = false
      const { entries } = decodeTranscriptBuffer<Entry>(row)
      if (total < args.forkOrdinal) {
        prefixEnd += row.length
        needsNewline = row.at(-1) !== 10
        for (const entry of entries) applyTranscriptEntry(fold, entry)
      }
      total += entries.length
      if (total === args.forkOrdinal && args.forkOrdinal > 0) break
    }
  } catch (e) {
    return { ok: false, reason: `source transcript unreadable: ${String(e)}` }
  }
  if (first) return { ok: false, reason: `unsupported-for-branch: ${TRANSCRIPT_FORMAT_REFUSAL}` }
  if (!(Number.isInteger(args.forkOrdinal) && args.forkOrdinal > 0 && args.forkOrdinal <= total)) {
    return { ok: false, reason: `fork ordinal ${args.forkOrdinal} outside the committed range 1..${total}` }
  }
  const digest = materializationDigest(fold)

  const parentSessionId = basename(args.sourceTranscriptPath).replace(/\.jsonl$/, '')
  const branchSessionId = randomUUID()
  const branchTranscriptPath = join(dirname(args.sourceTranscriptPath), `${branchSessionId}.jsonl`)
  const receipt = `${args.boundaryKind} of ${parentSessionId} at ordinal ${args.forkOrdinal} (digest ${digest.slice(0, 12)})`

  let created = false
  try {
    const fd = openSync(branchTranscriptPath, 'wx', 0o600)
    created = true
    try {
      for (const row of historyLines(args.sourceTranscriptPath, 0, prefixEnd, head)) {
        for (let at = 0; at < row.length;) at += writeSync(fd, row, at, row.length - at)
      }
      if (needsNewline) writeSync(fd, '\n')
    } finally { closeSync(fd) }
    const boundary = encodeTranscriptLine(branchTranscriptPath, {
      type: 'system',
      subtype: args.boundaryKind === 'fork' ? 'fork_boundary' : 'rewind_boundary',
      content: receipt,
      parentSessionId,
      forkOrdinal: args.forkOrdinal,
      sourceSnapshotDigest: digest,
      branchSessionId,
    })
    appendFileSync(branchTranscriptPath, boundary.line)
  } catch (e) {
    if (created) unlinkSync(branchTranscriptPath)
    return { ok: false, reason: `branch write failed: ${String(e)}` }
  }

  const manifest: BranchManifest = {
    v: 1,
    branchSessionId,
    parentSessionId,
    forkOrdinal: args.forkOrdinal,
    boundaryKind: args.boundaryKind,
    sourceSnapshotDigest: digest,
    project: { cwd: args.cwd, ...(args.worktree ? { worktree: args.worktree } : {}) },
    providerOrigin: args.providerOrigin,
    createdAt: now(),
    receipt,
  }
  const manifestPath = branchManifestPathFor(branchTranscriptPath)
  try {
    writeFileSync(manifestPath, JSON.stringify(manifest, null, 2))
  } catch (e) {
    return { ok: false, reason: `manifest write failed: ${String(e)}` }
  }
  return { ok: true, manifest, branchTranscriptPath, manifestPath }
}

export function readBranchManifest(branchTranscriptPath: string): BranchManifest | null {
  let rawText: string
  try {
    rawText = readFileSync(branchManifestPathFor(branchTranscriptPath), 'utf8')
  } catch (error) {
    if (isENOENT(error)) return null
    throw error
  }
  const raw = JSON.parse(rawText) as BranchManifest
  return raw && raw.v === 1 ? raw : null
}
