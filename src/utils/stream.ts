/**
 * A push-driven async iterator: producers enqueue values, then complete,
 * fail, or cancel; a single consumer iterates.
 */

type ParkedReader<T> = {
  resolve: (result: IteratorResult<T, undefined>) => void
  reject: (error: unknown) => void
}

/** Compact the drained prefix once it dominates the buffer — the head
 *  cursor keeps next() O(1) under consumer lag (sweep #2, C25)
 *  without paying a splice per event. */
const COMPACT_AT = 1024

export class Stream<T> implements AsyncIterableIterator<T> {
  private queue: T[] = []
  /** Index of the next value to hand out; everything before it is drained. */
  private head = 0
  private isDone = false
  private recordedError: unknown = undefined
  private parked: ParkedReader<T> | null = null
  private iterated = false

  constructor(private readonly onCancel?: () => void) {}

  /** Single-consumption: the guard trips on the second request for the iterator, not on the second next(). */
  [Symbol.asyncIterator](): AsyncIterableIterator<T> {
    if (this.iterated) {
      throw new Error('Stream can only be iterated once')
    }
    this.iterated = true
    return this
  }

  /**
   * Buffered values drain before the done signal is observed and before a
   * recorded error is observed. The error check is a truthiness test, so a
   * falsy recorded error is never observed and the reader parks instead.
   */
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
      // Cleared before being invoked so it cannot fire twice.
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

  /**
   * Records the error and rejects any parked reader. Already-buffered
   * values still drain first, and an error does not by itself mark the
   * stream done — a stream that is both done and errored reports done.
   */
  error(error: unknown): void {
    this.recordedError = error
    const parked = this.parked
    if (parked) {
      this.parked = null
      parked.reject(error)
    }
  }

  /** Early termination (a `break` out of `for await`): marks done and fires the cancellation callback. Does not settle a parked reader. */
  async return(): Promise<IteratorResult<T, undefined>> {
    this.isDone = true
    this.onCancel?.()
    return { done: true, value: undefined }
  }
}
