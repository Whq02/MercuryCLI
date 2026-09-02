
export type BatchMode = 'auto' | 'manual'

let mode: BatchMode = 'auto'
let approved = true

export function getBatchMode(): BatchMode {
  return mode
}

export function isBatchApproved(): boolean {
  return mode === 'auto' || approved
}

export function setBatchMode(m: BatchMode): void {
  mode = m
  if (m === 'auto') approved = true
}

export function approveBatch(): void {
  approved = true
}

export function denyBatch(): void {
  mode = 'manual'
  approved = false
}

export function resetBatchGate(): void {
  mode = 'auto'
  approved = true
}

export function evaluateBatchHold(args: { mode: BatchMode; approved: boolean }): {
  held: boolean
  reason: string
} {
  if (args.mode === 'auto') return { held: false, reason: 'auto-approve (bypass/Mercury default) — no hold' }
  if (args.approved) return { held: false, reason: 'batch approved by the operator — proceed' }
  return { held: true, reason: 'batch denied/paused by the operator (/batch approve to release)' }
}

export function batchGateStatus(): string {
  if (mode === 'auto') return 'auto — batches dispatch automatically (bypass/Mercury default)'
  return approved
    ? 'manual — current batch APPROVED (next batch will re-gate)'
    : 'manual — batches PAUSED (/batch approve to release)'
}
