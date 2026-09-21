export type TreeEntry = { name: string; path: string; dir: boolean }
export type TreeRow = TreeEntry & { depth: number; open: boolean }
export type GitMark = 'M' | 'U'

function byteOrder(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0
}

export function sortEntries(entries: readonly TreeEntry[]): TreeEntry[] {
  return [...entries].sort((a, b) => (a.dir === b.dir ? byteOrder(a.name, b.name) : a.dir ? -1 : 1))
}

export function childPath(parent: string, name: string): string {
  return parent === '' ? name : `${parent}/${name}`
}

export function parentPath(path: string): string {
  const cut = path.lastIndexOf('/')
  return cut === -1 ? '' : path.slice(0, cut)
}

export function flattenTree(children: ReadonlyMap<string, readonly TreeEntry[]>, open: ReadonlySet<string>): TreeRow[] {
  const rows: TreeRow[] = []
  const walk = (dir: string, depth: number): void => {
    for (const entry of children.get(dir) ?? []) {
      const isOpen = entry.dir && open.has(entry.path)
      rows.push({ ...entry, depth, open: isOpen })
      if (isOpen) walk(entry.path, depth + 1)
    }
  }
  walk('', 0)
  return rows
}

export function filterRows(rows: readonly TreeRow[], filter: string): TreeRow[] {
  const needle = filter.trim().toLowerCase()
  if (needle === '') return [...rows]
  const keep = new Set<string>()
  for (const row of rows) {
    if (!row.name.toLowerCase().includes(needle)) continue
    keep.add(row.path)
    let parent = parentPath(row.path)
    while (parent !== '') {
      keep.add(parent)
      parent = parentPath(parent)
    }
  }
  return rows.filter(row => keep.has(row.path))
}

export function parseGitMarks(porcelainZ: string, rebase: (repoPath: string) => string | null): Map<string, GitMark> {
  const marks = new Map<string, GitMark>()
  const tokens = porcelainZ.split('\0')
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i] ?? ''
    if (token === '') continue
    const status = token.slice(0, 2)
    const repoPath = token.slice(3)
    if (status[0] === 'R' || status[0] === 'C') i++
    const path = rebase(repoPath)
    if (path === null || path === '') continue
    marks.set(path, status === '??' ? 'U' : 'M')
  }
  return marks
}
