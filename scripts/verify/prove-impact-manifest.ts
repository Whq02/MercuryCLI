#!/usr/bin/env bun
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { execSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { loadImpactManifest, selectImpact, type ImpactManifest } from './impactManifest.ts'

const ROOT = resolve(import.meta.dir, '..', '..')
let failures = 0
const check = (label: string, cond: boolean, detail = ''): void => {
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ' — ' + detail : ''}`)
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
  const behind = [...selectImpact(manifest, ['src/substrate/flags/zz-probe.ts']).suites]
  const door = [...selectImpact(manifest, ['src/substrate/flagRegistry.ts']).suites]
  const lost = door.filter(s => !behind.includes(s))
  check(
    `a file under src/substrate/flags wakes every suite the registry's door wakes (${door.length} suites)`,
    door.length > 0 && lost.length === 0,
    `${lost.length} not woken: ${lost.slice(0, 12).join(' ')}; add the row "src/substrate/flags/** src/substrate/flagRegistry.ts" to scripts/gate/impact-doors.txt`,
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
    exact: ['src/utils/shell/engine.ts', 'src/utils/Shell.ts'],
    net: ['src/**'],
    flat: ['src/utils/*'],
  },
  ignores: [],
  narrowed: ['src/utils/shell/**', 'src/utils/Shell.ts'],
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
  claimed(narrow, 'src/utils/Shell.ts') === 'exact net',
  claimed(narrow, 'src/utils/Shell.ts'),
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
  const s = selectImpact(manifest, [
    'src/services/lsp/config.ts',
    'src/components/anything.tsx',
    'scripts/ui/vshot.py',
    'docs/ROADMAP.md',
    'src/main.tsx',
  ])
  check(
    'core estate paths classify (lsp source → lsp; components → ui-ish; vshot → capture suites; docs → the identity suite; src/main.tsx claimed by smoke src/**)',
    s.unclassified.length === 0 &&
      s.ignored.length === 0 &&
      s.suites.has('lsp') &&
      s.suites.has('ui') &&
      s.perPath['docs/ROADMAP.md']?.includes('identity') === true &&
      s.perPath['src/main.tsx']?.includes('smoke') === true,
    JSON.stringify({ unclassified: s.unclassified, ignored: s.ignored, docs: s.perPath['docs/ROADMAP.md'], main: s.perPath['src/main.tsx'] }),
  )
}

console.log('\n' + '═'.repeat(60))
if (failures === 0) {
  console.log(' ✅ IMPACT MANIFEST GREEN')
  process.exit(0)
}
console.log(` ❌ ${failures} IMPACT-MANIFEST FAILURE(S)`)
process.exit(1)
