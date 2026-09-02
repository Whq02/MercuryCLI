import { getProcessStartTokenCachedOrRefresh } from '../daemon/ownerWatch.js'

/** pid liveness, injected so the staleness folds that take it stay
 *  pure/provable. When a start-token was recorded, require the LIVE process
 *  at that pid to carry the SAME token — a recycled pid (different start
 *  time) is NOT the recorded process (the pid-reuse window). Token-blind
 *  fallback = bare liveness. */
export function pidAlive(pid: number, startToken?: string): boolean {
  try {
    process.kill(pid, 0)
  } catch {
    return false
  }
  if (!startToken) return true
  // Reuse the daemon's own token helper (cross-platform: ps lstart / Win32 CIM)
  // so the compared token can never drift from the one the writer recorded.
  // This runs on the RENDER path — the cached-or-refresh form never spawns
  // synchronously (the win32 sync query cost 400–900ms per check); a cold
  // miss reads null and converges on the next render.
  const live = getProcessStartTokenCachedOrRefresh(pid)
  // null ⇒ token unknowable here (never falsely declare a live pid dead); a real
  // token must MATCH — a recycled pid has a different start time.
  return live === null || live === startToken
}
