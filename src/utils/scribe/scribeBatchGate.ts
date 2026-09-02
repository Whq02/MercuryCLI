// ============================================================================
//  utils/scribe/scribeBatchGate.ts — the operator's `/batch` approve/deny brake.
// ----------------------------------------------------------------------------
//  The operator wanted a slash lever to approve or deny the Scribe's queued work
//  BATCH, surfaced in the scribe-mode launch tooltip, that on bypass/Mercury mode is
//  "approved automatically unless you say otherwise". So the DEFAULT is `auto`
//  (always approved ⇒ zero friction ⇒ byte-identical to no-gate). `/batch deny`
//  flips to a MANUAL hold: the source dispatch gate (scribeDispatchGate) then HOLDS
//  new dispatches until `/batch approve`, so the Implementer's queue never advances
//  without the operator's go-ahead. Coordination traffic (progress/escalate/control)
//  is never held — only new `dispatch` work — so a denied batch can't wedge the Scribe.
//
//  Session-scoped module state (mirrors scribeMode.ts): the foreground Scribe is a
//  single process, so a module-level flag is the right scope. Pure evaluator exported
//  for the proof. NOT a permission/capability/refusal gate — it only ADDS a hold the
//  operator asked for; it never widens anything.
// ============================================================================

export type BatchMode = 'auto' | 'manual'

let mode: BatchMode = 'auto'
// In manual mode, whether the current batch is approved for dispatch. (Auto ⇒ always
// approved.) Starts approved so flipping to manual mid-stream doesn't strand in-flight intent.
let approved = true

/** The current approval mode (`auto` = bypass/Mercury default; `manual` = operator gating). */
export function getBatchMode(): BatchMode {
  return mode
}

/** Is the queued batch approved for dispatch right now? Auto ⇒ always; manual ⇒ the flag. */
export function isBatchApproved(): boolean {
  return mode === 'auto' || approved
}

/** Switch modes. Returning to `auto` re-approves (auto is always-approved). */
export function setBatchMode(m: BatchMode): void {
  mode = m
  if (m === 'auto') approved = true
}

/** Approve the current batch (stays in manual mode so the next batch re-gates). */
export function approveBatch(): void {
  approved = true
}

/** Deny / pause: flip to manual and hold. New dispatches are held until approve/auto. */
export function denyBatch(): void {
  mode = 'manual'
  approved = false
}

/** Reset to the default (auto/approved) — used by engage/disengage so a fresh Scribe
 *  session never inherits a stale manual hold. */
export function resetBatchGate(): void {
  mode = 'auto'
  approved = true
}

/** Pure verdict: should a NEW dispatch be held by the operator's batch brake?
 *  Held iff manual-mode AND not approved. (Auto ⇒ never held ⇒ byte-identical.) */
export function evaluateBatchHold(args: { mode: BatchMode; approved: boolean }): {
  held: boolean
  reason: string
} {
  if (args.mode === 'auto') return { held: false, reason: 'auto-approve (bypass/Mercury default) — no hold' }
  if (args.approved) return { held: false, reason: 'batch approved by the operator — proceed' }
  return { held: true, reason: 'batch denied/paused by the operator (/batch approve to release)' }
}

/** A one-line status string for the `/batch` command + the deck. */
export function batchGateStatus(): string {
  if (mode === 'auto') return 'auto — batches dispatch automatically (bypass/Mercury default)'
  return approved
    ? 'manual — current batch APPROVED (next batch will re-gate)'
    : 'manual — batches PAUSED (/batch approve to release)'
}
