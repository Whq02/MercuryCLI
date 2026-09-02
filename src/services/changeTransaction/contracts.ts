// ============================================================================
//  changeTransaction/contracts — ONE change vocabulary for every mutation
//  path.
//
//  The typed ToolEffect (src/Tool.ts) stays the wire truth for what a tool
//  call actually did; this module adds the two layers the coding loop was
//  missing around it:
//    · ChangeSnapshot — a compact content-derived anchor a read can hand the
//      model so a LATER mutation can fail fast on staleness instead of
//      guessing (snapshotAnchor.ts mints/verifies them);
//    · ChangeReceipt — intent + observed effect, recorded exactly once at
//      the effectObserver seam for every mutation-shaped tool call
//      (receipts.ts). Receipts are the feed Counsel, the resource
//      plane, and the doctor circuit read.
//
//  Receipts NEVER duplicate the durable run ledger: the run kernel remains
//  the persisted record; the receipt ring is bounded, owner-scoped,
//  conversation-lifetime state derived from the same exactly-once
//  observation.
// ============================================================================

import type { ToolEffect } from '../../Tool.js'
import type { OwnerKey } from '../run/ownerKey.js'
import { isEnvDefinedFalsy } from '../../utils/envUtils.js'
import { flagEnv } from '../../substrate/flagRegistry.js'

export const CHANGE_CONTRACT_VERSION = 1

/** A compact, content-derived staleness anchor for one read of one file. */
export interface ChangeSnapshot {
  path: string
  /** The printable anchor string the model carries (see snapshotAnchor.ts). */
  anchor: string
  byteLength: number
  observedAt: number
  /** 1-based line range for partial reads; absent means the whole file. */
  range?: { startLine: number; lineCount: number }
}

/** What a mutation SET OUT to do — recorded beside the observed effect. */
export interface ChangeIntent {
  /** Where the mutation came from ('tool:Edit', 'tool:Write', 'lsp.rename', …). */
  source: string
  /** Operation name, matching the effect's operation vocabulary. */
  operation: string
  /** The paths the caller intended to touch (input-derived, bounded). */
  targetPaths: string[]
  /** The staleness anchor the caller carried, when it carried one. */
  expectedAnchor?: string
  /** per-target path/version pairs (anchors/digests) when the tool
   *  provided a typed intent projection — multi-file mutations carry EVERY
   *  expected version; single-path receipts keep expectedAnchor untouched. */
  targetVersions?: { path: string; version: string }[]
}

/** Intent + observed effect: the exactly-once record of one mutation. */
export interface ChangeReceipt {
  version: typeof CHANGE_CONTRACT_VERSION
  /** Monotonic per-owner sequence (the Counsel/resource cursor). */
  seq: number
  id: string
  owner: OwnerKey
  toolName: string
  toolUseId: string | undefined
  startedAt: number
  completedAt: number
  intent: ChangeIntent
  effect: ToolEffect
}

/**
 * The mutation-operation vocabulary receipts record. Effects from read
 * operations (LSP navigation, Debug inspection) never mint receipts; any
 * effect that actually changed paths always does (belt for new operations).
 * /5 extend this list with their operations.
 */
const MUTATION_OPERATION_PREFIXES = [
  'file.',
  'notebook.',
  'lsp.rename',
  'lsp.codeAction',
  'lsp.pathRename',
  'workshop.',
  // the structural codemod apply + the git commit-plan
  // transactions. Observation ops (structure.query, git.status)
  // are NOT here — reads never mint receipts.
  'structure.apply',
  'git.commit',
  'git.stage',
  'git.restore',
  'git.resolve',
] as const

export function isMutationOperation(operation: string): boolean {
  return MUTATION_OPERATION_PREFIXES.some(p => operation.startsWith(p))
}

/** Should this terminal tool event mint a ChangeReceipt? */
export function isReceiptShaped(effect: ToolEffect): boolean {
  return effect.changedPaths.length > 0 || isMutationOperation(effect.operation)
}

/**
 * The change-transaction layer gate (registered as MERCURY_CHANGE_RECEIPTS in
 * flagRegistry.ts). Default-ON; `=0` restores the pre-slice surface exactly:
 * no anchor lines on reads, no expected_anchor field/enforcement on edits,
 * no receipt ring. Re-read live on every call (authority-toggle honesty).
 */
export function changeTransactionEnabled(): boolean {
  return !isEnvDefinedFalsy(flagEnv('MERCURY_CHANGE_RECEIPTS'))
}
