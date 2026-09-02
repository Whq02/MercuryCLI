#!/usr/bin/env bun
// ============================================================================
//  scripts/daemon/prove-dispatch-death-settles.ts — a runner's death settles
// its DISPATCH row (conceded):
//  the degrade path settled the WORKER record while the dispatch stayed
//  state:'working' forever, and a fresh daemon over the same dir re-served
//  the stale row byte-identical.
//    (1) failWorkingDispatchesForRunner — the owning WORKING row moves to
//        'failed' carrying the supervisor's reason; another runner's row and
//        a queued row stand; a second call is the adjudicator's terminal noop.
//    (2) reconcileWorkingDispatches (boot) — a working row whose worker
//        already carries endedAt settles; a live worker's row stands.
//    (3) the wiring — onDegraded rides (1) beside settleConcourseWorker;
//        the daemon boot rides (2) after recovery.
//  Hermetic: a scratch daemon dir; the workers read is injected.
//  Run:  ~/.bun/bin/bun run scripts/daemon/prove-dispatch-death-settles.ts
// ============================================================================
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  concourseDispatchesPath,
  failWorkingDispatchesForRunner,
  readConcourseDispatches,
  reconcileWorkingDispatches,
} from '../../src/daemon/concourseDispatch.js'

const ROOT = join(import.meta.dir, '..', '..')
let failures = 0
const check = (name: string, cond: boolean, detail = ''): void => {
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${name}${cond || !detail ? '' : ` — ${detail}`}`)
  if (!cond) failures++
}
const section = (s: string): void => console.log(`\n── ${s} ──`)

const scratch = mkdtempSync(join(tmpdir(), 'dispatch-death-'))
const rec = (id: string, state: string, workerId?: string): Record<string, unknown> => ({
  schema: 1,
  clientMessageId: id,
  promptDigest: 'd'.repeat(64),
  state,
  stateRevision: 3,
  acceptedAt: Date.now() - 60_000,
  ...(workerId !== undefined ? { workerId } : {}),
  deliveredAt: Date.now() - 50_000,
})
const seed = (): void => {
  writeFileSync(
    concourseDispatchesPath(scratch),
    JSON.stringify({
      version: 1,
      dispatches: {
        'd-working-w1': rec('d-working-w1', 'working', 'concourse-w1'),
        'd-working-w2': rec('d-working-w2', 'working', 'concourse-w2'),
        'd-queued': rec('d-queued', 'queued'),
      },
    }),
  )
}

try {
  section('(1) the degrade path settles the owning WORKING row')
  {
    seed()
    const moved = failWorkingDispatchesForRunner('concourse-w1', 'concourse-w1: long-lived worker exceeded 5 respawns', scratch)
    const after = readConcourseDispatches(scratch)
    check(
      "the owning WORKING row is 'failed' and carries the supervisor's reason",
      moved === 1 && after['d-working-w1']!.state === 'failed' && after['d-working-w1']!.reason === 'concourse-w1: long-lived worker exceeded 5 respawns',
      JSON.stringify(after['d-working-w1']),
    )
    check('the revision advanced through the one adjudicator', after['d-working-w1']!.stateRevision === 4)
    check("another runner's working row stands", after['d-working-w2']!.state === 'working')
    check('a queued row is untouched — death settles only what was RUNNING', after['d-queued']!.state === 'queued')
    const again = failWorkingDispatchesForRunner('concourse-w1', 'a later reason must not overwrite', scratch)
    check(
      'a second call is the terminal noop and the first reason survives',
      again === 0 && readConcourseDispatches(scratch)['d-working-w1']!.reason === 'concourse-w1: long-lived worker exceeded 5 respawns',
    )
  }

  section('(2) the boot reconcile settles a working row whose worker already ended')
  {
    seed()
    const settled = reconcileWorkingDispatches(scratch, () => ({
      'concourse-w1': { endedAt: Date.now() - 1_000 },
      'concourse-w2': {},
    }))
    const after = readConcourseDispatches(scratch)
    check(
      "an ended worker's working row settles at boot with the reconcile reason",
      settled === 1 && after['d-working-w1']!.state === 'failed' && /settled at boot reconcile/.test(after['d-working-w1']!.reason ?? ''),
      JSON.stringify(after['d-working-w1']),
    )
    check("a live worker's row stands", after['d-working-w2']!.state === 'working')
    check('a repeat reconcile is a noop', reconcileWorkingDispatches(scratch, () => ({ 'concourse-w1': { endedAt: 1 } })) === 0)
  }

  section('(3) the wiring')
  {
    const main = readFileSync(join(ROOT, 'src', 'daemon', 'main.ts'), 'utf8')
    const degraded = main.slice(main.indexOf('onDegraded: (reason, short)'), main.indexOf('onDegraded: (reason, short)') + 1200)
    check('onDegraded settles the dispatch beside the worker record, carrying its reason', degraded.includes('settleConcourseWorker(short)') && degraded.includes('failWorkingDispatchesForRunner(short, reason)'))
    check('the daemon boot reconciles working dispatches after recovery', main.includes('runBootRecovery({ scope: ') && main.indexOf('reconcileWorkingDispatches()') > main.indexOf('runBootRecovery({ scope: ') && main.includes('reconcileWorkingDispatches()'))
  }
} finally {
  rmSync(scratch, { recursive: true, force: true })
}

console.log('\n============================================================')
if (failures === 0) {
  console.log(' ✅ DISPATCH DEATH-SETTLEMENT PROOFS PASS')
  process.exit(0)
}
console.log(` ❌ ${failures} CHECK(S) FAILED`)
process.exit(1)
