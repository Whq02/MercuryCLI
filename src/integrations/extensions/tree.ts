import { createHash } from 'node:crypto'
import { readdirSync, readFileSync, statSync, type Dirent } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { isENOENT } from '../../platform/errors/errors.js'
import { passedOver } from '../../platform/errors/passedOver.js'

const SKIP = new Set(['.git', 'node_modules', '__pycache__', '.DS_Store'])

type WalkEntry = { path: string; unreadableDir?: true }

function walk(root: string, dir: string, out: WalkEntry[], bestEffort = false): void {
  let entries: Dirent[]
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch (error) {
    if (isENOENT(error) || bestEffort) {
      passedOver(error)
      return
    }
    out.push({ path: dir, unreadableDir: true })
    return
  }
  for (const entry of entries) {
    if (SKIP.has(entry.name)) continue
    const path = join(dir, entry.name)
    if (entry.isDirectory()) walk(root, path, out, bestEffort)
    else if (entry.isFile() || entry.isSymbolicLink()) out.push({ path })
  }
}

export function hashTree(root: string): string {
  const entries: WalkEntry[] = []
  walk(root, root, entries)
  const rows = entries
    .map(entry => ({
      rel: entry.unreadableDir
        ? `${relative(root, entry.path).split(sep).join('/') || '.'}/`
        : relative(root, entry.path).split(sep).join('/'),
      file: entry.path,
      unreadableDir: entry.unreadableDir === true,
    }))
    .sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0))
  const hash = createHash('sha256')
  for (const row of rows) {
    hash.update(row.rel)
    hash.update('\0')
    if (row.unreadableDir) {
      hash.update('<unreadable-dir>')
    } else {
      try {
        hash.update(readFileSync(row.file))
      } catch {
        hash.update('<unreadable>')
      }
    }
    hash.update('\0')
  }
  return `sha256:${hash.digest('hex')}`
}

export function treeFileDigests(root: string, options: { except?: ReadonlySet<string> } = {}): Record<string, string> {
  const entries: WalkEntry[] = []
  walk(root, root, entries)
  const out: Record<string, string> = {}
  for (const entry of entries) {
    const rel = relative(root, entry.path).split(sep).join('/')
    if (entry.unreadableDir) {
      out[`${rel || '.'}/`] = '<unreadable-dir>'
      continue
    }
    if (options.except?.has(rel)) continue
    try {
      out[rel] = createHash('sha256').update(readFileSync(entry.path)).digest('hex')
    } catch {
      out[rel] = '<unreadable>'
    }
  }
  return out
}

export function folderSize(root: string): number {
  const entries: WalkEntry[] = []
  walk(root, root, entries, true)
  let total = 0
  for (const entry of entries) {
    if (entry.unreadableDir) continue
    try {
      total += statSync(entry.path).size
    } catch (error) {
      passedOver(error)
    }
  }
  return total
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(bytes < 10 * 1024 ? 1 : 0)} kB`
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`
}
