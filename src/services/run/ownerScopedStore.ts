
import type { OwnerKey } from './ownerKey.js'

export interface OwnerScopedStoreOptions<T> {
  name: string
  create: (owner: OwnerKey) => T
  dispose?: (state: T, owner: OwnerKey) => void | Promise<void>
  retain?: (state: T, owner: OwnerKey) => boolean
  cap?: number
}

export class OwnerScopedStore<T> {
  readonly name: string
  #create: (owner: OwnerKey) => T
  #dispose?: (state: T, owner: OwnerKey) => void | Promise<void>
  #retain?: (state: T, owner: OwnerKey) => boolean
  #cap: number
  #states = new Map<OwnerKey, T>()
  #pending = new Set<Promise<void>>()
  #overCapacity = 0

  constructor(opts: OwnerScopedStoreOptions<T>) {
    this.name = opts.name
    this.#create = opts.create
    this.#dispose = opts.dispose
    this.#retain = opts.retain
    this.#cap = Math.max(1, opts.cap ?? 64)
  }

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

  #evictOne(justCreated: OwnerKey): void {
    for (const [owner, state] of this.#states) {
      if (owner === justCreated) continue
      if (this.#retain?.(state, owner)) continue
      this.dispose(owner)
      this.#overCapacity = Math.max(0, this.#states.size - this.#cap)
      return
    }
    this.#overCapacity = Math.max(0, this.#states.size - this.#cap)
  }

  get overCapacity(): number {
    return this.#overCapacity
  }

  peek(owner: OwnerKey): T | undefined {
    return this.#states.get(owner)
  }

  has(owner: OwnerKey): boolean {
    return this.#states.has(owner)
  }

  dispose(owner: OwnerKey): void {
    void this.#disposeInternal(owner, false)
  }

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
      return Promise.resolve()
    }
    if (!(result instanceof Promise)) return Promise.resolve()
    const tracked = result.catch(() => undefined).then(() => {
      this.#pending.delete(tracked)
    })
    this.#pending.add(tracked)
    return awaited ? tracked : Promise.resolve()
  }

  async drainPending(): Promise<void> {
    while (this.#pending.size > 0) {
      await Promise.all([...this.#pending])
    }
  }

  get size(): number {
    return this.#states.size
  }

  owners(): OwnerKey[] {
    return [...this.#states.keys()]
  }

  clearAllForShutdown(): void {
    for (const owner of [...this.#states.keys()]) this.dispose(owner)
  }
}
