// ============================================================================
//  console-size.ts — the live console size, asked for directly.
//
//  The runtime keeps stdout.columns/rows current only when its own resize
//  detection runs: SIGWINCH on POSIX, and on Windows the console reader
//  thread — which watches for WINDOW_BUFFER_SIZE_EVENT only while stdin is
//  in raw mode. A resize during an external-editor handover, a suspendStdin
//  window, or under a console host that never signals, therefore never
//  reaches the cached pair — and the public getWindowSize() returns that
//  same cache, so a reconcile that read either could not see the change it
//  existed to catch (FN-015 rank 43). The runtime's own refresh road
//  (_refreshSize, what its SIGWINCH handler calls) queries the console
//  handle, updates the cache and emits `resize` when the answer moved.
// ============================================================================

type RefreshingStream = { _refreshSize?: unknown }

/**
 * Re-query the console for its live size through the runtime's refresh
 * road. Returns true when the road exists and was taken — a moved size has
 * then updated the stream's cached columns/rows and emitted `resize`; an
 * unchanged size emitted nothing. Returns false when the stream has no such
 * road (a fake stream, a runtime without it), so the caller can fall back to
 * the cached pair. A refused query emits `error` on the stream, which
 * throws when nothing listens — caught here: the cached pair stands.
 */
export function refreshConsoleSize(stdout: unknown): boolean {
  const refresh = (stdout as RefreshingStream | null | undefined)?._refreshSize
  if (typeof refresh !== 'function') return false
  try {
    ;(refresh as () => void).call(stdout)
  } catch {
    /* the query refused (no console handle behind the stream); the cached size stands */
  }
  return true
}
