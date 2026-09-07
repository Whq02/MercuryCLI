#!/usr/bin/env bun
//  The impact manifest (impactManifest.ts) maps each suite's `# gate-watch:`
import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { loadImpactManifest, selectImpact } from './impactManifest.ts'

const ROOT = process.env.MERCURY_SLICE_ROOT ?? resolve(import.meta.dir, '..', '..')

const ALWAYS = ['integrity', 'identity', 'consistency-census', 'gate', 'verify', 'render-engine']

const argv = process.argv.slice(2)
const json = argv.includes('--json')
const explain = argv.includes('--explain')
const run = argv.includes('--run')
const staged = argv.includes('--staged')
const dirty = argv.includes('--dirty')
const args = argv.filter(a => !['--json', '--explain', '--run', '--staged', '--dirty'].includes(a))

function usage(): never {
  console.error('usage: bun scripts/verify/impact.ts <rev-range>|--staged|--dirty|--paths <path…> [--explain|--json] [--run]')
  process.exit(2)
}

const gitLines = (gitArgs: string[]): string[] =>
  execFileSync('git', gitArgs, { cwd: ROOT, encoding: 'utf8' })
    .split('\n')
    .map(l => l.trim())
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

if (!run) for (const s of suites) console.log(s)

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

if (run) {
  const { mkdtempSync, readFileSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { spawnSync } = await import('node:child_process')
  const out = mkdtempSync(join(tmpdir(), 'impact-run-'))
  const budget = process.env.MERCURY_SUITE_TIMEOUT ?? process.env.MERCURY_SUITE_CEILING ?? '900'
  let red = 0
  const rows: string[] = []
  for (const suite of suites) {
    const runner = join('scripts', suite, 'run-all.sh')
    const res = spawnSync('bash', ['scripts/gate/run-suite.sh', runner, budget, out, 'impact --run'], { cwd: ROOT, stdio: 'ignore', env: process.env })
    let rc = res.status ?? 1
    let secs = '?'
    try {
      rc = Number.parseInt(readFileSync(join(out, `${suite}.rc`), 'utf8').trim(), 10)
      secs = readFileSync(join(out, `${suite}.secs`), 'utf8').trim()
    } catch {
    }
    if (rc !== 0) red++
    const row = `${suite}\t${rc}\t${secs}`
    rows.push(row)
    console.log(row)
  }
  console.error(`impact --run: ${suites.length} suite(s), ${red} red; output under ${out}`)
  process.exit(red === 0 ? 0 : 1)
}
