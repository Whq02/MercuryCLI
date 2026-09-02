// ============================================================================
//  watchRoot — win32 long-path normalization for fs-watcher roots
//
//
//  libuv's Windows fs-event backend ASSERTS the watched root is a prefix of
//  every delivered filename (`!_wcsnicmp(filename, dir, dirlen)`,
//  fs-event.c:72). A root containing an 8.3 SHORT segment (RUNNERA~1 — the
//  hosted runners' TEMP, and any user profile with a short-form
//  MERCURY_CONFIG_DIR) fails that compare the moment an event arrives
//  long-form, and the assertion KILLS the process — Mercury died ~5s after
//  its first interactive Windows boot when a config-home watcher's first
//  event fired.
//
//  The fix is spelling-only and watcher-local: expand short segments via
//  realpathSync.native (which resolves 8.3 forms on win32) at the WATCH
//  seam. Deliberately NOT applied to path identity anywhere else — on POSIX
//  realpath resolves symlinks, and a symlinked ~/.claude must never move the
//  session's identity (envUtils' contract), so POSIX returns the input
//  untouched and win32 accepts the symlink side effect only for the armed
//  watcher root.
// ============================================================================

import { existsSync, realpathSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'

/** Normalize a watch target for fs.watch/chokidar. win32: expand the deepest
 *  EXISTING ancestor to its long form and rejoin the (possibly not yet
 *  existing) tail — chokidar legitimately watches absent files. Elsewhere:
 *  identity. Never throws; any surprise returns the input unchanged. */
export function resolveWatchRoot(p: string): string {
  if (process.platform !== 'win32') return p
  try {
    let base = p
    const tail: string[] = []
    while (!existsSync(base)) {
      const parent = dirname(base)
      if (parent === base) return p
      tail.unshift(basename(base))
      base = parent
    }
    return join(realpathSync.native(base), ...tail)
  } catch {
    return p
  }
}
