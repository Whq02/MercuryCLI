import { startTimeout, stopTimeout } from './timers.js'

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
  const { writeFn, flushIntervalMs = 1000, maxBufferSize = 100, maxBufferBytes = Infinity, immediateMode = false } = options
  const live: string[] = []
  const pending: string[] = []
  let units = 0
  let delay: ReturnType<typeof startTimeout> | undefined
  let drainScheduled = false

  function takeLive(): string {
    const text = live.join('')
    live.length = 0
    units = 0
    return text
  }

  function drainPending(): void {
    if (!pending.length) return
    const text = pending.join('')
    pending.length = 0
    writeFn(text)
  }

  function stopDelay(): void {
    if (delay === undefined) return
    stopTimeout(delay)
    delay = undefined
  }

  function flush(): void {
    drainPending()
    stopDelay()
    if (live.length) writeFn(takeLive())
  }

  return {
    write(content) {
      if (immediateMode) {
        writeFn(content)
        return
      }
      live.push(content)
      units += content.length
      if (delay === undefined) delay = startTimeout(flush, flushIntervalMs)
      if (live.length >= maxBufferSize || units >= maxBufferBytes) {
        pending.push(takeLive())
        stopDelay()
        if (!drainScheduled) {
          drainScheduled = true
          startTimeout(() => {
            drainScheduled = false
            drainPending()
          }, 0)
        }
      }
    },
    flush,
    dispose: flush,
  }
}
