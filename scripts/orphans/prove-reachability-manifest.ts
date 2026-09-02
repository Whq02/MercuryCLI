#!/usr/bin/env bun
// ============================================================================
//  scripts/orphans/prove-reachability-manifest.ts — the typed reachability
//  manifest regenerates deterministically, its counts reconcile with the
//  machine owners, and proof-only reachability can NEVER satisfy a
//  production-live claim. Generate → verify → never commit: the manifest is
//  derived truth living at the untracked scripts/orphans/.out/ path; this
//  prover regenerates it fresh every run, so every number below is
//  live-owner truth, never a stale snapshot.
//
//    §1 DETERMINISM — a fresh generation followed by gen --check is
//       byte-stable (two runs, identical output).
//    §2 COUNT RECONCILIATION — capabilities == the matrix roll-up's stated
//       tally (when the matrix is present; its absence is a named skip,
//       never a silent pass); flags == FLAG_REGISTRY.length; durable
//       owners == DURABLE_OPERATION_MATRIX.length; suites == the
//       run-all.sh glob; class tally sums to the node universe.
//    §3 CLASSIFICATION INVARIANTS — an unreached module is
//       never production-live; an unreached, un-SDK module carries a typed
//       exemption class; no live-kind flag has an existing-but-unreached src
//       consumer (the severed-flag finding list is pinned EMPTY);
//       durable-owner sources are all reached.
// ============================================================================

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { checker } from '../engine-durability/harness.ts'
import { FLAG_REGISTRY } from '../../src/substrate/flagRegistry.ts'
import { DURABLE_OPERATION_MATRIX } from '../../src/substrate/durableOperationMatrix.ts'

const t = checker()
const ROOT = join(import.meta.dir, '..', '..')

// ── §1 determinism (generate fresh, then --check against it) ────────────────
t.section('§1 — the manifest regenerates deterministically (CA-38)')
{
  let code = 0
  let out = ''
  try {
    out = execFileSync('bun', [join(import.meta.dir, 'gen-reachability-manifest.ts')], {
      cwd: ROOT,
      encoding: 'utf8',
    })
    out += execFileSync('bun', [join(import.meta.dir, 'gen-reachability-manifest.ts'), '--check'], {
      cwd: ROOT,
      encoding: 'utf8',
    })
  } catch (e) {
    const err = e as { status?: number; stdout?: string; stderr?: string }
    code = err.status ?? -1
    out = `${err.stdout ?? ''}${err.stderr ?? ''}`
  }
  t.check('generate + gen --check exit 0 (json + md byte-stable across runs)', code === 0, out.trim().split('\n').pop())
}

const manifest = JSON.parse(readFileSync(join(ROOT, 'scripts', 'orphans', '.out', 'REACHABILITY-MANIFEST.json'), 'utf8')) as {
  summary: {
    srcFiles: number
    runtimeReached: number
    sdkOnlyReached: number
    typedExemptions: number
    classTally: Record<string, number>
    capabilityMatrix: string
    capabilities: number
    flags: number
    durableOwners: number
    suites: number
    flagFindings: string[]
  }
  capabilities: Array<{ name: string; verdict: string; srcAnchors: string[]; anchorsRuntimeReached: 0 | 1; anchorsUnionReached: 0 | 1 }>
  flags: Array<{ env: string; consumerExists: 0 | 1; consumerReached: 0 | 1; consumerParked: 0 | 1 }>
  durableOwners: Array<{ id: string; sourcesReached: 0 | 1 }>
  nodes: Array<{ file: string; class: string; runtime: 0 | 1; sdk: 0 | 1; proofSuites: number }>
}

// ── §2 count reconciliation ────────────────────────────────────────
t.section('§2 — counts reconcile across the machine owners (CA-11)')
{
  const matrixPath = join(ROOT, 'docs', 'CAPABILITY-GRADUATION-MATRIX.md')
  if (existsSync(matrixPath)) {
    const matrixText = readFileSync(matrixPath, 'utf8')
    const rollup = matrixText.match(/## Roll-up \((\d+) capabilities classified/)
    t.check('the matrix roll-up states a tally', rollup !== null)
    t.check(
      `capabilities == the roll-up tally (${rollup?.[1]})`,
      manifest.summary.capabilities === Number(rollup?.[1]),
      `manifest=${manifest.summary.capabilities}`,
    )
  } else {
    t.check(
      'capability legs: SKIPPED by name — docs/CAPABILITY-GRADUATION-MATRIX.md absent from this tree (returns with the docs fold) and the manifest says so',
      manifest.summary.capabilityMatrix.startsWith('absent') && manifest.summary.capabilities === 0,
      manifest.summary.capabilityMatrix,
    )
  }
  t.check(
    `flags == FLAG_REGISTRY.length (${FLAG_REGISTRY.length})`,
    manifest.summary.flags === FLAG_REGISTRY.length && manifest.flags.length === FLAG_REGISTRY.length,
  )
  t.check(
    `durable owners == DURABLE_OPERATION_MATRIX.length (${DURABLE_OPERATION_MATRIX.length})`,
    manifest.summary.durableOwners === DURABLE_OPERATION_MATRIX.length &&
      manifest.durableOwners.length === DURABLE_OPERATION_MATRIX.length,
  )
  const suites = readdirSync(join(ROOT, 'scripts'), { withFileTypes: true }).filter(
    d => d.isDirectory() && existsSync(join(ROOT, 'scripts', d.name, 'run-all.sh')),
  ).length
  t.check(`suites == the run-all.sh glob (${suites})`, manifest.summary.suites === suites)
  const tallySum = Object.values(manifest.summary.classTally).reduce((a, b) => a + b, 0)
  t.check('class tally sums to the node universe', tallySum === manifest.summary.srcFiles && manifest.nodes.length === manifest.summary.srcFiles)
  t.check(
    'runtimeReached + sdkOnly + exemptions == the node universe',
    manifest.summary.runtimeReached + manifest.summary.sdkOnlyReached + manifest.summary.typedExemptions ===
      manifest.summary.srcFiles,
  )
}

// ── §3 classification invariants ───────────────────────────
t.section('§3 — proof-only reachability can never claim production-live (CA-09)')
{
  const bogusLive = manifest.nodes.filter(n => n.runtime === 0 && n.class === 'production-live')
  t.check('no unreached module is classed production-live', bogusLive.length === 0, bogusLive.map(n => n.file).join(','))
  const TYPED = new Set([
    'sdk-or-external-contract',
    'metadata-or-generated',
    'living-specimen',
    'proof-or-fixture-only',
    'archive',
    'broken-path',
    'superseded-unreachable',
    'operator-opt-in-live',
  ])
  const untyped = manifest.nodes.filter(n => n.runtime === 0 && n.sdk === 0 && !TYPED.has(n.class))
  t.check('every unreached module carries a typed exemption class', untyped.length === 0, untyped.map(n => n.file).join(','))
  const proofOnlyUpgraded = manifest.nodes.filter(n => n.runtime === 0 && n.sdk === 0 && n.proofSuites > 0 && n.class === 'production-live')
  t.check('proof coverage never upgraded a class (mechanical CA-09)', proofOnlyUpgraded.length === 0)

  {
    const live = manifest.capabilities.filter(c => c.verdict === 'LIVE_DEFAULT_ON' || c.verdict === 'LIVE_OPT_IN')
    const anchored = live.filter(c => c.srcAnchors.length > 0)
    const rtMiss = anchored.filter(c => c.anchorsRuntimeReached !== 1)
    t.check(`every LIVE capability with a file anchor is runtime-reached (${anchored.length} anchored live rows)`, rtMiss.length === 0, rtMiss.map(c => c.name).join(' | '))
    const unionMiss = anchored.filter(c => c.anchorsUnionReached !== 1)
    t.check('every LIVE capability file anchor is reached (union)', unionMiss.length === 0, unionMiss.map(c => c.name).join(' | '))
  }

  t.check('the severed-flag finding list is EMPTY (pinned)', manifest.summary.flagFindings.length === 0, manifest.summary.flagFindings.join(','))
  // An unreached consumer is either PARKED (its typed baseline row records
  // the decision and the reason) or a severed flag — never a third thing.
  const flagMiss = manifest.flags.filter(f => f.consumerExists === 1 && f.consumerReached === 0 && f.consumerParked !== 1)
  t.check('every existing src flag consumer is reached or parked in the typed baseline', flagMiss.length === 0, flagMiss.map(f => f.env).join(','))
  const parked = manifest.flags.filter(f => f.consumerParked === 1).map(f => f.env)
  if (parked.length > 0) console.log(`     parked with a baselined consumer: ${parked.join(', ')}`)
  const durMiss = manifest.durableOwners.filter(d => d.sourcesReached !== 1)
  t.check('every durable-owner source is reached', durMiss.length === 0, durMiss.map(d => d.id).join(','))
}

t.finish('prove-reachability-manifest')
