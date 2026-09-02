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
