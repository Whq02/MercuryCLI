#!/usr/bin/env bun
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { execSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { loadImpactManifest, selectImpact, type ImpactManifest } from './impactManifest.ts'
import { computedWatch, watchGraphOf } from './watchGraph.ts'
import { flagRegistryFiles, isFlagRegistryFile } from '../lib/flagRegistrySource.ts'

const ROOT = resolve(import.meta.dir, '..', '..')
let failures = 0
const check = (label: string, cond: boolean, detail = ''): void => {
  const impactHint = 'fix selectImpact or loadImpactManifest in scripts/verify/impactManifest.ts, computedWatch in scripts/verify/watchGraph.ts, a gate-watch header line in the named suite run-all.sh, or a row in scripts/gate/impact-doors.txt'
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond ? ` — ${detail ? `${detail} — ` : ''}${impactHint}` : ''}`)
  if (!cond) failures++
}
const section = (t: string): void => console.log('\n' + '─'.repeat(76) + '\n' + t)

section('§1 the real manifest: every declared glob is ALIVE')
const manifest = loadImpactManifest(ROOT)
const tracked = execSync('git ls-files', { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
  .split('\n')
  .filter(Boolean)

function alive(glob: string): boolean {
  const g = new Bun.Glob(glob)
  return tracked.some(t => g.match(t))
}

const deadWatches: string[] = []
for (const [dom, globs] of Object.entries(manifest.watches)) {
  for (const g of globs) if (!alive(g)) deadWatches.push(`${dom}: ${g}`)
}
check(
  `all declared gate-watch globs match ≥1 tracked path (${Object.values(manifest.watches).flat().length} globs / ${Object.keys(manifest.watches).length} suites)`,
  deadWatches.length === 0,
  deadWatches.slice(0, 8).join(' · '),
)
const deadIgnores = manifest.ignores.filter(g => !alive(g))
check(
  `all impact-ignore globs match ≥1 tracked path (${manifest.ignores.length} globs)`,
  deadIgnores.length === 0,
  deadIgnores.join(' · '),
)
const narrowedRows = manifest.narrowed ?? []
const deadNarrowed = narrowedRows.filter(g => !alive(g))
check(
  `all impact-narrowed rows match ≥1 tracked path (${narrowedRows.length} rows)`,
  deadNarrowed.length === 0,
  deadNarrowed.join(' · '),
)
check(`the manifest sees the full suite estate (${manifest.suites.length} ≥ 90)`, manifest.suites.length >= 90)
{
  const doorRows = manifest.doors ?? []
  const badDoors = doorRows.filter(d => !d.behind || !d.door || !tracked.includes(d.door))
  check(
    `every impact-doors row names a glob and a tracked door file (${doorRows.length} rows)`,
    doorRows.length > 0 && badDoors.length === 0,
    badDoors.map(d => `${d.behind} ${d.door}`).join(' · ') || 'scripts/gate/impact-doors.txt holds no row',
  )
  const probeOf = (behind: string): string => behind.replace(/\*\*.*$/, 'zz-probe.ts')
  for (const row of doorRows) {
    const behind = [...selectImpact(manifest, [probeOf(row.behind)]).suites]
    const door = [...selectImpact(manifest, [row.door]).suites]
    const lost = door.filter(s => !behind.includes(s))
    check(
      `a file behind ${row.door} wakes every suite that file wakes (${door.length} suites)`,
      door.length > 0 && lost.length === 0,
      `${lost.length} not woken by ${probeOf(row.behind)}: ${lost.slice(0, 12).join(' ')}`,
    )
  }
  const registry = flagRegistryFiles()[0]
  check(
    "the folder of flag rows stands behind the flag registry's door",
    doorRows.some(row => row.door === registry && isFlagRegistryFile(probeOf(row.behind))),
    `scripts/gate/impact-doors.txt has no row whose door is ${registry} and whose glob holds the registry's row files`,
  )
}

{
  const KNOWN = new Set(['gate-watch', 'gate-class'])
  const impostors: string[] = []
  for (const runner of execSync("git ls-files 'scripts/*/run-all.sh'", { cwd: ROOT, encoding: 'utf8' })
    .split('\n')
    .filter(Boolean)) {
    const text = readFileSync(join(ROOT, runner), 'utf8')
    for (const line of text.split('\n')) {
      if (line && !line.startsWith('#')) break
      const m = line.match(/^# ([a-z][a-z-]*):\s+(.*)$/)
      if (!m) continue
      if (KNOWN.has(m[1]!)) continue
      if (/(^|\s)(src|scripts|docs|design-system)\/|\*\*/.test(m[2]!)) {
        impostors.push(`${runner}: "# ${m[1]}:"`)
      }
    }
  }
  check(
    'no run-all.sh header carries a watch-shaped line the parser does not read',
    impostors.length === 0,
    impostors.join(' · ') || 'all watch declarations are live',
  )
}

section('§2 selector decision table (synthetic manifest)')
const syn: ImpactManifest = {
  suites: ['alpha', 'beta', 'gamma'],
  watches: { alpha: ['src/one/**', 'src/shared*'], beta: ['src/two/x.ts', 'src/shared*', 'docs/covered.md'] },
  ignores: ['docs/**', '*.md'],
}
{
  const s = selectImpact(syn, ['src/one/deep/a.ts'])
  check('watch hit selects the watching suite', s.suites.has('alpha') && s.suites.size === 1 && s.unclassified.length === 0)
}
{
  const s = selectImpact(syn, ['scripts/gamma/prove-x.ts'])
  check('implicit self-watch: scripts/<dom>/** selects the suite', s.suites.has('gamma') && s.suites.size === 1)
}
{
  const s = selectImpact(syn, ['scripts/not-a-suite/x.ts'])
  check('scripts path of a NON-suite is not self-claimed', !s.suites.has('not-a-suite') && s.unclassified.length === 1)
}
{
  const s = selectImpact(syn, ['src/shared.ts'])
  check('multi-suite claim: both watchers selected', s.suites.has('alpha') && s.suites.has('beta') && s.suites.size === 2)
}
{
  const s = selectImpact(syn, ['docs/notes.txt', 'README.md'])
  check('ignored paths select nothing and do not escalate', s.suites.size === 0 && s.ignored.length === 2 && s.unclassified.length === 0)
}
{
  const s = selectImpact(syn, ['docs/covered.md'])
  check('a WATCHED path beats the ignore list (declaration wins)', s.suites.has('beta') && s.ignored.length === 0)
}
{
  const s = selectImpact(syn, ['mystery/top-level.bin'])
  check('FAIL-CLOSED: an unclaimed, un-ignored path is UNCLASSIFIED', s.unclassified.length === 1 && s.perPath['mystery/top-level.bin']?.[0] === '(UNCLASSIFIED)')
}
const narrow: ImpactManifest = {
  suites: ['wide', 'folder', 'exact', 'net', 'flat'],
  watches: {
    wide: ['src/utils/**'],
    folder: ['src/utils/shell/*'],
    exact: ['src/utils/shell/engine.ts', 'src/platform/shell/shellExec.ts'],
    net: ['src/**'],
    flat: ['src/utils/*'],
  },
  ignores: [],
  narrowed: ['src/utils/shell/**', 'src/platform/shell/shellExec.ts'],
}
const claimed = (m: ImpactManifest, path: string): string => [...selectImpact(m, [path]).suites].sort().join(' ')
check(
  'narrowed area: a folder-wide glob no longer claims a path inside it',
  !selectImpact(narrow, ['src/utils/shell/engine.ts']).suites.has('wide'),
  claimed(narrow, 'src/utils/shell/engine.ts'),
)
check(
  "narrowed area: a glob on the area's own folder, a file's own name and the src/** net still claim it",
  claimed(narrow, 'src/utils/shell/engine.ts') === 'exact folder net' && claimed(narrow, 'src/utils/shell/other.ts') === 'folder net',
  `${claimed(narrow, 'src/utils/shell/engine.ts')} · ${claimed(narrow, 'src/utils/shell/other.ts')}`,
)
check(
  'narrowed area: a path outside every row is claimed as before',
  claimed(narrow, 'src/utils/other/x.ts') === 'net wide' && claimed(narrow, 'src/utils/top.ts') === 'flat net wide',
  `${claimed(narrow, 'src/utils/other/x.ts')} · ${claimed(narrow, 'src/utils/top.ts')}`,
)
check(
  'narrowed file row: only its own name and the net claim it',
  claimed(narrow, 'src/platform/shell/shellExec.ts') === 'exact net',
  claimed(narrow, 'src/platform/shell/shellExec.ts'),
)
{
  const s = selectImpact({ ...narrow, watches: { wide: ['src/utils/**'] } }, ['src/utils/shell/unnamed.ts'])
  check(
    'narrowed area, FAIL-CLOSED: a path nobody names and no net watches is UNCLASSIFIED',
    s.suites.size === 0 && s.unclassified.length === 1,
    JSON.stringify(s.perPath),
  )
}
{
  const nested: ImpactManifest = { ...narrow, narrowed: ['src/utils/shell/**', 'src/utils/shell/engine.ts'] }
  check(
    'narrowed rows that overlap: the more exact row sets the bar for its path alone',
    claimed(nested, 'src/utils/shell/engine.ts') === 'exact net' && claimed(nested, 'src/utils/shell/other.ts') === 'folder net',
    `${claimed(nested, 'src/utils/shell/engine.ts')} · ${claimed(nested, 'src/utils/shell/other.ts')}`,
  )
}

{
  const doors: ImpactManifest = {
    suites: ['door', 'folder', 'other'],
    watches: { door: ['src/reg/door.ts'], folder: ['src/reg/**'], other: ['src/else/**'] },
    ignores: [],
    doors: [{ behind: 'src/reg/rows/**', door: 'src/reg/door.ts' }],
  }
  check(
    'door: a change behind a door also wakes the suites that watch the door',
    claimed(doors, 'src/reg/rows/a.ts') === 'door folder',
    claimed(doors, 'src/reg/rows/a.ts'),
  )
  check(
    'door: a path outside the row wakes its own watchers alone',
    claimed(doors, 'src/reg/other.ts') === 'folder' && claimed(doors, 'src/else/x.ts') === 'other',
    `${claimed(doors, 'src/reg/other.ts')} · ${claimed(doors, 'src/else/x.ts')}`,
  )
  const lone = selectImpact({ ...doors, watches: { door: ['src/reg/door.ts'] } }, ['src/reg/rows/a.ts'])
  check(
    'door: a path behind a door that no glob names is claimed through the door, not UNCLASSIFIED',
    lone.suites.has('door') && lone.suites.size === 1 && lone.unclassified.length === 0,
    JSON.stringify(lone.perPath),
  )
}

section('§3 verify:fast --plan runs the real selector end-to-end')
{
  const out = execSync(`${process.env.BUN ?? process.env.HOME + '/.bun/bin/bun'} run scripts/verify/fast.ts --plan`, {
    cwd: ROOT,
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
  })
  check('--plan prints a plan line and exits 0 (no execution)', /plan: warm typecheck/.test(out), out.slice(0, 300))
  check('--plan never runs a step', !/━━ /.test(out))
}
{
  const s = selectImpact(loadImpactManifest(ROOT, computedWatch(ROOT)), [
    'src/integrations/lsp/config.ts',
    'src/components/anything.tsx',
    'scripts/ui/vshot.py',
    'docs/ROADMAP.md',
    'src/boot/main.tsx',
  ])
  check(
    'core estate paths classify (lsp source → lsp; components → ui-ish; vshot → capture suites; docs → the identity suite; src/boot/main.tsx claimed by smoke src/**)',
    s.unclassified.length === 0 &&
      s.ignored.length === 0 &&
      s.suites.has('lsp') &&
      s.suites.has('ui') &&
      s.perPath['docs/ROADMAP.md']?.includes('identity') === true &&
      s.perPath['src/boot/main.tsx']?.includes('smoke') === true,
    JSON.stringify({ unclassified: s.unclassified, ignored: s.ignored, docs: s.perPath['docs/ROADMAP.md'], main: s.perPath['src/boot/main.tsx'] }),
  )
}

section('§4 a planted estate: what a suite\'s proofs touch wakes it, with no header line; what the reader cannot see still takes one')
{
  const estate = mkdtempSync(join(tmpdir(), 'computed-watch-estate-'))
  const w = (rel: string, body: string): void => {
    mkdirSync(dirname(join(estate, rel)), { recursive: true })
    writeFileSync(join(estate, rel), body)
  }
  const head = ["import { join } from 'node:path'", "const ROOT = join(import.meta.dir, '..', '..')"]
  const runner = (watch: string, body: string): string => `#!/usr/bin/env bash\n# gate-class: pure\n${watch}set -u\n. "$(dirname "$0")/../lib/suite-env.sh"\nhere="$(cd "$(dirname "$0")" && pwd)"\n${body}`
  const each = 'for f in "$here"/prove-*.ts; do "${BUN:-bun}" run "$f"; done\n'
  w('src/alpha/a.ts', "import { deep } from './deep.ts'\nexport const a = deep\n")
  w('src/alpha/deep.ts', 'export const deep = 1\n')
  w('src/beta/b.ts', 'export const b = 2\n')
  w('src/gamma/g.ts', 'export const g = 3\n')
  w('src/keys/one.ts', 'export const one = 1\n')
  w('src/keys/two.ts', 'export const two = 2\n')
  w('src/hidden/h.ts', 'export const h = 4\n')
  w('docs/page.md', '# page\n')
  w('scripts/lib/suite-env.sh', 'suite_env_guard() { :; }\n')
  w('scripts/lib/child.ts', "import { g } from '../../src/gamma/g.ts'\nconsole.log(g)\n")
  w('scripts/template/run-all.sh', runner('# gate-watch: src/alpha/deep.ts\n', `claimed=$(cat scripts/template-*/members.txt 2>/dev/null | grep -v '^#')\n${each}`))
  w('scripts/template/prove-template.ts', [...head, 'const { a } = await import(`${ROOT}/src/alpha/a.ts`)', 'console.log(a)', ''].join('\n'))
  w('scripts/template/prove-drive.ts', "import { b } from '../../src/beta/b.ts'\nconsole.log(b)\n")
  w('scripts/template-drives/run-all.sh', '#!/usr/bin/env bash\n# gate-class: pty\nset -u\n. "$(dirname "$0")/../lib/suite-env.sh"\nwhile read -r name; do f="scripts/template/$name"; bun "$f"; done < scripts/template-drives/members.txt\n')
  w('scripts/template-drives/members.txt', 'prove-drive.ts\n')
  w('scripts/handed/run-all.sh', runner('', each))
  w('scripts/handed/prove-handed.ts', ["import { readFileSync } from 'node:fs'", ...head, "const src = (rel: string): string => readFileSync(join(ROOT, 'src', rel), 'utf8')", "console.log(src('beta/b.ts').includes('b'))", ''].join('\n'))
  w('scripts/child/run-all.sh', runner('', each))
  w('scripts/child/prove-child.ts', ["import { spawnSync } from 'node:child_process'", ...head, "const ran = spawnSync(process.execPath, [join(ROOT, 'scripts/lib/child.ts')])", 'console.log(ran.status)', ''].join('\n'))
  w('scripts/named/run-all.sh', runner('', each))
  w('scripts/named/prove-named.ts', ["import { existsSync, readFileSync } from 'node:fs'", ...head, "console.log(readFileSync(join(ROOT, 'docs/page.md'), 'utf8').length, existsSync(join(ROOT, 'src/keys/one.ts')))", ''].join('\n'))
  w('scripts/walked/run-all.sh', runner('', each))
  w('scripts/walked/prove-walked.ts', ["import { readdirSync } from 'node:fs'", ...head, "console.log(readdirSync(join(ROOT, 'src', 'keys')).length)", ''].join('\n'))
  w('src/boot/main.tsx', 'export const main = 1\n')
  w('src/daemon/runner/runHeadless.ts', 'export const run = 1\n')
  w('scripts/lib/builtProduct.ts', "export const builtCli = (): string => 'dist/mercury.mjs'\n")
  w('scripts/built/run-all.sh', runner('', each))
  w('scripts/built/prove-built.ts', "import { builtCli } from '../lib/builtProduct.ts'\nconsole.log(builtCli())\n")
  w('scripts/lister/run-all.sh', runner('', each))
  w('scripts/lister/prove-lister.ts', ["import { readdirSync, readFileSync } from 'node:fs'", ...head, "const texts = (sub: string): string[] => readdirSync(join(ROOT, sub)).map(f => readFileSync(join(ROOT, sub, f), 'utf8'))", "console.log(texts('src/keys').length)", ''].join('\n'))
  w('scripts/pyrun/run-all.sh', runner('', '/usr/bin/python3 "$here/prove-py.py"\n'))
  w('scripts/pyrun/prove-py.py', ['import os', 'import subprocess', 'REPO = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))', "CHILD = os.path.join(REPO, 'scripts', 'lib', 'child.ts')", "page = open(os.path.join(REPO, 'docs', 'page.md')).read()", "ran = subprocess.run(['bun', 'run', CHILD], cwd=REPO)", ''].join('\n'))
  w('scripts/blind/run-all.sh', runner('# gate-watch: src/hidden/**\n', each))
  w(
    'scripts/blind/prove-blind.ts',
    [
      "import { spawnSync } from 'node:child_process'",
      "import { readdirSync, readFileSync } from 'node:fs'",
      ...head,
      'const name = process.argv[2]',
      "const late = await import(join(ROOT, 'src', 'hidden', `${name}.ts`))",
      "const built = readFileSync(join(ROOT, name), 'utf8')",
      "const tool = spawnSync('true', [])",
      "const git = spawnSync('git', ['status'])",
      "const bundle = spawnSync(process.execPath, [join(ROOT, 'dist', 'mercury.mjs'), '--version'])",
      "const all = readdirSync(join(ROOT, 'src'))",
      'console.log(late, built, tool.status, git.status, bundle.status, all.length)',
      '',
    ].join('\n'),
  )
  const computed = computedWatch(estate)
  const graph = watchGraphOf(estate)
  const hand = loadImpactManifest(estate)
  const both = loadImpactManifest(estate, computed)
  const SOURCED = 'scripts/lib/suite-env.sh'
  const want: Record<string, string[]> = {
    blind: ['scripts/blind/prove-blind.ts', SOURCED],
    built: ['scripts/built/prove-built.ts', 'scripts/lib/builtProduct.ts', SOURCED, 'src/boot/main.tsx', 'src/daemon/runner/runHeadless.ts'],
    child: ['scripts/child/prove-child.ts', 'scripts/lib/child.ts', SOURCED, 'src/gamma/g.ts'],
    handed: ['scripts/handed/prove-handed.ts', SOURCED, 'src/beta/b.ts'],
    lister: [SOURCED, 'scripts/lister/prove-lister.ts', 'src/keys/one.ts', 'src/keys/two.ts'],
    named: ['docs/page.md', SOURCED, 'scripts/named/prove-named.ts', 'src/keys/one.ts'],
    pyrun: ['docs/page.md', 'scripts/lib/child.ts', SOURCED, 'scripts/pyrun/prove-py.py', 'src/gamma/g.ts'],
    template: [SOURCED, 'scripts/template/prove-template.ts', 'src/alpha/a.ts', 'src/beta/b.ts'],
    'template-drives': [SOURCED, 'scripts/template-drives/members.txt', 'scripts/template/prove-drive.ts', 'src/alpha/a.ts', 'src/beta/b.ts'],
    walked: [SOURCED, 'scripts/walked/prove-walked.ts', 'src/keys/one.ts', 'src/keys/two.ts'],
  }
  const listOf = (map: Record<string, string[]>): string => Object.keys(map).sort().map(suite => `${suite}: ${map[suite]!.join(' ')}`).join(' · ')
  check(
    "the computed list of a suite holds what its proofs touch: an import on a template, a path handed to a helper, a child script and what it imports, a name read as text, a walked folder, what the runner sources, a twin's member in its parent's folder, for twins whose lists read one folder the source files either one's proofs touch, the two entry files for a proof that runs the bundle through scripts/lib/builtProduct.ts, for a Python member the script it starts through subprocess with what that script imports, and every file of a folder handed to a helper that lists it and opens what it lists",
    listOf(computed) === listOf(want),
    `seen ${listOf(computed)} · want ${listOf(want)}`,
  )
  const blind = graph.suites.find(s => s.suite === 'blind')
  const sight = blind === undefined ? 'no such suite' : `imports ${blind.blind.imports} · paths ${blind.blind.paths} · children ${blind.blind.children} · git ${blind.blind.git} · bundle ${blind.bundle.join(' ')} · whole ${blind.whole.map(walk => walk.scope).join(' ')}`
  check(
    'what the reader cannot see is counted and not listed: an import and a path built at run time, a child program that names no script, a git child, the built bundle, a walk of all of src',
    sight === 'imports 1 · paths 1 · children 1 · git 1 · bundle scripts/blind/prove-blind.ts · whole src',
    sight,
  )
  const claimants = (m: ImpactManifest, path: string): string[] => (selectImpact(m, [path]).perPath[path] ?? []).filter(c => !c.startsWith('('))
  const TOUCHED: Array<[string, string]> = [
    ['template', 'src/alpha/a.ts'],
    ['handed', 'src/beta/b.ts'],
    ['child', 'scripts/lib/child.ts'],
    ['child', 'src/gamma/g.ts'],
    ['named', 'docs/page.md'],
    ['named', 'src/keys/one.ts'],
    ['walked', 'src/keys/two.ts'],
    ['walked', SOURCED],
    ['template-drives', 'scripts/template/prove-drive.ts'],
    ['template-drives', 'src/beta/b.ts'],
    ['template', 'src/beta/b.ts'],
    ['template-drives', 'src/alpha/a.ts'],
    ['built', 'src/boot/main.tsx'],
    ['built', 'src/daemon/runner/runHeadless.ts'],
    ['pyrun', 'scripts/lib/child.ts'],
    ['pyrun', 'src/gamma/g.ts'],
    ['pyrun', 'docs/page.md'],
    ['lister', 'src/keys/one.ts'],
    ['lister', 'src/keys/two.ts'],
  ]
  const asleep = TOUCHED.filter(([suite, path]) => claimants(hand, path).includes(suite)).map(([suite, path]) => `${suite} ${path}`)
  check('the hand map alone wakes none of these suites for the file its proof touches (the header holds no line for it)', asleep.length === 0, asleep.join(' · '))
  const stillAsleep = TOUCHED.filter(([suite, path]) => !claimants(both, path).includes(suite) || !selectImpact(both, [path]).computed.has(suite)).map(([suite, path]) => `${suite} ${path}`)
  check('with the computed list in the manifest each of them is woken, and the selection names it as computed', stillAsleep.length === 0, stillAsleep.join(' · '))
  const hidden = selectImpact(both, ['src/hidden/h.ts'])
  const deep = selectImpact(both, ['src/alpha/deep.ts'])
  check(
    'a file out of sight (an import on a name built at run time) and a file one import into src are in no computed list: the hand line of the header claims each, and the selection does not name them as computed',
    !computed.blind!.includes('src/hidden/h.ts') && !computed.template!.includes('src/alpha/deep.ts') && claimants(both, 'src/hidden/h.ts').join() === 'blind' && claimants(both, 'src/alpha/deep.ts').join() === 'template' && hidden.computed.size === 0 && deep.computed.size === 0,
    `${claimants(both, 'src/hidden/h.ts').join()} · ${claimants(both, 'src/alpha/deep.ts').join()} · computed ${[...hidden.computed, ...deep.computed].join()}`,
  )
  const lost = graph.listed.flatMap(path => claimants(hand, path).filter(suite => !claimants(both, path).includes(suite)).map(suite => `${suite} ${path}`))
  check(`no file of the estate loses a claimant when the computed list joins the hand map (${graph.listed.length} files)`, lost.length === 0, lost.join(' · '))
  rmSync(estate, { recursive: true, force: true })
}

console.log('\n' + '═'.repeat(60))
if (failures === 0) {
  console.log(' ✅ IMPACT MANIFEST GREEN')
  process.exit(0)
}
console.log(` ❌ ${failures} IMPACT-MANIFEST FAILURE(S)`)
process.exit(1)
