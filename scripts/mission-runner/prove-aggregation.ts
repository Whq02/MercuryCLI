// ============================================================================
//  prove-aggregation.ts — aggregation determinism + honesty laws (pure).
// ----------------------------------------------------------------------------
//    1. byte-stable output for the same input rows (twice, plus shuffled);
//    2. failed/timed-out/indeterminate runs are COUNTED, never hidden;
//    3. NOT APPLICABLE rows are separated from executed runs;
//    4. incorrect claims are counted separately from ordinary failures;
//    5. policy digests are stable and distinct across the arm set.
// ============================================================================
import { aggregate, latestRows, renderMarkdown } from './live/aggregate.js'
import type { HelixRunRow } from './live/runner.js'
import { HELIX_POLICIES, policyDigest } from './live/policies.js'

let failures = 0
function check(label: string, ok: boolean, detail?: string): void {
  if (ok) console.log('  ok  ' + label)
  else {
    failures += 1
    console.log('  FAIL ' + label + (detail ? ' — ' + detail : ''))
  }
}

function row(partial: Partial<HelixRunRow>): HelixRunRow {
  return {
    ts: '2026-07-21T00:00:00.000Z',
    taskId: 'T18',
    family: 8,
    partition: 'development',
    policyId: 'solo',
    policyDigest: 'hp1-x',
    corpusDigest: 'hc1-x',
    mercurySha: 'deadbeef',
    artifactTree: 'tree',
    model: 'claude-opus-4-8',
    effortIntent: 'high',
    status: 'accepted',
    accepted: true,
    wallSeconds: 60,
    numTurns: 10,
    outputTokens: 1000,
    ...partial,
  }
}

const FIXTURE: HelixRunRow[] = [
  row({}),
  row({ taskId: 'T19', status: 'rejected', accepted: false, incorrectClaim: true, wallSeconds: 90 }),
  row({ taskId: 'T24', family: 11, status: 'incomplete', accepted: false, timedOut: true, wallSeconds: 600 }),
  row({ taskId: 'T05', family: 2, status: 'indeterminate', accepted: false, isError: true }),
  row({ taskId: 'T20', family: 9, policyId: 'workflow', status: 'accepted', wallSeconds: 120 }),
  row({ taskId: 'T18', policyId: 'router', status: 'not-applicable', accepted: false, naReason: 'headless' }),
]

// 1 · determinism.
const once = JSON.stringify(aggregate(FIXTURE))
const twice = JSON.stringify(aggregate(FIXTURE))
const shuffled = JSON.stringify(aggregate([...FIXTURE].reverse()))
check('aggregate is byte-stable', once === twice)
check('aggregate is order-independent', once === shuffled)

// 2–4 · honesty.
const result = aggregate(FIXTURE)
const solo = result.byPolicy.find(p => p.policyId === 'solo')!
check('all executed solo runs counted', solo.runs === 4, String(solo.runs))
check('rejected counted', solo.rejected === 1)
check('incomplete counted', solo.incomplete === 1)
check('indeterminate counted', solo.indeterminate === 1)
check('accepted rate over EXECUTED runs', solo.acceptedRate === 0.25, String(solo.acceptedRate))
check('incorrect claims separate', solo.incorrectClaims === 1)
const routerPolicy = result.byPolicy.find(p => p.policyId === 'router')!
check('NA separated from executed', routerPolicy.runs === 0 && routerPolicy.notApplicable === 1)
check('markdown renders', renderMarkdown(result).includes('| solo |'))

// 4b · supersede view: highest runIndex per cell wins; raw rows survive.
{
  const superseded = [
    row({ taskId: 'T10', runIndex: 1, status: 'rejected', accepted: false }),
    row({ taskId: 'T10', runIndex: 2, status: 'accepted', accepted: true }),
    row({ taskId: 'T18', runIndex: 1 }),
  ]
  const latest = latestRows(superseded)
  check('latest view keeps one row per cell', latest.length === 2)
  check('the run-2 correction wins', latest.find(r => r.taskId === 'T10')?.status === 'accepted')
  check('latest view is order-independent', JSON.stringify(latestRows([...superseded].reverse())) === JSON.stringify(latest))
}

// 5 · policy digests.
const digests = HELIX_POLICIES.map(policyDigest)
check('policy digests distinct', new Set(digests).size === digests.length)
check('policy digests shaped', digests.every(d => /^hp1-[0-9a-f]{16}$/.test(d)))

if (failures > 0) {
  console.error('prove-aggregation: ' + failures + ' failure(s)')
  process.exit(1)
}
console.log('prove-aggregation: green')
