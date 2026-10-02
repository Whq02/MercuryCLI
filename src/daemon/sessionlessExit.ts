export const SESSIONLESS_EXIT_GRACE_MS = 30_000

export const SESSIONLESS_EXIT_BEAT_MS = 5_000

export interface SessionlessFactsV1 {
  live: number
  birthsInFlight: number
  superseded: boolean
  persist: boolean
  foreground: boolean
  scheduled: boolean
  now: number
}

export interface SessionlessStateV1 {
  hosted: boolean
  emptySince: number | null
}

export type SessionlessVerdictV1 = { exit: false; state: SessionlessStateV1; hold: string } | { exit: true; state: SessionlessStateV1; why: string }

export function initialSessionlessState(): SessionlessStateV1 {
  return { hosted: false, emptySince: null }
}

export function decideSessionlessExit(state: SessionlessStateV1, facts: SessionlessFactsV1, graceMs: number = SESSIONLESS_EXIT_GRACE_MS): SessionlessVerdictV1 {
  const hosted = state.hosted || facts.live > 0 || facts.superseded
  if (facts.live > 0 || facts.birthsInFlight > 0) {
    return { exit: false, state: { hosted, emptySince: null }, hold: facts.live > 0 ? `${facts.live} live worker(s)` : `${facts.birthsInFlight} birth(s) in flight` }
  }
  if (facts.foreground) return { exit: false, state: { hosted, emptySince: null }, hold: 'runs on a terminal' }
  if (!hosted) return { exit: false, state: { hosted, emptySince: null }, hold: 'never hosted a session' }
  if (facts.superseded) return { exit: true, state: { hosted, emptySince: facts.now }, why: 'the plane is served by a newer daemon and the last session this daemon held has exited' }
  if (facts.persist) return { exit: false, state: { hosted, emptySince: null }, hold: 'persists by its own posture' }
  if (facts.scheduled) return { exit: false, state: { hosted, emptySince: null }, hold: 'a session schedule waits on this daemon' }
  const emptySince = state.emptySince ?? facts.now
  if (facts.now - emptySince < graceMs) {
    return { exit: false, state: { hosted, emptySince }, hold: `empty for ${Math.round((facts.now - emptySince) / 1000)}s of the ${Math.round(graceMs / 1000)}s grace` }
  }
  return {
    exit: true,
    state: { hosted, emptySince },
    why: `the last session this daemon hosted has exited (empty for ${Math.round(graceMs / 1000)}s)`,
  }
}
