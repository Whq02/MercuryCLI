// ============================================================================
//  globPrefix — the relative-pattern link accommodation (FC-088), a leaf so
//  proofs can drive it (utils/glob.ts itself rides a bundle macro).
//
//  Ripgrep's file walk does not follow links, so a relative Glob pattern
//  whose STATIC PREFIX is a directory link — a Windows junction, any
//  symlink — never matched: `junc-link/*.txt` answered "No files found"
//  while the SAME junction given as `path`, or spelled absolutely, answered
//  the file. The static prefix moves into the search directory through
//  realpath, so the walk starts INSIDE the link exactly as the path=
//  spelling does; a non-link prefix resolves to itself and nothing changes.
// ============================================================================
import { realpathSync } from 'node:fs'
import { join, resolve } from 'node:path'

/** Rewrite {searchDir, pattern} when the pattern's static prefix is a
 *  directory LINK; identity otherwise (absent prefixes included). */
export function resolveRelativePatternPrefix(
  searchDir: string,
  pattern: string,
): { searchDir: string; pattern: string } {
  const meta = pattern.search(/[*?[{]/)
  const staticPrefix = meta === -1 ? pattern : pattern.slice(0, meta)
  const lastSep = Math.max(staticPrefix.lastIndexOf('/'), staticPrefix.lastIndexOf('\\'))
  if (lastSep <= 0) return { searchDir, pattern }
  const prefixDir = join(searchDir, staticPrefix.slice(0, lastSep))
  try {
    const real = realpathSync(prefixDir)
    if (real !== resolve(prefixDir)) {
      return { searchDir: real, pattern: pattern.slice(lastSep + 1) }
    }
  } catch {
    /* absent prefix — the walk answers exactly as before */
  }
  return { searchDir, pattern }
}
