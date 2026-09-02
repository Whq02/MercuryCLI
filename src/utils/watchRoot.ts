
import { existsSync, realpathSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'

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
