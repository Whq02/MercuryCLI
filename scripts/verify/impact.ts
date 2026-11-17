#!/usr/bin/env bun
import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { loadImpactManifest, RATCHETS, selectImpact } from './impactManifest.ts'

const ROOT = process.env.MERCURY_SLICE_ROOT ?? resolve(import.meta.dir, '..', '..')

const FLAGS = ['--json', '--explain', '--staged', '--dirty']
const argv = process.argv.slice(2)
const json = argv.includes('--json')
const explain = argv.includes('--explain')
const staged = argv.includes('--staged')
const dirty = argv.includes('--dirty')
const args = argv.filter(a => !FLAGS.includes(a))

function usage(): never {
  console.error('usage: bun scripts/verify/impact.ts <rev-range>|--staged|--dirty|--paths <path…> [--explain|--json]')
  process.exit(2)
}
if (args.some(a => a.startsWith('--') && a !== '--paths')) usage()

const gitLines = (gitArgs: string[]): string[] =>
  execFileSync('git', [gitArgs[0]!, '-z', ...(gitArgs[0] === 'diff' ? ['--no-renames', '--no-relative'] : []), ...gitArgs.slice(1)], { cwd: ROOT, encoding: 'utf8' })
    .split('\0')
    .filter(Boolean)

let paths: string[]
if (args[0] === '--paths') {
  paths = args.slice(1)
  if (paths.length === 0) usage()
} else if (staged) {
  paths = gitLines(['diff', '--cached', '--name-only'])
  if (paths.length === 0) {
    console.error('impact: nothing is staged')
    process.exit(2)
  }
} else if (dirty) {
  paths = [...new Set([...gitLines(['diff', '--name-only', 'HEAD']), ...gitLines(['ls-files', '--others', '--exclude-standard'])])].sort()
  if (paths.length === 0) {
    console.error('impact: the working tree matches HEAD')
    process.exit(2)
  }
} else {
  const range = args[0]
  if (!range || range.startsWith('-')) usage()
  paths = gitLines(['diff', '--name-only', range])
  if (paths.length === 0) {
    console.error(`impact: the range ${range} names no changed paths`)
    process.exit(2)
  }
}

const manifest = loadImpactManifest(ROOT)
const sel = selectImpact(manifest, paths)
const always = RATCHETS.filter(s => existsSync(join(ROOT, 'scripts', s, 'run-all.sh')))
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
