#!/usr/bin/env bun
// ============================================================================
//  scripts/tree-ownership/prove-suite-membership.ts — §13 (D-4, the
//  orphan-prover class): every scripts/*/prove-*.ts RUNS in its suite or is
//  explicitly registered excluded.
//
//  The class this kills: a prover written against an explicit-list run-all
//  and never wired in sits red-or-rotten for weeks with zero signal
//  (prove-classifier-prompt carried an unsatisfiable check as far back as
//  START; the config-home prover's stale source-lock was
//  invisible the same way). A glob-driven run-all covers its dir by
//  construction; explicit-list suites must NAME every prover.
// ============================================================================
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { basename, join } from 'node:path'

const ROOT = join(import.meta.dir, '..', '..')
const SCRIPTS = join(ROOT, 'scripts')

/** Deliberately suite-less provers: each entry carries its reason. */
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
// A prover is enrolled when ANY suite's runner names it — a suite may drive a
// sibling directory's prover by its repo path (identity runs substrate's
// health self-recognition), and that is enrolment, not orphanhood.
const everyRunnerText = readdirSync(SCRIPTS)
  .map(dir => join(SCRIPTS, dir, 'run-all.sh'))
  .filter(p => existsSync(p))
  .map(p => readFileSync(p, 'utf8'))
  .join('\n')
// THE SPLIT (GATE-REMAKE, 661db2b): a `<suite>-drives` member suite runs the
// drive provers that LIVE in its parent's directory, naming them by basename
// in its members.txt — enrolment by list, one basename per line.
const memberEnrolled = new Set<string>()
for (const dir of readdirSync(SCRIPTS)) {
  if (!dir.endsWith('-drives')) continue
  const members = join(SCRIPTS, dir, 'members.txt')
  if (!existsSync(members)) continue
  const parent = dir.slice(0, -'-drives'.length)
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

// The vacuous-green kill (meta-gaps F7): a glob-driven suite whose provers
// all moved away would exit GREEN having run zero proofs — assert every
// glob-driven suite dir still contains at least one prover.
const vacuous: string[] = []
for (const dir of readdirSync(SCRIPTS)) {
  const runAll = join(SCRIPTS, dir, 'run-all.sh')
  if (!existsSync(runAll)) continue
  if (!readFileSync(runAll, 'utf8').includes('prove-*.ts')) continue
  // count one subdir level too — suites like pulse keep provers in
  // matrix//lib/ subdirs and drive them from the runner explicitly; a
  // repro-* driver the runner runs as a gate member (update-reliability's
  // released-artifact repros) is a proof too.
  let n = 0
  try {
    const entries = readdirSync(join(SCRIPTS, dir))
    n = entries.filter(f => /^(prove|repro)-.*\.ts$/.test(f)).length
    for (const e of entries) {
      try {
        n += readdirSync(join(SCRIPTS, dir, e)).filter(f => /^(prove|repro)-.*\.ts$/.test(f)).length
      } catch {
        /* file, not dir */
      }
    }
  } catch {
    /* unreadable dir counts as vacuous below */
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
