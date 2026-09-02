/**
 * Time/size/byte-bounded write batcher with deferred overflow flush.
 *
 * The write function may block (synchronous file appends), and overflow can
 * occur during a render or a keystroke, so an overflowing batch is detached
 * synchronously but written on the next macrotask tick — the current tick
 * stays short. `flush()`/`dispose()` drain any queued batch synchronously,
 * so a process exit between overflow detach and the deferred write can never
 * silently lose the batch.
 *
 * Byte accounting is the JavaScript string length of each chunk, not its
 * UTF-8 encoded size. Content is concatenated with no separator; callers
 * append their own newlines.
 */
export type BufferedWriter = {
  write(content: string): void
  flush(): void
  dispose(): void
}

export function createBufferedWriter(options: {
  writeFn: (content: string) => void
  flushIntervalMs?: number
  maxBufferSize?: number
  maxBufferBytes?: number
  immediateMode?: boolean
}): BufferedWriter {
  const {
    writeFn,
    flushIntervalMs = 1000,
    maxBufferSize = 100,
    maxBufferBytes = Number.POSITIVE_INFINITY,
    immediateMode = false,
  } = options

  let buffer: string[] = []
  let byteCount = 0
  let flushTimer: NodeJS.Timeout | undefined
  // Overflow batches detached from the buffer, awaiting their deferred write.
  // A second overflow while one is queued appends here so write ordering is
  // preserved and only one deferred write is ever scheduled.
  let pendingOverflow: string[] = []
  let overflowScheduled = false

  const writeBatch = (batch: string[]): void => {
    if (batch.length === 0) return
    writeFn(batch.join(''))
  }

  const drainOverflow = (): void => {
    if (pendingOverflow.length === 0) return
    const batch = pendingOverflow
    pendingOverflow = []
    writeBatch(batch)
  }

  const clearFlushTimer = (): void => {
    if (flushTimer !== undefined) {
      clearTimeout(flushTimer)
      flushTimer = undefined
    }
  }

  const flush = (): void => {
    // Queued overflow first, so a flush that lands between detach and the
    // deferred tick loses nothing and duplicates nothing — the deferred
    // callback will find the queue empty and write nothing.
    drainOverflow()
    if (buffer.length === 0) return
    const batch = buffer
    buffer = []
    byteCount = 0
    clearFlushTimer()
    writeBatch(batch)
  }

  const detachOverflow = (): void => {
    pendingOverflow.push(...buffer)
    buffer = []
    byteCount = 0
    // Disarm the interval so the next write after an overflow arms a fresh one.
    clearFlushTimer()
    if (!overflowScheduled) {
      overflowScheduled = true
      setTimeout(() => {
        overflowScheduled = false
        drainOverflow()
      }, 0)
    }
  }

  const write = (content: string): void => {
    if (immediateMode) {
      writeFn(content)
      return
    }
    buffer.push(content)
    byteCount += content.length
    if (flushTimer === undefined) {
      flushTimer = setTimeout(() => {
        flushTimer = undefined
        flush()
      }, flushIntervalMs)
    }
    if (buffer.length >= maxBufferSize || byteCount >= maxBufferBytes) {
      detachOverflow()
    }
  }

  return {
    write,
    flush,
    dispose(): void {
      flush()
    },
  }
}
