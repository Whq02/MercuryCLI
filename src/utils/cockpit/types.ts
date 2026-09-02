
export type {
  SnapshotState,
  Snapshot,
} from '../../components/mercury-ui/theme.js'

import type { Snapshot, SnapshotState } from '../../components/mercury-ui/theme.js'

export function nowIso(): string {
  return new Date().toISOString()
}

export function withState<T>(
  state: SnapshotState,
  data: T,
  reason?: string,
  source?: string,
): Snapshot<{ data: T }> {
  return { state, reason, source, data }
}
