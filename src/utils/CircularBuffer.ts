export class CircularBuffer<T> {
  private readonly capacity: number
  private items: T[] = []
  private start: number = 0

  constructor(capacity: number) {
    this.capacity = capacity
  }

  add(item: T): void {
    if (this.capacity <= 0) return
    if (this.items.length < this.capacity) {
      this.items.push(item)
    } else {
      this.items[this.start] = item
      this.start = (this.start + 1) % this.capacity
    }
  }

  addAll(items: T[]): void {
    for (const item of items) {
      this.add(item)
    }
  }

  getRecent(count: number): T[] {
    if (count <= 0 || this.items.length === 0) return []
    const all = this.toArray()
    return count >= all.length ? all : all.slice(all.length - count)
  }

  toArray(): T[] {
    if (this.start === 0) return this.items.slice()
    return [...this.items.slice(this.start), ...this.items.slice(0, this.start)]
  }

  clear(): void {
    this.items = []
    this.start = 0
  }

  length(): number {
    return this.items.length
  }
}
