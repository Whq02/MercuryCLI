
export type SnapshotState =
  | 'live'
  | 'ready'
  | 'starting'
  | 'configured'
  | 'degraded'
  | 'stale'
  | 'off'
  | 'disabled'
  | 'gated'
  | 'unavailable'
  | 'blocked'
  | 'failed'
  | 'excluded'
  | 'planned'

export type Snapshot<T = Record<never, never>> = {
  state: SnapshotState
  reason?: string
  source?: string
  updatedAt?: string
} & T

export function withState<T>(
  state: SnapshotState,
  data: T,
  reason?: string,
  source?: string,
): Snapshot<{ data: T }> {
  return { state, reason, source, data }
}
