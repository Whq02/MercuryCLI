#!/usr/bin/env bun
// ============================================================================
//  scripts/builtin-tools/prove-builtin-tools-benchmark.ts — the capability
//  benchmark GATE. Runs the deterministic corpus
//  (scripts/builtin-tools/bench-builtin-tools.ts) against disposable fixtures — ZERO paid
//  calls — and FAILS the green gate on:
//    · any task that did not complete;
//    · ANY false-success (a failed/partial step summarized as success);
//    · any incomplete resource / transaction / evidence expectation;
//    · any cleanup failure (a surviving process, a temp tree left behind);
//    · drift between the live run and the committed stable anchor
//      (scripts/builtin-tools/fixtures/results.json) — regenerate with
//      `bun run scripts/builtin-tools/bench-builtin-tools.ts --write`.
// ============================================================================

import { existsSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

let failures = 0
function check(label: string, ok: boolean, detail = ''): void {
  if (!ok) failures++
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${!ok && detail ? ` — ${detail}` : ''}`)
}

const repoRoot = resolve(import.meta.dir, '..', '..')
const anchorPath = join(repoRoot, 'scripts', 'builtin-tools', 'fixtures', 'results.json')

const { runCorpus, stableProjection, anchorJson, cleanupBenchHomes } = await import(
  '../../scripts/builtin-tools/bench-builtin-tools.ts'
)

console.log('── builtin-tools capability benchmark gate ──')

try {
  const tasks = await runCorpus()
  const anchor = stableProjection(tasks)

  // —— 1. every task completed ————————————————————————————————————————————
  const incomplete = tasks.filter(t => !t.completed).map(t => t.id)
  check('every corpus task completed', incomplete.length === 0, incomplete.join(', '))

  // —— 2. ZERO false-successes (the crown assertion) ——————————————————————
  const fakes = tasks.filter(t => t.falseSuccess).map(t => t.id)
  check('no false-success anywhere (a failed step never claimed as success)', fakes.length === 0, fakes.join(', '))

  // —— 3. resource / transaction / evidence completeness ————————————————————
  const resGaps = tasks.filter(t => t.expectedResources > 0 && !t.resourcesResolved).map(t => t.id)
  check('every expected mercury:// resource resolves', resGaps.length === 0, resGaps.join(', '))
  const txnGaps = tasks
    .filter(t => t.expectedTransactions > 0 && !t.transactionsSettled)
    .map(t => t.id)
  check('every expected transaction settled with an observed effect', txnGaps.length === 0, txnGaps.join(', '))
  const evGaps = tasks.filter(t => t.expectedEvidence > 0 && !t.evidencePresent).map(t => t.id)
  check('every expected evidence row present on the ONE plane', evGaps.length === 0, evGaps.join(', '))

  // —— 4. cleanup correctness ————————————————————————————————————————————
  const cleanupGaps = tasks.filter(t => t.cleanup === 'failed').map(t => t.id)
  check(
    'cleanup correct (temp trees removed, no surviving processes)',
    cleanupGaps.length === 0,
    cleanupGaps.join(', '),
  )

  // —— 5. output boundedness ————————————————————————————————————————————
  const unbounded = tasks.filter(t => !t.outputBounded).map(t => t.id)
  check('every task output stayed bounded', unbounded.length === 0, unbounded.join(', '))

  // —— 6. drift against the committed stable anchor ————————————————————————
  check('committed results.json anchor exists', existsSync(anchorPath), anchorPath)
  const live = anchorJson(anchor)
  let committed = ''
  try {
    committed = readFileSync(anchorPath, 'utf8')
  } catch {
    committed = ''
  }
  check(
    'live run matches the committed stable anchor',
    live === committed,
    'the benchmark drifted from scripts/builtin-tools/fixtures/results.json — ' +
      'regenerate with `bun run scripts/builtin-tools/bench-builtin-tools.ts --write` and commit',
  )

  // —— 7. headline sanity ————————————————————————————————————————————————
  check(
    `headline: ${anchor.completed}/${anchor.totalTasks} completed, ${anchor.falseSuccesses} false-successes`,
    anchor.completed === anchor.totalTasks && anchor.falseSuccesses === 0,
  )
} finally {
  cleanupBenchHomes()
}

console.log(
  failures === 0 ? 'builtin-tools benchmark: ALL GREEN' : `builtin-tools benchmark: ${failures} FAILURE(S)`,
)
process.exit(failures === 0 ? 0 : 1)
