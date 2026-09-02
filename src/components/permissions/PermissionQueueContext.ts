import * as React from 'react'

/**
 * Queue position of the consent request currently on screen.
 *
 * The REPL keeps a QUEUE of pending tool approvals but renders only the head
 * card — without this, three stacked requests are indistinguishable from one
 * and the operator can't tell how much consent work remains. The provider
 * wraps the head `PermissionRequest`; `PermissionDialog` (the shared consent
 * shell every tool card renders through) shows a compact `n/total` marker in
 * its title row when total > 1, so worker/plan/tool-specific cards all get it
 * without per-card edits.
 *
 * `position` is 1-based among the requests seen in this contiguous consent
 * sequence (resolved + on-screen); `total` = resolved + still queued. New
 * arrivals mid-sequence grow `total` truthfully (e.g. 2/4). Null = no
 * provider (agent views, tests) → no marker, card unchanged.
 */
export type PermissionQueueStatus = {
  position: number
  total: number
}

export const PermissionQueueContext =
  React.createContext<PermissionQueueStatus | null>(null)

/**
 * Pure sequence math (REPL threads its resolved-count + live queue length
 * through here; proofs pin it): position is the next unresolved request,
 * total counts every request seen this sequence. The dialog hides the marker
 * when total <= 1, so a lone request renders byte-identical.
 */
export function permissionQueueStatus(
  resolvedCount: number,
  queueLength: number,
): PermissionQueueStatus {
  return {
    position: resolvedCount + 1,
    total: resolvedCount + queueLength,
  }
}
