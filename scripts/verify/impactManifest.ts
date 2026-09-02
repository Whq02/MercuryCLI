//  (`# gate-watch: <glob> …`, repeatable), each suite implicitly watches its
import { readdirSync, readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'

export interface ImpactManifest {
  watches: Record<string, string[]>
  ignores: string[]
  suites: string[]
  /** suite → declared `# gate-class:` (absent/invalid ⇒ 'undeclared' — the
   *  scheduler and the slice estimator both treat that as pty-conservative).
   *  Optional so synthetic fixture manifests stay minimal; loadImpactManifest
   *  always fills it. */
  classes?: Record<string, string>
}

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

/** The suite's declared `# gate-class:` — same header discipline as the
 *  scheduler's suite_class(): first declaration wins, anything else (absent,
 *  misspelled) is 'undeclared' and schedules pty-conservative. */
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
  const ignorePath = join(root, 'scripts', 'gate', 'impact-ignore.txt')
  const ignores = existsSync(ignorePath)
    ? readFileSync(ignorePath, 'utf8')
        .split('\n')
        .map(l => l.trim())
        .filter(l => l && !l.startsWith('#'))
    : []
  return { watches, ignores, suites, classes }
}

function matchesAny(path: string, globs: string[]): boolean {
  for (const g of globs) {
    if (new Bun.Glob(g).match(path)) return true
  }
  return false
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
    for (const [dom, globs] of Object.entries(manifest.watches)) {
      if (!claimants.includes(dom) && matchesAny(path, globs)) claimants.push(dom)
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
