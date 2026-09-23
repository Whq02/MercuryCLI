
import { existsSync, realpathSync, watch, type FSWatcher, type Stats, type WatchListener, type WatchOptionsWithStringEncoding } from 'node:fs'
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

export function watchDirectory(
  root: string,
  options: WatchOptionsWithStringEncoding,
  onChange: WatchListener<string>,
  onGone: () => void,
): FSWatcher {
  let gone = false
  const watcher = watch(root, options, (event, filename) => {
    if (gone) return
    if (process.platform === 'win32' && !existsSync(root)) {
      gone = true
      watcher.close()
      onGone()
      return
    }
    onChange(event, filename)
  })
  return watcher
}
