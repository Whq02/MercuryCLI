import { realpathSync } from 'node:fs'
import { join, resolve } from 'node:path'

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
  }
  return { searchDir, pattern }
}
