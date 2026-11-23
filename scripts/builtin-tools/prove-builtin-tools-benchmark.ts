#!/usr/bin/env bun

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
  './bench-builtin-tools.ts'
)

console.log('── builtin-tools capability benchmark gate ──')

try {
  const tasks = await runCorpus()
  const anchor = stableProjection(tasks)

  const incomplete = tasks.filter(t => !t.completed).map(t => t.id)
  check('every corpus task completed', incomplete.length === 0, `${incomplete.join(', ')} — these corpus tasks did not complete; read their steps in runCorpus in scripts/builtin-tools/bench-builtin-tools.ts and fix the tool they exercise`)

  const fakes = tasks.filter(t => t.falseSuccess).map(t => t.id)
  check('no false-success anywhere (a failed step never claimed as success)', fakes.length === 0, `${fakes.join(', ')} — these tasks claimed success on a step that did not land; compare falseSuccess for each in runCorpus in scripts/builtin-tools/bench-builtin-tools.ts`)

  const resGaps = tasks.filter(t => t.expectedResources > 0 && !t.resourcesResolved).map(t => t.id)
  check('every expected mercury:// resource resolves', resGaps.length === 0, `${resGaps.join(', ')} — a mercury:// ref these tasks returned did not resolve; see refsResolve and resourcesResolved in scripts/builtin-tools/bench-builtin-tools.ts`)
  const txnGaps = tasks
    .filter(t => t.expectedTransactions > 0 && !t.transactionsSettled)
    .map(t => t.id)
  check('every expected transaction settled with an observed effect', txnGaps.length === 0, `${txnGaps.join(', ')} — a transaction in these tasks did not settle with an observed effect; see transactionsSettled in scripts/builtin-tools/bench-builtin-tools.ts`)
  const evGaps = tasks.filter(t => t.expectedEvidence > 0 && !t.evidencePresent).map(t => t.id)
  check('every expected evidence row present on the ONE plane', evGaps.length === 0, `${evGaps.join(', ')} — an expected evidence row is missing for these tasks; see evidencePresent in scripts/builtin-tools/bench-builtin-tools.ts`)

  const cleanupGaps = tasks.filter(t => t.cleanup === 'failed').map(t => t.id)
  check(
    'cleanup correct (temp trees removed, no surviving processes)',
    cleanupGaps.length === 0,
    `${cleanupGaps.join(', ')} — a temp tree or process of these tasks survived; see removeTree and cleanup in scripts/builtin-tools/bench-builtin-tools.ts`,
  )

  const unbounded = tasks.filter(t => !t.outputBounded).map(t => t.id)
  check('every task output stayed bounded', unbounded.length === 0, `${unbounded.join(', ')} — these task outputs reached OUTPUT_BOUND; shrink what the tool returns, see outputBounded in scripts/builtin-tools/bench-builtin-tools.ts`)

  check('committed results.json anchor exists', existsSync(anchorPath), `${anchorPath} — missing; regenerate with bun run scripts/builtin-tools/bench-builtin-tools.ts --write and commit it`)
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

  check(
    `headline: ${anchor.completed}/${anchor.totalTasks} completed, ${anchor.falseSuccesses} false-successes`,
    anchor.completed === anchor.totalTasks && anchor.falseSuccesses === 0,
    'not every corpus task completed cleanly; the per-task checks above name the ids, and runCorpus in scripts/builtin-tools/bench-builtin-tools.ts holds the tasks',
  )
} finally {
  cleanupBenchHomes()
}

console.log(
  failures === 0 ? 'builtin-tools benchmark: ALL GREEN' : `builtin-tools benchmark: ${failures} FAILURE(S)`,
)
process.exit(failures === 0 ? 0 : 1)
