#!/usr/bin/env bun
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, relative, resolve } from 'node:path'
import { loadImpactManifest, selectImpact, type ImpactManifest } from '../verify/impactManifest.ts'
import { computedWatch } from '../verify/watchGraph.ts'
import { slash } from './sourceCensus.ts'

const REAL_ROOT = resolve(import.meta.dir, '..', '..')
const SELF = 'scripts/gate/prove-gate-watch-census.ts'
const TABLE = 'scripts/gate/watch-hand-list.tsv'
const REPORT = process.argv.includes('--report')
const WRITE = process.argv.includes('--write')
const CUT = process.argv.includes('--cut')
const CHAIN = 'bun scripts/verify/watch-report.ts --chain <suite> <path>'
const HAND_LAW =
  "a header line stands only for what the reader of a suite's proofs cannot see: an area a member that runs the built bundle covers, a file one import or more into src, a path built at run time; what a proof imports, runs, names or walks wakes its suite with no line"

type Glob = { glob: string; line: number; matches: number; covered: boolean }
type SuiteRow = { suite: string; globs: Glob[] }
type Miss = { law: 1 | 2; suite: string; text: string }
type Census = { suites: SuiteRow[]; misses: Miss[] }
type Row = { globs: number; covered: number }
type Table = Map<string, Row>
type Over = { suite: string; what: 'covered' | 'globs'; now: number; row: number; named: Glob[] }
type Cut = { runner: string; line: number; gone: string[]; left: string[] }

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

function census(root: string, tracked: string[], manifest: ImpactManifest, computed: Record<string, string[]>): Census {
  const misses: Miss[] = []
  const suites: SuiteRow[] = []
  const matching = new Map<string, string[]>()
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
    const globs: Glob[] = []
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
        for (const glob of watch[1]!.trim().split(/\s+/)) {
          const hits = matchesOf(glob)
          globs.push({ glob, line: i + 1, matches: hits.length, covered: hits.length > 0 && hits.every(file => touched.has(file) || file.startsWith(own)) })
          if (hits.length > 0) continue
          if (glob.split('/')[0] === 'sdk' && !tracked.some(t => t.startsWith('sdk/'))) continue
          misses.push({ law: 1, suite, text: `${runner}: gate-watch ${glob} matches no tracked path` })
        }
      })
    suites.push({ suite, globs })
  }
  return { suites, misses }
}

function tableOf(text: string): Table | null {
  const table: Table = new Map()
  for (const line of text.split('\n')) {
    if (line === '') continue
    const m = /^([A-Za-z0-9_-]+)\t([0-9]+)\t([0-9]+)$/.exec(line)
    if (!m || table.has(m[1]!) || Number(m[2]) === 0 || Number(m[3]) > Number(m[2])) return null
    table.set(m[1]!, { globs: Number(m[2]), covered: Number(m[3]) })
  }
  return table
}

const rowOf = (s: SuiteRow): Row => ({ globs: s.globs.length, covered: s.globs.filter(g => g.covered).length })

const render = (suites: SuiteRow[]): string =>
  suites
    .filter(s => s.globs.length > 0)
    .sort((a, b) => (a.suite < b.suite ? -1 : 1))
    .map(s => `${s.suite}\t${rowOf(s).globs}\t${rowOf(s).covered}\n`)
    .join('')

function judge(suites: SuiteRow[], table: Table): { over: Over[]; globs: number; covered: number; allowed: Row; slack: number } {
  const over: Over[] = []
  let globs = 0
  let covered = 0
  for (const s of suites) {
    const now = rowOf(s)
    globs += now.globs
    covered += now.covered
    const row = table.get(s.suite) ?? { globs: 0, covered: 0 }
    if (now.covered > row.covered) over.push({ suite: s.suite, what: 'covered', now: now.covered, row: row.covered, named: s.globs.filter(g => g.covered) })
    if (now.globs > row.globs) over.push({ suite: s.suite, what: 'globs', now: now.globs, row: row.globs, named: s.globs.filter(g => !g.covered) })
  }
  const allowed: Row = { globs: 0, covered: 0 }
  let slack = 0
  for (const [suite, row] of table) {
    allowed.globs += row.globs
    allowed.covered += row.covered
    const now = suites.find(s => s.suite === suite)
    if (!now || rowOf(now).globs < row.globs || rowOf(now).covered < row.covered) slack++
  }
  return { over, globs, covered, allowed, slack }
}

const WRITE_WORDS = `bun ${SELF} --write lowers a row and never raises or adds one`

function told(o: Over): string {
  const runner = `scripts/${o.suite}/run-all.sh`
  const names = o.named.slice(0, 24).map(g => `\n      ${runner}:${g.line} ${g.glob} (${g.matches} file${g.matches === 1 ? '' : 's'})`).join('') + (o.named.length > 24 ? `\n      … and ${o.named.length - 24} more` : '')
  if (o.what === 'covered') return `${runner} holds ${o.now} watch globs the computation covers and ${o.row === 0 ? 'its row allows none' : `its row in ${TABLE} allows ${o.row}`}: the suite's proofs touch every file each of them matches, so the suite wakes without the line (${CHAIN} prints the road) — take them out of the header (bun ${SELF} --cut does it for every runner); ${WRITE_WORDS}:${names}`
  return `${runner} holds ${o.now} watch globs and ${o.row === 0 ? 'has no row' : `its row in ${TABLE} allows ${o.row}`}: ${HAND_LAW}. For a new line ${CHAIN} says which of the three it is, or prints the road by which the suite wakes already; a line that must stand raises the suite's row by hand in the same commit, where the diff shows it. The globs of this header the computation does not cover:${names}`
}

function cutsOf(root: string, suites: SuiteRow[]): Cut[] {
  const cuts: Cut[] = []
  for (const s of suites) {
    const runner = `scripts/${s.suite}/run-all.sh`
    const covered = new Map<number, Set<string>>()
    for (const g of s.globs) if (g.covered) covered.set(g.line, (covered.get(g.line) ?? new Set()).add(g.glob))
    if (covered.size === 0) continue
    const lines = readFileSync(join(root, runner), 'utf8').split('\n')
    for (const [line, gone] of [...covered].sort((a, b) => a[0] - b[0])) {
      const globs = /^# gate-watch:\s*(.+)$/.exec(lines[line - 1]!)![1]!.trim().split(/\s+/)
      cuts.push({ runner, line, gone: globs.filter(g => gone.has(g)), left: globs.filter(g => !gone.has(g)) })
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
  w('scripts/lib/helper.ts', 'export const lib = 1\n')
  w('scripts/alpha/run-all.sh', `#!/usr/bin/env bash\n# gate-class: pure\n# gate-watch: src/alpha/a.ts scripts/lib/helper.ts src/alpha/**\n# gate-watch: src/beta/b.ts\n# gate-watch: src/gone/** scripts/alpha/notes.txt\nset -u\nfor f in "$here"/prove-*.ts; do ${bun} run "$f"; done\n`)
  w('scripts/alpha/notes.txt', 'a note the proofs do not read\n')
  w('scripts/alpha/prove-a.ts', "import { a } from '../../src/alpha/a.ts'\nimport { b } from '../../src/beta/b.ts'\nimport { lib } from '../lib/helper.ts'\nexport const out = a + b + lib\n")
  w('scripts/beta/run-all.sh', `#!/usr/bin/env bash\n# gate-class: pure\n# gate-watch: src/area/**\nset -u\n# gate-watch: src/beta/**\n${bun} run "$here/prove-b.ts"\n`)
  w('scripts/beta/prove-b.ts', "import { one } from '../../src/area/one.ts'\nexport const out = one\n")
  w('scripts/gamma/run-all.sh', `#!/usr/bin/env bash\n# gate-class: pure\nset -u\n${bun} run "$here/prove-g.ts"\n`)
  w('scripts/gamma/prove-g.ts', "import { b } from '../../src/beta/b.ts'\nexport const out = b\n")
  const tracked = walkAll(root)
  const computed = computedWatch(root)
  const got = census(root, tracked, loadImpactManifest(root), computed)
  const seen = got.misses.map(m => `${m.law} ${m.suite} ${m.text}`).sort()
  const want = ['1 alpha scripts/alpha/run-all.sh: gate-watch src/gone/** matches no tracked path', '1 beta scripts/beta/run-all.sh:5: a gate-watch line below the header block is never read']
  const states = got.suites.map(s => `${s.suite}: ${s.globs.map(g => `${g.glob} ${g.covered ? 'covered' : 'hand'}`).join(', ')}`).join(' · ')
  const wantStates = 'alpha: src/alpha/a.ts covered, scripts/lib/helper.ts covered, src/alpha/** hand, src/beta/b.ts covered, src/gone/** hand, scripts/alpha/notes.txt covered · beta: src/area/** hand · gamma: '
  const text = render(got.suites)
  const table = tableOf(text)
  const held = table === null ? null : judge(got.suites, table)
  const bare = judge(got.suites, new Map())
  const lowered = judge(got.suites, new Map([['alpha', { globs: 6, covered: 3 }], ['beta', { globs: 1, covered: 0 }]]))
  const fallen = judge(got.suites, new Map([['alpha', { globs: 9, covered: 5 }], ['beta', { globs: 1, covered: 0 }], ['gone', { globs: 2, covered: 1 }]]))
  const judgeOk =
    text === 'alpha\t6\t4\nbeta\t1\t0\n' &&
    held !== null && held.over.length === 0 && held.globs === 7 && held.covered === 4 && held.slack === 0 &&
    bare.over.map(o => `${o.suite} ${o.what} ${o.now}`).join(' · ') === 'alpha covered 4 · alpha globs 6 · beta globs 1' &&
    lowered.over.length === 1 && lowered.over[0]!.what === 'covered' && told(lowered.over[0]!).includes('scripts/alpha/run-all.sh:3 src/alpha/a.ts (1 file)') && told(lowered.over[0]!).includes('--cut') &&
    told(bare.over[2]!).includes('scripts/beta/run-all.sh:3 src/area/** (2 files)') && told(bare.over[2]!).includes('has no row') && told(bare.over[2]!).includes('raises the suite') &&
    fallen.over.length === 0 && fallen.slack === 2 &&
    tableOf('a\t2\t1\nb\t3\t0\n')?.get('a')?.covered === 1 && tableOf('a\t0\t0\n') === null && tableOf('a\t1\t2\n') === null && tableOf('a\t1\t0\na\t1\t0\n') === null && tableOf('a 1 0\n') === null
  const before = claimantsOf(root, tracked, computed)
  const cuts = cutsOf(root, got.suites)
  applyCuts(root, cuts)
  const after = census(root, tracked, loadImpactManifest(root), computedWatch(root))
  const header = readFileSync(join(root, 'scripts/alpha/run-all.sh'), 'utf8').split('\n').slice(0, 5).join(' | ')
  const cutOk =
    cuts.map(c => `${c.runner}:${c.line} -${c.gone.join(',')} +${c.left.join(',')}`).join(' · ') === 'scripts/alpha/run-all.sh:3 -src/alpha/a.ts,scripts/lib/helper.ts +src/alpha/** · scripts/alpha/run-all.sh:4 -src/beta/b.ts + · scripts/alpha/run-all.sh:5 -scripts/alpha/notes.txt +src/gone/**' &&
    header === '#!/usr/bin/env bash | # gate-class: pure | # gate-watch: src/alpha/** | # gate-watch: src/gone/** | set -u' &&
    render(after.suites) === 'alpha\t2\t0\nbeta\t1\t0\n' &&
    claimantsOf(root, tracked, computedWatch(root)) === before
  rmSync(root, { recursive: true, force: true })
  const ok = seen.join('\n') === want.join('\n') && states === wantStates && judgeOk && cutOk
  console.log(
    `  [${ok ? 'PASS' : 'FAIL'}] §0 self-test on a planted estate: a glob that names no tracked path and a watch line below the header are named (${seen.length} of ${want.length}) · a glob is covered when the suite's proofs touch every file it matches or the file stands in the suite's own folder, and held by hand when it reaches a file they do not (${String(states === wantStates)}) · the table judges a held row, no row, a row lowered under its suite and a fallen row, and reads back as written (${String(judgeOk)}) · the cut takes the covered globs out of the header, drops a line it empties, and no file of the estate changes its claimants (${String(cutOk)})`,
  )
  if (!ok) {
    for (const s of seen) console.log(`         seen: ${s}`)
    console.log(`         states: ${states}`)
    console.log(`         table: ${JSON.stringify(text)} · header: ${header}`)
  }
  return ok
}

if (import.meta.main) {
  let failures = selfTest() ? 0 : 1
  const tracked = trackedOf(REAL_ROOT)
  const computed = computedWatch(REAL_ROOT)
  const c = census(REAL_ROOT, tracked, loadImpactManifest(REAL_ROOT), computed)
  const globs = c.suites.reduce((n, s) => n + s.globs.length, 0)
  const covered = c.suites.reduce((n, s) => n + s.globs.filter(g => g.covered).length, 0)
  const cuts = cutsOf(REAL_ROOT, c.suites)
  console.log(`  census: ${c.suites.length} suites · ${globs} gate-watch globs · ${covered} of them covered by the computation, ${globs - covered} held by hand · ${Object.values(computed).reduce((n, files) => n + files.length, 0)} suite-and-file pairs the proofs touch`)
  console.log(`  ${HAND_LAW}`)
  if (REPORT) {
    for (const cut of cuts) console.log(`  cut  ${cut.runner}:${cut.line}\t${cut.gone.join(' ')}\t${cut.left.length === 0 ? '(the line goes)' : `# gate-watch: ${cut.left.join(' ')}`}`)
    console.log(`  the cut: ${cuts.reduce((n, cut) => n + cut.gone.length, 0)} globs on ${cuts.length} lines of ${new Set(cuts.map(cut => cut.runner)).size} runners · ${cuts.filter(cut => cut.left.length === 0).length} lines go whole`)
  }
  const law1 = c.misses.filter(m => m.law === 1)
  if (law1.length === 0) console.log(`  [PASS] §1 every gate-watch glob names a tracked path and every gate-watch line is read (${globs} globs / ${c.suites.length} runners)`)
  for (const m of law1) console.log(`  [FAIL] §1 ${m.text}`)
  failures += law1.length
  const text = existsSync(join(REAL_ROOT, TABLE)) ? readFileSync(join(REAL_ROOT, TABLE), 'utf8') : null
  const table = text === null ? null : tableOf(text)
  if (CUT) {
    if (failures > 0) console.log('  nothing cut: the census failed above')
    else {
      applyCuts(REAL_ROOT, cuts)
      console.log(`  cut ${cuts.reduce((n, cut) => n + cut.gone.length, 0)} covered globs from ${new Set(cuts.map(cut => cut.runner)).size} runner headers; run the census again, then ${WRITE_WORDS}`)
    }
  } else if (WRITE) {
    const against = table === null ? null : judge(c.suites, table)
    if (failures > 0) console.log('  nothing written: the census failed above')
    else if (text !== null && table === null) {
      failures++
      console.log(`  [FAIL] §2 ${TABLE} reads as rows of a suite, its watch globs and how many the computation covers — put the committed table back, then write`)
    } else if (against !== null && against.over.length > 0) {
      failures++
      console.log(`  [FAIL] §2 no row rises and none is added, nothing written — ${against.over.map(told).join('\n    ')}`)
    } else {
      writeFileSync(join(REAL_ROOT, TABLE), render(c.suites))
      console.log(`  wrote ${TABLE}: ${c.suites.filter(s => s.globs.length > 0).length} rows · ${globs} globs · ${covered} covered${against === null ? ' (the first table)' : ` (it allowed ${against.allowed.globs} and ${against.allowed.covered})`}`)
    }
  } else if (table === null) {
    failures++
    console.log(`  [FAIL] §2 ${TABLE} reads as rows of a suite, its watch globs and how many the computation covers — ${text === null ? `no table: bun ${SELF} --write writes the first one` : 'a row is not a suite and two counts, the second no higher than the first, or a suite stands twice'}`)
  } else {
    const found = judge(c.suites, table)
    for (const o of found.over) {
      failures++
      console.log(`  [FAIL] §2 ${told(o)}`)
    }
    if (found.over.length === 0) console.log(`  [PASS] §2 no header holds more watch globs than its row, and none more that the computation covers (${found.globs} globs, ${found.covered} covered; ${TABLE} allows ${found.allowed.globs} and ${found.allowed.covered}; a suite with no row holds none)`)
    if (found.slack > 0) console.log(`  rows above their header's count: ${found.slack} (${WRITE_WORDS})`)
  }
  console.log(`\n${failures === 0 ? '✅' : '❌'} prove-gate-watch-census — ${failures === 0 ? 'all checks pass' : `${failures} check(s) failed`}`)
  process.exit(failures === 0 ? 0 : 1)
}
