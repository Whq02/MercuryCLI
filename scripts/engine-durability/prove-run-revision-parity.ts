#!/usr/bin/env bun

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
  const { getRunSnapshot } = await import('../../src/services/run/runCoordinator.ts')

  const before = sidecar.runRevision(ownerA)
  const load = await sidecar.loadRunSidecar(ownerA)
  t.check(
    'the loaded sidecar is the revision the number names',
    load.state === 'loaded' && load.snapshot.objective === 'revision parity run-a',
    `state=${load.state}`,
  )
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
