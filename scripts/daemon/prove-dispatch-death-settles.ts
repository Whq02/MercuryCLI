#!/usr/bin/env bun
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  concourseDispatchesPath,
  failWorkingDispatchesForRunner,
  readConcourseDispatches,
  reconcileWorkingDispatches,
} from '../../src/daemon/concourse-workers/concourseDispatch.js'

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
      "the owning WORKING row is 'failed' and carries the daemon's reason",
      moved === 1 && after['d-working-w1']!.state === 'failed' && after['d-working-w1']!.reason === 'concourse-w1: long-lived worker exceeded 5 respawns',
      `${JSON.stringify(after['d-working-w1'])} — failWorkingDispatchesForRunner in src/daemon/concourse-workers/concourseDispatch.ts must move the runner's working row to failed with the given reason (moved=${moved})`,
    )
    check('the revision advanced through the one adjudicator', after['d-working-w1']!.stateRevision === 4, `stateRevision=${after['d-working-w1']!.stateRevision}, expected 4: the failed transition in failWorkingDispatchesForRunner (src/daemon/concourse-workers/concourseDispatch.ts) must advance it by one`)
    check("another runner's working row stands", after['d-working-w2']!.state === 'working', `state=${after['d-working-w2']!.state}: failWorkingDispatchesForRunner in src/daemon/concourse-workers/concourseDispatch.ts must settle only rows whose workerId is the runner it was given`)
    check('a queued row is untouched — death settles only what was RUNNING', after['d-queued']!.state === 'queued', `state=${after['d-queued']!.state}: failWorkingDispatchesForRunner in src/daemon/concourse-workers/concourseDispatch.ts must skip rows that are not working`)
    const again = failWorkingDispatchesForRunner('concourse-w1', 'a later reason must not overwrite', scratch)
    check(
      'a second call is the terminal noop and the first reason survives',
      again === 0 && readConcourseDispatches(scratch)['d-working-w1']!.reason === 'concourse-w1: long-lived worker exceeded 5 respawns',
      `second call returned ${again}, reason now ${readConcourseDispatches(scratch)['d-working-w1']!.reason}: a failed row is terminal, so failWorkingDispatchesForRunner in src/daemon/concourse-workers/concourseDispatch.ts must leave it alone`,
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
      `${JSON.stringify(after['d-working-w1'])} — reconcileWorkingDispatches in src/daemon/concourse-workers/concourseDispatch.ts must fail the working row of a worker whose record has endedAt, with a reason containing "settled at boot reconcile" (settled=${settled})`,
    )
    check("a live worker's row stands", after['d-working-w2']!.state === 'working', `state=${after['d-working-w2']!.state}: reconcileWorkingDispatches in src/daemon/concourse-workers/concourseDispatch.ts must skip workers with no endedAt`)
    check('a repeat reconcile is a noop', reconcileWorkingDispatches(scratch, () => ({ 'concourse-w1': { endedAt: 1 } })) === 0, 'a second reconcileWorkingDispatches (src/daemon/concourse-workers/concourseDispatch.ts) settled a row that was already failed; it must skip terminal rows')
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
