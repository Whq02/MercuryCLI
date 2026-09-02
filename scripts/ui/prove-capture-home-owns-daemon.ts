#!/usr/bin/env bun
// ============================================================================
//  scripts/ui/prove-capture-home-owns-daemon.ts — a capture that drives its
//  own config home owns its daemon dir.
//
//  The class: the shared capture harness (scripts/ui/renderScenarios.ts)
//  pins MERCURY_DAEMON_DIR to a scratch keyed by the PROVER's pid, so every
//  capture of one run shares one daemon — a drive that gives a leg its own
//  home still attached its session to the daemon born under another leg's
//  home, and the screen never saw its own seat's rows. The law: a home
//  minted for a capture carries its own daemon dir beside it.
//
//   §1  every scratch-home scenario in the harness pins its daemon dir
//       beside the home (a session born in one scenario never reaches the
//       next scenario's daemon probe).
//   §2  every prover that spawns captures on two or more DISTINCT homes
//       carries a daemon dir in each of those spawn envs (a ratchet over the
//       tree: none may regress to the shared pid scratch).
//   §3  the canonical spelling stands where the class was found (the busy
//       world of the exit-copy journeys).
//
//  Run:  ~/.bun/bin/bun run scripts/ui/prove-capture-home-owns-daemon.ts
// ============================================================================
import { execSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = process.cwd()
const read = (rel: string): string => readFileSync(join(ROOT, rel), 'utf8')
let failures = 0
const check = (label: string, ok: boolean, detail = ''): void => {
  if (!ok) failures++
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${detail && !ok ? ` — ${detail}` : ''}`)
}

console.log('§1 every scratch-home scenario in the harness owns its daemon dir')
{
  const lines = read('scripts/ui/renderScenarios.ts').split('\n')
  const bare: number[] = []
  let sites = 0
  lines.forEach((line, i) => {
    if (!/^\s*process\.env\.MERCURY_CONFIG_DIR = scratch\s*(\/\/.*)?$/.test(line)) return
    sites++
    const window = lines.slice(i + 1, i + 7).join('\n')
    if (!/process\.env\.MERCURY_DAEMON_DIR = /.test(window)) bare.push(i + 1)
  })
  check('the harness has scratch-home scenarios to pin', sites > 0)
  check('no scratch-home scenario inherits the shared pid-keyed daemon dir', bare.length === 0, `bare at lines ${bare.join(', ')}`)
  check('the shared default stays keyed to the prover for captures on the shared home', lines.some(l => l.includes("process.env.MERCURY_DAEMON_DIR = join(tmpdir(), `hermes-render-daemon-${process.pid}`)")))
}

console.log('§2 a prover on two or more homes carries a daemon dir in each spawn env')
{
  const files = execSync("git ls-files 'scripts/**/*.ts'", { cwd: ROOT, encoding: 'utf8' }).split('\n').filter(Boolean)
  const offenders: string[] = []
  let multiHome = 0
  for (const file of files) {
    const src = readFileSync(join(ROOT, file), 'utf8')
    if (!src.includes('renderScenarios')) continue
    // A spawn env names a home as `MERCURY_CONFIG_DIR: <expr>`; the
    // harness's shared home (CONFIG_HOME) and the inherited one are the
    // run's own — their daemon dir is the run's — so only MINTED homes count.
    const minted = (expr: string): boolean => expr !== 'CONFIG_HOME' && !expr.startsWith('process.env.MERCURY_CONFIG_DIR')
    const homes = new Set<string>()
    for (const m of src.matchAll(/MERCURY_CONFIG_DIR: ([^,\n}]+)/g)) if (minted(m[1]!.trim())) homes.add(m[1]!.trim())
    if (homes.size < 2) continue
    multiHome++
    // Every env object that names a minted home must name a daemon dir too.
    for (const m of src.matchAll(/\{[^{}]*MERCURY_CONFIG_DIR: ([^,\n}]+)[^{}]*\}/g)) {
      if (!minted(m[1]!.trim())) continue
      if (!m[0].includes('MERCURY_DAEMON_DIR')) offenders.push(`${file}: ${m[0].replace(/\s+/g, ' ').slice(0, 80)}`)
    }
  }
  check('every multi-home prover gives each home its daemon dir', offenders.length === 0, offenders.join(' | '))
  console.log(`      (${multiHome} multi-home prover(s) under the law)`)
}

console.log('§3 the canonical spelling where the class was found')
{
  const src = read('scripts/interaction/prove-exit-copy-journeys.ts')
  check("the busy world's home carries its daemon dir beside it", src.includes("MERCURY_CONFIG_DIR: home,") && src.includes("MERCURY_DAEMON_DIR: join(home, 'daemon'),"))
}

if (failures > 0) {
  console.log(`\n ❌ capture-home-owns-daemon — ${failures} failure(s)`)
  process.exit(1)
}
console.log('\n ✅ capture-home-owns-daemon — every minted capture home owns its daemon dir')
