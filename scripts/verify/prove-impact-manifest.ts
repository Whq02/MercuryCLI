#!/usr/bin/env bun
// ============================================================================
//  prove-impact-manifest.ts — the declared impact manifest is itself gated
// Two planes:
//    §1 REAL-ESTATE DRIFT — every declared gate-watch glob and every
//       impact-ignore glob matches ≥1 tracked path (a dead glob is a renamed
//       dir silently un-watching a suite ⇒ RED), and every suite parses.
//    §2 SELECTOR LAW — the decision table over a synthetic manifest:
//       watch hit · implicit self-watch · ignore · UNCLASSIFIED fail-closed ·
//       multi-suite claims · watch-beats-ignore priority.
//    §3 LADDER SEAM — `verify:fast --plan` runs end-to-end on the real tree
//       and prints a plan (no execution), and the real manifest classifies
//       the estate's own core paths.
// ============================================================================
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

// ── §1 real-estate drift ──────────────────────────────────────────────────────
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
check(`the manifest sees the full suite estate (${manifest.suites.length} ≥ 90)`, manifest.suites.length >= 90)

// A watch that LOOKS declared but is never parsed is worse than none — the
// author believes the suite is impact-selected and it silently is not (the
// re-audit found six `# n:` continuation lines carrying eight owners
// that no parser read). Any header comment line shaped like `# key: glob…`
// whose key is not a known header is a refusal.
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

// ── §2 selector law ───────────────────────────────────────────────────────────
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

// ── §3 the ladder seam ────────────────────────────────────────────────────────
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
  // The estate's own core paths classify without escalation. docs/ sits in
  // the ignore list (no runtime suite tests it), but the public-cut ratchet
  // reads hand-written text everywhere, so a docs change selects the origin
  // suite — a declared watch beats the ignore list — and nothing in this set
  // is ignored or escalates. src/main.tsx stays claimed by smoke's src/**:
  // the fail-closed law over src is untouched by the docs watch.
  const s = selectImpact(manifest, [
    'src/services/lsp/config.ts',
    'src/components/anything.tsx',
    'scripts/ui/vshot.py',
    'docs/ROADMAP.md',
    'src/main.tsx',
  ])
  check(
    'core estate paths classify (lsp source → lsp; components → ui-ish; vshot → capture suites; docs → the origin ratchet; src/main.tsx claimed by smoke src/**)',
    s.unclassified.length === 0 &&
      s.ignored.length === 0 &&
      s.suites.has('lsp') &&
      s.suites.has('ui') &&
      s.perPath['docs/ROADMAP.md']?.includes('origin') === true &&
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
