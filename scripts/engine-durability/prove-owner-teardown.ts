#!/usr/bin/env bun

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

function liveOwner(sessionId: string): string {
  const owner = makeOwnerKey({ workspace: ROOT, sessionId, lane: 'main' })
  coord.acceptUserRequest(owner, { objective: `keel ${sessionId}`, rootMessageId: 'u1' })
  coord.noteRunEvent(owner, { type: 'substantive', at: 2, reason: 'edits landed' })
  guardWrite(ROOT, sidecar.runSidecarPath(owner))
  return owner
}

t.section('§1 — disposal during a coalesce wait settles the accepted generation')
{
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

t.section('§6 — an active durable owner is not silently evicted')
{
  const before = coord._runOwnerCountForTesting()
  const first = liveOwner('keel-evict-first')
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

t.section('§7 — a new owner admitted while EVERY other owner is retained survives')
{
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

  retained.delete(a)
  const d = makeOwnerKey({ workspace: ROOT, sessionId: 'keel-retained-d', lane: 'main' })
  store.get(d)
  t.check('eviction resumes once an owner becomes evictable', disposed.includes(a), `disposed=${disposed.length}`)
  t.check('the new owner is held', store.has(d))
}

t.section('§8 — the graceful-shutdown sweep drains durable owners')
{
  const { runCleanupFunctions } = await import('../../src/utils/cleanupRegistry.ts')

  const owner = liveOwner('keel-shutdown')
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
