#!/usr/bin/env bun
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { buildImportGraph } from '../orphans/graph.ts'
import { loadImpactManifest, narrowedRow, NET_GLOB, RATCHETS, selectImpact } from './impactManifest.ts'
import { DEFAULT_HUB_CEILING, estimatePooledWallS, type GateClass } from './sliceCore.ts'
import { watchGraphOf } from './watchGraph.ts'

const ROOT = process.env.MERCURY_SLICE_ROOT ? resolve(process.env.MERCURY_SLICE_ROOT) : resolve(import.meta.dir, '..', '..')
const DRAW = 200
const CORES = 8
const argv = process.argv.slice(2)
const option = (name: string): string[] => {
  const at = argv.indexOf(name)
  return at === -1 ? [] : argv.slice(at + 1)
}
const detail = option('--detail')[0]
const chainOf = option('--chain')

type Suite = ReturnType<typeof watchGraphOf>['suites'][number]
type Tier = 'touched' | 'deep' | 'lazy'
type State = 'dead' | 'unread' | 'partial' | 'covered'
const TIERS = ['touched', 'deep', 'lazy'] as const

const graph = watchGraphOf(ROOT)
const tracked = graph.listed
const underSrc = tracked.filter(f => f.startsWith('src/'))
const manifest = loadImpactManifest(ROOT)
const bySuite = new Map(graph.suites.map(s => [s.suite, s]))
const classOf = (suite: string): string => manifest.classes?.[suite] ?? 'undeclared'

const globs = new Map<string, Set<string>>()
function matchesOf(pattern: string): Set<string> {
  let hit = globs.get(pattern)
  if (!hit) {
    const g = new Bun.Glob(pattern)
    hit = new Set(tracked.filter(f => g.match(f)))
    globs.set(pattern, hit)
  }
  return hit
}
const prefixLength = (glob: string): number => {
  const wild = glob.search(/[*?[{]/)
  return wild === -1 ? glob.length : wild
}
const floors = new Map<string, number>()
function floorOf(path: string): number {
  let floor = floors.get(path)
  if (floor === undefined) {
    const row = narrowedRow(manifest, path)
    floor = row === null ? 0 : prefixLength(row)
    floors.set(path, floor)
  }
  return floor
}
const doorsOf = (path: string): string[] => (manifest.doors ?? []).filter(row => row.behind !== '' && row.door !== '' && matchesOf(row.behind).has(path)).map(row => row.door)
function claimingGlob(suite: string, path: string): string | null {
  const floor = floorOf(path)
  for (const g of manifest.watches[suite] ?? []) {
    if (floor > 0 && g !== NET_GLOB && prefixLength(g) < floor) continue
    if (matchesOf(g).has(path)) return g
  }
  return null
}
const globClaims = (suite: string, path: string): boolean => claimingGlob(suite, path) !== null
const claims = (suite: string, path: string): boolean => path.startsWith(`scripts/${suite}/`) || globClaims(suite, path) || doorsOf(path).some(door => globClaims(suite, door))

const tierOf = (s: Suite, file: string): Tier | null => {
  const dep = s.deps.get(file)
  if (!dep) return null
  if (dep.how === 'lazy') return 'lazy'
  return dep.how === 'import' && dep.hops > 0 ? 'deep' : 'touched'
}
const wholeOf = (s: Suite): string[] => [...new Set(s.whole.map(w => (w.scope === '' ? '.' : w.scope)))].sort()
const walksSrc = (s: Suite): boolean => s.whole.some(w => w.scope === '' || w.scope === 'src')
const blindOf = (s: Suite): number => s.blind.imports + s.blind.paths + s.blind.children + s.blind.git
const closed = (s: Suite): boolean => s.bundle.length === 0 && s.whole.length === 0 && blindOf(s) === 0

if (chainOf.length >= 2) {
  const [suite, path] = [chainOf[0]!, chainOf[1]!]
  const s = bySuite.get(suite)
  if (!s) {
    console.log(`${suite} is no suite: scripts/${suite}/run-all.sh does not stand`)
    process.exit(2)
  }
  const runner = `scripts/${suite}/run-all.sh`
  const tier = tierOf(s, path)
  const road = (): void => {
    let at = path
    for (let guard = 0; guard < 64 && s.deps.has(at); guard++) {
      const dep = s.deps.get(at)!
      console.log(`  ${at}  [${dep.how}${dep.hops > 0 ? ` ${dep.hops}` : ''}]  from ${dep.via}`)
      if (dep.how === 'member' || dep.how === 'runner') break
      at = dep.via
    }
  }
  const glob = claimingGlob(suite, path) ?? doorsOf(path).map(door => claimingGlob(suite, door)).find(g => g !== null) ?? null
  const line = `# gate-watch: ${path}`
  if (tier === 'touched') {
    console.log(`${suite} wakes for ${path}: its proofs touch it, and the planner reads that with no header line`)
    road()
    process.exit(0)
  }
  if (path.startsWith(`scripts/${suite}/`) || glob !== null) {
    console.log(`${suite} wakes for ${path}: ${glob === null ? "the file stands in the suite's own folder" : `the header of ${runner} holds ${glob}`}`)
    road()
    process.exit(0)
  }
  console.log(`${suite} does not wake for ${path}`)
  if (tier !== null) {
    console.log(`  the reader sees a road, and no script on it names the file: it is reached ${tier === 'lazy' ? 'through an import inside a function' : `${s.deps.get(path)!.hops} import${s.deps.get(path)!.hops === 1 ? '' : 's'} into src`}`)
    road()
    console.log(`  the hand line, if a change to the file can turn a proof of the suite: "${line}" in the header of ${runner} — reason: depth`)
  } else if (s.bundle.length > 0) {
    console.log(`  the reader sees no road. ${s.bundle.length} member${s.bundle.length === 1 ? '' : 's'} of the suite run${s.bundle.length === 1 ? 's' : ''} the built bundle (${s.bundle.slice(0, 3).join(' ')}${s.bundle.length > 3 ? ' …' : ''}), which holds all of src`)
    console.log(`  the hand line, if what they drive reaches the file: "${line}" in the header of ${runner} — reason: area`)
  } else {
    console.log(`  the reader sees no road and no member that runs the built bundle. Out of its sight in this suite: ${s.blind.imports} imports and ${s.blind.paths} tree paths built at run time, ${s.blind.children} child programs that name no tracked script, ${s.blind.git} git children`)
    console.log(`  the hand line, if a proof reads the file by one of those: "${line}" in the header of ${runner} — reason: out of sight`)
  }
  console.log(`  a hand line raises the suite's row in scripts/gate/watch-hand-list.tsv by hand, in the same commit`)
  process.exit(1)
}

function headerLines(suite: string): string[][] {
  const lines: string[][] = []
  for (const line of readFileSync(join(ROOT, 'scripts', suite, 'run-all.sh'), 'utf8').split('\n')) {
    const m = /^# gate-watch:\s*(.+)$/.exec(line)
    if (m) lines.push(m[1]!.trim().split(/\s+/))
    if (line && !line.startsWith('#')) break
  }
  return lines
}

const stateOf = (pattern: string, read: (file: string) => boolean): State => {
  const hits = matchesOf(pattern)
  let n = 0
  for (const f of hits) if (read(f)) n++
  return hits.size === 0 ? 'dead' : n === 0 ? 'unread' : n === hits.size ? 'covered' : 'partial'
}

const rows = graph.suites.map(s => {
  const lines = headerLines(s.suite)
  const declared = lines.flat()
  const candidates = new Set<string>()
  for (const g of declared) for (const f of matchesOf(g)) candidates.add(f)
  for (const f of tracked) if (f.startsWith(`scripts/${s.suite}/`) || doorsOf(f).length > 0) candidates.add(f)
  let hand = 0
  for (const f of candidates) if (claims(s.suite, f)) hand++
  const tiers: Record<Tier, number> = { touched: 0, deep: 0, lazy: 0 }
  const missed: Record<Tier, string[]> = { touched: [], deep: [], lazy: [] }
  for (const file of s.deps.keys()) {
    const tier = tierOf(s, file)!
    tiers[tier]++
    if (!claims(s.suite, file)) missed[tier].push(file)
  }
  for (const tier of TIERS) missed[tier].sort()
  const far = new Map<string, State>()
  const near = new Map<string, State>()
  for (const g of new Set(declared)) {
    far.set(g, stateOf(g, f => s.deps.has(f)))
    near.set(g, stateOf(g, f => tierOf(s, f) === 'touched'))
  }
  const count = (state: State): number => declared.filter(g => far.get(g) === state).length
  return { s, lines, globs: declared, hand, tiers, missed, far, near, count }
})
type Row = (typeof rows)[number]

const out: string[] = []
const say = (line = ''): void => void out.push(line)
const sum = (list: number[]): number => list.reduce((n, x) => n + x, 0)
const quantile = (list: number[], q: number): number => {
  const sorted = [...list].sort((a, b) => a - b)
  return sorted.length === 0 ? 0 : sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))]!
}
const spread = (list: number[]): string => `median ${quantile(list, 0.5)} · p90 ${quantile(list, 0.9)} · max ${quantile(list, 1)} · none ${list.filter(n => n === 0).length} · over ${DEFAULT_HUB_CEILING}: ${list.filter(n => n > DEFAULT_HUB_CEILING).length}`
const tallyOf = (list: string[]): string => {
  const counts = new Map<string, number>()
  for (const item of list) counts.set(item, (counts.get(item) ?? 0) + 1)
  return [...counts]
    .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))
    .map(([name, n]) => `${name} ${n}`)
    .join(' · ')
}

const total = (label: string, set: Row[]): void => {
  const pairs = (tier: Tier): number => sum(set.map(r => r.missed[tier].length))
  const distinct = (tier: Tier): number => new Set(set.flatMap(r => r.missed[tier])).size
  const everyGlob = set.flatMap(r => r.globs)
  const states = (pick: (r: Row) => Map<string, State>): string => tallyOf(set.flatMap(r => r.globs.map(g => pick(r).get(g)!)))
  const lineState = (r: Row, line: string[]): string => (line.every(g => r.near.get(g) === 'covered') ? 'every glob covered by touched files' : line.some(g => r.far.get(g) === 'unread' || r.far.get(g) === 'dead') ? 'holds a glob nothing reads' : 'wider than the touched files')
  say(`### ${label}`)
  say()
  say(`- suites ${set.length} · members ${sum(set.map(r => r.s.members.length))} · watch lines ${sum(set.map(r => r.lines.length))} · globs ${everyGlob.length} (${new Set(everyGlob).size} distinct)`)
  say(`- files a header claims, summed over suites: ${sum(set.map(r => r.hand))} · files a suite depends on, summed: ${sum(set.map(r => r.s.deps.size))} (touched ${sum(set.map(r => r.tiers.touched))} · deep ${sum(set.map(r => r.tiers.deep))} · lazy ${sum(set.map(r => r.tiers.lazy))})`)
  say(`- missed, touched: ${pairs('touched')} suite-and-file pairs over ${distinct('touched')} files in ${set.filter(r => r.missed.touched.length > 0).length} suites`)
  say(`  - by how the suite reaches the file: ${tallyOf(set.flatMap(r => r.missed.touched.map(f => r.s.deps.get(f)!.how)))}`)
  say(`  - by where the file is: ${tallyOf(set.flatMap(r => r.missed.touched.map(f => (f.includes('/') ? f.split('/')[0]! : 'the root'))))}`)
  const inSrc = set.flatMap(r => r.missed.touched.filter(f => f.startsWith('src/')).map(f => ({ r, f, near: r.s.members.includes(r.s.deps.get(f)!.via) || r.s.deps.get(f)!.via.startsWith(`scripts/${r.s.suite}/`) })))
  say(`  - under src alone: ${inSrc.length} pairs over ${new Set(inSrc.map(p => p.f)).size} files in ${new Set(inSrc.map(p => p.r.s.suite)).size} suites`)
  say(`    - reached from a member or a script in the suite's own folder: ${inSrc.filter(p => p.near).length}, of which ${inSrc.filter(p => p.near && !walksSrc(p.r.s)).length} in suites that do not walk src · reached from a script elsewhere: ${inSrc.filter(p => !p.near).length}, of which ${inSrc.filter(p => !p.near && !walksSrc(p.r.s)).length} in suites that do not walk src`)
  say(`    - by how: ${tallyOf(inSrc.map(p => p.r.s.deps.get(p.f)!.how))}`)
  say(`- missed, deep: ${pairs('deep')} pairs over ${distinct('deep')} files in ${set.filter(r => r.missed.deep.length > 0).length} suites`)
  say(`- missed, lazy: ${pairs('lazy')} pairs over ${distinct('lazy')} files in ${set.filter(r => r.missed.lazy.length > 0).length} suites`)
  say(`- header globs against every file the suite depends on: ${states(r => r.far)}`)
  say(`- header globs against the files its scripts touch: ${states(r => r.near)}`)
  say(`- watch lines: ${tallyOf(set.flatMap(r => r.lines.map(line => lineState(r, line))))}`)
  say(`- suites with a member that reaches the built bundle: ${set.filter(r => r.s.bundle.length > 0).length} (${sum(set.map(r => r.s.bundle.length))} of ${sum(set.map(r => r.s.members.length))} members) · suites that walk all of src or the whole tree: ${set.filter(r => walksSrc(r.s)).length} · suites that walk all of scripts: ${set.filter(r => r.s.whole.some(w => w.scope === 'scripts')).length}`)
  say(`- out of the reader's sight, summed: imports built at run time ${sum(set.map(r => r.s.blind.imports))} · tree paths built at run time ${sum(set.map(r => r.s.blind.paths))} · child programs that name no tracked script ${sum(set.map(r => r.s.blind.children))} · git children ${sum(set.map(r => r.s.blind.git))}`)
  say(`- suites with none of these, no bundle and no whole-tree walk: ${set.filter(r => closed(r.s)).length} (${set.filter(r => closed(r.s)).map(r => r.s.suite).join(' ') || 'none'}) · suites with no bundle and no walk of src: ${set.filter(r => r.s.bundle.length === 0 && !walksSrc(r.s)).length}`)
  say()
}

const pure = rows.filter(r => classOf(r.s.suite) === 'pure')
const sameGraph = (() => {
  const theirs = buildImportGraph()
  const prefix = `${theirs.root}/`
  const targets = new Map<string, Set<string>>()
  for (const e of theirs.edges) {
    if (!e.resolved) continue
    const from = e.from.slice(prefix.length)
    targets.set(from, (targets.get(from) ?? new Set()).add(e.resolved.slice(prefix.length)))
  }
  let same = 0
  const differ: string[] = []
  for (const abs of theirs.files) {
    const rel = abs.slice(prefix.length)
    const mine = new Set(graph.targets(rel))
    const other = targets.get(rel) ?? new Set<string>()
    if (mine.size === other.size && [...mine].every(t => other.has(t))) same++
    else differ.push(`${rel} (+${[...mine].filter(t => !other.has(t)).length} −${[...other].filter(t => !mine.has(t)).length})`)
  }
  return { files: theirs.files.length, edges: theirs.edges.filter(e => e.resolved).length, same, differ }
})()

say('# The watch computed from the proofs beside the watch written by hand')
say()
say('Written by `bun scripts/verify/watch-report.ts`. It reads the tree and changes nothing.')
say()
say('## What was read')
say()
say(`- files git lists in the work tree ${tracked.length} · under src ${underSrc.length} · under scripts ${tracked.filter(f => f.startsWith('scripts/')).length}`)
say(`- suites ${rows.length} · by class: ${[...new Set(rows.map(r => classOf(r.s.suite)))].sort().map(c => `${c} ${rows.filter(r => classOf(r.s.suite) === c).length}`).join(' · ')}`)
say(`- the module graph: ${graph.files.src} files under src and ${graph.files.other} outside it read, ${graph.edges} resolved edges, ${graph.unread.length} files that did not parse`)
say(`- the text fence's reader (scripts/lib/sourceTextReads.ts, called here): ${graph.fence.opened} src files opened as text and ${graph.fence.onlyNamed} only named, by ${graph.fence.scripts} scripts`)
say(`- beside scripts/orphans/graph.ts on src: ${sameGraph.files} files, ${sameGraph.edges} resolved edges there; the targets of ${sameGraph.same} files are the same here, ${sameGraph.differ.length} differ${sameGraph.differ.length > 0 ? `: ${sameGraph.differ.slice(0, 6).join(', ')}${sameGraph.differ.length > 6 ? ', …' : ''}` : ''}`)
say()
say('## Words')
say()
say('- **member**: a file the runner launches (the class census reads the runner). **touched**: a file a member or a script it reaches imports, runs, names as text or walks, and a src file such a script imports itself. **deep**: a src file reached only through other src files, by imports that load with the module. **lazy**: a src file reached only through an import inside a function.')
say("- **hand**: the tracked files the header claims, by the planner's rule (the suite's own folder, its globs under the narrowing list, the doors). **missed**: files the suite depends on that the header does not claim. **covered / partial / unread**: a header glob whose matches are all, some or none of the files the suite depends on.")
say('- **bundle**: members with a road to dist/mercury.mjs over all members; such a member depends on all of src, and that is not in the file counts. **whole**: the scopes a member walks whole (`.` the tree, `src`, `scripts`); not in the file counts either. **blind**: i imports whose specifier is built at run time, p reads of a tree path built at run time, c child programs that name no tracked script, g git children.')
say()
say('## Every suite')
say()
say('| suite | class | members | lines | globs | hand | computed | touched | deep | lazy | missed touched | missed deep | missed lazy | covered | partial | unread | bundle | whole | blind |')
say('|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---|---|')
for (const r of rows) {
  const b = r.s.blind
  say(
    `| ${r.s.suite} | ${classOf(r.s.suite)} | ${r.s.members.length} | ${r.lines.length} | ${r.globs.length} | ${r.hand} | ${r.s.deps.size} | ${r.tiers.touched} | ${r.tiers.deep} | ${r.tiers.lazy} | ${r.missed.touched.length} | ${r.missed.deep.length} | ${r.missed.lazy.length} | ${r.count('covered')} | ${r.count('partial')} | ${r.count('unread') + r.count('dead')} | ${r.s.bundle.length}/${r.s.members.length} | ${wholeOf(r.s).join(' ') || '-'} | i${b.imports} p${b.paths} c${b.children} g${b.git} |`,
  )
}
say()
say('## Totals')
say()
total('The tree', rows)
total('The pure suites', pure)

const durations: Record<string, number> = {}
for (const line of readFileSync(join(ROOT, 'scripts', 'gate', 'duration-seed.tsv'), 'utf8').split('\n')) {
  const m = /^([A-Za-z0-9-]+)\t(\d+)$/.exec(line)
  if (m) durations[m[1]!] = Number(m[2])
}
const classes = (manifest.classes ?? {}) as Record<string, GateClass>
const owed = RATCHETS.filter(suite => manifest.suites.includes(suite))
const wall = (suites: string[]): number => estimatePooledWallS([...new Set([...suites, ...owed])], { durations, classes, cores: CORES, ptyMax: 3 })
const fullWall = estimatePooledWallS(manifest.suites, { durations, classes, cores: CORES, ptyMax: 3 })

const within = (path: string, limit: number, lazy: boolean): string[] =>
  rows
    .filter(r => {
      const dep = r.s.deps.get(path)
      return dep !== undefined && (dep.how === 'lazy' ? lazy : dep.how !== 'import' || dep.hops <= limit)
    })
    .map(r => r.s.suite)
const handOf = (paths: string[]): Map<string, string[]> => {
  const picked = selectImpact(manifest, paths)
  return new Map(paths.map(path => [path, (picked.perPath[path] ?? []).filter(c => !c.startsWith('(')).sort()]))
}

const drawn = Array.from({ length: Math.min(DRAW, underSrc.length) }, (_, i) => underSrc[Math.floor((i * underSrc.length) / DRAW)]!)
const drawnHand = handOf(drawn)
const netSuites = rows.filter(r => r.globs.includes(NET_GLOB)).map(r => r.s.suite)
const bundleSuites = rows.filter(r => r.s.bundle.length > 0).map(r => r.s.suite)
const walkSuites = rows.filter(r => walksSrc(r.s)).map(r => r.s.suite)
const changes = drawn.map(path => {
  const hand = drawnHand.get(path)!
  const mine = rows.filter(r => claims(r.s.suite, path)).map(r => r.s.suite)
  const touched = within(path, 0, false)
  const every = within(path, Infinity, true)
  const withBundle = [...new Set([...every, ...bundleSuites])]
  return { path, hand, agrees: mine.join(' ') === hand.join(' '), touched, one: within(path, 1, false), two: within(path, 2, false), three: within(path, 3, false), eager: within(path, Infinity, false), every, withBundle, withWalk: [...new Set([...withBundle, ...walkSuites])] }
})

say('## From a change')
say()
say(`The draw: the ${underSrc.length} tracked files under src in the order git lists them, file number floor(i × ${underSrc.length} / ${DRAW}) for i from 0 to ${DRAW - 1}. **hand** is what \`bun scripts/verify/impact.ts --paths <path>\` wakes beside the ratchets (the same function, called here; this report's own reading of the headers agrees on ${changes.filter(c => c.agrees).length} of ${changes.length} paths). The other columns are the suites that depend on the path: **touched**, then with deep files one, two and three imports into src, then every import that loads with the module (**eager**), then with lazy imports (**all**), then with every suite that runs the bundle, then with every suite that walks src. **hand only** and **touched only** count the suites one of the two maps wakes and the other does not.`)
say()
say('| path | hand | touched | ≤1 | ≤2 | ≤3 | eager | all | +bundle | +walk | hand only | touched only |')
say('|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|')
for (const c of changes) {
  const handOnly = c.hand.filter(s => !c.touched.includes(s)).length
  const touchedOnly = c.touched.filter(s => !c.hand.includes(s)).length
  say(`| ${c.path} | ${c.hand.length} | ${c.touched.length} | ${c.one.length} | ${c.two.length} | ${c.three.length} | ${c.eager.length} | ${c.every.length} | ${c.withBundle.length} | ${c.withWalk.length} | ${handOnly} | ${touchedOnly} |`)
}
say()
say('### What a change wakes')
say()
const relation = (c: (typeof changes)[number]): string => {
  const less = c.hand.some(s => !c.touched.includes(s))
  const more = c.touched.some(s => !c.hand.includes(s))
  return less && more ? 'other' : less ? 'fewer' : more ? 'more' : 'same'
}
const tally = (name: string): number => changes.filter(c => relation(c) === name).length
const withNet = (list: string[]): string[] => [...new Set([...list, ...netSuites])]
say(`- hand: ${spread(changes.map(c => c.hand.length))}`)
say(`- touched: ${spread(changes.map(c => c.touched.length))}`)
say(`- touched and the ${netSuites.length} suites whose header holds ${NET_GLOB} (${netSuites.join(' ')}): ${spread(changes.map(c => withNet(c.touched).length))}`)
say(`- one import into src: ${spread(changes.map(c => c.one.length))}`)
say(`- two: ${spread(changes.map(c => c.two.length))}`)
say(`- three: ${spread(changes.map(c => c.three.length))}`)
say(`- eager: ${spread(changes.map(c => c.eager.length))}`)
say(`- all: ${spread(changes.map(c => c.every.length))}`)
say(`- with the bundle: ${spread(changes.map(c => c.withBundle.length))}`)
say(`- with the walks: ${spread(changes.map(c => c.withWalk.length))}`)
say(`- touched against hand, path by path: the same suites ${tally('same')} · fewer (a subset) ${tally('fewer')} · more (a superset) ${tally('more')} · some of each ${tally('other')}`)
say(`- suites the hand map wakes and no touched file explains, summed over the paths: ${sum(changes.map(c => c.hand.filter(s => !c.touched.includes(s)).length))} · suites that touch the path and the hand map does not wake: ${sum(changes.map(c => c.touched.filter(s => !c.hand.includes(s)).length))} on ${changes.filter(c => c.touched.some(s => !c.hand.includes(s))).length} paths`)
const sliceOf = (list: string[][]): string => {
  const run = list.filter(suites => suites.length <= DEFAULT_HUB_CEILING)
  return `${list.length - run.length} of ${list.length} paths go to the full run; the other ${run.length} run a slice of median ${quantile(run.map(wall), 0.5)} s, p90 ${quantile(run.map(wall), 0.9)} s`
}
say(`- the planner's hub rule (a path that wakes more than ${DEFAULT_HUB_CEILING} suites goes to the full run), with the ${owed.length} ratchets, the seeded durations and ${CORES} cores, the full run estimated at ${fullWall} s: hand, ${sliceOf(changes.map(c => c.hand))}`)
say(`- the same with touched and the net: ${sliceOf(changes.map(c => withNet(c.touched)))}`)
say(`- the same with one import into src and the net: ${sliceOf(changes.map(c => withNet(c.one)))}`)
say(`- the paths that more than ${DEFAULT_HUB_CEILING} suites touch: ${changes.filter(c => c.touched.length > DEFAULT_HUB_CEILING).map(c => `${c.path} (${c.touched.length})`).join(' · ') || 'none'}`)
say()
say('### The narrowed areas')
say()
say('| row of scripts/gate/impact-narrowed.txt | files | hand, median | hand, max | touched, median | touched, max | touched and not woken |')
say('|---|---:|---:|---:|---:|---:|---:|')
for (const area of manifest.narrowed ?? []) {
  const files = [...matchesOf(area)].sort()
  const hand = handOf(files)
  const touched = files.map(f => within(f, 0, false))
  const stray = sum(files.map((f, i) => touched[i]!.filter(s => !hand.get(f)!.includes(s)).length))
  say(`| ${area} | ${files.length} | ${quantile(files.map(f => hand.get(f)!.length), 0.5)} | ${quantile(files.map(f => hand.get(f)!.length), 1)} | ${quantile(touched.map(t => t.length), 0.5)} | ${quantile(touched.map(t => t.length), 1)} | ${stray} |`)
}
say()

const text = out.join('\n') + '\n'
if (detail) {
  mkdirSync(detail, { recursive: true })
  const tsv = (name: string, lines: string[]): void => writeFileSync(join(detail, name), lines.join('\n') + '\n')
  tsv('missed-touched.tsv', ['suite\tclass\tfile\thow\tfrom', ...rows.flatMap(r => r.missed.touched.map(f => `${r.s.suite}\t${classOf(r.s.suite)}\t${f}\t${r.s.deps.get(f)!.how}\t${r.s.deps.get(f)!.via}`))])
  tsv('missed-deep.tsv', ['suite\tclass\tfile\timports into src\tfrom', ...rows.flatMap(r => r.missed.deep.filter(f => r.s.deps.get(f)!.hops === 1).map(f => `${r.s.suite}\t${classOf(r.s.suite)}\t${f}\t1\t${r.s.deps.get(f)!.via}`))])
  tsv('globs.tsv', ['suite\tclass\tglob\tagainst every file\tagainst touched files\tmatches', ...rows.flatMap(r => r.globs.map(g => `${r.s.suite}\t${classOf(r.s.suite)}\t${g}\t${r.far.get(g)}\t${r.near.get(g)}\t${matchesOf(g).size}`))])
  tsv('paths.tsv', ['path\thand\ttouched', ...changes.map(c => `${c.path}\t${c.hand.join(' ')}\t${c.touched.join(' ')}`)])
  tsv('roads.tsv', ['suite\tclass\tmember\tnames the bundle', ...rows.flatMap(r => r.s.bundle.map(m => `${r.s.suite}\t${classOf(r.s.suite)}\t${m}\t${r.s.naming.includes(m) ? 'itself' : 'through a file it reaches'}`))])
  tsv('whole.tsv', ['suite\tclass\tscope\tfrom', ...rows.flatMap(r => [...new Set(r.s.whole.map(w => `${r.s.suite}\t${classOf(r.s.suite)}\t${w.scope === '' ? '.' : w.scope}\t${w.via}`))].sort())])
}
process.stdout.write(text)
