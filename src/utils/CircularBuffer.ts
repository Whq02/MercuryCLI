/**
 * Fixed-capacity rolling window with oldest-first eviction.
 *
 * Implemented as a ring over a plain array. `clear()` drops the backing
 * array entirely so no evicted or cleared item stays reachable through the
 * buffer, and the structure behaves exactly like a freshly constructed one.
 */
export class CircularBuffer<T> {
  private readonly capacity: number
  private items: T[] = []
  private start = 0

  constructor(capacity: number) {
    this.capacity = capacity
  }

  add(item: T): void {
    if (this.items.length < this.capacity) {
      this.items.push(item)
      return
    }
    // Full: overwrite the oldest slot and advance the ring start.
    this.items[this.start] = item
    this.start = (this.start + 1) % this.capacity
  }

  addAll(items: T[]): void {
    for (const item of items) {
      this.add(item)
    }
  }

  /**
   * The most recent `count` items in chronological (oldest→newest) order.
   * Asking for more than is held returns everything held; zero or a negative
   * count returns an empty list.
   */
  getRecent(count: number): T[] {
    if (count <= 0) return []
    const all = this.toArray()
    return all.slice(Math.max(0, all.length - count))
  }

  /** Every held item, oldest first. */
  toArray(): T[] {
    if (this.start === 0) return this.items.slice()
    return this.items.slice(this.start).concat(this.items.slice(0, this.start))
  }

  clear(): void {
    this.items = []
    this.start = 0
  }

  length(): number {
    return this.items.length
  }
}
