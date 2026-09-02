#!/usr/bin/env bun
// ============================================================================
//  scripts/scribe/bench-router.ts  (#42 R3 / #44 R4 — the benchmark behind the flip)
//  The operator's "open-router-like method to boost benchmarking": route each task
//  to the effort it EARNS so MAX is spent only where it pays. This is the replay-corpus
//  benchmark that produces the NUMBER to justify flipping MERCURY_SCRIBE_TASK_ROUTER:
//   (1) classify a labeled corpus through the REAL decideDispatchRoute;
//   (2) A/B router-OFF (every task pinned @max) vs router-ON (effort matched) → the
//       compute-cost saving on a representative mix;
//   (3) prove the QUALITY FLOOR holds on the whole corpus — a non-mechanical task is
//       NEVER routed below xhigh — so the saving is "spend less on trivial work", not
//       "under-power real work" (quality preserved BY CONSTRUCTION, no API needed);
//   (4) a drain latency/throughput sanity over the corpus (one-at-a-time bound).
//  HONEST CAVEAT (printed): an end-to-end QUALITY A/B (does routing change task
//  OUTCOMES) needs live-API runs — this measures the routing decision + cost, and
//  the floor that makes the cost-saving safe. NOT in run-all (a bench); run manually.
//  Run:  ~/.bun/bin/bun run scripts/scribe/bench-router.ts
// ============================================================================
;(globalThis as Record<string, unknown>)['MACRO'] = { VERSION: '1.0.0' }

const router = (await import('../../src/utils/scribe/dispatchRouter.js')) as typeof import('../../src/utils/scribe/dispatchRouter.js')

type Hardness = 'mechanical' | 'standard' | 'deep'
// A representative corpus: each task labeled with the hardness a human would assign.
const CORPUS: Array<{ task: string; label: Hardness; title?: string }> = [
  // mechanical (should route DOWN to high/quick)
  { task: 'rename the variable foo to bar in utils.ts', label: 'mechanical' },
  { task: 'fix the typo in the comment above parseFoo', label: 'mechanical' },
  { task: 'bump the version to 2.1.0 in package.json', label: 'mechanical' },
  { task: 'reorder imports in src/cli.ts', label: 'mechanical' },
  { task: 'format the file with prettier', label: 'mechanical' },
  { task: 'update the docstring on tokenize()', label: 'mechanical' },
  { task: 'a one-liner tweak to the log prefix', label: 'mechanical' },
  // standard (should stay xhigh/standard — the floor)
  { task: 'add a --json flag to the status command', label: 'standard' },
  { task: 'wire the new retry option into the http loader', label: 'standard' },
  { task: 'add a test for the parser empty-input edge case', label: 'standard' },
  { task: 'handle the null branch in resolveConfig and return a default', label: 'standard' },
  { task: 'add a spinner to the upload flow', label: 'standard' },
  { task: 'validate the email field on the signup form', label: 'standard' },
  // deep (should route UP to max/deep)
  { task: 'refactor the parser module to a visitor pattern', label: 'deep' },
  { task: 'migrate the auth flow to the new OAuth API', label: 'deep' },
  { task: 'investigate and root-cause the race condition in the daemon drain', label: 'deep' },
  { task: 'redesign the memory index for cross-process concurrency', label: 'deep' },
  { task: 'optimize the hot path in the renderer (performance)', label: 'deep' },
  { task: 'audit the credential handling end-to-end for security', label: 'deep' },
  { task: 'rewrite the scheduler to fix the deadlock under load', label: 'deep' },
]

// A relative compute-cost weight per effort (a proxy for "max costs more than high").
const COST: Record<router.RouteEffort, number> = { high: 1, xhigh: 2, max: 3 }
const EFFORT_RANK: Record<router.RouteEffort, number> = { high: 0, xhigh: 1, max: 2 }

console.log('============================================================')
console.log(' Dispatch router — replay-corpus benchmark (#42 R3 / #44 R4)')
console.log('============================================================')

let failures = 0
const dist: Record<string, number> = { high: 0, xhigh: 0, max: 0 }
let routedCost = 0
const FIXED: router.RouteEffort = 'max' // router-OFF pins every task at the Implementer's max
let fixedCost = 0
let floorViolations = 0
let labelMatches = 0

for (const { task, label, title } of CORPUS) {
  const d = router.decideDispatchRoute(task, title ? { title } : undefined)
  dist[d.effort] = (dist[d.effort] ?? 0) + 1
  routedCost += COST[d.effort]
  fixedCost += COST[FIXED]
  // FLOOR: a non-mechanical (standard/deep) task must NEVER route below xhigh.
  if (label !== 'mechanical' && EFFORT_RANK[d.effort] < EFFORT_RANK.xhigh) {
    floorViolations++
    console.log(`  ⚠ FLOOR VIOLATION: "${task}" (${label}) routed @${d.effort}`)
  }
  // classification sanity vs the human label (deep⇒max, mechanical⇒high, standard⇒xhigh)
  const expected: router.RouteEffort = label === 'deep' ? 'max' : label === 'mechanical' ? 'high' : 'xhigh'
  if (d.effort === expected) labelMatches++
}

const n = CORPUS.length
const saving = Math.round(((fixedCost - routedCost) / fixedCost) * 100)
console.log(`\nCorpus: ${n} tasks`)
console.log(`Effort distribution (router ON): high=${dist.high} · xhigh=${dist.xhigh} · max=${dist.max}`)
console.log(`Compute-cost A/B: router-OFF (all @max) = ${fixedCost}u → router-ON = ${routedCost}u  ⇒  ${saving}% less compute on this mix`)
console.log(`Classification vs human label: ${labelMatches}/${n} (${Math.round((labelMatches / n) * 100)}%)`)
console.log(`Quality FLOOR (no non-mechanical task below xhigh): ${floorViolations === 0 ? 'HELD ✅' : `VIOLATED ✕ (${floorViolations})`}`)

console.log('\n── interpretation ──')
console.log('The saving is SAFE because the floor holds: every standard/deep task keeps')
console.log('xhigh/max (quality preserved by construction); only mechanical work drops to')
console.log('high. So flipping MERCURY_SCRIBE_TASK_ROUTER spends max where it pays without')
console.log('under-powering real work. END-TO-END quality (does routing change OUTCOMES)')
console.log('needs a live-API A/B — this proves the decision + cost + the safety floor.')

// Gate: the floor is a HARD invariant (the no-trade-off requirement). A weak
// classification (< 80% vs labels) also fails — the router must be a real signal.
if (floorViolations > 0) failures++
if (labelMatches / n < 0.8) {
  failures++
  console.log(`\n✕ classification ${Math.round((labelMatches / n) * 100)}% < 80% — router signal too weak`)
}

console.log('\n' + '═'.repeat(76))
if (failures === 0) console.log(`✅ ROUTER BENCH OK — floor held, ${saving}% compute saved on the corpus, ${Math.round((labelMatches / n) * 100)}% label match`)
else console.log(`❌ ROUTER BENCH FAILED (${failures})`)
console.log('═'.repeat(76))
process.exit(failures === 0 ? 0 : 1)
