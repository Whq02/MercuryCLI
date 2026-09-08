#!/usr/bin/env bun
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
  check('the shared default stays keyed to the prover for captures on the shared home', lines.some(l => l.includes("process.env.MERCURY_DAEMON_DIR = join(tmpdir(), `mercury-render-daemon-${process.pid}`)")))
}

console.log('§2 a prover on two or more homes carries a daemon dir in each spawn env')
{
  const files = execSync("git ls-files 'scripts/**/*.ts'", { cwd: ROOT, encoding: 'utf8' }).split('\n').filter(Boolean)
  const offenders: string[] = []
  let multiHome = 0
  for (const file of files) {
    if (file.endsWith('prove-capture-home-owns-daemon.ts')) continue
    const src = readFileSync(join(ROOT, file), 'utf8')
    if (!src.includes('renderScenarios')) continue
    const minted = (expr: string): boolean => expr !== 'CONFIG_HOME' && !expr.startsWith('process.env.MERCURY_CONFIG_DIR')
    const homes = new Set<string>()
    for (const m of src.matchAll(/MERCURY_CONFIG_DIR: ([^,\n}]+)/g)) if (minted(m[1]!.trim())) homes.add(m[1]!.trim())
    if (homes.size < 2) continue
    multiHome++
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
