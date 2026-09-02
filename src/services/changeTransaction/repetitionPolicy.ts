// ============================================================================
//  changeTransaction/repetitionPolicy — the ONE bounded, owner-scoped
//  no-change repetition policy.
//
//  A content-mutation tool that computes a result byte-identical to the
//  observed input returns a truthful typed 'no-change' outcome (zero writes,
//  zero notifications). This module bounds REPEATING that same intent:
//    · consulted synchronously IN the tool's no-change return path — the
//      tool owns its model-visible text, and the ceiling must surface as a
//      model-visible tool error while the internal outcome stays a truthful
//      no-change, which a pure observer at the effect seam cannot shape;
//    · keyed by operation + canonical path + observed revision +
//      deterministically serialized intent — changing any one resets;
//    · NO_CHANGE_REPETITION_CEILING (3) consecutive materially identical
//      no-change outcomes is the default ceiling: the 1st/2nd carry concise
//      reread/current-state guidance, the 3rd (and later) instructs the
//      caller to stop repeating that intent and is surfaced as is_error by
//      the owning tool (effect/receipt stay truthful no-change);
//    · a successful mutation on a path resets its streak (subscribed at the
//      SAME exactly-once effectObserver seam receipts ride — a content
//      roundtrip can restore an old revision, so key mismatch alone is not
//      enough to prove intervening progress);
//    · paths and owners are independent; per-owner entries are bounded
//      (PATH_ENTRY_CAP, LRU) and cleaned through the existing owner
//      lifecycle (OwnerScopedStore + registerOwnerScopedStore).
//  The daemon recurring-task policy is a DIFFERENT owner and is untouched.
//
//  Proof: scripts/repetition-guard/ (suite member).
// ============================================================================

import { realpathSync } from 'node:fs'
import { expandPath } from '../../utils/path.js'
import { runtimeKernel } from '../primitives/runtimeKernel.js'
import { subscribeToolTerminal } from '../run/effectObserver.js'
import type { OwnerKey } from '../run/ownerKey.js'
import { registerOwnerScopedStore } from '../run/ownerLifecycle.js'
import { OwnerScopedStore } from '../run/ownerScopedStore.js'

/** Default ceiling: the 3rd consecutive materially identical no-change
 *  outcome is bounded (1st/2nd stay recoverable). */
export const NO_CHANGE_REPETITION_CEILING = 3

/** Bounded per-owner retention — distinct paths beyond the cap evict LRU. */
const PATH_ENTRY_CAP = 128

export interface NoChangeObservation {
  /** Effect-vocabulary operation ('file.edit' · 'file.write' · 'file.changeSet'). */
  operation: string
  /** Absolute target path. */
  path: string
  /** The observed content revision (a snapshot anchor / digest of the
   *  CURRENT content the no-change was computed against). */
  revision: string
  /** Deterministically serialized intent digest (serializeIntentDigest). */
  intentDigest: string
  /** Optional display spelling for guidance text (defaults to path). */
  displayPath?: string
}

export interface RepetitionVerdict {
  /** Consecutive materially identical no-change outcomes, INCLUDING this one. */
  streak: number
  /** streak ≥ ceiling — the owning tool surfaces a model-visible tool error. */
  atCeiling: boolean
  /** Concise reread/current-state guidance (stop instruction at the ceiling). */
  guidance: string
}

interface PathEntry {
  key: string
  count: number
}

interface RepetitionState {
  /** canonical-path (case-folded) → last no-change key + consecutive count.
   *  Map iteration order is insertion order — re-set on touch gives LRU. */
  entries: Map<string, PathEntry>
}

const store = new OwnerScopedStore<RepetitionState>({
  name: 'no-change-repetition',
  create: () => ({ entries: new Map() }),
  cap: 64,
})
registerOwnerScopedStore(store)

const CASE_INSENSITIVE_FS =
  process.platform === 'darwin' || process.platform === 'win32'

/** Canonicalize a target path for keying (realpath when resolvable — the
 *  idiom; case-folded on case-insensitive filesystems). */
export function canonicalNoChangePath(path: string): string {
  const expanded = expandPath(path)
  let canonical: string
  try {
    canonical = realpathSync(expanded)
  } catch {
    canonical = expanded
  }
  return CASE_INSENSITIVE_FS ? canonical.toLowerCase() : canonical
}

/** Deterministic intent digest over EXPLICIT array material (the
 *  digest idiom — never incidental object-key order). */
export function serializeIntentDigest(material: readonly unknown[]): string {
  return runtimeKernel().hash.sha256Hex(JSON.stringify(material)).slice(0, 16)
}

function operationNoun(operation: string): string {
  switch (operation) {
    case 'file.edit':
      return 'edit'
    case 'file.write':
      return 'write'
    case 'file.changeSet':
      return 'change set'
    default:
      return operation
  }
}

function guidanceFor(
  obs: NoChangeObservation,
  streak: number,
): string {
  const noun = operationNoun(obs.operation)
  const display = obs.displayPath ?? obs.path
  if (streak >= NO_CHANGE_REPETITION_CEILING) {
    return (
      `Stop repeating this ${noun}: it has produced no change ${streak} consecutive times on ${display} — ` +
      `the file already matches the intended state (current anchor: ${obs.revision}). ` +
      `Re-read the file and take a different action.`
    )
  }
  if (streak === 1) {
    return (
      `The file already matches this ${noun}. ` +
      `If you expected different content, re-read ${display} (current anchor: ${obs.revision}) before retrying.`
    )
  }
  return (
    `Repeated no-change: this identical ${noun} has produced no change ${streak} times in a row on ${display}. ` +
    `Re-read the file (current anchor: ${obs.revision}) and reassess — another identical call returns an error.`
  )
}

/**
 * Record one typed no-change outcome from a content-mutation operation and
 * return the bounded-repetition verdict. Consulted synchronously in the
 * owning tool's no-change return path. Never throws.
 */
export function recordNoChangeOutcome(
  owner: OwnerKey,
  obs: NoChangeObservation,
): RepetitionVerdict {
  try {
    const state = store.get(owner)
    const pathKey = canonicalNoChangePath(obs.path)
    const key = [obs.operation, pathKey, obs.revision, obs.intentDigest].join(
      '\u0000',
    )
    const prior = state.entries.get(pathKey)
    const count = prior && prior.key === key ? prior.count + 1 : 1
    // Re-set on touch (LRU), bound distinct paths.
    state.entries.delete(pathKey)
    state.entries.set(pathKey, { key, count })
    if (state.entries.size > PATH_ENTRY_CAP) {
      const oldest = state.entries.keys().next().value as string | undefined
      if (oldest !== undefined) state.entries.delete(oldest)
    }
    return {
      streak: count,
      atCeiling: count >= NO_CHANGE_REPETITION_CEILING,
      guidance: guidanceFor(obs, count),
    }
  } catch {
    // The policy must never break a tool's truthful no-change return.
    return { streak: 1, atCeiling: false, guidance: guidanceFor(obs, 1) }
  }
}

/** A successful mutation on a path resets its streak for that owner. */
export function noteSuccessfulMutation(
  owner: OwnerKey,
  changedPaths: readonly string[],
): void {
  const state = store.peek(owner)
  if (!state || state.entries.size === 0) return
  for (const path of changedPaths) {
    try {
      state.entries.delete(canonicalNoChangePath(path))
    } catch {
      /* reset must never break observation */
    }
  }
}

// Self-install at module scope — the receipts idiom: the SAME exactly-once
// terminal observation resets streaks on real mutations (any tool, incl.
// ChangeSet/Structure/LSP applies touching the same paths).
let installed = false
export function installRepetitionResetObserver(): void {
  if (installed) return
  installed = true
  subscribeToolTerminal(event => {
    if (
      event.effect &&
      event.effect.outcome === 'succeeded' &&
      event.effect.changedPaths.length > 0
    ) {
      noteSuccessfulMutation(event.owner, event.effect.changedPaths)
    }
  })
}
installRepetitionResetObserver()

/** TEST-ONLY: reset the policy store (proof harnesses). */
export function _resetRepetitionPolicyForTesting(): void {
  store.clearAllForShutdown()
}
