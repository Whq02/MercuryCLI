// ============================================================================
//  prove-corpus-schema.ts — pure corpus-contract prover (no seeding, no git).
// ----------------------------------------------------------------------------
//  Laws: ≥36 tasks · ≥6 repos · all 16 families · three
//  nonempty partitions with every task in exactly one · unique ids · grader
//  shape sanity (checks present; zeroDiff vs onlyChange coherent; falsify
//  variants present; reference present) · switch-pair completeness · the
//  committed manifest matches a recomputation (digest drift gate).
// ============================================================================
import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import {
  CORPUS_SCHEMA_VERSION,
  HELIX_FAMILIES,
  HELIX_PARTITIONS,
  type HelixFamilyId,
} from './corpus/contracts.js'
import { HELIX_TASKS } from './corpus/tasks.js'
import { corpusDigest, MANIFEST_PATH } from './corpus/manifest.js'

let failures = 0
function check(label: string, ok: boolean, detail?: string): void {
  if (ok) {
    console.log('  ok  ' + label)
  } else {
    failures += 1
    console.log('  FAIL ' + label + (detail ? ' — ' + detail : ''))
  }
}

// ── composition ─────────────────────────────────────────────────────────────
check('at least 36 tasks', HELIX_TASKS.length >= 36, String(HELIX_TASKS.length))
const repos = new Set(HELIX_TASKS.map(t => t.repo))
check('at least 6 repositories', repos.size >= 6, [...repos].join(','))
const families = new Set(HELIX_TASKS.map(t => t.family))
check(
  'all 16 families covered',
  Object.keys(HELIX_FAMILIES).every(f => families.has(Number(f) as HelixFamilyId)),
  [...families].sort((a, b) => a - b).join(','),
)
const ids = HELIX_TASKS.map(t => t.id)
check('task ids unique', new Set(ids).size === ids.length)

// ── partitions ──────────────────────────────────────────────────────────────
for (const partition of HELIX_PARTITIONS) {
  const size = HELIX_TASKS.filter(t => t.partition === partition).length
  check('partition ' + partition + ' nonempty', size > 0, String(size))
}
check(
  'every task in exactly one partition',
  HELIX_TASKS.every(t => HELIX_PARTITIONS.includes(t.partition)),
)
const qualFamilies = new Set(
  HELIX_TASKS.filter(t => t.partition === 'qualification').map(t => t.family),
)
check('qualification covers >= 12 families', qualFamilies.size >= 12, String(qualFamilies.size))

// ── grader shape ────────────────────────────────────────────────────────────
for (const task of HELIX_TASKS) {
  const g = task.grader
  check(task.id + ' has checks', g.checks.length > 0)
  check(task.id + ' zeroDiff/onlyChange coherent', !(g.zeroDiff && g.onlyChange))
  check(
    task.id + ' scope law present',
    Boolean(g.zeroDiff) || Boolean(g.onlyChange),
    'every task pins its effect scope',
  )
  check(task.id + ' has falsify variants', task.falsify.length > 0)
  check(
    task.id + ' has a reference solution',
    Boolean(task.reference.files) || Boolean(task.reference.answer),
  )
  check(task.id + ' has a time ceiling', task.timeCeilingSec >= 60)
  if (g.zeroDiff) {
    check(task.id + ' zero-diff carries a text oracle', (g.requiredTokens ?? []).length > 0)
  }
}

// ── switch-pair completeness: firsts and seconds balance globally, and no
//    partition holds more than one of either (the difficult-work pair straddles
//    development/calibration; the comparison pair lives inside its own
//    partition) ─────────────────────────────────────────────────────────────
const firstTotal = HELIX_TASKS.filter(t => t.runner?.switchPair === 'first').length
const secondTotal = HELIX_TASKS.filter(t => t.runner?.switchPair === 'second').length
check('switch pairs balance', firstTotal === secondTotal && firstTotal >= 1, firstTotal + '/' + secondTotal)
for (const partition of HELIX_PARTITIONS) {
  const inPartition = HELIX_TASKS.filter(t => t.partition === partition)
  const first = inPartition.filter(t => t.runner?.switchPair === 'first').length
  const second = inPartition.filter(t => t.runner?.switchPair === 'second').length
  check(
    'switch-pair density sane in ' + partition,
    first <= 1 && second <= 1,
    first + '/' + second,
  )
}
check(
  'collaboration task present',
  HELIX_TASKS.some(t => t.runner?.collaboration && t.family === 16),
)

// ── manifest drift gate ─────────────────────────────────────────────────────
const repoRoot = resolve(new URL('../..', import.meta.url).pathname)
let committed: Record<string, unknown> | null = null
try {
  committed = JSON.parse(readFileSync(join(repoRoot, MANIFEST_PATH), 'utf8'))
} catch {
  committed = null
}
check('committed manifest exists', committed !== null, MANIFEST_PATH)
if (committed) {
  check(
    'manifest schema version matches',
    committed.schemaVersion === CORPUS_SCHEMA_VERSION,
    String(committed.schemaVersion),
  )
  check(
    'manifest digest matches the recomputation',
    committed.corpusDigest === corpusDigest(),
    committed.corpusDigest + ' vs ' + corpusDigest(),
  )
  const taskRows = (committed.tasks as { id: string }[] | undefined) ?? []
  check('manifest task list matches', taskRows.length === HELIX_TASKS.length)
}

if (failures > 0) {
  console.error('prove-corpus-schema: ' + failures + ' failure(s)')
  process.exit(1)
}
console.log('prove-corpus-schema: green (' + HELIX_TASKS.length + ' tasks, ' + repos.size + ' repos)')
