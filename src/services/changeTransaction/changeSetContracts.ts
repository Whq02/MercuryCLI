// ============================================================================
//  changeTransaction/changeSetContracts — the change-set vocabulary.
//
//  ONE provider-neutral contract for an anchored text change spanning several
//  EXISTING files: typed per-target plans, one immutable content-addressed
//  aggregate plan, explicit bounds, and the closed refusal vocabulary. The
//  product guarantee (never bare "atomic"):
//    1. any preparation/validation/scope/drift failure writes NOTHING;
//    2. a normal apply reaches the COMPLETE planned state;
//    3. a midway interruption is journaled and deterministically reconciled;
//    4. if later bytes prevent safe reconciliation, the EXACT unresolved
//       paths are reported — uncertainty is never promoted to success.
//
//  Gate: MERCURY_CHANGESET (default-ON, registered) composed with the
//  change-transaction layer + the hunk vocabulary (anchors and hunks ARE the
//  member grammar) — either =0 removes the ChangeSet tool from the catalog
//  byte-identically. The shared commit core (changeSetCommit.ts) is NOT
//  behind this flag: Structure/LSP ride it unconditionally (F5).
// ============================================================================

import { join } from 'node:path'
import { getMercuryHome, isEnvDefinedFalsy } from '../../utils/envUtils.js'
import type { LineEndingType } from '../../utils/fileRead.js'
import type { BoundedDiffHunk } from './diffBudget.js'
import { changeTransactionEnabled } from './contracts.js'
import { editHunksEnabled, type EditHunkInput, type HunkSpan } from './hunks.js'
import { flagEnv } from '../../substrate/flagRegistry.js'

export const CHANGESET_CONTRACT_VERSION = 1

/** The ChangeSet tool gate (registered as MERCURY_CHANGESET). Live-reread. */
export function changeSetEnabled(): boolean {
  return (
    changeTransactionEnabled() &&
    editHunksEnabled() &&
    !isEnvDefinedFalsy(flagEnv('MERCURY_CHANGESET'))
  )
}

/** The change-set durable home (journal + recovery bundles).
 *  `MERCURY_CHANGESET_DIR` is the hermetic proof seam. */
export function changeSetHomeDir(): string {
  const pinned = flagEnv('MERCURY_CHANGESET_DIR')
  return pinned && pinned.length > 0
    ? pinned
    : join(getMercuryHome(), 'changesets')
}

export function changeSetJournalDir(): string {
  return join(changeSetHomeDir(), 'journal')
}

export function changeSetBundleRoot(): string {
  return join(changeSetHomeDir(), 'bundles')
}

// ── bounds (every one explicit; an exceeded bound names the limit and the
//    smallest useful recovery action) ─────────────────────────────────────────

export const CHANGESET_BOUNDS = {
  /** Files per change set. */
  maxFiles: 16,
  /** Hunks per file. */
  maxHunksPerFile: 32,
  /** Hunks per set, aggregate. */
  maxHunksTotal: 128,
  /** Bytes read + staged per set (matches the structural plane's 4MB
   *  bounded working set). */
  maxStagedBytes: 4_000_000,
  /** Rendered diff lines per set (per-file cuts are NAMED, never silent). */
  maxDiffLines: 240,
  /** Retained plans per owner (older plans evict into the expired set). */
  planRing: 16,
  /** Plan lifetime — applying an older plan refuses as expired. */
  planTtlMs: 30 * 60_000,
  /** Terminal recovery bundles kept after compaction (incomplete bundles
   *  are ALWAYS retained until recovery settles them). */
  bundleKeepTerminal: 8,
} as const

// ── member input (the LIVE hunk vocabulary, per existing text file) ─────────

export interface ChangeSetMemberInput {
  file_path: string
  /** REQUIRED staleness anchor from a prior Read of this file. */
  expected_anchor: string
  hunks: EditHunkInput[]
  /** File-level operation. 'edit' (default) rewrites content via hunks;
   *  'delete' removes the file (hunks must be empty); 'move' renames the
   *  file to new_path after applying any hunks. The patch dialect is the
   *  authoring surface for the non-edit kinds. */
  op?: 'edit' | 'delete' | 'move'
  /** move: the destination path (must not exist). */
  new_path?: string
}

// ── per-target plan ─────────────────────────────────────────────────────────

export interface ChangeSetTargetPlan {
  /** The path as requested by the caller. */
  requestedPath: string
  /** Canonical absolute path (expansion + realpath; the dedup identity). */
  canonicalPath: string
  expectedAnchor: string
  /** The anchor the same scope mints against the observed content. */
  observedAnchor: string
  /** sha256-hex over the EXACT original disk bytes. */
  originalDigest: string
  /** sha256-hex over the EXACT planned disk bytes. */
  plannedDigest: string
  originalByteLength: number
  plannedByteLength: number
  encoding: BufferEncoding
  lineEndings: LineEndingType
  finalNewline: boolean
  /** POSIX permission bits of the original file (preserved on write). */
  mode: number
  /** The validated hunk plan (disjoint spans against the anchored snapshot). */
  hunkSpans: HunkSpan[]
  /** Exact planned output, LF domain (what the model reasons about). */
  plannedContent: string
  /** Bounded structured diff for preview/consent/card rendering. */
  diff: { hunks: BoundedDiffHunk[]; omittedHunks: number }
  /** false ⇒ already satisfied (planned output === observed content). */
  changed: boolean
  /** File-level operation beyond a content rewrite (delete removes the
   *  path; move lands plannedContent at newPath and removes the path). */
  fileOp?: 'delete' | 'move'
  /** move: canonical absolute destination (verified absent at plan time). */
  newPath?: string
}

/** The non-serialized byte payloads (bundle + staging material). Held on the
 *  in-memory plan only — full source NEVER rides transcripts, model results,
 *  or the JSON journal record. */
export interface ChangeSetTargetBytes {
  canonicalPath: string
  originalBytes: Buffer
  plannedBytes: Buffer
}

// ── the aggregate plan ──────────────────────────────────────────────────────

export type ChangeSetPlanState =
  | 'prepared'
  | 'applied'
  | 'no-change'
  | 'stale'
  | 'failed'
  | 'indeterminate'
  | 'discarded'
  | 'expired'
  | 'cancelled'
  | 'recovered'

export interface ChangeSetPlan {
  version: typeof CHANGESET_CONTRACT_VERSION
  /** Stable content-addressed id: cs-<hex12> of the plan digest. */
  id: string
  /** The full content digest (target set + anchors + hunks + outputs). */
  digest: string
  /** Owner identity — a plan is applicable ONLY by the owner that minted it. */
  ownerKey: string
  createdAt: number
  expiresAt: number
  state: ChangeSetPlanState
  /** Deterministic canonical-path order (the commit order). */
  targets: ChangeSetTargetPlan[]
  /** Canonical paths whose bytes the plan will change, in commit order. */
  changedPaths: string[]
  /** Already-satisfied members (reported, never written). */
  noChangePaths: string[]
  totalHunks: number
  note?: string
  appliedAt?: number
  operationId?: string
}

// ── refusals (closed vocabulary; every refusal names the smallest useful
//    recovery action and writes NOTHING) ────────────────────────────────────

export type ChangeSetRefusalCode =
  | 'schema'
  | 'bounds'
  | 'duplicate-path'
  | 'missing'
  | 'directory'
  | 'notebook'
  | 'binary'
  | 'not-read'
  | 'stale-anchor'
  | 'malformed-anchor'
  | 'hunks'
  | 'destination'
  | 'scope'
  | 'denied'
  | 'absent'
  | 'expired'
  | 'discarded'
  | 'already-applied'
  | 'foreign-owner'
  | 'stale-plan'
  | 'cancelled'
  | 'in-flight'
  | 'io'

export interface ChangeSetMemberFailure {
  path: string
  code: ChangeSetRefusalCode
  message: string
}

export interface ChangeSetRefusal {
  ok: false
  code: ChangeSetRefusalCode
  /** One aggregate message; per-member failures are ALL collected (bounded). */
  message: string
  failures?: ChangeSetMemberFailure[]
  /** The smallest useful recovery action. */
  recovery: string
}

export interface ChangeSetPlanned {
  ok: true
  plan: ChangeSetPlan
  /** Byte payloads by canonical path (in-memory only). */
  bytes: Map<string, ChangeSetTargetBytes>
}

export type ChangeSetPlanResult = ChangeSetPlanned | ChangeSetRefusal
