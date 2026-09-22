
import { existsSync, realpathSync, type Stats } from 'node:fs'
import { basename, dirname, join } from 'node:path'

export type WatchIgnoreRule = (candidatePath: string, stats?: Stats) => boolean

export function ignoringSpecialFiles(rule?: WatchIgnoreRule): WatchIgnoreRule {
  return (candidatePath, stats) => {
    if (stats !== undefined && (stats.isFIFO() || stats.isSocket() || stats.isCharacterDevice() || stats.isBlockDevice())) return true
    return rule !== undefined && rule(candidatePath, stats)
  }
}

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
