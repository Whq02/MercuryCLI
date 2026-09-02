
export type BuddyState =
  | 'idle'
  | 'thinking'
  | 'working'
  | 'focused'
  | 'blocked'
  | 'sad'
  | 'done'
  | 'sleeping'

export const BUDDY_FRESH_MS = 45_000

export const BUDDY_FOCUS_MS = 5 * 60 * 1000

export const BUDDY_DEEP_IDLE_MS = 5 * 60 * 1000

export interface BuddyAgentRow {
  isMain: boolean
  status: 'running' | 'done' | 'idle'
  lastTs?: string | null
}

export interface BuddySignals {
  activeStatus?: { live?: boolean; turnStartTs?: string | null } | null
  activeStreaming?: { text?: string | null } | null
  perm?: unknown | null
  latestNotification?: { notificationKind?: string | null } | null
  justSettled?: boolean
  recentFail?: boolean
  asleep?: boolean
  bridgeLive?: boolean
}

function mainBuddyState(s: BuddySignals, now: number): BuddyState {
  const blockedByPerm = s.perm != null
  const blockedByNote = s.latestNotification?.notificationKind === 'permission_prompt'
  if (blockedByPerm || blockedByNote) return 'blocked'

  if (s.recentFail) return 'sad'

  if (s.activeStreaming?.text && s.bridgeLive !== false) return 'thinking'

  if (s.activeStatus?.live && s.bridgeLive !== false) {
    const start =
      typeof s.activeStatus.turnStartTs === 'string'
        ? Date.parse(s.activeStatus.turnStartTs)
        : NaN
    if (Number.isFinite(start) && now - start >= BUDDY_FOCUS_MS) return 'focused'
    return 'working'
  }

  if (s.justSettled) return 'done'

  if (s.asleep) return 'sleeping'
  return 'idle'
}

function subBuddyState(a: BuddyAgentRow, now: number, bridgeLive?: boolean): BuddyState {
  if (a.status === 'done') return 'done'
  const last = a.lastTs ? Date.parse(a.lastTs) : NaN
  if (!Number.isFinite(last)) return 'idle'
  const quietMs = now - last
  if (quietMs < BUDDY_FRESH_MS) return bridgeLive === false ? 'idle' : 'working'
  if (quietMs >= BUDDY_DEEP_IDLE_MS) return 'sleeping'
  return 'idle'
}

export function buddyStateFor(
  a: BuddyAgentRow,
  signals: BuddySignals,
  now: number = Date.now(),
): BuddyState {
  return a.isMain ? mainBuddyState(signals, now) : subBuddyState(a, now, signals.bridgeLive)
}

export function buddyRowFromHealth(
  h: {
    name?: string
    state: 'idle' | 'busy' | 'drifting' | string
    leaseAgeMs?: number | null
    currentTasks?: string[]
  },
  opts: { isMain?: boolean; nowMs?: number } = {},
): BuddyAgentRow {
  const now = opts.nowMs ?? Date.now()
  const isMain = opts.isMain ?? false

  if (h.state === 'idle') {
    return { isMain, status: 'idle', lastTs: null }
  }

  const ageMs =
    typeof h.leaseAgeMs === 'number' && Number.isFinite(h.leaseAgeMs) && h.leaseAgeMs >= 0
      ? h.leaseAgeMs
      : 0
  const lastTs = new Date(now - ageMs).toISOString()
  return { isMain, status: 'running', lastTs }
}

export type BuddyToneKey =
  | 'TERRA'
  | 'IVORY'
  | 'SECOND'
  | 'FAINT'
  | 'TEAL'
  | 'AMBER'
  | 'CRIMSON'

export function buddyTone(state: BuddyState): BuddyToneKey {
  switch (state) {
    case 'blocked':
      return 'CRIMSON'
    case 'sad':
      return 'AMBER'
    case 'thinking':
    case 'working':
    case 'focused':
      return 'TEAL'
    case 'done':
      return 'SECOND'
    case 'sleeping':
    case 'idle':
    default:
      return 'FAINT'
  }
}
