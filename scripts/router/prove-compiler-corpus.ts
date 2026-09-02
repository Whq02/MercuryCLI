#!/usr/bin/env bun
// ============================================================================
//  scripts/router/prove-compiler-corpus.ts
//  PROOF: compileRoute() honors every frozen policy ruling in
//  scripts/router/corpus/compiler/*.json — profile, useful width, per-node
//  model classes, decisive reason CODES, and adjustments. The corpus is the
//  policy contract; a compiler change that flips a ruling fails here and must
//  either fix the compiler or DELIBERATELY re-rule the fixture (in the same
//  change set, with the reason in the commit).
//
//  Assertion law:
//    - expected.reasonCodes / expected.adjustments are INCLUSION sets (the
//      compiler may add codes — e.g. a synthesized fallback node always gets
//      'empty-acceptance-repaired' — but must produce every expected code).
//    - profile / width / modelClasses are EXACT.
//    - expected.profile === 'REFUSAL' asserts the typed-refusal path.
//    - Every compiled plan must survive a JSON round-trip through the TOTAL
//      decoder byte-equivalently (decodeTaskRoutePlan ∘ stringify = identity).
//
//  Uses the REAL model registry (production resolution condition — the
//  proof-must-replicate-production-condition doctrine), a fixed clock, and a
//  fixed plan id. Run: ~/.bun/bin/bun run scripts/router/prove-compiler-corpus.ts
// ============================================================================
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { decodeTaskRoutePlan, LEGACY_ROUTE_PROFILES, ROUTE_PROFILES, stableDigest } from '../../src/utils/router/contracts.js'
import { buildRouterModelSnapshot } from '../../src/utils/router/modelRegistry.js'
import {
  compileRoute,
  computeUsefulWidth,
  type RouteCompilerInput,
  type RouteMissionIntent,
} from '../../src/utils/router/routeCompiler.js'

const DIR = join(import.meta.dir, 'corpus', 'compiler')
const NOW = 1_800_000_000_000

let failures = 0
const fail = (id: string, msg: string): void => {
  failures++
  console.error(`  [FAIL] ${id}: ${msg}`)
}
const pass = (id: string, msg: string): void => {
  console.log(`  [PASS] ${id}: ${msg}`)
}

const snapshot = buildRouterModelSnapshot()

// The profiles every fixture EXPECTS and every compile PRODUCES — the legacy
// profile law below reads both sets, plus one compiled plan as its sample.
const EXPECTED_PROFILES = new Set<string>()
const PRODUCED_PROFILES = new Set<string>()
let SAMPLE_PLAN: unknown = null

for (const file of readdirSync(DIR).sort()) {
  if (!file.endsWith('.json')) continue
  const fx = JSON.parse(readFileSync(join(DIR, file), 'utf8')) as {
    id: string
    mode: 'sequential' | 'fanout'
    mission: RouteMissionIntent & {
      workerAffinity?: { currentModelClass?: string; currentEffort?: string }
      sharedLane?: boolean
      contextFillPct?: number
      activeTurn?: boolean
    }
    expected: {
      profile: string
      width: number
      modelClasses: string[]
      reasonCodes: string[]
      adjustments: string[]
    }
  }
  const m = fx.mission
  EXPECTED_PROFILES.add(fx.expected.profile)
  const input: RouteCompilerInput = {
    mode: fx.mode,
    mission: m,
    posture: 'adaptive',
    models: snapshot,
    worker: {
      maxWidth: fx.mode === 'fanout' ? 3 : 1,
      sharedLane: m.sharedLane === true,
      ...(m.workerAffinity?.currentModelClass
        ? { currentModelClass: m.workerAffinity.currentModelClass as 'opus' | 'sonnet' | 'fable' }
        : {}),
      ...(m.workerAffinity?.currentEffort ? { currentEffort: m.workerAffinity.currentEffort } : {}),
      ...(typeof m.contextFillPct === 'number' ? { contextFillPct: m.contextFillPct } : {}),
      ...(m.activeTurn === true ? { activeTurn: true } : {}),
    },
    now: NOW,
    planId: `rp-corpus-${fx.id}`,
  }
  const result = compileRoute(input)

  if (fx.expected.profile === 'REFUSAL') {
    if (result.ok) {
      fail(fx.id, `expected a typed refusal, compiled to '${result.plan.profile}'`)
      continue
    }
    const missing = fx.expected.reasonCodes.filter(c => !result.refusal.reasonCodes.includes(c as never))
    if (missing.length > 0) {
      fail(fx.id, `refusal missing codes [${missing.join(', ')}] (got [${result.refusal.reasonCodes.join(', ')}])`)
      continue
    }
    pass(fx.id, `refused with [${result.refusal.reasonCodes.join(', ')}]`)
    continue
  }

  if (!result.ok) {
    fail(fx.id, `unexpected refusal [${result.refusal.reasonCodes.join(', ')}]: ${result.refusal.detail}`)
    continue
  }
  const plan = result.plan
  PRODUCED_PROFILES.add(plan.profile)
  SAMPLE_PLAN ??= plan
  const problems: string[] = []
  if (plan.profile !== fx.expected.profile) {
    problems.push(`profile '${plan.profile}' != '${fx.expected.profile}'`)
  }
  const { width } = computeUsefulWidth(plan.nodes, {
    maxWidth: input.worker.maxWidth,
    sharedLane: input.worker.sharedLane,
  })
  if (width !== fx.expected.width) problems.push(`width ${width} != ${fx.expected.width}`)
  const classes = plan.nodes.map(n => n.assignedModel?.modelClass ?? '?')
  if (JSON.stringify(classes) !== JSON.stringify(fx.expected.modelClasses)) {
    problems.push(`modelClasses [${classes.join(',')}] != [${fx.expected.modelClasses.join(',')}]`)
  }
  for (const c of fx.expected.reasonCodes) {
    if (!plan.decision.decisiveReasons.includes(c as never)) {
      problems.push(`missing decisive code '${c}' (got [${plan.decision.decisiveReasons.join(', ')}])`)
    }
  }
  for (const c of fx.expected.adjustments) {
    if (!plan.decision.adjustments.includes(c as never)) {
      problems.push(`missing adjustment '${c}' (got [${plan.decision.adjustments.join(', ')}])`)
    }
  }
  // Total-decoder round-trip: persist → decode → canonically identical (key
  // ORDER is decode-owned; the digest compares sorted-key content).
  const decoded = decodeTaskRoutePlan(JSON.parse(JSON.stringify(plan)))
  if (!decoded) {
    problems.push('decodeTaskRoutePlan returned null on the compiled plan')
  } else if (stableDigest(decoded) !== stableDigest(plan)) {
    problems.push('decode round-trip is not content-identity (canonical digest differs)')
  }
  // Structural floor on every compiled plan: no empty acceptance anywhere.
  if (plan.nodes.some(n => n.acceptance.length === 0)) {
    problems.push('a node compiled with an EMPTY acceptance contract')
  }
  if (problems.length > 0) {
    fail(fx.id, problems.join(' · '))
  } else {
    pass(
      fx.id,
      `${plan.profile} width=${width} [${plan.decision.decisiveReasons.join(',')}]${plan.decision.adjustments.length ? ` adj[${plan.decision.adjustments.join(',')}]` : ''}`,
    )
  }
}

// ── the legacy profile law ──────────────────────────────────────────────────
// A profile the compiler no longer produces (it belonged to a retired seat's
// workflow posture) is READ-tolerant, never PRODUCED: the corpus schema
// still spells it for pre-retirement fixtures and a persisted plan carrying
// it still decodes, while the producer-facing vocabulary, every compile and
// every fixture's expectation stay clear of it.
{
  const legacy = new Set<string>(LEGACY_ROUTE_PROFILES)
  const law = (id: string, ok: boolean, msg: string): void => (ok ? pass(id, msg) : fail(id, msg))
  law('legacy-profile', !(ROUTE_PROFILES as readonly string[]).some(p => legacy.has(p)), 'the producer-facing vocabulary carries no legacy profile')
  law('legacy-profile', ![...PRODUCED_PROFILES].some(p => legacy.has(p)), `no compile produced a legacy profile (${[...PRODUCED_PROFILES].sort().join(', ')})`)
  law('legacy-profile', ![...EXPECTED_PROFILES].some(p => legacy.has(p)), 'no fixture expects a legacy profile')
  const withLegacy = SAMPLE_PLAN === null ? null : { ...(SAMPLE_PLAN as Record<string, unknown>), profile: LEGACY_ROUTE_PROFILES[0] }
  law('legacy-profile', withLegacy !== null && decodeTaskRoutePlan(JSON.parse(JSON.stringify(withLegacy))) !== null, 'a persisted plan carrying the legacy profile still decodes (read-tolerant)')
}

console.log('════════════════════════════════════════════════════════════════════════════')
if (failures > 0) {
  console.error(`❌ ${failures} corpus ruling(s) violated`)
  process.exit(1)
}
console.log('✅ ALL COMPILER CORPUS RULINGS HOLD')
