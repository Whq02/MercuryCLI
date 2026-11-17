import { readdirSync, readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'

export interface ImpactManifest {
  watches: Record<string, string[]>
  ignores: string[]
  suites: string[]
  classes?: Record<string, string>
  narrowed?: string[]
  doors?: Array<{ behind: string; door: string }>
}

export const NET_GLOB = 'src/**'

export const RATCHETS = ['integrity', 'identity', 'consistency-census', 'gate', 'verify', 'ui-census', 'interaction-pure', 'tree-ownership', 'primitives-kernel', 'permissions']

export interface ImpactSelection {
  suites: Set<string>
  ignored: string[]
  unclassified: string[]
  perPath: Record<string, string[]>
}

export function parseWatchHeader(runnerText: string): string[] {
  const globs: string[] = []
  for (const line of runnerText.split('\n')) {
    const m = line.match(/^# gate-watch:\s*(.+)$/)
    if (m) globs.push(...m[1]!.trim().split(/\s+/))
    if (line && !line.startsWith('#')) break
  }
  return globs
}

export function parseClassHeader(runnerText: string): string {
  for (const line of runnerText.split('\n')) {
    const m = line.match(/^# gate-class:\s*(\S+)/)
    if (m) {
      const c = m[1]!.trim()
      return c === 'pure' || c === 'cpu' || c === 'pty' || c === 'exclusive' ? c : 'undeclared'
    }
    if (line && !line.startsWith('#')) break
  }
  return 'undeclared'
}

function declaredRows(path: string): string[] {
  if (!existsSync(path)) return []
  return readFileSync(path, 'utf8')
    .split('\n')
    .map(l => l.trim())
    .filter(l => l && !l.startsWith('#'))
}

export function loadImpactManifest(root: string): ImpactManifest {
  const watches: Record<string, string[]> = {}
  const classes: Record<string, string> = {}
  const suites: string[] = []
  const scriptsDir = join(root, 'scripts')
  for (const dom of readdirSync(scriptsDir).sort()) {
    const runner = join(scriptsDir, dom, 'run-all.sh')
    if (!existsSync(runner)) continue
    suites.push(dom)
    const text = readFileSync(runner, 'utf8')
    const globs = parseWatchHeader(text)
    if (globs.length > 0) watches[dom] = globs
    classes[dom] = parseClassHeader(text)
  }
  const ignores = declaredRows(join(root, 'scripts', 'gate', 'impact-ignore.txt'))
  const narrowed = declaredRows(join(root, 'scripts', 'gate', 'impact-narrowed.txt'))
  const doors = declaredRows(join(root, 'scripts', 'gate', 'impact-doors.txt')).map(row => {
    const [behind = '', door = ''] = row.split(/\s+/)
    return { behind, door }
  })
  return { watches, ignores, suites, classes, narrowed, doors }
}

function matchesAny(path: string, globs: string[]): boolean {
  for (const g of globs) {
    if (new Bun.Glob(g).match(path)) return true
  }
  return false
}

function literalPrefix(glob: string): string {
  const wild = glob.search(/[*?[{]/)
  return wild === -1 ? glob : glob.slice(0, wild)
}

export function narrowedRow(manifest: ImpactManifest, path: string): string | null {
  let row: string | null = null
  let floor = 0
  for (const area of manifest.narrowed ?? []) {
    const prefix = literalPrefix(area)
    if (prefix.length > floor && path.startsWith(prefix) && new Bun.Glob(area).match(path)) {
      row = area
      floor = prefix.length
    }
  }
  return row
}

export function watchClaims(manifest: ImpactManifest, suite: string, path: string): boolean {
  const row = narrowedRow(manifest, path)
  const floor = row === null ? 0 : literalPrefix(row).length
  for (const g of manifest.watches[suite] ?? []) {
    if (floor > 0 && g !== NET_GLOB && literalPrefix(g).length < floor) continue
    if (new Bun.Glob(g).match(path)) return true
  }
  return false
}

export function doorsOf(manifest: ImpactManifest, path: string): string[] {
  return (manifest.doors ?? []).filter(row => row.behind !== '' && row.door !== '' && new Bun.Glob(row.behind).match(path)).map(row => row.door)
}

export function selectImpact(manifest: ImpactManifest, paths: string[]): ImpactSelection {
  const suites = new Set<string>()
  const ignored: string[] = []
  const unclassified: string[] = []
  const perPath: Record<string, string[]> = {}
  for (const path of paths) {
    const claimants: string[] = []
    const self = path.match(/^scripts\/([A-Za-z0-9_-]+)\//)
    if (self && manifest.suites.includes(self[1]!)) claimants.push(self[1]!)
    const doors = doorsOf(manifest, path)
    for (const dom of Object.keys(manifest.watches)) {
      if (claimants.includes(dom)) continue
      if (watchClaims(manifest, dom, path) || doors.some(door => watchClaims(manifest, dom, door))) claimants.push(dom)
    }
    if (claimants.length > 0) {
      for (const c of claimants) suites.add(c)
      perPath[path] = claimants
    } else if (matchesAny(path, manifest.ignores)) {
      ignored.push(path)
      perPath[path] = ['(ignored)']
    } else {
      unclassified.push(path)
      perPath[path] = ['(UNCLASSIFIED)']
    }
  }
  return { suites, ignored, unclassified, perPath }
}
