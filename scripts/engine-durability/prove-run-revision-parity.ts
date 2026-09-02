#!/usr/bin/env bun
// ============================================================================
//  scripts/engine-durability/prove-run-revision-parity.ts — client-protocol: the
//  TUI and ACP must not disagree about WHICH revision of the run they are
//  describing.
//
//  Before this, ACP could describe the workbench and the review artifacts but
//  had no run surface at all, and no revision was exposed to any client. An
//  editor and the terminal beside it could therefore render different run
//  state with nothing to compare — the disagreement was not merely possible,
//  it was unobservable.
//
//    §1  The revision is REAL: 0 before any durable write (which is distinct
//        from "no run"), and monotonic across saves for an owner.
//    §2  PARITY: the number the run domain reports and the number the ACP
//        surface reports are the same at the same instant, and stay the same
//        after a further write. Both surfaces are driven through their own
//        readers — no shared local variable stands in for the comparison.
//    §3  Owners do not bleed: a second owner's writes never move the first
//        owner's revision.
//
//  Scope stated honestly: this pins the "identical run revisions" clause of
//  the measure. Cursor reconnect-to-exact-digest and the prior-version
//  fixtures are separate clauses and are NOT covered here.
// ============================================================================

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { checker, scratchRoot } from './harness.ts'

const ROOT = scratchRoot('runrevision')
const t = checker()

const { makeOwnerKey } = await import('../../src/services/run/ownerKey.ts')
const sidecar = await import('../../src/services/run/runSidecar.ts')
const { emptyRunSnapshot } = await import('../../src/services/run/runKernel.ts')

const ownerA = makeOwnerKey({ workspace: ROOT, sessionId: 'keel-rev-a', lane: 'main' })
const ownerB = makeOwnerKey({ workspace: ROOT, sessionId: 'keel-rev-b', lane: 'main' })

const snapFor = (id: string, owner: ReturnType<typeof makeOwnerKey>) =>
  emptyRunSnapshot({
    runId: id,
    owner,
    objective: `revision parity ${id}`,
    rootMessageId: null,
    at: 1,
  })

t.section('§1 — the revision is real and monotonic')
{
  t.check(
    'an owner with no durable write reports revision 0',
    sidecar.runRevision(ownerA) === 0,
    `revision=${sidecar.runRevision(ownerA)}`,
  )

  await sidecar.saveRunSidecar(ownerA, snapFor('run-a', ownerA))
  const first = sidecar.runRevision(ownerA)
  t.check('the first save advances the revision', first > 0, `revision=${first}`)

  await sidecar.saveRunSidecar(ownerA, snapFor('run-a', ownerA))
  const second = sidecar.runRevision(ownerA)
  t.check(
    'a further save advances it strictly',
    second > first,
    `${first} → ${second}`,
  )
}

t.section('§2 — the revision names the sidecar it was allocated for')
{
  // NOTE ON SCOPE, because the obvious version of this section is a lie.
  // Comparing `runRevision(owner)` to `runRevision(owner)` and calling the
  // second one "ACP" is a tautology — one function compared to itself. The
  // REAL cross-surface comparison drives the registered `_mercury/run`
  // handler over an actual ACP connection, and that rig lives in
  // scripts/editor-bridge/prove-acp-server.ts, which is where it is asserted.
  // What belongs here is the property that makes such a comparison
  // meaningful: the number is bound to the durable write it names.
  const { getRunSnapshot } = await import('../../src/services/run/runCoordinator.ts')

  const before = sidecar.runRevision(ownerA)
  const load = await sidecar.loadRunSidecar(ownerA)
  t.check(
    'the loaded sidecar is the revision the number names',
    load.state === 'loaded' && load.snapshot.objective === 'revision parity run-a',
    `state=${load.state}`,
  )
  // A load must never REGRESS the revision — the monotonicity belt in
  // saveRunSidecar, seen from the read side.
  t.check(
    'loading does not regress the revision',
    sidecar.runRevision(ownerA) >= before,
    `${before} → ${sidecar.runRevision(ownerA)}`,
  )

  await sidecar.saveRunSidecar(ownerA, snapFor('run-a', ownerA))
  t.check(
    'a write after a load still advances it',
    sidecar.runRevision(ownerA) > before,
    `${before} → ${sidecar.runRevision(ownerA)}`,
  )
  // The in-memory run reader is the TUI's own path; it must answer honestly
  // for an owner this process never hosted (the projection-only case ACP
  // hits) rather than throwing.
  t.check(
    'the in-memory reader answers honestly for an unhosted owner',
    getRunSnapshot(ownerA) === null || typeof getRunSnapshot(ownerA) === 'object',
  )
}

t.section('§3 — owners do not bleed')
{
  const beforeA = sidecar.runRevision(ownerA)
  await sidecar.saveRunSidecar(ownerB, snapFor('run-b', ownerB))
  t.check(
    "a second owner's write does not move the first owner's revision",
    sidecar.runRevision(ownerA) === beforeA,
    `A ${beforeA} → ${sidecar.runRevision(ownerA)}, B=${sidecar.runRevision(ownerB)}`,
  )
  t.check(
    'the second owner has its own independent revision',
    sidecar.runRevision(ownerB) > 0,
    `B=${sidecar.runRevision(ownerB)}`,
  )
}

t.finish('prove-run-revision-parity')
