#!/usr/bin/env bun
//  The impact manifest (impactManifest.ts) maps each suite's `# gate-watch:`
import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { loadImpactManifest, selectImpact } from './impactManifest.ts'

const ROOT = resolve(import.meta.dir, '..', '..')

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
