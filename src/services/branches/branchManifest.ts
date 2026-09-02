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
  forkOrdinal: number
  boundaryKind: 'fork' | 'rewind'
  sourceSnapshotDigest: string
  project: { cwd: string; worktree?: string }
  providerOrigin: string
  createdAt: number
  receipt: string
}

export type BranchResult =
  | { ok: true; manifest: BranchManifest; branchTranscriptPath: string; manifestPath: string }
  | { ok: false; reason: string }

export const branchManifestPathFor = (branchTranscriptPath: string): string =>
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
  } catch {
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
  let raw: Buffer
  try {
    raw = readFileSync(args.sourceTranscriptPath)
  } catch (e) {
    return { ok: false, reason: `source transcript unreadable: ${String(e)}` }
  }
  const rawText = raw.toString('utf8')
  if (!isRecordTranscript(rawText)) {
    return {
      ok: false,
      reason: `unsupported-for-branch: ${TRANSCRIPT_FORMAT_REFUSAL}`,
    }
  }
  const decoded = decodeTranscriptBuffer<Entry>(raw)
  const total = decoded.entries.length
  if (!(Number.isInteger(args.forkOrdinal) && args.forkOrdinal > 0 && args.forkOrdinal <= total)) {
    return {
      ok: false,
      reason: `fork ordinal ${args.forkOrdinal} outside the committed range 1..${total}`,
    }
  }
  const point = materializeEntriesAt(decoded.entries, args.forkOrdinal)

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
