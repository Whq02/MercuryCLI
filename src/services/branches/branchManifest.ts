// ============================================================================
//  services/branches/branchManifest — branch creation with immutable lineage
//
//
//  A branch is a NEW session whose transcript is the source's byte-verbatim
//  line prefix up to the fork ordinal, closed by a 'fork'/'rewind' boundary
//  record written through the WRITER's own encoder (the entry codec
//  round-trips fork_boundary/rewind_boundary), plus a manifest published
//  beside it naming the full lineage. Laws:
//
//    · ancestors stay byte-identical — the source transcript is only ever
//      READ; the branch is a new file, a new session id, independent
//      mutable state by construction;
//    · the manifest names parent session, fork record/ordinal, the source
//      materialization digest at the fork point, the project reference,
//      the provider origin, and a human receipt;
//    · a file outside the record format terminates typed
//      'unsupported-for-branch' with the one honest refusal line — never
//      translated, never silently rewritten.
// ============================================================================
import { randomUUID } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import {
  decodeTranscriptBuffer,
  TRANSCRIPT_FORMAT_REFUSAL,
} from '../../fabric/transcriptDecode.js'
import { materializeEntriesAt } from '../../utils/sessionStorage/materialize.js'
import { encodeTranscriptLine } from '../../utils/sessionStorage/vnext.js'
import type { Entry } from '../../types/logs.js'

export interface BranchManifest {
  v: 1
  branchSessionId: string
  parentSessionId: string
  /** The committed ordinal (1-based entry position) the branch forks at. */
  forkOrdinal: number
  boundaryKind: 'fork' | 'rewind'
  /** The semantic materialization digest of the source AT the fork point. */
  sourceSnapshotDigest: string
  /** Project reference — the cwd (and worktree, when distinct) the parent ran in. */
  project: { cwd: string; worktree?: string }
  /** The provider/model origin at the fork point (operator-readable). */
  providerOrigin: string
  createdAt: number
  receipt: string
}

export type BranchResult =
  | { ok: true; manifest: BranchManifest; branchTranscriptPath: string; manifestPath: string }
  | { ok: false; reason: string }

export const branchManifestPathFor = (branchTranscriptPath: string): string =>
  `${branchTranscriptPath}.branch-manifest.json`

/** First-line record probe — the same record-shape predicate the store uses. */
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
  } catch {
    return false
  }
}

/** Create a branch session from a source transcript at a committed ordinal.
 *  Pure file-level operation — no live session state is read or touched. */
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
  let raw: Buffer
  try {
    raw = readFileSync(args.sourceTranscriptPath)
  } catch (e) {
    return { ok: false, reason: `source transcript unreadable: ${String(e)}` }
  }
  const rawText = raw.toString('utf8')
  if (!isRecordTranscript(rawText)) {
    // A file outside the record format is never rewritten into a branch
    // child — the refusal is typed and terminal.
    return {
      ok: false,
      reason: `unsupported-for-branch: ${TRANSCRIPT_FORMAT_REFUSAL}`,
    }
  }
  // Decode ONCE for the ordinal universe + the fork-point digest.
  const decoded = decodeTranscriptBuffer<Entry>(raw)
  const total = decoded.entries.length
  if (!(Number.isInteger(args.forkOrdinal) && args.forkOrdinal > 0 && args.forkOrdinal <= total)) {
    return {
      ok: false,
      reason: `fork ordinal ${args.forkOrdinal} outside the committed range 1..${total}`,
    }
  }
  const point = materializeEntriesAt(decoded.entries, args.forkOrdinal)

  // Walk raw lines, counting each line's OWN decode contribution, until the
  // prefix covers exactly forkOrdinal entries — the branch head is the
  // byte-verbatim line prefix (junk/malformed lines ride along harmlessly,
  // exactly as the loader would skip them).
  const lines = rawText.split('\n')
  let covered = 0
  let endLine = -1
  for (let i = 0; i < lines.length && covered < args.forkOrdinal; i++) {
    const line = lines[i]!
    if (line.trim()) {
      covered += decodeTranscriptBuffer<Entry>(line).entries.length
    }
    endLine = i
  }
  if (covered < args.forkOrdinal) {
    return { ok: false, reason: `prefix walk covered ${covered} < ${args.forkOrdinal} entries` }
  }
  const prefix = lines.slice(0, endLine + 1).join('\n') + '\n'

  const parentSessionId = basename(args.sourceTranscriptPath).replace(/\.jsonl$/, '')
  const branchSessionId = randomUUID()
  const branchTranscriptPath = join(dirname(args.sourceTranscriptPath), `${branchSessionId}.jsonl`)
  const receipt = `${args.boundaryKind} of ${parentSessionId} at ordinal ${args.forkOrdinal} (digest ${point.digest.slice(0, 12)})`

  try {
    writeFileSync(branchTranscriptPath, prefix)
    // The boundary record rides the WRITER's own encoder — correct envelope,
    // continuing ordinals, the reserved vocabulary's real producer.
    const boundary = encodeTranscriptLine(branchTranscriptPath, {
      type: 'system',
      subtype: args.boundaryKind === 'fork' ? 'fork_boundary' : 'rewind_boundary',
      content: receipt,
      parentSessionId,
      forkOrdinal: args.forkOrdinal,
      sourceSnapshotDigest: point.digest,
      branchSessionId,
    })
    writeFileSync(branchTranscriptPath, prefix + boundary.line)
  } catch (e) {
    return { ok: false, reason: `branch write failed: ${String(e)}` }
  }

  const manifest: BranchManifest = {
    v: 1,
    branchSessionId,
    parentSessionId,
    forkOrdinal: args.forkOrdinal,
    boundaryKind: args.boundaryKind,
    sourceSnapshotDigest: point.digest,
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
  try {
    const raw = JSON.parse(
      readFileSync(branchManifestPathFor(branchTranscriptPath), 'utf8'),
    ) as BranchManifest
    return raw && raw.v === 1 ? raw : null
  } catch {
    return null
  }
}
