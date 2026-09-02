
type ParkedReader<T> = {
  resolve: (result: IteratorResult<T, undefined>) => void
  reject: (error: unknown) => void
}

const COMPACT_AT = 1024

export class Stream<T> implements AsyncIterableIterator<T> {
  private queue: T[] = []
  private head = 0
  private isDone = false
  private recordedError: unknown = undefined
  private parked: ParkedReader<T> | null = null
  private iterated = false

  constructor(private readonly onCancel?: () => void) {}

  [Symbol.asyncIterator](): AsyncIterableIterator<T> {
    if (this.iterated) {
      throw new Error('Stream can only be iterated once')
    }
    this.iterated = true
    return this
  }

  async next(): Promise<IteratorResult<T, undefined>> {
    if (this.head < this.queue.length) {
      const value = this.queue[this.head] as T
      this.queue[this.head] = undefined as unknown as T
      this.head++
      if (this.head === this.queue.length) {
        this.queue = []
        this.head = 0
      } else if (this.head >= COMPACT_AT && this.head * 2 >= this.queue.length) {
        this.queue = this.queue.slice(this.head)
        this.head = 0
      }
      return { done: false, value }
    }
    if (this.isDone) {
      return { done: true, value: undefined }
    }
    if (this.recordedError) {
      throw this.recordedError
    }
    return new Promise<IteratorResult<T, undefined>>((resolve, reject) => {
      this.parked = { resolve, reject }
    })
  }

  enqueue(value: T): void {
    const parked = this.parked
    if (parked) {
      this.parked = null
      parked.resolve({ done: false, value })
    } else {
      this.queue.push(value)
    }
  }

  done(): void {
    this.isDone = true
    const parked = this.parked
    if (parked) {
      this.parked = null
      parked.resolve({ done: true, value: undefined })
    }
  }

  error(error: unknown): void {
    this.recordedError = error
    const parked = this.parked
    if (parked) {
      this.parked = null
      parked.reject(error)
    }
  }

  async return(): Promise<IteratorResult<T, undefined>> {
    this.isDone = true
    this.onCancel?.()
    return { done: true, value: undefined }
  }
}
