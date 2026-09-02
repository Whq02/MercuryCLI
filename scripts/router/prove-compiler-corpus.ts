#!/usr/bin/env bun
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { decodeTaskRoutePlan, stableDigest } from '../../src/utils/router/contracts.js'
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

for (const file of readdirSync(DIR).sort()) {
  if (!file.endsWith('.json')) continue
  const fx = JSON.parse(readFileSync(join(DIR, file), 'utf8')) as {
    id: string
    mode: 'scribe' | 'party'
    mission: RouteMissionIntent & {
      workerAffinity?: { currentModelClass?: string; currentEffort?: string }
      sharedLane?: boolean
      contextFillPct?: number
      activeTurn?: boolean
      workflowPostureActive?: boolean
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
  const input: RouteCompilerInput = {
    mode: fx.mode,
    intentSource: m.legacyRoute ? 'legacy' : 'structured',
    mission: m,
    posture: 'adaptive',
    models: snapshot,
    worker: {
      maxWidth: fx.mode === 'party' ? 3 : 1,
      sharedLane: m.sharedLane === true,
      ...(m.workerAffinity?.currentModelClass
        ? { currentModelClass: m.workerAffinity.currentModelClass as 'opus' | 'sonnet' | 'fable' }
        : {}),
      ...(m.workerAffinity?.currentEffort ? { currentEffort: m.workerAffinity.currentEffort } : {}),
      ...(typeof m.contextFillPct === 'number' ? { contextFillPct: m.contextFillPct } : {}),
      ...(m.activeTurn === true ? { activeTurn: true } : {}),
    },
    workflowPostureActive: m.workflowPostureActive === true,
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
  const decoded = decodeTaskRoutePlan(JSON.parse(JSON.stringify(plan)))
  if (!decoded) {
    problems.push('decodeTaskRoutePlan returned null on the compiled plan')
  } else if (stableDigest(decoded) !== stableDigest(plan)) {
    problems.push('decode round-trip is not content-identity (canonical digest differs)')
  }
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

console.log('════════════════════════════════════════════════════════════════════════════')
if (failures > 0) {
  console.error(`❌ ${failures} corpus ruling(s) violated`)
  process.exit(1)
}
console.log('✅ ALL COMPILER CORPUS RULINGS HOLD')
