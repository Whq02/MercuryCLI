// ============================================================================
//  ownerScopedStore — the one bounded, disposable shape every owner-keyed
//  registry uses.
//
//  Contract (the "explicit owner, bounded retention, teardown" floor):
//    · get(owner) lazily creates that owner's state (LRU-touched);
//    · retention is BOUNDED — at `cap` live owners the least-recently-used
//      one is evicted through the SAME disposer as an explicit dispose, so
//      eviction can never leak timers/subscriptions;
//    · dispose(owner) is idempotent;
//    · clearAllForShutdown() is the ONLY whole-store reset and is named for
//      its two legitimate callers (process shutdown, proof harnesses).
//
//  added the two properties durable owners need, because the original
//  contract had no way to express them:
//    · the disposer may be ASYNC. disposeAsync(owner) awaits it; the sync
//      dispose(owner) still exists for the many callers that cannot await,
//      and any promise it starts is tracked so drainPending() can settle it.
//      Without this, an owner mid-write was torn down by a call that had no
//      way to wait for the write.
//    · RETENTION is declarable. `retain(state, owner)` marks an owner that
//      would LOSE something if dropped — eviction skips those and takes the
//      least-recently-used evictable owner instead. Silently evicting an
//      owner with an uncommitted durable write is data loss wearing a cache
//      policy's clothes; when every live owner is retained the store reports
//      `overCapacity` rather than choosing a victim.
//
//  Pure + React-free. Stores register themselves with ownerLifecycle so one
//  disposeOwner(owner) tears an owner out of EVERY registry.
// ============================================================================

import type { OwnerKey } from './ownerKey.js'

export interface OwnerScopedStoreOptions<T> {
  /** Human name for diagnostics ('verification', 'ctx-forecast', …). */
  name: string
  /** Create a fresh state for an owner on first touch. */
  create: (owner: OwnerKey) => T
  /**
   * Release an owner's state (timers, subscriptions, child processes). May be
   * async: a durable owner drains its outstanding write here.
   *
   * The store has ALREADY forgotten the owner when this runs — synchronously,
   * because callers rely on the owner being gone the moment dispose() returns
   * — so this call is the state's last reachable moment. An operation the
   * state still has in flight (a child being spawned, a write being staged)
   * is the disposer's to await or cancel; left alone, it lands in a state
   * nothing can reach again.
   */
  dispose?: (state: T, owner: OwnerKey) => void | Promise<void>
  /**
   * True while this owner must NOT be evicted — it holds state whose loss
   * would be a defect rather than a cache miss. Absent ⇒ always evictable.
   */
  retain?: (state: T, owner: OwnerKey) => boolean
  /** Max live owners before LRU eviction (default 64). */
  cap?: number
}

export class OwnerScopedStore<T> {
  readonly name: string
  #create: (owner: OwnerKey) => T
  #dispose?: (state: T, owner: OwnerKey) => void | Promise<void>
  #retain?: (state: T, owner: OwnerKey) => boolean
  #cap: number
  /** Map iteration order is insertion order — re-set on touch gives LRU. */
  #states = new Map<OwnerKey, T>()
  /** Drains started by a caller that could not await them (sync dispose,
   *  eviction, shutdown sweep). drainPending() is the barrier over these. */
  #pending = new Set<Promise<void>>()
  /** Live owners the cap could not evict because every one was retained. */
  #overCapacity = 0

  constructor(opts: OwnerScopedStoreOptions<T>) {
    this.name = opts.name
    this.#create = opts.create
    this.#dispose = opts.dispose
    this.#retain = opts.retain
    this.#cap = Math.max(1, opts.cap ?? 64)
  }

  /** Get (creating if needed) the owner's state. Touches LRU order. */
  get(owner: OwnerKey): T {
    const existing = this.#states.get(owner)
    if (existing !== undefined) {
      this.#states.delete(owner)
      this.#states.set(owner, existing)
      return existing
    }
    const created = this.#create(owner)
    this.#states.set(owner, created)
    if (this.#states.size > this.#cap) this.#evictOne(owner)
    return created
  }

  /**
   * Evict the least-recently-used EVICTABLE owner, if there is one.
   *
   * `justCreated` is excluded explicitly. It is the newest entry, so it sorts
   * last in insertion order, and a brand-new owner is never retained — so
   * without this guard, a store whose every OTHER owner is retained evicts
   * the very state get() is about to hand back. The caller then holds a state
   * the store does not, every later get() for that owner mints another
   * throwaway, and the store can never admit anyone again.
   */
  #evictOne(justCreated: OwnerKey): void {
    for (const [owner, state] of this.#states) {
      if (owner === justCreated) continue
      if (this.#retain?.(state, owner)) continue
      this.dispose(owner)
      this.#overCapacity = Math.max(0, this.#states.size - this.#cap)
      return
    }
    // Every other live owner declared itself retained. Growing past the cap is
    // the correct outcome — the alternative is discarding state that is still
    // needed — and the overflow is reported rather than hidden.
    this.#overCapacity = Math.max(0, this.#states.size - this.#cap)
  }

  /** How far past `cap` retention has pushed this store (0 when at or under). */
  get overCapacity(): number {
    return this.#overCapacity
  }

  /** Read without creating. Does not touch LRU order. */
  peek(owner: OwnerKey): T | undefined {
    return this.#states.get(owner)
  }

  has(owner: OwnerKey): boolean {
    return this.#states.has(owner)
  }

  /**
   * Idempotent owner teardown through the disposer. Synchronous for the many
   * callers that cannot await; an async disposer's promise is TRACKED (see
   * drainPending) rather than dropped, so nothing it was releasing is lost.
   * Prefer disposeAsync where the caller can wait.
   */
  dispose(owner: OwnerKey): void {
    void this.#disposeInternal(owner, false)
  }

  /** Owner teardown that AWAITS an async disposer's drain. */
  async disposeAsync(owner: OwnerKey): Promise<void> {
    await this.#disposeInternal(owner, true)
  }

  #disposeInternal(owner: OwnerKey, awaited: boolean): Promise<void> {
    const state = this.#states.get(owner)
    if (state === undefined) return Promise.resolve()
    this.#states.delete(owner)
    let result: void | Promise<void>
    try {
      result = this.#dispose?.(state, owner)
    } catch {
      /* a disposer error must never break the teardown sweep */
      return Promise.resolve()
    }
    if (!(result instanceof Promise)) return Promise.resolve()
    const tracked = result.catch(() => undefined).then(() => {
      this.#pending.delete(tracked)
    })
    this.#pending.add(tracked)
    return awaited ? tracked : Promise.resolve()
  }

  /**
   * Settle every drain started without a caller to await it — the barrier
   * eviction and the sync dispose path need so their work is provable rather
   * than merely started.
   */
  async drainPending(): Promise<void> {
    while (this.#pending.size > 0) {
      await Promise.all([...this.#pending])
    }
  }

  /** Live owner count (proof harnesses assert return-to-baseline). */
  get size(): number {
    return this.#states.size
  }

  owners(): OwnerKey[] {
    return [...this.#states.keys()]
  }

  /** Whole-store reset — process shutdown and proof harnesses ONLY. */
  clearAllForShutdown(): void {
    for (const owner of [...this.#states.keys()]) this.dispose(owner)
  }
}
