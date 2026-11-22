import { notBuilt, unbuilt } from '../pi/holes.js'

export class CircularBuffer<T> {
  private readonly capacity: number
  private items: T[] = unbuilt('src/utils/CircularBuffer.ts:3')
  private start: number = unbuilt('src/utils/CircularBuffer.ts:4')

  constructor(capacity: number) {
    notBuilt('src/utils/CircularBuffer.ts:6')
  }

  add(item: T): void {
    return notBuilt('src/utils/CircularBuffer.ts:10')
  }

  addAll(items: T[]): void {
    return notBuilt('src/utils/CircularBuffer.ts:19')
  }

  getRecent(count: number): T[] {
    return notBuilt('src/utils/CircularBuffer.ts:25')
  }

  toArray(): T[] {
    return notBuilt('src/utils/CircularBuffer.ts:31')
  }

  clear(): void {
    return notBuilt('src/utils/CircularBuffer.ts:36')
  }

  length(): number {
    return notBuilt('src/utils/CircularBuffer.ts:41')
  }
}
