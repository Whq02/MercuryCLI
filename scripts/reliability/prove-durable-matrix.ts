// prove-durable-matrix — the matrix's structural floor + doc anti-drift.
//
//   §1 every row is complete: ≥1 interruption window, ≥1 failure class,
//      ≥1 source anchor, unique id
//   §2 every source anchor's FILE exists (line numbers drift; files must not)
//   §3 every failure class is covered by ≥1 row, and every row's classes are
//      registered
//   §4 the matrix renders cleanly from the table (untracked derived output)
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import {
  DURABLE_OPERATION_MATRIX,
  FAILURE_CLASSES,
  RESOURCE_BOUNDS,
  STATE_CLASSES,
} from '../../src/substrate/durableOperationMatrix.ts'

let failures = 0
const ok = (cond: boolean, label: string) => {
  console.log(`${cond ? '  ✅' : '  ❌'} ${label}`)
  if (!cond) failures++
}
const repo = join(import.meta.dir, '..', '..')

// §1 structural completeness
{
  const ids = new Set<string>()
  let complete = true
  let unique = true
  for (const r of DURABLE_OPERATION_MATRIX) {
    if (ids.has(r.id)) unique = false
    ids.add(r.id)
    if (
      r.interruptionWindows.length === 0 ||
      r.failureClass.length === 0 ||
      r.source.length === 0 ||
      !r.recovery.trim()
    ) {
      complete = false
      console.log(`     incomplete row: ${r.id}`)
    }
  }
  ok(unique, '§1 row ids are unique')
  ok(complete, '§1 every row has windows + failure classes + sources + recovery')
  ok(DURABLE_OPERATION_MATRIX.length >= 18, `§1 matrix covers the load-bearing surface (${DURABLE_OPERATION_MATRIX.length} rows)`)
  ok(
    DURABLE_OPERATION_MATRIX.every(r => r.schemaOrEpoch.trim().length > 0),
    '§1b every row names its schema/epoch identity',
  )
}

// §1c the resource-bound table: complete rows, unique ids,
// and every proof file exists — a bound in a comment is not evidence.
{
  const ids = new Set<string>()
  let unique = true
  let complete = true
  let proofsExist = true
  for (const r of RESOURCE_BOUNDS) {
    if (ids.has(r.id)) unique = false
    ids.add(r.id)
    if (!r.structure.trim() || !r.writer.trim() || !r.bound.trim() || !r.reaper.trim() || !r.preserves.trim()) {
      complete = false
      console.log(`     incomplete resource row: ${r.id}`)
    }
    if (!existsSync(join(repo, r.proof))) {
      proofsExist = false
      console.log(`     missing resource proof: ${r.proof} (row ${r.id})`)
    }
  }
  ok(unique, '§1c resource row ids are unique')
  ok(complete, '§1c every resource row declares writer + bound + reaper + preserves')
  ok(proofsExist, '§1c every resource proof file exists')
  ok(RESOURCE_BOUNDS.length >= 12, `§1c the resource table covers the estate (${RESOURCE_BOUNDS.length} rows)`)
}

// §2 source anchors point at real files
{
  let allExist = true
  for (const r of DURABLE_OPERATION_MATRIX) {
    for (const s of r.source) {
      const file = s.split(':')[0]!
      if (!existsSync(join(repo, file))) {
        allExist = false
        console.log(`     missing source file: ${s} (row ${r.id})`)
      }
    }
  }
  ok(allExist, '§2 every source anchor file exists')
}

// §3 failure-class coverage both directions
{
  const covered = new Set(DURABLE_OPERATION_MATRIX.flatMap(r => r.failureClass))
  const registered = new Set<string>(FAILURE_CLASSES)
  ok(
    FAILURE_CLASSES.every(fc => covered.has(fc)),
    '§3 every registered failure class is covered by ≥1 row',
  )
  ok(
    [...covered].every(fc => registered.has(fc)),
    '§3 every row failure class is registered',
  )
}

// §5 state-class floor + the migration ratchet
{
  const valid = new Set<string>(STATE_CLASSES)
  let classed = true
  let ratchetHonest = true
  for (const r of DURABLE_OPERATION_MATRIX) {
    if (!valid.has(r.stateClass)) {
      classed = false
      console.log(`     unclassified row: ${r.id} (stateClass ${String(r.stateClass)})`)
    }
    // Only state a competing writer can silently lose ever moves onto the
    // authority. A projection is rebuilt, an append-only log is never rewritten
    // and an immutable artefact has no second writer — marking one of those
    // "migrated" would inflate the ratchet with rows that were never in scope.
    if (r.migrated && r.stateClass !== 'authority') {
      ratchetHonest = false
      console.log(`     non-authority row marked migrated: ${r.id} (${r.stateClass})`)
    }
  }
  ok(classed, '§5 every row declares a registered state class')
  ok(ratchetHonest, '§5 only authority rows can be marked migrated')

  const authority = DURABLE_OPERATION_MATRIX.filter(r => r.stateClass === 'authority')
  const migrated = authority.filter(r => r.migrated)
  ok(
    authority.length > 0,
    `§5 the migration has a scope (${authority.length} authority rows; ${migrated.length} migrated)`,
  )
  console.log(
    `     durable-authority ratchet: ${migrated.length}/${authority.length} authority rows on the durable authority`,
  )
}

// §4 the matrix renders cleanly to its untracked home
{
  const res = spawnSync(
    process.execPath,
    [join(import.meta.dir, 'gen-durable-matrix.ts')],
    { encoding: 'utf8' },
  )
  ok(res.status === 0, '§4 the matrix renders from the table (untracked derived output)')
  if (res.status !== 0) console.log(res.stderr || res.stdout)
}

console.log(failures === 0 ? '\nPASS prove-durable-matrix' : `\nFAIL prove-durable-matrix (${failures})`)
process.exit(failures === 0 ? 0 : 1)
