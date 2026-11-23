import { resolve, sep } from 'node:path'
import { errorMessage } from '../../platform/errors/errors.js'

interface MnemeUnread {
  path: string
  error: string
}

const unread = new Map<string, MnemeUnread>()

function keyOf(path: string): string {
  return resolve(path)
}

export function recordMnemeUnread(path: string, error: unknown): void {
  unread.set(keyOf(path), { path, error: errorMessage(error) })
}

export function clearMnemeUnread(path: string): void {
  unread.delete(keyOf(path))
}

export function clearMnemeUnreadWhere(predicate: (resolvedPath: string) => boolean): void {
  for (const key of unread.keys()) {
    if (predicate(key)) unread.delete(key)
  }
}

export function mnemeUnreadSentence(roots?: readonly string[], exact?: readonly string[]): string | null {
  let hit: MnemeUnread | undefined
  if (roots === undefined && exact === undefined) {
    hit = unread.values().next().value
  } else {
    const normalized = (roots ?? []).map(root => {
      const key = keyOf(root)
      return { key, prefix: key.endsWith(sep) ? key : `${key}${sep}` }
    })
    const exactKeys = new Set((exact ?? []).map(keyOf))
    for (const [key, entry] of unread) {
      if (exactKeys.has(key) || normalized.some(r => key === r.key || key.startsWith(r.prefix))) {
        hit = entry
        break
      }
    }
  }
  if (hit === undefined) return null
  return `${hit.path} could not be read (${hit.error}), so what it holds is not shown — fix or remove the file.`
}
