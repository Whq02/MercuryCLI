import { readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'

interface DoorUnits {
  heads: string[]
  partsOf(head: string): string[]
  doorOf(file: string): string | null
}

const SOURCE = /\.tsx?$/
const SKIPPED = new Set(['node_modules', '__snapshots__'])
const SPECIFIER = /(?:\bfrom\s*|\bimport\s*\(?\s*|\brequire\s*\(\s*)(['"])(\.{1,2}\/[^'"\n]+)\1/g
const TABLE = 'scripts/lib/doorUnits.tsv'

function sourcesUnder(root: string, dir: string, out: string[]): void {
  for (const name of readdirSync(join(root, dir))) {
    if (SKIPPED.has(name)) continue
    const rel = `${dir}/${name}`
    if (statSync(join(root, rel)).isDirectory()) sourcesUnder(root, rel, out)
    else if (SOURCE.test(name) && !name.endsWith('.d.ts')) out.push(rel)
  }
}

function normal(path: string): string {
  const out: string[] = []
  for (const part of path.split('/')) {
    if (part === '.' || part === '') continue
    if (part === '..') out.pop()
    else out.push(part)
  }
  return out.join('/')
}

function resolved(from: string, specifier: string, known: ReadonlySet<string>): string | null {
  const base = normal(`${dirname(from)}/${specifier}`)
  const stem = base.replace(/\.(?:js|jsx|ts|tsx|mjs)$/, '')
  for (const candidate of [base, `${stem}.ts`, `${stem}.tsx`, `${stem}/index.ts`, `${stem}/index.tsx`]) if (known.has(candidate)) return candidate
  return null
}

export function doorUnits(root: string, importersUnder: string, trees: readonly string[]): DoorUnits {
  const all: string[] = []
  sourcesUnder(root, importersUnder, all)
  const known = new Set(all)
  const tabled = new Map<string, string>()
  for (const row of readFileSync(join(import.meta.dir, 'doorUnits.tsv'), 'utf8').split('\n')) {
    if (row === '') continue
    const [door, part] = row.split('\t')
    if (door === undefined || part === undefined || !known.has(door) || !known.has(part)) throw new Error(`${TABLE}: the row "${row}" names a file that is not under ${importersUnder}/: write the door and its part at their paths with a tab between them, or delete the row of a file that is gone`)
    tabled.set(part, door)
  }
  const outside = new Map<string, Set<string>>()
  for (const file of all) {
    const text = readFileSync(join(root, file), 'utf8')
    for (const match of text.matchAll(SPECIFIER)) {
      const target = resolved(file, match[2]!, known)
      if (target === null || target === file) continue
      for (let folder = dirname(target); folder !== importersUnder && folder !== '.'; folder = dirname(folder)) {
        if (file.startsWith(`${folder}/`)) break
        let seen = outside.get(folder)
        if (seen === undefined) outside.set(folder, (seen = new Set()))
        seen.add(file)
      }
    }
  }
  const doorOfFolder = new Map<string, string>()
  for (const [folder, importers] of outside) {
    if (importers.size !== 1) continue
    const [door] = [...importers]
    if (dirname(door!) === dirname(folder)) doorOfFolder.set(folder, door!)
  }
  const doorOf = (file: string): string | null => {
    const listed = tabled.get(file)
    if (listed !== undefined) return listed
    for (let folder = dirname(file); folder !== importersUnder && folder !== '.'; folder = dirname(folder)) {
      const door = doorOfFolder.get(folder)
      if (door !== undefined) return door
    }
    return null
  }
  const inTrees = all.filter(file => trees.some(tree => file.startsWith(`${tree}/`)))
  const parts = new Map<string, string[]>()
  const heads: string[] = []
  for (const file of inTrees) {
    const door = doorOf(file)
    if (door === null) heads.push(file)
    else parts.set(door, [...(parts.get(door) ?? []), file])
  }
  const partsOf = (head: string): string[] => {
    const own = parts.get(head) ?? []
    return [...own, ...own.flatMap(part => partsOf(part))]
  }
  return { heads, partsOf, doorOf }
}
