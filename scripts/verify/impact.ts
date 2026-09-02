#!/usr/bin/env bun
// ============================================================================
//  scripts/verify/impact.ts — the suites a change owes, from a git range.
//
//  The impact manifest (impactManifest.ts) maps each suite's `# gate-watch:`
//  globs to the paths it watches. This command answers the fold question
//  "which suites must run for THIS diff?" mechanically:
//
//    bun scripts/verify/impact.ts <rev-range>        # e.g. main..HEAD, abc123^..abc123
//    bun scripts/verify/impact.ts --paths a.ts b.ts   # explicit paths
//    bun scripts/verify/impact.ts <rev-range> --explain   # per-path claimants
//    bun scripts/verify/impact.ts <rev-range> --json      # machine-readable
//
//  STDOUT is the battery: suite names, one per line, sorted — the suites the
//  globs select PLUS the whole-tree ratchets that every fold owes regardless
//  of the paths (integrity · identity · consistency-census · gate · verify),
//  so `for s in $(bun scripts/verify/impact.ts main..HEAD); do …; done` is
//  the fold battery. STDERR carries the reading: the ignored paths and —
//  loudly — every changed path NO suite watches (an unclassified path is a
//  change nothing in the gate would notice). Exit 0 for a listing; exit 2
//  when a range yields no paths at all (a mistyped range must never read as
//  "nothing to run").
// ============================================================================
import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { loadImpactManifest, selectImpact } from './impactManifest.ts'

const ROOT = resolve(import.meta.dir, '..', '..')

/** The whole-tree ratchets: owed by every fold, whatever the diff touches
 *  (render-engine scans every src file for references to the paint engine —
 *  a comment in an unrelated leaf can trip it). */
const ALWAYS = ['integrity', 'identity', 'consistency-census', 'gate', 'verify', 'render-engine']

const argv = process.argv.slice(2)
const json = argv.includes('--json')
const explain = argv.includes('--explain')
const args = argv.filter(a => a !== '--json' && a !== '--explain')

function usage(): never {
  console.error('usage: bun scripts/verify/impact.ts <rev-range> [--explain|--json] | --paths <path…> [--explain|--json]')
  process.exit(2)
}

let paths: string[]
if (args[0] === '--paths') {
  paths = args.slice(1)
  if (paths.length === 0) usage()
} else {
  const range = args[0]
  if (!range || range.startsWith('-')) usage()
  const out = execFileSync('git', ['diff', '--name-only', range], { cwd: ROOT, encoding: 'utf8' })
  paths = out
    .split('\n')
    .map(l => l.trim())
    .filter(Boolean)
  if (paths.length === 0) {
    console.error(`impact: the range ${range} names no changed paths`)
    process.exit(2)
  }
}

const manifest = loadImpactManifest(ROOT)
const sel = selectImpact(manifest, paths)
const always = ALWAYS.filter(s => existsSync(join(ROOT, 'scripts', s, 'run-all.sh')))
const suites = [...new Set([...sel.suites, ...always])].sort()

if (json) {
  console.log(
    JSON.stringify(
      {
        suites: suites.map(s => ({
          suite: s,
          class: manifest.classes[s] ?? 'undeclared',
          reason: sel.suites.has(s) ? 'gate-watch' : 'whole-tree ratchet',
        })),
        ignored: sel.ignored,
        unclassified: sel.unclassified,
        perPath: sel.perPath,
      },
      null,
      2,
    ),
  )
  process.exit(0)
}

for (const s of suites) console.log(s)

console.error(
  `impact: ${paths.length} changed path(s) → ${sel.suites.size} watched suite(s) + ${always.length} whole-tree ratchet(s) (${always.join(' · ')})`,
)
if (sel.ignored.length > 0) console.error(`ignored (${sel.ignored.length}): ${sel.ignored.join(' ')}`)
if (sel.unclassified.length > 0) {
  console.error(`UNCLASSIFIED (${sel.unclassified.length}) — no suite watches these paths:`)
  for (const p of sel.unclassified) console.error(`  ${p}`)
}
if (explain) {
  for (const [p, claimants] of Object.entries(sel.perPath)) console.error(`  ${p} → ${claimants.join(', ')}`)
}
