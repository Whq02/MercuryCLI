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
    this.items[this.start] = item
    this.start = (this.start + 1) % this.capacity
  }

  addAll(items: T[]): void {
    for (const item of items) {
      this.add(item)
    }
  }

  getRecent(count: number): T[] {
    if (count <= 0) return []
    const all = this.toArray()
    return all.slice(Math.max(0, all.length - count))
  }

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
