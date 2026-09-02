#!/usr/bin/env bun
// ============================================================================
//  scripts/engine-durability/prove-settlement-ordering.ts — M0 reproducer for the
//  run-persistence defects A and C.
//
//  ORACLE:
//    · delay write A deterministically, let B finish, release A — the disk
//      holds B with a monotonic revision;
//    · a failed required write surfaces DEGRADED settlement, and a later retry
//      lands the same or a newer generation;
//    · a force-flush awaits the newest in-flight write, not a pointer some
//      earlier write already cleared.
//
//  What the code does today:
//    A · flushNow clears `state.dirty` BEFORE the write, discards the write
//        error in a bare `.catch(() => {})`, and keeps ONE `flushing` pointer
//        that any completing write nulls. Missed invariant: durability of an
//        accepted state change. The in-source assumption — "the dirty flag
//        re-arms on the next event" — does not hold for an idle or terminal
//        run, because no next event arrives.
//    C · saveRunSidecar allocates its sequence number in memory and then
//        publishes through durableAtomicPublish, which has no per-path
//        serialization. Missed invariant: write ordering. The atomic rename
//        prevents a torn file; it does not stop an older snapshot landing
//        after a newer one, so sequence N can overwrite N+1 on disk.
//
//  Scheduling is CONTROLLED (scripts/engine-durability/barrier.ts holds an exact
//  publication), failures ride the repo's own MERCURY_FAULT_INJECT seam, and
//  the whole run is scratch-rooted. No wall-clock sleeps.
// ============================================================================

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { readFileSync } from 'node:fs'
import { checker, scratchRoot, guardWrite, waitUntil } from './harness.ts'

const ROOT = scratchRoot('settle')
const t = checker()

// The scheduling seam must be registered before runSidecar binds the primitive.
const barrier = await import('./barrier.ts')
const { makeOwnerKey } = await import('../../src/services/run/ownerKey.ts')
const kernel = await import('../../src/services/run/runKernel.ts')
const sidecar = await import('../../src/services/run/runSidecar.ts')
const coord = await import('../../src/services/run/runCoordinator.ts')

const diskSeq = (path: string): number | null => {
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as { writeSeq?: unknown }
    return typeof parsed.writeSeq === 'number' ? parsed.writeSeq : null
  } catch {
    return null
  }
}

/** An owner made substantive on the main lane — the only shape that persists. */
function liveOwner(sessionId: string): string {
  const owner = makeOwnerKey({ workspace: ROOT, sessionId, lane: 'main' })
  coord.acceptUserRequest(owner, { objective: `keel ${sessionId}`, rootMessageId: 'u1' })
  coord.noteRunEvent(owner, { type: 'substantive', at: 2, reason: 'edits landed' })
  guardWrite(ROOT, sidecar.runSidecarPath(owner))
  return owner
}

// ── §1 write ordering at the sidecar seam (defect C) ────────────────────────
t.section('§1 — an older held write cannot land over a newer committed one')
{
  const owner = makeOwnerKey({ workspace: ROOT, sessionId: 'keel-order', lane: 'main' })
  const path = guardWrite(ROOT, sidecar.runSidecarPath(owner))
  const base = kernel.emptyRunSnapshot({
    runId: 'run-order',
    owner,
    objective: 'ordering',
    rootMessageId: null,
    at: 1,
  })

  const hold = barrier.holdNextPublish(p => p === path)
  const older = sidecar.saveRunSidecar(owner, { ...base, nextAction: 'OLDER' })
  await hold.entered
  const newer = sidecar.saveRunSidecar(owner, { ...base, nextAction: 'NEWER' })
  // Give the newer write every chance to overtake the held one. An unordered
  // writer lets it publish immediately, so this returns at once and the older
  // write is then released LAST — the defect. An ordered writer queues it
  // behind the held write, so the wait expires and the ordering can never
  // invert: the bound costs time only on the correct side and cannot change
  // the verdict.
  await waitUntil(() => barrier.completionOrder().some(p => p === path), {
    tries: 40,
    everyMs: 5,
  })
  hold.release()
  await Promise.all([older, newer])

  const seq = diskSeq(path)
  t.check(
    'the on-disk committed revision is the newest accepted revision',
    seq === 2,
    `writeSeq on disk = ${String(seq)} (accepted 1 then 2; 1 was released last)`,
  )
  barrier.clearHolds()
}

// ── §2 an accepted generation survives a failed required write (defect A) ───
t.section('§2 — a failed required write is retryable, not silently discarded')
{
  const owner = liveOwner('keel-retry')
  process.env.MERCURY_FAULT_INJECT = 'write@keel-retry:throw'
  coord.noteRunEvent(owner, { type: 'completed', at: 3, satisfied: ['shipped'] })
  await coord.flushRun(owner)
  delete process.env.MERCURY_FAULT_INJECT

  const duringFailure = await sidecar.loadRunSidecar(owner)
  t.check(
    'the failed write left nothing on disk (the precondition)',
    duringFailure.state === 'none',
    `state=${duringFailure.state}`,
  )

  await coord.flushRun(owner)
  const afterRetry = await sidecar.loadRunSidecar(owner)
  t.check(
    'a later retry lands the accepted generation',
    afterRetry.state === 'loaded' && afterRetry.snapshot.lifecycle === 'completed',
    `state=${afterRetry.state}${afterRetry.state === 'loaded' ? ` lifecycle=${afterRetry.snapshot.lifecycle}` : ''}`,
  )
}

// ── §3 the failure is REPORTED, not swallowed (defect A) ────────────────────
t.section('§3 — a required persistence failure yields a typed degraded receipt')
{
  const owner = liveOwner('keel-degraded')
  process.env.MERCURY_FAULT_INJECT = 'write@keel-degraded:throw'
  coord.noteRunEvent(owner, { type: 'completed', at: 3, satisfied: ['shipped'] })
  await coord.flushRun(owner)

  const settlementOf = (coord as unknown as Record<string, unknown>).runSettlement
  const receipt =
    typeof settlementOf === 'function'
      ? ((settlementOf as (o: string) => { state?: string; reason?: string } | null)(owner) ??
        null)
      : null
  t.check(
    'the coordinator exposes a settlement receipt for the owner',
    receipt !== null,
    receipt !== null
      ? ''
      : typeof settlementOf === 'function'
        ? 'runSettlement returned null'
        : 'no runSettlement export',
  )
  t.check(
    'the receipt reports DEGRADED after the failed required write',
    receipt?.state === 'degraded',
    `state=${String(receipt?.state)}`,
  )
  delete process.env.MERCURY_FAULT_INJECT
}

// ── §4 the force-flush awaits the write that is actually in flight ──────────
t.section('§4 — flushRun awaits the newest in-flight write, not a cleared pointer')
{
  const owner = liveOwner('keel-flushptr')
  const path = sidecar.runSidecarPath(owner)

  const held = barrier.holdNextPublish(p => p === path)
  coord.noteRunEvent(owner, { type: 'paused', at: 3, reason: 'generation A' })
  await held.entered
  // A newer generation is accepted while the first write is still in flight.
  coord.noteRunEvent(owner, { type: 'resumed', at: 4, reason: 'generation B' })

  let settled = false
  const forced = coord.flushRun(owner).then(() => {
    settled = true
  })
  await barrier.microturns()
  t.check(
    'flushRun has not settled while a required write is still in flight',
    !settled,
    settled ? 'flushRun returned with an unsettled write outstanding' : '',
  )

  held.release()
  await forced
  t.check(
    'flushRun settles both accepted generations',
    diskSeq(path) === 2,
    `writeSeq on disk = ${String(diskSeq(path))}`,
  )
  barrier.clearHolds()
}

// ── §5 write ordering at the coordinator seam (defect C, production path) ───
t.section('§5 — the coordinator never publishes an older generation last')
{
  const owner = liveOwner('keel-coordorder')
  const path = sidecar.runSidecarPath(owner)

  const held = barrier.holdNextPublish(p => p === path)
  coord.noteRunEvent(owner, { type: 'paused', at: 3, reason: 'generation A' })
  await held.entered
  coord.noteRunEvent(owner, { type: 'resumed', at: 4, reason: 'generation B' })
  await barrier.microturns()
  held.release()
  await waitUntil(() => diskSeq(path) === 2, { tries: 60, everyMs: 5 })

  const seq = diskSeq(path)
  t.check(
    'the on-disk revision is the newest generation the coordinator accepted',
    seq === 2,
    `writeSeq on disk = ${String(seq)}`,
  )
  barrier.clearHolds()
}

t.finish('prove-settlement-ordering')
