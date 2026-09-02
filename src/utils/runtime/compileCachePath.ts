// ============================================================================
//  src/utils/runtime/compileCachePath.ts — may the V8 compile cache live at
//  this directory? Pure; loaded at the cli.tsx boot seam the way the win32
//  console seam is (a dynamic import behind the same guard).
//
//  WHY: a config home of 224 characters or more made Mercury never start on
//  Windows — no output, no error, no exit, one core at 100% (TASK-014
//  w1-f15-01, S1). The compile cache's own file names ride under
//  <home>/compile-cache, and past the legacy 260-character path bound the
//  runtime's cache machinery spins instead of failing. Node "silently
//  no-ops on unwritable directories" — this is the case it does not.
//  The lever is skipped, never the boot.
// ============================================================================

/** Room the cache's own file names need under the directory (hash-named
 *  entries plus their lock files), inside the 260-character bound. */
export const WIN32_COMPILE_CACHE_DIR_MAX = 200

export function compileCacheDirUsable(dir: string, platform: string = process.platform): boolean {
  if (platform !== 'win32') return true
  // An extended-length spelling opts out of the bound by construction.
  if (dir.startsWith('\\\\?\\')) return true
  return dir.length <= WIN32_COMPILE_CACHE_DIR_MAX
}
