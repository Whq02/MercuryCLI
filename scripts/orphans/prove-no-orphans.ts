#!/usr/bin/env bun
// scripts/orphans/prove-no-orphans.ts — the dead-code ratchet (typed-baseline
// semantics).
//
// BFS the import graph from the real entrypoints (scripts/orphans/graph.ts —
// the ONE syntax-aware graph builder, shared with the reachability manifest)
// and flag src files no path reaches. RATCHET semantics, TIGHTENED at:
//
//   · a NEW orphan fails the gate (wire it in or delete it — or, deliberately,
//     hand-add a typed exemption row with a class + a concrete reason);
//   · a CURED exemption (listed file now reachable or deleted) FAILS the gate
//     until removed — `--regen` PRUNES cured rows only, it never adds
//     (the law: a stale exemption cannot hide a future severed
//     loop, and relocking cannot silently grandfather new dead code);
//   · every exemption row carries a class from the node vocabulary and
//     a reason ≥ 40 chars — a generic baseline line is not an explanation.
//
//   bun run scripts/orphans/prove-no-orphans.ts             # gate
//   bun run scripts/orphans/prove-no-orphans.ts --regen     # prune cured rows
//   … --baseline <path>   # the discrimination prover's seam (never the pool)
//
// Static-only caveat: dynamic require(expr) and build-time-injected modules
// don't appear as edges. Entrypoint siblings, the SDK surface, and build.ts
// stub-map targets are covered as roots/edges by graph.ts.

import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { buildImportGraph } from './graph.ts'

const ROOT = join(import.meta.dir, '..', '..')
const REGEN = process.argv.includes('--regen')
const baselineArg = process.argv.indexOf('--baseline')
const BASELINE = baselineArg !== -1 ? process.argv[baselineArg + 1]! : join(import.meta.dir, 'baseline.json')

const CLASSES = new Set([
  'production-live',
  'operator-opt-in-live',
  'sdk-or-external-contract',
  'metadata-or-generated',
  'living-specimen',
  'proof-or-fixture-only',
  'archive',
  'broken-path',
  'superseded-unreachable',
])

interface BaselineRow {
  file: string
  class: string
  reason: string
}
interface BaselineFile {
  schema: number
  note?: string
  classes?: string[]
  rows: BaselineRow[]
}

const graph = buildImportGraph()
const orphans = graph.files
  .filter(f => !graph.reached.has(f))
  .map(f => f.slice(ROOT.length + 1))
  .sort()

const baseline: BaselineFile = existsSync(BASELINE)
  ? (JSON.parse(readFileSync(BASELINE, 'utf-8')) as BaselineFile)
  : { schema: 1, rows: [] }
const baselineFiles = new Set(baseline.rows.map(r => r.file))

const orphanSet = new Set(orphans)
const fresh = orphans.filter(o => !baselineFiles.has(o))
const cured = baseline.rows.filter(r => !orphanSet.has(r.file))
const malformed = baseline.rows.filter(
  r => !CLASSES.has(r.class) || typeof r.reason !== 'string' || r.reason.length < 40,
)

if (REGEN) {
  if (cured.length === 0) {
    console.log('  [RELOCK] nothing cured — baseline unchanged')
    process.exit(0)
  }
  const kept = baseline.rows.filter(r => orphanSet.has(r.file))
  writeFileSync(BASELINE, JSON.stringify({ ...baseline, rows: kept }, null, 2) + '\n')
  console.log(`  [RELOCKED] pruned ${cured.length} cured exemption(s); ${kept.length} remain:`)
  for (const c of cured) console.log(`      · ${c.file} (${c.class})`)
  console.log('  NOTE: --regen never ADDS exemptions — a new orphan is wired, deleted, or hand-classified.')
  process.exit(0)
}

console.log('============================================================')
console.log(' no-orphans ratchet — syntax-aware reachability from the entrypoints')
console.log('============================================================')
const reachedTs = graph.files.filter(f => graph.reached.has(f)).length
console.log(
  `  reachable: ${reachedTs}/${graph.files.length} src ts files (+${graph.reached.size - reachedTs} resolved assets) · edges: ${graph.edges.length} · orphans: ${orphans.length} (typed baseline ${baseline.rows.length})`,
)

let red = false
if (malformed.length) {
  red = true
  console.log(`  [FAIL] ${malformed.length} exemption row(s) with an invalid class or a thin reason:`)
  for (const m of malformed) console.log(`      - ${m.file} (class '${m.class}', reason ${m.reason?.length ?? 0} chars)`)
}
if (cured.length) {
  red = true
  console.log(`  [FAIL] ${cured.length} CURED exemption(s) — the file is reachable or deleted; prune via --regen:`)
  for (const c of cured.slice(0, 10)) console.log(`      - ${c.file} (${c.class})`)
}
if (fresh.length) {
  red = true
  console.log(`  [FAIL] ${fresh.length} NEW orphan(s) — wire them in, delete them, or hand-add a typed exemption:`)
  for (const f of fresh) console.log(`      - ${f}`)
}

if (red) {
  console.log('❌ NO-ORPHANS RED')
  process.exit(1)
}
console.log('✅ NO-ORPHANS GREEN')
process.exit(0)
