// ============================================================================
//  utils/cockpit/types — the snapshot envelope + safe construction helpers.
//
//  Every Mercury surface reads its data through a snapshot helper instead of
// scraping env/files/git ad hoc. A snapshot NEVER throws during a
//  render: a read that fails or a backend that is absent resolves to an honest
//  state (off/unavailable/failed/planned) with a reason — a missing data source
// is a valid UI state, not an exception.
//
//  SnapshotState / Snapshot are defined once in mercury-ui/theme (the token
//  bridge); re-exported here so data code imports from the data layer. Type-only
//  re-export — no runtime cycle.
// ============================================================================

export type {
  SnapshotState,
  Snapshot,
} from '../../components/mercury-ui/theme.js'

import type { Snapshot, SnapshotState } from '../../components/mercury-ui/theme.js'

// Stamp an ISO instant for `updatedAt` (runtime, not a workflow script — safe).
export function nowIso(): string {
  return new Date().toISOString()
}

// Build an honest empty/error snapshot with a payload default. Used by the catch
// arm of every helper so a thrown read degrades to a labelled state, never a
// crash.
export function withState<T>(
  state: SnapshotState,
  data: T,
  reason?: string,
  source?: string,
): Snapshot<{ data: T }> {
  return { state, reason, source, data }
}
