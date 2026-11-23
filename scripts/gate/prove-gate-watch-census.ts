#!/usr/bin/env bun
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, relative, resolve } from 'node:path'
import { loadImpactManifest, NET_GLOB, selectImpact, type ImpactManifest } from '../verify/impactManifest.ts'
import { computedWatch, watchGraphOf } from '../verify/watchGraph.ts'
import { slash } from './sourceCensus.ts'

const REAL_ROOT = resolve(import.meta.dir, '..', '..')
const SELF = 'scripts/gate/prove-gate-watch-census.ts'
const TABLE = 'scripts/gate/watch-hand-list.tsv'
const REPORT = process.argv.includes('--report')
const WRITE = process.argv.includes('--write')
const CUT = process.argv.includes('--cut')
const CHAIN = 'bun scripts/verify/watch-report.ts --chain <suite> <path>'
const HAND_LAW =
  "a header line stands only for what the reader of a suite's proofs cannot see: an area a member that runs the built bundle covers, a file one import or more into src, a path built at run time, or a wildcard kept for future paths; what a proof imports, runs, names or walks wakes its suite with no line"

type Reason = 'bundle' | 'deep' | 'future' | 'lazy' | 'unseen'
const REASONS = new Set<string>(['bundle', 'deep', 'future', 'lazy', 'unseen'])

type Graph = ReturnType<typeof watchGraphOf>
type GraphSuite = Graph['suites'][number]
type Glob = {
  glob: string
  line: number
  index: number
  matches: number
  covered: boolean
  redundant: boolean
  duplicateOf: number | null
  reason: Reason
}
type SuiteRow = { suite: string; globs: Glob[] }
type Miss = { law: 1 | 2; suite: string; text: string }
type Census = { suites: SuiteRow[]; misses: Miss[] }
type TableRow = { count: number; reason: string }
type Table = Map<string, TableRow>
type Over = { suite: string; now: number; row: number; covered: Glob[]; hand: Glob[] }
type Cut = { runner: string; line: number; gone: string[]; left: string[] }

const isWild = (glob: string): boolean => /[*?[{]/.test(glob)

const literalPrefix = (glob: string): string => {
  const wild = glob.search(/[*?[{]/)
  return wild === -1 ? glob : glob.slice(0, wild)
}

function blockedByNarrowed(narrowed: string[], narrow: string, wide: string): boolean {
  if (wide === NET_GLOB) return false
  const widePrefix = literalPrefix(wide)
  const narrowPrefix = literalPrefix(narrow)
  for (const row of narrowed) {
    const rowPrefix = literalPrefix(row)
    if (widePrefix.length >= rowPrefix.length) continue
    if (rowPrefix.startsWith(narrowPrefix) || narrowPrefix.startsWith(rowPrefix)) return true
  }
  return false
}

function siblingSubsumes(glob: string, peers: Set<string>, narrowed: string[]): boolean {
  for (const other of peers) {
    if (other === glob || !other.endsWith('/**')) continue
    const dir = other.slice(0, -3)
    if (isWild(dir) || !glob.startsWith(`${dir}/`)) continue
    if (!blockedByNarrowed(narrowed, glob, other)) return true
  }
  return false
}

function bundledOf(tracked: string[], targets: (rel: string) => string[]): Set<string> {
  const bundled = new Set<string>()
  const queue = ['src/boot/main.tsx', 'src/daemon/runner/runHeadless.ts'].filter(f => tracked.includes(f))
  for (const f of queue) bundled.add(f)
  while (queue.length > 0) {
    for (const to of targets(queue.pop()!)) {
      if (bundled.has(to)) continue
      bundled.add(to)
      queue.push(to)
    }
  }
  return bundled
}

function reasonOf(
  hits: string[],
  touched: Set<string>,
  own: string,
  suiteNode: GraphSuite | undefined,
  bundled: Set<string>,
  futureOnly: boolean,
): Reason {
  if (futureOnly) return 'future'
  if (hits.length === 0) return 'unseen'
  let deep = 0
  let lazy = 0
  let viaBundle = 0
  let unseen = 0
  for (const f of hits) {
    if (touched.has(f) || f.startsWith(own)) continue
    const dep = suiteNode?.deps.get(f)
    if (dep && dep.how === 'import') deep++
    else if (dep) lazy++
    else if ((suiteNode?.bundle.length ?? 0) > 0 && bundled.has(f)) viaBundle++
    else unseen++
  }
  if (unseen > 0) return 'unseen'
  if (viaBundle > 0) return 'bundle'
  if (lazy > 0) return 'lazy'
  return 'deep'
}

function trackedOf(root: string): string[] {
  return execFileSync('git', ['ls-files', '-z'], { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
    .split('\0')
    .filter(Boolean)
    .map(slash)
}

function walkAll(root: string): string[] {
  const out: string[] = []
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir).sort()) {
      const full = join(dir, name)
      if (statSync(full).isDirectory()) walk(full)
      else out.push(slash(relative(root, full)))
    }
  }
  walk(root)
  return out
}

function census(
  root: string,
  tracked: string[],
  manifest: ImpactManifest,
  computed: Record<string, string[]>,
  graph: Graph | null,
): Census {
  const misses: Miss[] = []
  const suites: SuiteRow[] = []
  const matching = new Map<string, string[]>()
  const bySuite = graph === null ? null : new Map(graph.suites.map(s => [s.suite, s]))
  const bundled = graph === null ? null : bundledOf(tracked, graph.targets)
  const narrowed = manifest.narrowed ?? []
  const matchesOf = (glob: string): string[] => {
    let hit = matching.get(glob)
    if (!hit) {
      const g = new Bun.Glob(glob)
      hit = tracked.filter(t => g.match(t))
      matching.set(glob, hit)
    }
    return hit
  }
  for (const suite of manifest.suites) {
    const runner = `scripts/${suite}/run-all.sh`
    const touched = new Set(computed[suite] ?? [])
    const own = `scripts/${suite}/`
    const suiteNode = bySuite?.get(suite)
    const raw: Array<{ glob: string; line: number; index: number }> = []
    let header = true
    readFileSync(join(root, runner), 'utf8')
      .split('\n')
      .forEach((line, i) => {
        if (header && line !== '' && !line.startsWith('#')) header = false
        const watch = /^# gate-watch:\s*(.+)$/.exec(line)
        if (!watch) return
        if (!header) {
          misses.push({ law: 1, suite, text: `${runner}:${i + 1}: a gate-watch line below the header block is never read` })
          return
        }
        watch[1]!
          .trim()
          .split(/\s+/)
          .forEach((glob, index) => raw.push({ glob, line: i + 1, index }))
      })
    const peers = new Set(raw.map(r => r.glob))
    const seenAt = new Map<string, number>()
    const globs: Glob[] = []
    for (const entry of raw) {
      const { glob, line, index } = entry
      const firstLine = seenAt.get(glob) ?? null
      if (firstLine === null) seenAt.set(glob, line)
      const hits = matchesOf(glob)
      const covered = hits.length > 0 && hits.every(file => touched.has(file) || file.startsWith(own))
      const futureSafe = !isWild(glob) || glob.startsWith(own) || siblingSubsumes(glob, peers, narrowed)
      const redundant = firstLine === null && covered && futureSafe
      const futureOnly = firstLine === null && covered && !futureSafe
      const reason = bundled === null ? (futureOnly ? 'future' : 'unseen') : reasonOf(hits, touched, own, suiteNode, bundled, futureOnly)
      globs.push({ glob, line, index, matches: hits.length, covered, redundant, duplicateOf: firstLine, reason })
      if (firstLine !== null) {
        misses.push({ law: 2, suite, text: `${runner}:${line}: duplicate gate-watch ${glob} (first on line ${firstLine}); run bun ${SELF} --cut` })
      } else if (redundant) {
        misses.push({ law: 2, suite, text: `${runner}:${line}: redundant gate-watch ${glob} (${hits.length} file${hits.length === 1 ? '' : 's'}, covered by computed watch); run bun ${SELF} --cut` })
      }
      if (hits.length > 0) continue
      if (glob.split('/')[0] === 'sdk' && !tracked.some(t => t.startsWith('sdk/'))) continue
      misses.push({ law: 1, suite, text: `${runner}: gate-watch ${glob} matches no tracked path` })
    }
    suites.push({ suite, globs })
  }
  return { suites, misses }
}

function tableOf(text: string): Table | null {
  const table: Table = new Map()
  for (const line of text.split('\n')) {
    if (line === '') continue
    const m = /^([A-Za-z0-9_-]+)\t([1-9][0-9]*)\t([a-z]+(?:,[a-z]+)*)$/.exec(line)
    if (!m || table.has(m[1]!)) return null
    const words = m[3]!.split(',')
    if (words.some(w => !REASONS.has(w)) || new Set(words).size !== words.length) return null
    table.set(m[1]!, { count: Number(m[2]), reason: m[3]! })
  }
  return table
}

const suiteReason = (s: SuiteRow): string => {
  const tags = [...new Set(s.globs.filter(g => g.duplicateOf === null && !g.redundant).map(g => g.reason))].sort()
  return tags.length > 0 ? tags.join(',') : 'unseen'
}

const render = (suites: SuiteRow[]): string =>
  suites
    .filter(s => s.globs.length > 0)
    .sort((a, b) => (a.suite < b.suite ? -1 : 1))
    .map(s => `${s.suite}\t${s.globs.length}\t${suiteReason(s)}\n`)
    .join('')

function judge(suites: SuiteRow[], table: Table): { over: Over[]; globs: number; covered: number; redundant: number; future: number; duplicates: number; allowed: number; slack: number } {
  const over: Over[] = []
  let globs = 0
  let covered = 0
  let redundant = 0
  let future = 0
  let duplicates = 0
  for (const s of suites) {
    globs += s.globs.length
    covered += s.globs.filter(g => g.covered).length
    redundant += s.globs.filter(g => g.redundant).length
    future += s.globs.filter(g => g.duplicateOf === null && g.covered && !g.redundant).length
    duplicates += s.globs.filter(g => g.duplicateOf !== null).length
    const row = table.get(s.suite)?.count ?? 0
    if (s.globs.length > row) over.push({ suite: s.suite, now: s.globs.length, row, covered: s.globs.filter(g => g.redundant), hand: s.globs.filter(g => !g.redundant) })
  }
  let allowed = 0
  let slack = 0
  for (const [suite, row] of table) {
    allowed += row.count
    if ((suites.find(s => s.suite === suite)?.globs.length ?? 0) < row.count) slack++
  }
  return { over, globs, covered, redundant, future, duplicates, allowed, slack }
}

const WRITE_WORDS = `bun ${SELF} --write lowers a row and never raises or adds one`

function told(o: Over): string {
  const runner = `scripts/${o.suite}/run-all.sh`
  const names = (list: Glob[]): string =>
    list.slice(0, 24).map(g => `\n      ${runner}:${g.line} ${g.glob} (${g.matches} file${g.matches === 1 ? '' : 's'})`).join('') +
    (list.length > 24 ? `\n      … and ${list.length - 24} more` : '')
  const needless =
    o.covered.length === 0
      ? ''
      : `\n    ${o.covered.length} of its globs the computation covers: the suite's proofs touch every file each of them matches, so the suite wakes with no line (${CHAIN} prints the road). If the new line is one of these, take it out:${names(o.covered)}`
  const held =
    o.hand.length === 0
      ? ''
      : `\n    ${o.hand.length} it does not cover. If the new line is one of these, ${CHAIN} says which of the three it stands for; a line that must stand raises the suite's row by hand in the same commit, where the diff shows it:${names(o.hand)}`
  return `${runner} holds ${o.now} watch globs and ${o.row === 0 ? 'has no row' : `its row in ${TABLE} allows ${o.row}`}: a line was added. ${HAND_LAW}.${needless}${held}`
}

function cutsOf(root: string, suites: SuiteRow[]): Cut[] {
  const cuts: Cut[] = []
  for (const s of suites) {
    const runner = `scripts/${s.suite}/run-all.sh`
    const drop = new Map<number, Set<number>>()
    for (const g of s.globs) {
      if (g.duplicateOf !== null || g.redundant) {
        const at = drop.get(g.line) ?? new Set<number>()
        at.add(g.index)
        drop.set(g.line, at)
      }
    }
    if (drop.size === 0) continue
    const lines = readFileSync(join(root, runner), 'utf8').split('\n')
    for (const [line, indices] of [...drop].sort((a, b) => a[0] - b[0])) {
      const globs = /^# gate-watch:\s*(.+)$/.exec(lines[line - 1]!)![1]!.trim().split(/\s+/)
      cuts.push({
        runner,
        line,
        gone: globs.filter((_, idx) => indices.has(idx)),
        left: globs.filter((_, idx) => !indices.has(idx)),
      })
    }
  }
  return cuts
}

function applyCuts(root: string, cuts: Cut[]): void {
  const byRunner = new Map<string, Cut[]>()
  for (const cut of cuts) byRunner.set(cut.runner, [...(byRunner.get(cut.runner) ?? []), cut])
  for (const [runner, list] of byRunner) {
    const lines: Array<string | null> = readFileSync(join(root, runner), 'utf8').split('\n')
    for (const cut of list) lines[cut.line - 1] = cut.left.length === 0 ? null : `# gate-watch: ${cut.left.join(' ')}`
    writeFileSync(join(root, runner), lines.filter(line => line !== null).join('\n'))
  }
}

const claimantsOf = (root: string, tracked: string[], computed: Record<string, string[]>): string => {
  const picked = selectImpact(loadImpactManifest(root, computed), tracked)
  return tracked.map(path => `${path}\t${[...(picked.perPath[path] ?? [])].sort().join(' ')}`).join('\n')
}

function selfTest(): boolean {
  const root = mkdtempSync(join(tmpdir(), 'gate-watch-census-'))
  const w = (rel: string, body: string): void => {
    mkdirSync(dirname(join(root, rel)), { recursive: true })
    writeFileSync(join(root, rel), body)
  }
  const bun = '"${BUN:-$HOME/.bun/bin/bun}"'
  w('src/alpha/a.ts', "import { deep } from './deep.ts'\nexport const a = deep\n")
  w('src/alpha/deep.ts', 'export const deep = 1\n')
  w('src/beta/b.ts', 'export const b = 2\n')
  w('src/area/one.ts', 'export const one = 1\n')
  w('src/area/two.ts', 'export const two = 2\n')
  w('src/only/one.ts', 'export const onlyOne = 1\n')
  w('src/sub/s1.ts', 'export const s1 = 1\n')
  w('src/sub/other.ts', 'export const other = 1\n')
  w('src/narr/inner/x1.ts', 'export const x1 = 1\n')
  w('src/narr/top.ts', 'export const top = 1\n')
  w('scripts/lib/helper.ts', 'export const lib = 1\n')
  w('scripts/gate/impact-narrowed.txt', 'src/narr/inner/**\n')
  w(
    'scripts/alpha/run-all.sh',
    `#!/usr/bin/env bash\n# gate-class: pure\n# gate-watch: src/alpha/a.ts scripts/lib/helper.ts src/alpha/** src/alpha/**\n# gate-watch: src/beta/b.ts src/only/**\n# gate-watch: src/sub/s* src/sub/** src/narr/** src/narr/inner/x*\n# gate-watch: src/gone/** scripts/alpha/notes.txt\nset -u\nfor f in "$here"/prove-*.ts; do ${bun} run "$f"; done\n`,
  )
  w('scripts/alpha/notes.txt', 'a note the proofs do not read\n')
  w(
    'scripts/alpha/prove-a.ts',
    "import { a } from '../../src/alpha/a.ts'\nimport { b } from '../../src/beta/b.ts'\nimport { onlyOne } from '../../src/only/one.ts'\nimport { s1 } from '../../src/sub/s1.ts'\nimport { x1 } from '../../src/narr/inner/x1.ts'\nimport { lib } from '../lib/helper.ts'\nexport const out = a + b + onlyOne + s1 + x1 + lib\n",
  )
  w('scripts/beta/run-all.sh', `#!/usr/bin/env bash\n# gate-class: pure\n# gate-watch: src/area/**\nset -u\n# gate-watch: src/beta/**\n${bun} run "$here/prove-b.ts"\n`)
  w('scripts/beta/prove-b.ts', "import { one } from '../../src/area/one.ts'\nexport const out = one\n")
  w('scripts/gamma/run-all.sh', `#!/usr/bin/env bash\n# gate-class: pure\nset -u\n${bun} run "$here/prove-g.ts"\n`)
  w('scripts/gamma/prove-g.ts', "import { b } from '../../src/beta/b.ts'\nexport const out = b\n")
  const tracked = walkAll(root)
  const computed = computedWatch(root)
  const graph = watchGraphOf(root)
  const got = census(root, tracked, loadImpactManifest(root), computed, graph)
  const seenLaw1 = got.misses.filter(m => m.law === 1).map(m => `${m.suite} ${m.text}`).sort()
  const wantLaw1 = [
    'alpha scripts/alpha/run-all.sh: gate-watch src/gone/** matches no tracked path',
    'beta scripts/beta/run-all.sh:5: a gate-watch line below the header block is never read',
  ]
  const seenLaw2 = got.misses.filter(m => m.law === 2).map(m => m.text).sort()
  const law2Ok =
    seenLaw2.length === 6 &&
    seenLaw2.some(t => t.includes('duplicate gate-watch src/alpha/** (first on line 3)')) &&
    seenLaw2.some(t => t.includes('redundant gate-watch src/alpha/a.ts')) &&
    seenLaw2.some(t => t.includes('redundant gate-watch scripts/lib/helper.ts')) &&
    seenLaw2.some(t => t.includes('redundant gate-watch src/beta/b.ts')) &&
    seenLaw2.some(t => t.includes('redundant gate-watch src/sub/s*')) &&
    seenLaw2.some(t => t.includes('redundant gate-watch scripts/alpha/notes.txt'))
  const alphaGlobs = got.suites.find(s => s.suite === 'alpha')!.globs
  const futureOk =
    alphaGlobs.find(g => g.glob === 'src/only/**')?.redundant === false &&
    alphaGlobs.find(g => g.glob === 'src/only/**')?.reason === 'future' &&
    alphaGlobs.find(g => g.glob === 'src/narr/inner/x*')?.redundant === false &&
    alphaGlobs.find(g => g.glob === 'src/narr/inner/x*')?.reason === 'future'
  const text = render(got.suites)
  const table = tableOf(text)
  const held = table === null ? null : judge(got.suites, table)
  const bare = judge(got.suites, new Map())
  const lowered = judge(got.suites, new Map([['alpha', { count: 11, reason: 'deep,future,unseen' }], ['beta', { count: 1, reason: 'unseen' }]]))
  const fallen = judge(got.suites, new Map([['alpha', { count: 15, reason: 'deep,future,unseen' }], ['beta', { count: 1, reason: 'unseen' }], ['gone', { count: 2, reason: 'unseen' }]]))
  const judgeOk =
    text === 'alpha\t12\tdeep,future,unseen\nbeta\t1\tunseen\n' &&
    held !== null &&
    held.over.length === 0 &&
    held.globs === 13 &&
    held.redundant === 5 &&
    held.future === 2 &&
    held.duplicates === 1 &&
    held.allowed === 13 &&
    held.slack === 0 &&
    bare.over.map(o => `${o.suite} ${o.now}`).join(' · ') === 'alpha 12 · beta 1' &&
    lowered.over.length === 1 &&
    lowered.over[0]!.suite === 'alpha' &&
    told(lowered.over[0]!).includes('its row in scripts/gate/watch-hand-list.tsv allows 11') &&
    told(lowered.over[0]!).includes('5 of its globs the computation covers') &&
    told(bare.over[1]!).includes('has no row') &&
    fallen.over.length === 0 &&
    fallen.slack === 2 &&
    tableOf('a\t2\tdeep\nb\t3\tbundle,unseen\n')?.get('b')?.count === 3 &&
    tableOf('a\t2\n') === null &&
    tableOf('a\t2\tbogus\n') === null &&
    tableOf('a\t2\tdeep,deep\n') === null &&
    tableOf('a\t0\tdeep\n') === null &&
    tableOf('a\t1\tdeep\na\t1\tdeep\n') === null
  const before = claimantsOf(root, tracked, computed)
  const cuts = cutsOf(root, got.suites)
  applyCuts(root, cuts)
  const after = census(root, tracked, loadImpactManifest(root), computedWatch(root), watchGraphOf(root))
  const afterHeader = readFileSync(join(root, 'scripts/alpha/run-all.sh'), 'utf8').split('\n').slice(0, 7).join(' | ')
  w('src/only/new-child.ts', 'export const c = 1\n')
  w('src/sub/s2.ts', 'export const s2 = 2\n')
  w('src/narr/inner/x2.ts', 'export const x2 = 2\n')
  const afterManifest = loadImpactManifest(root, computedWatch(root))
  const unseenFuture = selectImpact(afterManifest, ['src/only/new-child.ts', 'src/sub/s2.ts', 'src/narr/inner/x2.ts'])
  const unseenOk =
    (unseenFuture.perPath['src/only/new-child.ts'] ?? []).includes('alpha') &&
    (unseenFuture.perPath['src/sub/s2.ts'] ?? []).includes('alpha') &&
    (unseenFuture.perPath['src/narr/inner/x2.ts'] ?? []).includes('alpha')
  const cutOk =
    afterHeader ===
      '#!/usr/bin/env bash | # gate-class: pure | # gate-watch: src/alpha/** | # gate-watch: src/only/** | # gate-watch: src/sub/** src/narr/** src/narr/inner/x* | # gate-watch: src/gone/** | set -u' &&
    render(after.suites) === 'alpha\t6\tdeep,future,unseen\nbeta\t1\tunseen\n' &&
    after.misses.filter(m => m.law === 2).length === 0 &&
    claimantsOf(root, tracked, computedWatch(root)) === before &&
    unseenOk
  rmSync(root, { recursive: true, force: true })
  const ok = seenLaw1.join('\n') === wantLaw1.join('\n') && law2Ok && futureOk && judgeOk && cutOk
  console.log(
    `  [${ok ? 'PASS' : 'FAIL'}] §0 self-test on a planted estate: dead globs and below-header lines named (${seenLaw1.length} of ${wantLaw1.length}) · duplicates and redundant globs fail law 2 (${String(law2Ok)}) · standalone and narrowed wildcards kept as future (${String(futureOk)}) · table holds counts and reasons (${String(judgeOk)}) · cut removes duplicates and redundant globs while keeping future paths and unseen children awake (${String(cutOk)})`,
  )
  if (!ok) {
    console.log(`         law1: ${seenLaw1.join(' | ')}`)
    console.log(`         law2: ${seenLaw2.join(' | ')}`)
    console.log(`         table: ${JSON.stringify(text)} · header: ${afterHeader} · unseen: ${JSON.stringify(unseenFuture.perPath)}`)
    console.log(`         change census, judge, cutsOf or applyCuts in ${SELF} (the planted estate is built in selfTest); the flags above show which part of the self-test drifted`)
  }
  return ok
}

if (import.meta.main) {
  let failures = selfTest() ? 0 : 1
  const tracked = trackedOf(REAL_ROOT)
  const computed = computedWatch(REAL_ROOT)
  const graph = REPORT || WRITE ? watchGraphOf(REAL_ROOT) : null
  const c = census(REAL_ROOT, tracked, loadImpactManifest(REAL_ROOT), computed, graph)
  const globs = c.suites.reduce((n, s) => n + s.globs.length, 0)
  const redundant = c.suites.reduce((n, s) => n + s.globs.filter(g => g.redundant).length, 0)
  const future = c.suites.reduce((n, s) => n + s.globs.filter(g => g.duplicateOf === null && g.covered && !g.redundant).length, 0)
  const duplicates = c.suites.reduce((n, s) => n + s.globs.filter(g => g.duplicateOf !== null).length, 0)
  const cuts = cutsOf(REAL_ROOT, c.suites)
  console.log(
    `  census: ${c.suites.length} suites · ${globs} gate-watch globs · ${duplicates} duplicates · ${redundant} redundant (wholly computed, future-safe) · ${future} wildcards kept for future paths · ${globs - duplicates - redundant - future} held by hand · ${Object.values(computed).reduce((n, files) => n + files.length, 0)} suite-and-file pairs the proofs touch`,
  )
  console.log(`  ${HAND_LAW}`)
  if (REPORT) {
    for (const cut of cuts) console.log(`  cut   ${cut.runner}:${cut.line}\t${cut.gone.join(' ')}\t${cut.left.length === 0 ? '(the line goes)' : `# gate-watch: ${cut.left.join(' ')}`}`)
    for (const s of c.suites) {
      const runner = `scripts/${s.suite}/run-all.sh`
      for (const g of s.globs) {
        if (g.duplicateOf !== null || g.redundant) continue
        console.log(`  keep  ${runner}:${g.line}\t${g.glob}\t${g.reason}\t(${g.matches} file${g.matches === 1 ? '' : 's'})`)
      }
    }
    console.log(`  the cut: ${cuts.reduce((n, cut) => n + cut.gone.length, 0)} globs on ${cuts.length} lines of ${new Set(cuts.map(cut => cut.runner)).size} runners · ${cuts.filter(cut => cut.left.length === 0).length} lines go whole`)
  }
  const law1 = c.misses.filter(m => m.law === 1)
  if (law1.length === 0) console.log(`  [PASS] §1 every gate-watch glob names a tracked path and every gate-watch line is read (${globs} globs / ${c.suites.length} runners)`)
  for (const m of law1) console.log(`  [FAIL] §1 ${m.text} — edit the # gate-watch lines in that runner header: correct the glob to a tracked path or remove it, and keep every line inside the header block`)
  failures += law1.length
  const law2 = c.misses.filter(m => m.law === 2)
  if (law2.length === 0) console.log(`  [PASS] §2 no duplicate or redundant gate-watch globs (0 duplicates · 0 redundant · ${future} wildcards kept for future paths)`)
  for (const m of law2) console.log(`  [FAIL] §2 ${m.text}`)
  if (!CUT) failures += law2.length
  const text = existsSync(join(REAL_ROOT, TABLE)) ? readFileSync(join(REAL_ROOT, TABLE), 'utf8') : null
  const table = text === null ? null : tableOf(text)
  if (CUT) {
    if (law1.length > 0) console.log('  nothing cut: §1 failed above')
    else {
      applyCuts(REAL_ROOT, cuts)
      console.log(`  cut ${cuts.reduce((n, cut) => n + cut.gone.length, 0)} duplicate or redundant globs from ${new Set(cuts.map(cut => cut.runner)).size} runner headers; run the census again, then ${WRITE_WORDS}`)
    }
  } else if (WRITE) {
    const against = table === null ? null : judge(c.suites, table)
    if (failures > 0) console.log('  nothing written: the census failed above')
    else if (text !== null && table === null) {
      failures++
      console.log(`  [FAIL] §3 ${TABLE} reads as rows of suite, count and reason — put the committed table back, then write`)
    } else if (against !== null && against.over.length > 0) {
      failures++
      console.log(`  [FAIL] §3 no row rises and none is added, nothing written — ${against.over.map(told).join('\n    ')}`)
    } else {
      writeFileSync(join(REAL_ROOT, TABLE), render(c.suites))
      console.log(`  wrote ${TABLE}: ${c.suites.filter(s => s.globs.length > 0).length} rows · ${globs} globs${against === null ? ' (the first table)' : ` (it allowed ${against.allowed})`}`)
    }
  } else if (table === null) {
    failures++
    console.log(`  [FAIL] §3 ${TABLE} reads as rows of suite, count and reason — ${text === null ? `no table: bun ${SELF} --write writes the first one` : 'a row is not suite, count >= 1 and valid reason words, or a suite stands twice'}`)
  } else {
    const found = judge(c.suites, table)
    for (const o of found.over) {
      failures++
      console.log(`  [FAIL] §3 ${told(o)}`)
    }
    if (found.over.length === 0)
      console.log(
        `  [PASS] §3 no header holds more watch globs than its row in ${TABLE} (${found.globs} globs, ${found.allowed} allowed; every row names a reason; a suite with no row holds none)`,
      )
    if (found.slack > 0) console.log(`  rows above their header's count: ${found.slack} (${WRITE_WORDS})`)
  }
  console.log(`\n${failures === 0 ? '✅' : '❌'} prove-gate-watch-census — ${failures === 0 ? 'all checks pass' : `${failures} check(s) failed`}`)
  process.exit(failures === 0 ? 0 : 1)
}
