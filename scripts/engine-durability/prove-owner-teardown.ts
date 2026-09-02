#!/usr/bin/env bun
// ============================================================================
//  scripts/engine-durability/prove-owner-teardown.ts — M0 reproducer for the owner
//  lifecycle defects B and E.
//
//  ORACLE:
//    · dispose during a timer wait and during an active write — no accepted
//      generation disappears;
//    · every disposal path settles durably or reports degraded explicitly.
//
//  What the code does today:
//    B · runCoordinator's disposer releases ONLY the coalesce timer:
//          dispose: state => { if (state.flushTimer) clearTimeout(...) ... }
//        Missed invariant: settlement on teardown. An in-flight write and a
//        dirty snapshot are both dropped by explicit disposal and by LRU
//        eviction (default cap 64).
//    E · OwnerScopedStore's disposer contract is synchronous only:
//          dispose?: (state: T, owner: OwnerKey) => void
//        Missed invariant: any async drain path for durable owners, including
//        on LRU eviction — the store has no way to await a release, so a
//        durable owner cannot be torn down without losing whatever its drain
//        would have written.
//
//  The two contract points the fix must provide (named here so the reproducer
//  is a specification, not just a complaint):
//    · OwnerScopedStore#disposeAsync(owner) — an awaited owner drain;
//    · OwnerScopedStore#drainPending() — a barrier over drains that eviction
//      and shutdown started without a caller to await them.
// ============================================================================

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { checker, scratchRoot, guardWrite } from './harness.ts'

const ROOT = scratchRoot('teardown')
const t = checker()

const barrier = await import('./barrier.ts')
const { makeOwnerKey } = await import('../../src/services/run/ownerKey.ts')
const sidecar = await import('../../src/services/run/runSidecar.ts')
const coord = await import('../../src/services/run/runCoordinator.ts')
const lifecycle = await import('../../src/services/run/ownerLifecycle.ts')
const { OwnerScopedStore } = await import('../../src/services/run/ownerScopedStore.ts')

/** An owner made substantive on the main lane — the only shape that persists. */
function liveOwner(sessionId: string): string {
  const owner = makeOwnerKey({ workspace: ROOT, sessionId, lane: 'main' })
  coord.acceptUserRequest(owner, { objective: `keel ${sessionId}`, rootMessageId: 'u1' })
  coord.noteRunEvent(owner, { type: 'substantive', at: 2, reason: 'edits landed' })
  guardWrite(ROOT, sidecar.runSidecarPath(owner))
  return owner
}

// ── §1 disposal while a coalesced write is still pending (defect B) ─────────
t.section('§1 — disposal during a coalesce wait settles the accepted generation')
{
  // acceptUserRequest marks the run dirty without scheduling; the substantive
  // event arms the 250ms coalesce timer. Disposal lands inside that window.
  const owner = liveOwner('keel-disposetimer')
  await lifecycle.disposeOwner(owner)
  await barrier.microturns()

  const load = await sidecar.loadRunSidecar(owner)
  t.check(
    'the accepted generation is durable (or explicitly degraded) after disposal',
    load.state === 'loaded',
    `sidecar state=${load.state}`,
  )
}

// ── §2 disposal while a required write is in flight (defect B) ──────────────
t.section('§2 — disposal awaits a required write already in flight')
{
  const owner = liveOwner('keel-disposewrite')
  const path = sidecar.runSidecarPath(owner)

  const hold = barrier.holdNextPublish(p => p === path)
  coord.noteRunEvent(owner, { type: 'paused', at: 3, reason: 'generation A' })
  await hold.entered

  let released = false
  void (async () => {
    await barrier.microturns(4)
    released = true
    hold.release()
  })()

  await lifecycle.disposeOwner(owner)
  t.check(
    'disposal did not settle while the required write was still in flight',
    released,
    released ? '' : 'disposeOwner returned with an unsettled write outstanding',
  )

  hold.release()
  await hold.settled
  await barrier.microturns()
  const load = await sidecar.loadRunSidecar(owner)
  t.check(
    'the in-flight generation is on disk after disposal',
    load.state === 'loaded',
    `sidecar state=${load.state}`,
  )
}

// ── §3 an owner disposed with an unwritable store reports degraded ──────────
t.section('§3 — a disposal that cannot settle reports degraded rather than dropping')
{
  const owner = liveOwner('keel-disposefail')
  process.env.MERCURY_FAULT_INJECT = 'write@keel-disposefail:throw'
  coord.noteRunEvent(owner, { type: 'paused', at: 3, reason: 'generation A' })
  await lifecycle.disposeOwner(owner)
  delete process.env.MERCURY_FAULT_INJECT

  const settlementOf = (coord as unknown as Record<string, unknown>).runSettlement
  const receipt =
    typeof settlementOf === 'function'
      ? ((settlementOf as (o: string) => { state?: string } | null)(owner) ?? null)
      : null
  t.check(
    'the disposed owner carries a typed degraded settlement receipt',
    receipt?.state === 'degraded',
    typeof settlementOf === 'function'
      ? `state=${String(receipt?.state)}`
      : 'no runSettlement export',
  )
}

// ── §4 the store's disposer contract admits an async drain (defect E) ───────
t.section('§4 — OwnerScopedStore exposes an awaited owner drain')
{
  let drained = false
  const store = new OwnerScopedStore<{ id: string }>({
    name: 'keel-async-drain',
    create: () => ({ id: 'x' }),
    dispose: () =>
      new Promise<void>(res =>
        setImmediate(() => {
          drained = true
          res()
        }),
      ) as unknown as void,
  })
  const owner = makeOwnerKey({ workspace: ROOT, sessionId: 'keel-drain', lane: 'main' })
  store.get(owner)

  const disposeAsync = (store as unknown as Record<string, unknown>).disposeAsync
  t.check(
    'the store exposes disposeAsync(owner)',
    typeof disposeAsync === 'function',
    typeof disposeAsync === 'function' ? '' : 'no disposeAsync on OwnerScopedStore',
  )
  if (typeof disposeAsync === 'function') {
    await (disposeAsync as (o: string) => Promise<void>).call(store, owner)
  }
  t.check(
    'the owner drain completed before the disposal call resolved',
    drained,
    drained ? '' : 'the disposer promise was never awaited',
  )
}

// ── §5 LRU eviction's drain is observable (defect E) ────────────────────────
t.section('§5 — an LRU-evicted owner has an awaitable drain barrier')
{
  const drainedOwners: string[] = []
  const store = new OwnerScopedStore<{ id: string }>({
    name: 'keel-lru-drain',
    cap: 2,
    create: () => ({ id: 'x' }),
    dispose: (_s, owner) =>
      new Promise<void>(res =>
        setImmediate(() => {
          drainedOwners.push(owner)
          res()
        }),
      ) as unknown as void,
  })
  const owners = ['a', 'b', 'c'].map(s =>
    makeOwnerKey({ workspace: ROOT, sessionId: `keel-lru-${s}`, lane: 'main' }),
  )
  for (const o of owners) store.get(o)

  const drainPending = (store as unknown as Record<string, unknown>).drainPending
  t.check(
    'the store exposes drainPending() for eviction-started drains',
    typeof drainPending === 'function',
    typeof drainPending === 'function' ? '' : 'no drainPending on OwnerScopedStore',
  )
  if (typeof drainPending === 'function') {
    await (drainPending as () => Promise<void>).call(store)
    t.check(
      'the evicted owner completed its drain at the barrier',
      drainedOwners.includes(owners[0]!),
      `drained=[${drainedOwners.join(', ')}]`,
    )
  } else {
    t.check('the evicted owner completed its drain at the barrier', false, 'no barrier to await')
  }
}

// ── §6 the durable run store does not evict a live durable owner ────────────
t.section('§6 — an active durable owner is not silently evicted')
{
  const before = coord._runOwnerCountForTesting()
  const first = liveOwner('keel-evict-first')
  // Push well past the default cap of 64 live owners.
  for (let i = 0; i < 70; i++) {
    const filler = makeOwnerKey({ workspace: ROOT, sessionId: `keel-filler-${i}`, lane: 'main' })
    coord.acceptUserRequest(filler, { objective: 'filler', rootMessageId: null })
  }
  const stillHeld = coord.getRunSnapshot(first) !== null
  t.check(
    'the first durable owner is still held after 70 later owners',
    stillHeld,
    `owners before=${before}, now=${coord._runOwnerCountForTesting()}`,
  )
}

// ── §7 the all-retained arm: the newcomer is never the eviction victim ──────
t.section('§7 — a new owner admitted while EVERY other owner is retained survives')
{
  // The arm §6 does not reach. A brand-new owner sorts last in insertion order
  // and is never retained, so a scan for "the first evictable owner" finds IT
  // when every older owner is retained — and disposes the state the caller is
  // about to be handed. The store would then hold nothing for that owner,
  // every later get() would mint another throwaway, and no new owner could
  // ever be admitted again. The condition that fills a store with retained
  // owners is a persistent write failure: exactly what this stage exists to
  // survive.
  const disposed: string[] = []
  const retained = new Set<string>()
  const store = new OwnerScopedStore<{ id: string }>({
    name: 'keel-all-retained',
    cap: 2,
    create: owner => ({ id: owner }),
    dispose: (_s, owner) => {
      disposed.push(owner)
    },
    retain: (_s, owner) => retained.has(owner),
  })
  const [a, b, c] = ['a', 'b', 'c'].map(s =>
    makeOwnerKey({ workspace: ROOT, sessionId: `keel-retained-${s}`, lane: 'main' }),
  )
  store.get(a)
  store.get(b)
  retained.add(a)
  retained.add(b)

  const created = store.get(c)
  t.check('get() returned a state', created !== undefined)
  t.check(
    'the store still holds the owner get() returned',
    store.has(c),
    `owners=[${store.owners().length}] disposed=[${disposed.length}]`,
  )
  t.check('the newcomer was not disposed', !disposed.includes(c))
  t.check(
    'the overflow is reported rather than hidden',
    store.overCapacity === 1,
    `overCapacity=${store.overCapacity} (size ${store.owners().length}, cap 2)`,
  )

  // And once an owner stops being retained, the cap resumes working.
  retained.delete(a)
  const d = makeOwnerKey({ workspace: ROOT, sessionId: 'keel-retained-d', lane: 'main' })
  store.get(d)
  t.check('eviction resumes once an owner becomes evictable', disposed.includes(a), `disposed=${disposed.length}`)
  t.check('the new owner is held', store.has(d))
}

// ── §8 process exit settles the drains it starts ───────────────────────────
t.section('§8 — the graceful-shutdown sweep drains durable owners')
{
  // The wiring file described a process-exit sweep that nothing called: a
  // generation inside the 250ms coalesce window was abandoned at exit with no
  // commit and no receipt.
  //
  // This section imports ONLY what a turn already pulls in — the coordinator,
  // and the cleanup registry gracefulShutdown drives. It deliberately does NOT
  // call wireOwnerLifecycle(): that helper is reachable only through a dynamic
  // import on the resume/continue paths, so a proof that calls it manufactures
  // wiring a plain launch does not have, and would pass while the default boot
  // still lost the generation. The registration has to follow the run kernel's
  // own module graph or this check is theatre.
  const { runCleanupFunctions } = await import('../../src/utils/cleanupRegistry.ts')

  const owner = liveOwner('keel-shutdown')
  // Coalesced only — nothing has been committed yet when the process ends.
  const before = await sidecar.loadRunSidecar(owner)
  t.check(
    'the accepted generation is not yet on disk (the precondition)',
    before.state === 'none',
    `sidecar state=${before.state}`,
  )

  await runCleanupFunctions()
  const after = await sidecar.loadRunSidecar(owner)
  t.check(
    'the shutdown sweep settled the coalesced generation',
    after.state === 'loaded',
    `sidecar state=${after.state}`,
  )
}

t.finish('prove-owner-teardown')
