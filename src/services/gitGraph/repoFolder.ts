import { readdirSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'

export type RepoFolder =
  | { state: 'ok'; root: string; folder: string; via: 'folder' | 'below' }
  | { state: 'refused'; folder: string; note: string }

const NAMED_AT_MOST = 8

function hasGitEntry(path: string): boolean {
  try {
    const entry = statSync(path)
    return entry.isDirectory() || entry.isFile()
  } catch {
    return false
  }
}

export function insideRepository(folder: string): boolean {
  let current = resolve(folder)
  for (;;) {
    if (hasGitEntry(join(current, '.git'))) return true
    const parent = dirname(current)
    if (parent === current) return false
    current = parent
  }
}

export function repositoriesDirectlyBelow(folder: string): string[] {
  let names: string[]
  try {
    names = readdirSync(folder, { withFileTypes: true })
      .filter(entry => entry.isDirectory() && entry.name !== '.git')
      .map(entry => entry.name)
  } catch {
    return []
  }
  return names.filter(name => hasGitEntry(join(folder, name, '.git'))).sort()
}

export function resolveRepoFolder(folder: string): RepoFolder {
  if (insideRepository(folder)) return { state: 'ok', root: folder, folder, via: 'folder' }
  const below = repositoriesDirectlyBelow(folder)
  if (below.length === 1) return { state: 'ok', root: join(folder, below[0]!), folder, via: 'below' }
  if (below.length === 0) {
    return {
      state: 'refused',
      folder,
      note: `no git repository at ${folder}, above it, or directly below it — pass cwd naming a repository folder`,
    }
  }
  const named = below.slice(0, NAMED_AT_MOST).join(', ') + (below.length > NAMED_AT_MOST ? ` and ${below.length - NAMED_AT_MOST} more` : '')
  return {
    state: 'refused',
    folder,
    note: `${folder} is not inside a git repository and holds ${below.length} repositories directly below it: ${named} — pass cwd naming one`,
  }
}
