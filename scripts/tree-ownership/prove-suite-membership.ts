#!/usr/bin/env bun
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { basename, join } from 'node:path'

const ROOT = join(import.meta.dir, '..', '..')
const SCRIPTS = join(ROOT, 'scripts')

const EXCLUDED: Record<string, string> = {
  'scripts/gate/prove-dist-cache.sh': 'shell prover invoked explicitly by the gate suite runner (not a bun prove-*.ts)',
}

let failures = 0
const check = (label: string, cond: boolean, detail = ''): void => {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}

console.log('============================================================')
console.log(' suite membership — no orphan provers')
console.log('============================================================')

const orphans: string[] = []
const staleExclusions: string[] = []
let total = 0
const everyRunnerText = readdirSync(SCRIPTS)
  .map(dir => join(SCRIPTS, dir, 'run-all.sh'))
  .filter(p => existsSync(p))
  .map(p => readFileSync(p, 'utf8'))
  .join('\n')
const memberEnrolled = new Set<string>()
for (const dir of readdirSync(SCRIPTS)) {
  const suffix = dir.endsWith('-drives') ? '-drives' : dir.endsWith('-boots') ? '-boots' : null
  if (suffix === null) continue
  const members = join(SCRIPTS, dir, 'members.txt')
  if (!existsSync(members)) continue
  const parent = dir.slice(0, -suffix.length)
  for (const raw of readFileSync(members, 'utf8').split('\n')) {
    const name = raw.trim()
    if (name === '' || name.startsWith('#')) continue
    memberEnrolled.add(`scripts/${parent}/${name}`)
  }
}
for (const dir of readdirSync(SCRIPTS)) {
  const suiteDir = join(SCRIPTS, dir)
  const runAll = join(suiteDir, 'run-all.sh')
  let provers: string[]
  try {
    provers = readdirSync(suiteDir).filter(f => /^prove-.*\.ts$/.test(f))
  } catch {
    continue
  }
  if (provers.length === 0) continue
  if (!existsSync(runAll)) {
    for (const p of provers) {
      const rel = `scripts/${dir}/${p}`
      if (EXCLUDED[rel]) continue
      orphans.push(`${rel} (no run-all.sh)`)
    }
    continue
  }
  const text = readFileSync(runAll, 'utf8')
  const globDriven = text.includes('prove-*.ts')
  for (const p of provers) {
    total++
    const rel = `scripts/${dir}/${p}`
    if (EXCLUDED[rel]) continue
    if (memberEnrolled.has(rel)) continue
    if (globDriven || text.includes(p) || text.includes(basename(p, '.ts'))) continue
    if (everyRunnerText.includes(`scripts/${dir}/${p}`)) continue
    orphans.push(rel)
  }
}
for (const rel of Object.keys(EXCLUDED)) {
  if (!existsSync(join(ROOT, rel))) staleExclusions.push(rel)
}

console.log(`  swept ${total} provers across the suite dirs`)
check('zero orphan provers (run in a suite or registered excluded)', orphans.length === 0, orphans.slice(0, 8).join(', '))
check('exclusion registry rows all point at existing files', staleExclusions.length === 0, staleExclusions.join(', '))

const RELEASE_COUNTED: Record<string, string> = {
  'scripts/ui/prove-declared-keys-unshadowed.ts': 'the closed roster of key hosts over src/components, src/screens and src/commands: a fold that lands an unrostered host turns it red',
  'scripts/ui/prove-exit-reachability.ts': 'the closed census of every way out over the same trees',
}
const RELEASE_CLASSES = new Set(['pure', 'cpu', 'exclusive'])
const classOf = (dir: string): string => /^# gate-class:\s*(\S+)/m.exec(readFileSync(join(SCRIPTS, dir, 'run-all.sh'), 'utf8'))?.[1] ?? 'undeclared'
const listedBy = new Map<string, string[]>()
for (const dir of readdirSync(SCRIPTS)) {
  const members = join(SCRIPTS, dir, 'members.txt')
  const runAll = join(SCRIPTS, dir, 'run-all.sh')
  if (!existsSync(members) || !existsSync(runAll)) continue
  const parent = /scripts\/([A-Za-z0-9_-]+)\/\$name/.exec(readFileSync(runAll, 'utf8'))?.[1]
  if (parent === undefined) continue
  for (const raw of readFileSync(members, 'utf8').split('\n')) {
    const name = raw.trim()
    if (name === '' || name.startsWith('#')) continue
    const rel = `scripts/${parent}/${name}`
    listedBy.set(rel, [...(listedBy.get(rel) ?? []), dir])
  }
}
const deferredOnly = Object.keys(RELEASE_COUNTED).filter(rel => !(listedBy.get(rel) ?? []).some(dir => RELEASE_CLASSES.has(classOf(dir))))
const missingCounted = Object.keys(RELEASE_COUNTED).filter(rel => !existsSync(join(ROOT, rel)))
check(
  'every source census the release verdict must count is named by a release-class member list (a pty suite is deferred to the drives verdict)',
  deferredOnly.length === 0,
  deferredOnly.map(rel => `${rel} — ${(listedBy.get(rel) ?? []).map(dir => `${dir} (${classOf(dir)})`).join(', ') || 'the pty complement only'}: ${RELEASE_COUNTED[rel]}`).join(' · '),
)
check('the release-counted census rows all point at existing files', missingCounted.length === 0, missingCounted.join(', '))

const vacuous: string[] = []
for (const dir of readdirSync(SCRIPTS)) {
  const runAll = join(SCRIPTS, dir, 'run-all.sh')
  if (!existsSync(runAll)) continue
  if (!readFileSync(runAll, 'utf8').includes('prove-*.ts')) continue
  let n = 0
  try {
    const entries = readdirSync(join(SCRIPTS, dir))
    n = entries.filter(f => /^(prove|repro)-.*\.ts$/.test(f)).length
    for (const e of entries) {
      try {
        n += readdirSync(join(SCRIPTS, dir, e)).filter(f => /^(prove|repro)-.*\.ts$/.test(f)).length
      } catch {
      }
    }
  } catch {
  }
  if (n === 0) vacuous.push(`scripts/${dir}`)
}
check('no glob-driven suite is proof-empty (vacuous green)', vacuous.length === 0, vacuous.join(', '))

console.log('════════════════════════════════════════════════════════════════════════════')
if (failures > 0) {
  console.error(`❌ ${failures} membership check(s) failed`)
  process.exit(1)
}
console.log('✅ EVERY PROVER RUNS IN ITS SUITE')
