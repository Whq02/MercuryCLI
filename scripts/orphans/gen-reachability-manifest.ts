#!/usr/bin/env bun
// ============================================================================
//  scripts/orphans/gen-reachability-manifest.ts — the ONE typed reachability
//  manifest.
//
//  Extends the existing owners — the syntax-aware import graph
//  (scripts/orphans/graph.ts), the typed orphan baseline (baseline.json), the
//  flag registry (src/substrate/flagRegistry.ts), the capability graduation
//  matrix (docs/CAPABILITY-GRADUATION-MATRIX.md — parsed when present, a
//  named absence otherwise), and the durable-operation
//  matrix (src/substrate/durableOperationMatrix.ts) — into ONE generated,
//  deterministic manifest, written to the UNTRACKED inspection path:
//
//    scripts/orphans/.out/REACHABILITY-MANIFEST.json  (typed; sorted; no timestamps)
//    scripts/orphans/.out/REACHABILITY-MAP.md         (the human-readable map)
//
//  Generate → verify → never commit: the manifest is derived truth, so the
//  gate regenerates it on every run (prove-reachability-manifest.ts) instead
//  of syncing a committed copy. Usage:
//    bun run scripts/orphans/gen-reachability-manifest.ts [--check]
//  (--check regenerates to memory and fails on any byte drift against the
//  last written artifact — the determinism seam the prover uses.)
//
//  Classification is MECHANICAL:
//    · a src module reached from the runtime roots        → production-live
//    · reached only from the SDK surface                  → sdk-or-external-contract
//    · unreached but in the typed baseline                → the baseline row's class
//    · unreached and unbaselined                          → (impossible while the
//      no-orphans gate is green — asserted here)
//  Capability rows map verdict→class explicitly (table below); flags carry
//  their registry kind plus consumer existence/reachability. Function-level
//  severance (an exported symbol nobody calls inside a reached module — the
//  DUALWRITE class) is BELOW module granularity and stays a concern; the
//  manifest records module-level truth and the known finding list pins any
//  live-kind flag whose src consumer module is unreached.
// ============================================================================

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { buildImportGraph, extractSpecs, resolveSpec, readStubMap, GRAPH_ROOT } from './graph.ts'
import { FLAG_REGISTRY } from '../../src/substrate/flagRegistry.ts'
import { DURABLE_OPERATION_MATRIX } from '../../src/substrate/durableOperationMatrix.ts'

const CHECK = process.argv.includes('--check')
const OUT_DIR = join(GRAPH_ROOT, 'scripts', 'orphans', '.out')
const MANIFEST_PATH = join(OUT_DIR, 'REACHABILITY-MANIFEST.json')
const MAP_PATH = join(OUT_DIR, 'REACHABILITY-MAP.md')

// ── the graph + root groups ────────────────────────────────────────────────
const graph = buildImportGraph()
const rel = (p: string): string => p.slice(GRAPH_ROOT.length + 1)

const RUNTIME_ROOT_FILES = ['src/entrypoints/cli.tsx', 'src/entrypoints/init.ts', 'src/entrypoints/mcp.ts']
const runtimeRoots = graph.entries.filter(e => RUNTIME_ROOT_FILES.includes(rel(e)))
const sdkRoots = graph.entries.filter(e => !RUNTIME_ROOT_FILES.includes(rel(e)))

const byFrom = new Map<string, string[]>()
for (const e of graph.edges) {
  if (!e.resolved) continue
  const list = byFrom.get(e.from)
  if (list) list.push(e.resolved)
  else byFrom.set(e.from, [e.resolved])
}
function bfs(entries: string[]): Set<string> {
  const seen = new Set<string>(entries)
  const queue = [...entries]
  while (queue.length) {
    const f = queue.pop()!
    for (const t of byFrom.get(f) ?? []) {
      if (!seen.has(t)) {
        seen.add(t)
        queue.push(t)
      }
    }
  }
  return seen
}
const runtimeReach = bfs(runtimeRoots)
const sdkReach = bfs(sdkRoots)

// ── proof coverage: which suites import which src files ───────────────────
const SCRIPTS = join(GRAPH_ROOT, 'scripts')
function* walkScripts(dir: string): Generator<string> {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name)
    if (e.isDirectory()) yield* walkScripts(p)
    else if (/\.(ts|tsx)$/.test(e.name) && !e.name.endsWith('.d.ts')) yield p
  }
}
const stubMap = readStubMap()
const proofSuitesByFile = new Map<string, Set<string>>()
for (const script of walkScripts(SCRIPTS)) {
  let text: string
  try {
    text = readFileSync(script, 'utf-8')
  } catch {
    continue
  }
  const suite = rel(script).split('/')[1]!
  for (const { spec } of extractSpecs(script, text)) {
    const target = resolveSpec(script, spec, stubMap)
    if (!target || !target.includes('/src/')) continue
    const set = proofSuitesByFile.get(target)
    if (set) set.add(suite)
    else proofSuitesByFile.set(target, new Set([suite]))
  }
}

// ── the typed baseline ─────────────────────────────────────────────────────
const baseline = JSON.parse(readFileSync(join(SCRIPTS, 'orphans', 'baseline.json'), 'utf-8')) as {
  rows: Array<{ file: string; class: string; reason: string }>
}
const baselineByFile = new Map(baseline.rows.map(r => [r.file, r]))

// ── node classification ────────────────────────────────────────────────────
interface NodeRow {
  file: string
  class: string
  runtime: 0 | 1
  sdk: 0 | 1
  proofSuites: number
}
const nodes: NodeRow[] = []
const unclassifiable: string[] = []
for (const f of graph.files) {
  const r = rel(f)
  const inRuntime = runtimeReach.has(f)
  const inSdk = sdkReach.has(f)
  const base = baselineByFile.get(r)
  let cls: string
  if (inRuntime) cls = 'production-live'
  else if (inSdk) cls = 'sdk-or-external-contract'
  else if (base) cls = base.class
  else {
    cls = 'UNCLASSIFIED'
    unclassifiable.push(r)
  }
  nodes.push({
    file: r,
    class: cls,
    runtime: inRuntime ? 1 : 0,
    sdk: inSdk ? 1 : 0,
    proofSuites: proofSuitesByFile.get(f)?.size ?? 0,
  })
}
if (unclassifiable.length) {
  console.error(`FATAL: ${unclassifiable.length} unreached src file(s) missing from the typed baseline (the no-orphans gate should be red):`)
  for (const u of unclassifiable) console.error(`  - ${u}`)
  process.exit(1)
}

// ── capability rows (the graduation matrix, header-mapped) ─────────────────
// The matrix is a hand-written truth table gated by scripts/capabilities/;
// when the file is absent the manifest records the absence by name and the
// prover skips the capability legs — never a fabricated empty claim.
const VERDICT_CLASS: Record<string, string> = {
  LIVE_DEFAULT_ON: 'production-live',
  LIVE_OPT_IN: 'operator-opt-in-live',
  PARKED_INTENTIONAL: 'living-specimen',
  DEAD_VENDORED: 'archive',
  BROKEN: 'broken-path',
  UNKNOWN: 'broken-path',
  DELETED: 'superseded-unreachable',
}
const VERDICTS = Object.keys(VERDICT_CLASS)

interface CapabilityRow {
  name: string
  verdict: string
  class: string
  srcAnchors: string[]
  anchorsRuntimeReached: 0 | 1
  anchorsUnionReached: 0 | 1
}
const MATRIX_PATH = join(GRAPH_ROOT, 'docs', 'CAPABILITY-GRADUATION-MATRIX.md')
const matrixPresent = existsSync(MATRIX_PATH)
const capabilities: CapabilityRow[] = []
if (matrixPresent) {
  const lines = readFileSync(MATRIX_PATH, 'utf-8').split('\n')
  let headers: string[] | null = null
  for (const line of lines) {
    if (!line.trim().startsWith('|')) {
      headers = null
      continue
    }
    const cells = line
      .trim()
      .replace(/^\|/, '')
      .replace(/\|$/, '')
      .split('|')
      .map(c => c.trim())
    if (cells.every(c => /^:?-{2,}:?$/.test(c.replace(/\s/g, '')))) continue
    if (cells[0] === 'Capability') {
      headers = cells
      continue
    }
    if (!headers || headers[0] !== 'Capability') continue
    const cell = (name: string): string => cells[headers!.indexOf(name)] ?? ''
    const verdictCell = cell('Verdict')
    const verdict = VERDICTS.find(v => verdictCell.includes(v))
    if (!verdict) continue
    const anchorCell = cell('Source anchor')
    // Reach-checkable anchors are FILES only — matrix rows may also anchor a
    // whole directory (prose granularity); a directory passes existsSync but
    // can never be a member of the file-reach set.
    const srcAnchors = [...new Set([...anchorCell.matchAll(/src\/[A-Za-z0-9_\-./]+/g)].map(m => m[0].replace(/[.,]$/, '').replace(/:\d+$/, '')))]
      .filter(a => {
        const pth = join(GRAPH_ROOT, a)
        return existsSync(pth) && statSync(pth).isFile()
      })
      .sort()
    const abs = srcAnchors.map(a => join(GRAPH_ROOT, a))
    capabilities.push({
      name: cell('Capability').replace(/\*\*/g, '').slice(0, 120),
      verdict,
      class: VERDICT_CLASS[verdict]!,
      srcAnchors,
      anchorsRuntimeReached: abs.length > 0 && abs.some(a => runtimeReach.has(a)) ? 1 : 0,
      anchorsUnionReached: abs.length > 0 && abs.every(a => runtimeReach.has(a) || sdkReach.has(a)) ? 1 : 0,
    })
  }
}

// ── flag rows (the registry, imported live) ────────────────────────────────
interface FlagRow {
  env: string
  kind: string
  tier: string
  consumer: string
  consumerExists: 0 | 1
  consumerReached: 0 | 1
  /** The consumer sits in the typed orphan baseline: the flag is PARKED with
   *  its reader by a recorded decision (the baseline row carries the class
   *  and the reason), not severed by accident. */
  consumerParked: 0 | 1
}
const flags: FlagRow[] = FLAG_REGISTRY.map(f => {
  const consumerPath = f.consumer.split(/[ (]/)[0]!
  const abs = join(GRAPH_ROOT, consumerPath)
  const exists = consumerPath.startsWith('src/') && existsSync(abs)
  const reached = exists && (runtimeReach.has(abs) || sdkReach.has(abs))
  return {
    env: f.env,
    kind: f.kind,
    tier: f.tier ?? '',
    consumer: f.consumer,
    consumerExists: exists ? 1 : 0,
    consumerReached: reached ? 1 : 0,
    consumerParked: exists && !reached && baselineByFile.has(consumerPath) ? 1 : 0,
  }
}).sort((a, b) => a.env.localeCompare(b.env))

// A live-kind flag whose src consumer module exists but is UNREACHED would be
// a severed-flag finding (the DUALWRITE class at module granularity) — unless
// the consumer is parked in the typed baseline, where the parking is recorded
// with its reason.
const flagFindings = flags
  .filter(f => f.consumerExists === 1 && f.consumerReached === 0 && f.consumerParked === 0)
  .map(f => f.env)
const flagsParked = flags.filter(f => f.consumerParked === 1).map(f => f.env)

// ── durable owners ─────────────────────────────────────────────────────────
const durableOwners = DURABLE_OPERATION_MATRIX.map(r => ({
  id: r.id,
  domain: r.domain,
  stateClass: r.stateClass,
  sources: [...r.source].sort(),
  sourcesReached: r.source.every(s => {
    const p = join(GRAPH_ROOT, s.split(':')[0]!)
    return !s.startsWith('src/') || !existsSync(p) || runtimeReach.has(p) || sdkReach.has(p)
  })
    ? 1
    : 0,
})).sort((a, b) => a.id.localeCompare(b.id))

// ── suites ─────────────────────────────────────────────────────────────────
const suites = readdirSync(SCRIPTS, { withFileTypes: true })
  .filter(d => d.isDirectory() && existsSync(join(SCRIPTS, d.name, 'run-all.sh')))
  .map(d => d.name)
  .sort()

// ── the manifest ───────────────────────────────────────────────────────────
const classTally: Record<string, number> = {}
for (const n of nodes) classTally[n.class] = (classTally[n.class] ?? 0) + 1

const manifest = {
  schema: 1,
  generator: 'scripts/orphans/gen-reachability-manifest.ts',
  rootClasses: {
    'interactive-runtime': ['src/entrypoints/cli.tsx'],
    'headless-cli': ['src/entrypoints/cli.tsx (print mode)', 'src/entrypoints/init.ts'],
    'daemon-scheduler': ['src/entrypoints/cli.tsx (mercury daemon)'],
    'spawned-workers-agents': ['src/entrypoints/cli.tsx (subagent/workflow re-entry)'],
    'acp-vscode-mcp': ['src/entrypoints/mcp.ts', 'src/entrypoints/cli.tsx (external seat attach)'],
    'sdk-barrels': graph.entries.filter(e => !RUNTIME_ROOT_FILES.includes(rel(e))).map(rel).sort(),
    'build-package-metadata': ['build.ts (stub map)', 'package.json (bin)'],
    'generated-registries': [
      'src/substrate/flagRegistry.ts',
      'src/substrate/durableOperationMatrix.ts',
      'docs/CAPABILITY-GRADUATION-MATRIX.md',
    ],
    'proof-fixture': ['scripts/*/ (suite runners; proof-coverage edges below)'],
    'living-specimens': ['(capability rows with verdict PARKED_INTENTIONAL)'],
    archive: [],
  },
  edgeKinds: (() => {
    const tally: Record<string, number> = {}
    for (const e of graph.edges) tally[e.kind] = (tally[e.kind] ?? 0) + 1
    return Object.fromEntries(Object.entries(tally).sort(([a], [b]) => a.localeCompare(b)))
  })(),
  registryEdges: {
    'build-alias (build.ts stub map)': Object.keys(graph.stubMap).length,
    'flag-guard (registry consumer fields)': flags.length,
    'capability-anchor (matrix source anchors)': capabilities.reduce((n, c) => n + c.srcAnchors.length, 0),
    'durable-owner (matrix source fields)': durableOwners.reduce((n, d) => n + d.sources.length, 0),
    'proof-coverage (script imports of src)': [...proofSuitesByFile.values()].reduce((n, s) => n + s.size, 0),
  },
  summary: {
    srcFiles: graph.files.length,
    runtimeReached: graph.files.filter(f => runtimeReach.has(f)).length,
    sdkOnlyReached: graph.files.filter(f => !runtimeReach.has(f) && sdkReach.has(f)).length,
    typedExemptions: baseline.rows.length,
    classTally: Object.fromEntries(Object.entries(classTally).sort(([a], [b]) => a.localeCompare(b))),
    capabilityMatrix: matrixPresent ? 'present' : 'absent (docs/CAPABILITY-GRADUATION-MATRIX.md not in this tree)',
    capabilities: capabilities.length,
    flags: flags.length,
    durableOwners: durableOwners.length,
    suites: suites.length,
    flagFindings,
  },
  capabilities: capabilities.sort((a, b) => a.name.localeCompare(b.name) || a.verdict.localeCompare(b.verdict)),
  flags,
  durableOwners,
  suites,
  nodes: nodes.sort((a, b) => a.file.localeCompare(b.file)),
}

const json = JSON.stringify(manifest, null, 1) + '\n'

// ── the human-readable map ─────────────────────────────────────────────────
const md = `# Reachability map (generated)

> GENERATED by \`scripts/orphans/gen-reachability-manifest.ts\` from the syntax-aware import
> graph + the typed orphan baseline + the flag registry + the capability graduation matrix
> (when present) + the durable-operation matrix.
> UNTRACKED derived truth — regenerate, never commit. Determinism and the classification
> invariants are gated by \`scripts/orphans/prove-reachability-manifest.ts\`; the typed
> manifest is \`scripts/orphans/.out/REACHABILITY-MANIFEST.json\`.

## Summary

- src ts/tsx files: **${manifest.summary.srcFiles}** — runtime-reached **${manifest.summary.runtimeReached}**, sdk-only **${manifest.summary.sdkOnlyReached}**, typed exemptions **${manifest.summary.typedExemptions}**.
- capabilities (matrix rows): **${manifest.summary.capabilities}** (matrix ${matrixPresent ? 'present' : 'ABSENT'}) · flags (registry rows): **${manifest.summary.flags}** · durable owners: **${manifest.summary.durableOwners}** · pool suites: **${manifest.summary.suites}**.
- module class tally: ${Object.entries(manifest.summary.classTally)
  .map(([k, v]) => `${k} ${v}`)
  .join(' · ')}.
- live-kind flags with an existing-but-unreached src consumer module: **${flagFindings.length}**${flagFindings.length ? ` (${flagFindings.join(', ')})` : ''}.
- flags parked with a consumer in the typed baseline (a recorded decision, reason on the row): **${flagsParked.length}**${flagsParked.length ? ` (${flagsParked.join(', ')})` : ''}.

## Roots

${Object.entries(manifest.rootClasses)
  .map(([k, v]) => `- **${k}** → ${(v as string[]).join(' · ')}`)
  .join('\n')}

## Edge classes

Import-graph edges (parser-extracted): ${Object.entries(manifest.edgeKinds)
  .map(([k, v]) => `${k} ${v}`)
  .join(' · ')}.
Registry/metadata edges: ${Object.entries(manifest.registryEdges)
  .map(([k, v]) => `${k} ${v}`)
  .join(' · ')}.

## The typed exemptions (unreached by design, each with a class + reason)

${baseline.rows.map(r => `- \`${r.file}\` — **${r.class}** — ${r.reason}`).join('\n')}

## Limitations (honest)

- Module granularity: an exported symbol nobody calls inside a reached module (the
  DUALWRITE severed-loop class) is invisible here — that is the severed-loop sweep's business.
- Literal specifiers only: \`require(expr)\` and build-injected dynamic module names do not
  appear as edges; the known build redirects ride the stub-map registry edges.
- Proof-only reachability NEVER upgrades a module's class (CA-09): the classification order
  is runtime → sdk → typed baseline; proof coverage is recorded as a separate count.
`

mkdirSync(OUT_DIR, { recursive: true })
if (CHECK) {
  const curJson = existsSync(MANIFEST_PATH) ? readFileSync(MANIFEST_PATH, 'utf-8') : ''
  const curMd = existsSync(MAP_PATH) ? readFileSync(MAP_PATH, 'utf-8') : ''
  if (curJson !== json || curMd !== md) {
    console.error('❌ reachability manifest DRIFTED from its generators — regenerate:')
    if (curJson !== json) console.error('   · docs/REACHABILITY-MANIFEST.json differs')
    if (curMd !== md) console.error('   · docs/REACHABILITY-MAP.md differs')
    process.exit(1)
  }
  console.log('✅ reachability manifest byte-stable (json + md)')
  process.exit(0)
}

writeFileSync(MANIFEST_PATH, json)
writeFileSync(MAP_PATH, md)
console.log(
  `wrote ${rel(MANIFEST_PATH)} (${json.length} bytes) + ${rel(MAP_PATH)} — ${manifest.summary.srcFiles} nodes · ${manifest.summary.capabilities} capabilities (matrix ${matrixPresent ? 'present' : 'absent'}) · ${manifest.summary.flags} flags · ${manifest.summary.durableOwners} durable owners · ${manifest.summary.suites} suites`,
)
