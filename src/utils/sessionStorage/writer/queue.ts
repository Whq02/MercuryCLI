import type { MercuryRecord } from '../../../fabric/record.js'
import { sealHistoryPart } from './sealPart.js'
import { appendFile as fsAppendFile, mkdir } from 'fs/promises'
import { basename, dirname } from 'path'
import type { Entry } from '../../../types/logs.js'
import { logError } from '../../log.js'
import { linkTaskOutputToTranscript } from '../../task/diskOutput.js'
import { encodeTranscriptLine } from '../vnext.js'
import { describeTranscriptStoreFailure, setStoreHealth } from './storeHealth.js'
import { passedOver } from '../../passedOver.js'
import { startTimeout, stopTimeout } from '../../timers.js'
import { notBuilt, unbuilt, type Unbuilt } from '../../../pi/holes.js'

export class QueuePart {
  private pendingWriteCount: number = unbuilt('src/utils/sessionStorage/writer/queue.ts:14')
  private flushResolvers: Array<() => void> = unbuilt('src/utils/sessionStorage/writer/queue.ts:15')
  writeQueues: Map<string, Array<{ line: string; resolve: () => void; boundary?: MercuryRecord }>> = unbuilt('src/utils/sessionStorage/writer/queue.ts:16')
  private flushTimer: ReturnType<typeof setTimeout> | null = unbuilt('src/utils/sessionStorage/writer/queue.ts:20')
  private activeDrain: Promise<void> | null = unbuilt('src/utils/sessionStorage/writer/queue.ts:21')
  private FLUSH_INTERVAL_MS: number = unbuilt('src/utils/sessionStorage/writer/queue.ts:22')
  private readonly MAX_CHUNK_BYTES: Unbuilt = unbuilt('src/utils/sessionStorage/writer/queue.ts:23')
  private fileWriteChain: Promise<unknown> = unbuilt('src/utils/sessionStorage/writer/queue.ts:24')

  _resetFlushState(): void {
    return notBuilt('src/utils/sessionStorage/writer/queue.ts:26')
  }

  private settleFlushWaiters(): void {
    return notBuilt('src/utils/sessionStorage/writer/queue.ts:36')
  }

  async trackWrite<T>(fn: () => Promise<T>): Promise<T> {
    return notBuilt('src/utils/sessionStorage/writer/queue.ts:40')
  }

  private insertChainQueue: Promise<unknown> = Promise.resolve()
  serializeInsert<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.insertChainQueue.then(
      () => fn(),
      () => fn(),
    )
    this.insertChainQueue = run.catch(passedOver)
    return run
  }

  serializeWrite<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.fileWriteChain.then(
      () => fn(),
      () => fn(),
    )
    this.fileWriteChain = run.catch(passedOver)
    return run
  }

  enqueueWrite(filePath: string, entry: Entry): Promise<void> {
    const { line, record } = encodeTranscriptLine(filePath, entry as Record<string, unknown>)
    return this.enqueueRawLine(filePath, line, undefined, record)
  }

  enqueueRawLine(
    filePath: string,
    line: string,
    capture?: (item: { line: string; resolve: () => void }) => void,
    record?: MercuryRecord,
  ): Promise<void> {
    return notBuilt('src/utils/sessionStorage/writer/queue.ts:73')
  }

  private drainFailureStreak: number = unbuilt('src/utils/sessionStorage/writer/queue.ts:92')

  private scheduleDrain(): void {
    return notBuilt('src/utils/sessionStorage/writer/queue.ts:94')
  }

  private runDrain(): Promise<void> {
    return notBuilt('src/utils/sessionStorage/writer/queue.ts:105')
  }

  private async appendToFile(filePath: string, data: string): Promise<void> {
    return notBuilt('src/utils/sessionStorage/writer/queue.ts:131')
  }

  private drainWriteQueue(): Promise<void> {
    return this.serializeWrite(() => this._drainWriteQueueInner())
  }

  async _drainWriteQueueInner(): Promise<void> {
    return notBuilt('src/utils/sessionStorage/writer/queue.ts:149')
  }

  async flush(): Promise<void> {
    return notBuilt('src/utils/sessionStorage/writer/queue.ts:210')
  }

  private trackedWritesLanded(): Promise<void> {
    return new Promise<void>(resolve => this.flushResolvers.push(resolve))
  }
}
