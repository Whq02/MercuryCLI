import { startTimeout, stopTimeout } from './timers.js'
import { notBuilt } from '../pi/holes.js'

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
  return notBuilt('src/utils/bufferedWriter.ts:9')
}
