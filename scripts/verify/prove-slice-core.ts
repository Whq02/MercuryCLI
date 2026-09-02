#!/usr/bin/env bun
// ============================================================================
//  prove-slice-core.ts — the slice rung's PURE decision laws (MERCURY
// Everything here runs on injected fixtures — no fs, no env, no
//  git, no gh — so every law is deterministic on any machine:
//
//   §1 the lane estimator mirrors the gate's dispatch (caps · weights ·
//      longest-first · exclusive-alone · undeclared-conservative), and adding
//      work never shrinks the estimate;
//   §2 the NOT-FASTER refusal law, BOTH directions (clearly-under runs; at
//      or over the ratio refuses naming "run the full pool");
//   §3 the HUB FAN-OUT CEILING, both sides of the boundary, naming the hub;
//   §4 fail-closed escalation on any UNCLASSIFIED path (outranks the hub);
//   §5 the anchor law: absent ⇒ refuse naming "run the full pool";
//   §6 selection ≡ lanes: the plan's suite list IS the selector's set
//      (sorted) — exactly what fast.ts hands scripts/run-all-suites.sh.
// ============================================================================

import type { ImpactManifest } from './impactManifest.ts'
import { parseClassHeader } from './impactManifest.ts'
import {
  estimatePooledWallS,
  planSlice,
  type GateClass,
  type SliceAnchor,
  type SlicePlanInput,
} from './sliceCore.ts'

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}
const section = (t: string): void => console.log('\n' + '─'.repeat(76) + '\n' + t)

// ── shared fixtures ──────────────────────────────────────────────────────────
const CLASSES: Record<string, GateClass> = {
  ui: 'pty',
  flux: 'pty',
  pulse: 'pty',
  smoke: 'cpu',
  bus: 'pure',
  mission: 'pure',
  memory: 'pure',
  bench: 'exclusive',
}
const DURATIONS: Record<string, number> = {
  ui: 600,
  flux: 600,
  pulse: 600,
  smoke: 200,
  bus: 40,
  mission: 30,
  memory: 20,
  bench: 100,
}
const EST = { durations: DURATIONS, classes: CLASSES, cores: 8, ptyMax: 2 }

const MANIFEST: ImpactManifest = {
  suites: Object.keys(CLASSES),
  watches: {
    ui: ['src/components/**'],
    flux: ['src/components/**'],
    pulse: ['src/components/**'],
    bus: ['src/utils/swarm/**'],
    mission: ['src/utils/hooks/**'],
    smoke: ['src/**'],
  },
  ignores: ['docs/**', '*.md'],
}

const ANCHOR: SliceAnchor = {
  treeSha: 'a'.repeat(40),
  source: 'local verdict',
  headSha: 'b'.repeat(40),
  ageCommits: 1,
}

function input(over: Partial<SlicePlanInput>): SlicePlanInput {
  return {
    changedPaths: [],
    manifest: MANIFEST,
    classes: CLASSES,
    durations: DURATIONS,
    anchor: ANCHOR,
    cores: 8,
    ptyMax: 2,
    hubCeiling: 15,
    clearlyUnderRatio: 0.5,
    ...over,
  }
}

// ── §1 the lane estimator ────────────────────────────────────────────────────
section('§1 the pooled-wall estimator mirrors the gate dispatch')
check('a single suite estimates its own duration', estimatePooledWallS(['ui'], EST) === 600)
check(
  'two pty suites run in parallel under cap 2 (600, not 1200)',
  estimatePooledWallS(['ui', 'flux'], EST) === 600,
)
check(
  'three pty suites serialize the third under cap 2 (1200)',
  estimatePooledWallS(['ui', 'flux', 'pulse'], EST) === 1200,
)
check(
  'pty cap 3 admits the third (600)',
  estimatePooledWallS(['ui', 'flux', 'pulse'], { ...EST, ptyMax: 3 }) === 600,
)
check(
  'pure suites ride the wide lane beside pty (no added wall)',
  estimatePooledWallS(['ui', 'bus', 'mission', 'memory'], EST) === 600,
)
check(
  'an exclusive suite runs ALONE after the pool drains (additive wall)',
  estimatePooledWallS(['ui', 'bench'], EST) === 700,
)
check(
  'an undeclared suite schedules pty-conservative (cap binds)',
  estimatePooledWallS(['ui', 'flux', 'mystery'], {
    ...EST,
    durations: { ...DURATIONS, mystery: 600 },
  }) === 1200,
)
check(
  'tiny slot budgets still make progress (deadlock guard)',
  estimatePooledWallS(['ui', 'flux', 'smoke'], { ...EST, cores: 2 }) > 0,
)
{
  const small = estimatePooledWallS(['bus', 'mission'], EST)
  const bigger = estimatePooledWallS(['bus', 'mission', 'ui'], EST)
  check('adding a suite never shrinks the estimate', bigger >= small, `${small} → ${bigger}`)
}
check('an unknown-duration suite defaults to the scheduler fallback (30s)',
  estimatePooledWallS(['never-seen'], { ...EST, classes: { 'never-seen': 'pure' } }) === 30)
{
  // 4 slots: ui (pty, 100) holds 2; the leftover 2 go to whichever of the cpu
  // head (smoke 200, weight 2) and the pure head (bigpure 300, weight 1) runs
  // longer — bigpure first ⇒ smoke follows ui at 100 ⇒ wall 300 (cpu-first
  // would park bigpure behind smoke until ui ends ⇒ 400).
  const est = estimatePooledWallS(['ui', 'smoke', 'bigpure'], {
    durations: { ui: 100, smoke: 200, bigpure: 300 },
    classes: { ui: 'pty', smoke: 'cpu', bigpure: 'pure' },
    cores: 4,
    ptyMax: 2,
  })
  check('a longer pure head goes before a shorter cpu head when both fit (300, not 400)', est === 300, `${est}`)
  const cpuFirst = estimatePooledWallS(['ui', 'smoke', 'smallpure'], {
    durations: { ui: 100, smoke: 200, smallpure: 50 },
    classes: { ui: 'pty', smoke: 'cpu', smallpure: 'pure' },
    cores: 4,
    ptyMax: 2,
  })
  check('a shorter pure head still waits behind the cpu head (200)', cpuFirst === 200, `${cpuFirst}`)
}
check(
  'the estimator DEFAULT cap mirrors the gate default (3 — tempo-2 adoption)',
  estimatePooledWallS(['ui', 'flux', 'pulse'], { durations: DURATIONS, classes: CLASSES, cores: 8 }) === 600,
)

// ── §2 the not-faster refusal law, both directions ───────────────────────────
section('§2 the NOT-FASTER refusal law (both directions)')
{
  // pool: ui,flux ‖ (600) → pulse (1200); smoke+pures beside; bench alone → 1300.
  const pool = estimatePooledWallS(MANIFEST.suites, EST)
  check('the fixture pool estimate is the pty tail + the exclusive (1300s)', pool === 1300, `${pool}`)
  const p = planSlice(input({ changedPaths: ['src/utils/swarm/bus.ts'] }))
  check(
    `a small slice (bus+smoke ≈ 200s vs pool ≈ ${pool}s) RUNS`,
    p.kind === 'run' && p.suites.join(',') === 'bus,smoke'.split(',').sort().join(','),
    JSON.stringify(p),
  )
}
{
  // Select the WHOLE pty tail (ui+flux+pulse ⇒ 1200s pooled) + smoke:
  // 1200/1300 = 92% — nowhere near clearly-under ⇒ refuse.
  const p = planSlice(
    input({ changedPaths: ['src/components/x.tsx', 'src/utils/swarm/bus.ts', 'src/utils/hooks/h.ts'] }),
  )
  check('a near-pool-wall slice REFUSES (not-faster)', p.kind === 'refuse' && p.reason === 'not-faster', p.kind)
  check(
    'the refusal names "run the full pool"',
    p.kind === 'refuse' && p.message.includes('run the full pool'),
    p.kind === 'refuse' ? p.message : '',
  )
  check(
    'the refusal carries both estimates (honesty ledger)',
    p.kind === 'refuse' && p.ledger.sliceEstimateS !== null && p.ledger.poolEstimateS > 0,
  )
}
{
  // The SAME selection under a permissive ratio runs — the law is the ratio,
  // not the suite count.
  const p = planSlice(
    input({
      changedPaths: ['src/components/x.tsx', 'src/utils/swarm/bus.ts', 'src/utils/hooks/h.ts'],
      clearlyUnderRatio: 0.999,
    }),
  )
  check('the same selection under ratio 0.999 RUNS (count never refuses, wall does)', p.kind === 'run', p.kind)
}
{
  const p = planSlice(input({ changedPaths: [] }))
  check('an empty changed set RUNS with zero suites (floors only)', p.kind === 'run' && p.suites.length === 0)
}
{
  const p = planSlice(input({ changedPaths: ['docs/notes.md'] }))
  check('ignored-only changes RUN with zero suites', p.kind === 'run' && p.suites.length === 0)
}

// ── §3 the hub fan-out ceiling ───────────────────────────────────────────────
section('§3 the HUB FAN-OUT CEILING (boundary both sides, named)')
{
  // s5 (300s, unselected) dominates the pool so the ratio law stays quiet —
  // this section isolates the CEILING law at its boundary.
  const wideManifest: ImpactManifest = {
    suites: ['s1', 's2', 's3', 's4', 's5'],
    watches: { s1: ['lib/hub.ts'], s2: ['lib/hub.ts'], s3: ['lib/hub.ts'], s4: ['lib/hub.ts'] },
    ignores: [],
  }
  const wideClasses: Record<string, GateClass> = { s1: 'pure', s2: 'pure', s3: 'pure', s4: 'pure', s5: 'pure' }
  const wideInput = (ceiling: number): SlicePlanInput =>
    input({
      changedPaths: ['lib/hub.ts'],
      manifest: wideManifest,
      classes: wideClasses,
      durations: { s1: 10, s2: 10, s3: 10, s4: 10, s5: 300 },
      hubCeiling: ceiling,
    })
  const at = planSlice(wideInput(4))
  check('fan-out AT the ceiling (4/4) does not escalate', at.kind === 'run', at.kind)
  const over = planSlice(wideInput(3))
  check('fan-out OVER the ceiling (4>3) escalates', over.kind === 'escalate' && over.reason === 'hub-fanout', over.kind)
  check(
    'the escalation NAMES the hub path and its fan-out',
    over.kind === 'escalate' && over.message.includes('lib/hub.ts') && over.message.includes('4'),
    over.kind === 'escalate' ? over.message : '',
  )
  check(
    'the ledger carries the hub row',
    over.kind === 'escalate' && over.ledger.hubs[0]?.path === 'lib/hub.ts' && over.ledger.hubs[0]?.fanout === 4,
  )
}

// ── §4 unclassified outranks everything after the anchor ─────────────────────
section('§4 fail-closed: UNCLASSIFIED escalates (and outranks the hub)')
{
  const p = planSlice(input({ changedPaths: ['mystery/top-level.bin'] }))
  check('an unclassified path escalates', p.kind === 'escalate' && p.reason === 'unclassified', p.kind)
}
{
  const p = planSlice(input({ changedPaths: ['mystery/top-level.bin', 'src/components/x.tsx'] }))
  check(
    'unclassified + wide selection still names UNCLASSIFIED (correctness first)',
    p.kind === 'escalate' && p.reason === 'unclassified',
    p.kind,
  )
}

// ── §5 the anchor law ────────────────────────────────────────────────────────
section('§5 anchor absent ⇒ refuse naming the pool')
{
  const p = planSlice(input({ anchor: null, changedPaths: ['src/utils/swarm/bus.ts'] }))
  check('no anchor refuses', p.kind === 'refuse' && p.reason === 'anchor-absent', p.kind)
  check(
    'the anchor refusal names "run the full pool"',
    p.kind === 'refuse' && p.message.includes('run the full pool'),
  )
}

// ── §6 selection ≡ lanes ─────────────────────────────────────────────────────
section('§6 the plan hands the selector set (sorted) to the lanes')
{
  const p = planSlice(input({ changedPaths: ['src/utils/swarm/bus.ts', 'src/utils/hooks/h.ts'] }))
  check(
    'plan.suites is exactly the sorted selection set',
    p.kind === 'run' &&
      p.suites.join('|') === [...(p.ledger.selection?.suites ?? [])].sort().join('|') &&
      p.suites.join(',') === 'bus,mission,smoke',
    JSON.stringify(p.kind === 'run' ? p.suites : p.kind),
  )
}
{
  // parseClassHeader — the manifest side of the estimator's inputs.
  check('parseClassHeader reads a declared class', parseClassHeader('#!/usr/bin/env bash\n# gate-class: pty\nset -u\n') === 'pty')
  check('parseClassHeader treats a misspelled class as undeclared', parseClassHeader('# gate-class: ptyy\n') === 'undeclared')
  check('parseClassHeader stops at the first non-comment line', parseClassHeader('#!/usr/bin/env bash\nset -u\n# gate-class: pty\n') === 'undeclared')
}

console.log('\n' + '═'.repeat(60))
if (failures === 0) {
  console.log(' ✅ SLICE CORE GREEN')
  process.exit(0)
}
console.log(` ❌ ${failures} SLICE-CORE FAILURE(S)`)
process.exit(1)
