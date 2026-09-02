/**
 * Asciicast v2 terminal recording — dormant in this build.
 *
 * The enablement branch is folded off (no env opt-in exists): path
 * resolution always yields null after the cache check, so a recorder is never installed and no recording path ever
 * resolves. The recorder machinery itself (stdout interception, resize
 * events, buffered appends) is a confirmed scope-out and is not built here;
 * the retention sweep still deletes aged `.cast` files recordings from
 * earlier builds may have left on disk.
 *
 * What survives is the production surface: `getRecordFilePath` (always null
 * under the folded gate) and `renameRecordingForSession`, which the REPL,
 * the resume screen and session restore call around session-id changes. Two
 * of those call sites await it inside session-switch sequences and the REPL
 * invokes it fire-and-forget, so it must be async, a no-op while nothing is
 * recording, and must never throw synchronously.
 */

// The resolved recording path is mutable module state because a
// resume/continue changes the session id after a recorder was installed.
// With the enablement gate folded off nothing ever assigns it.
let cachedRecordFilePath: string | null = null

/**
 * The current recording file path. Returns the cached path when one exists;
 * with the enablement branch folded off, resolution never yields one, so
 * this is null on every call in this build.
 */
export function getRecordFilePath(): string | null {
  if (cachedRecordFilePath !== null) return cachedRecordFilePath
  return null
}

/**
 * Recompute the recording name for the current session and rename the file.
 * A no-op when nothing is recording — which, with the folded gate, is
 * always. Never throws synchronously; failure would be non-fatal.
 */
export async function renameRecordingForSession(): Promise<void> {
  if (getRecordFilePath() === null) return
}
