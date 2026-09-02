import { createHash } from 'node:crypto'
import { readdirSync, readFileSync, statSync, type Dirent } from 'node:fs'
import { join, relative, sep } from 'node:path'

const SKIP = new Set(['.git', 'node_modules', '__pycache__', '.DS_Store'])

function walk(root: string, dir: string, out: string[]): void {
  let entries: Dirent[]
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return
  }
  for (const entry of entries) {
    if (SKIP.has(entry.name)) continue
    const path = join(dir, entry.name)
    if (entry.isDirectory()) walk(root, path, out)
    else if (entry.isFile() || entry.isSymbolicLink()) out.push(path)
  }
}

export function hashTree(root: string): string {
  const files: string[] = []
  walk(root, root, files)
  const rows = files
    .map(file => ({ rel: relative(root, file).split(sep).join('/'), file }))
    .sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0))
  const hash = createHash('sha256')
  for (const row of rows) {
    hash.update(row.rel)
    hash.update('\0')
    try {
      hash.update(readFileSync(row.file))
    } catch {
      hash.update('<unreadable>')
    }
    hash.update('\0')
  }
  return `sha256:${hash.digest('hex')}`
}

export function treeFileDigests(root: string, options: { except?: ReadonlySet<string> } = {}): Record<string, string> {
  const files: string[] = []
  walk(root, root, files)
  const out: Record<string, string> = {}
  for (const file of files) {
    const rel = relative(root, file).split(sep).join('/')
    if (options.except?.has(rel)) continue
    try {
      out[rel] = createHash('sha256').update(readFileSync(file)).digest('hex')
    } catch {
      out[rel] = '<unreadable>'
    }
  }
  return out
}

export function folderSize(root: string): number {
  const files: string[] = []
  walk(root, root, files)
  let total = 0
  for (const file of files) {
    try {
      total += statSync(file).size
    } catch {
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
