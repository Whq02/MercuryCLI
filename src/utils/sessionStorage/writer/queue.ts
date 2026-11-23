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

export class QueuePart {
  private pendingWriteCount: number = 0
  private flushResolvers: Array<() => void> = []
  writeQueues: Map<string, Array<{ line: string; resolve: () => void; boundary?: MercuryRecord }>> = new Map()
  private flushTimer: ReturnType<typeof setTimeout> | null = null
  private activeDrain: Promise<void> | null = null
  private FLUSH_INTERVAL_MS: number = 100
  private readonly MAX_CHUNK_BYTES: number = 104_857_600
  private fileWriteChain: Promise<unknown> = Promise.resolve()

  _resetFlushState(): void {
    this.pendingWriteCount = 0
    this.flushResolvers = []
    this.writeQueues.clear()
    if (this.flushTimer !== null) {
      stopTimeout(this.flushTimer)
      this.flushTimer = null
    }
    this.activeDrain = null
    this.fileWriteChain = Promise.resolve()
  }

  private settleFlushWaiters(): void {
    const waiters = this.flushResolvers.splice(0)
    for (const resolve of waiters) resolve()
  }

  async trackWrite<T>(fn: () => Promise<T>): Promise<T> {
    this.pendingWriteCount++
    try {
      return await fn()
    } finally {
      this.pendingWriteCount--
      if (this.pendingWriteCount === 0) {
        this.settleFlushWaiters()
      }
    }
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
    const { line, record } = encodeTranscriptLine(filePath, entry)
    return this.enqueueRawLine(filePath, line, undefined, record)
  }

  enqueueRawLine(
    filePath: string,
    line: string,
    capture?: (item: { line: string; resolve: () => void }) => void,
    record?: MercuryRecord,
  ): Promise<void> {
    return new Promise<void>(resolve => {
      let queue = this.writeQueues.get(filePath)
      if (!queue) {
        queue = []
        this.writeQueues.set(filePath, queue)
      }
      const boundary =
        record?.payload.kind === 'boundary' && record.payload.boundaryKind === 'compact'
          ? record
          : undefined
      const item: { line: string; resolve: () => void; boundary?: MercuryRecord } =
        boundary !== undefined ? { line, resolve, boundary } : { line, resolve }
      queue.push(item)
      capture?.(item)
      this.scheduleDrain()
    })
  }

  private drainFailureStreak: number = 0

  private scheduleDrain(): void {
    if (this.flushTimer !== null) return
    const delay = Math.min(this.FLUSH_INTERVAL_MS * 2 ** this.drainFailureStreak, 5000)
    this.flushTimer = startTimeout(() => {
      this.flushTimer = null
      void this.runDrain().catch(passedOver)
    }, delay)
  }

  private runDrain(): Promise<void> {
    const drain = this.drainWriteQueue()
      .then(
        () => {
          this.drainFailureStreak = 0
          setStoreHealth({ failing: false, sentence: null })
        },
        (error: unknown) => {
          if (this.drainFailureStreak === 0) {
            logError(error)
          }
          this.drainFailureStreak++
          if (this.drainFailureStreak >= 2) {
            setStoreHealth({
              failing: true,
              sentence: error instanceof Error ? error.message : String(error),
            })
          }
          throw error
        },
      )
      .finally(() => {
        if (this.activeDrain === drain) {
          this.activeDrain = null
        }
        if (this.writeQueues.size > 0) {
          this.scheduleDrain()
        }
      })
    this.activeDrain = drain
    return drain
  }

  private async appendToFile(filePath: string, data: string): Promise<void> {
    try {
      await fsAppendFile(filePath, data, { mode: 0o600 })
    } catch {
      try {
        await mkdir(dirname(filePath), { recursive: true, mode: 0o700 })
        await fsAppendFile(filePath, data, { mode: 0o600 })
      } catch (retryError) {
        throw describeTranscriptStoreFailure(filePath, retryError)
      }
    }
    linkTaskOutputToTranscript(filePath)
  }

  private drainWriteQueue(): Promise<void> {
    return this.serializeWrite(() => this._drainWriteQueueInner())
  }

  async _drainWriteQueueInner(): Promise<void> {
    const paths = [...this.writeQueues.keys()]
    const failures: Array<{ filePath: string; error: unknown }> = []

    for (const filePath of paths) {
      const queue = this.writeQueues.get(filePath)
      if (!queue || queue.length === 0) {
        this.writeQueues.delete(filePath)
        continue
      }
      const batch = queue.splice(0)
      this.writeQueues.delete(filePath)

      let landed = 0
      let chunk = ''
      let chunkItems: Array<{ line: string; resolve: () => void; boundary?: MercuryRecord }> = []

      try {
        for (let i = 0; i < batch.length; i++) {
          const item = batch[i]!
          if (item.boundary !== undefined) {
            if (chunk.length > 0) {
              await this.appendToFile(filePath, chunk)
              for (const pending of chunkItems) pending.resolve()
              landed = i
              chunk = ''
              chunkItems = []
            }
            if (await sealHistoryPart(filePath, item.line, item.boundary)) {
              item.resolve()
              landed = i + 1
              chunkItems = []
              continue
            }
          }
          if (chunk.length > 0 && chunk.length + item.line.length >= this.MAX_CHUNK_BYTES) {
            await this.appendToFile(filePath, chunk)
            for (const pending of chunkItems) pending.resolve()
            landed = i
            chunk = ''
            chunkItems = []
          }
          chunk += item.line
          chunkItems.push(item)
        }
        if (chunk.length > 0) {
          await this.appendToFile(filePath, chunk)
          for (const pending of chunkItems) pending.resolve()
          landed = batch.length
        }
      } catch (error) {
        const remaining = batch.slice(landed)
        if (remaining.length > 0) {
          const later = this.writeQueues.get(filePath)
          this.writeQueues.set(filePath, later ? [...remaining, ...later] : remaining)
        }
        failures.push({ filePath, error })
      }
    }

    if (failures.length === 1) {
      throw failures[0]!.error
    }
    if (failures.length > 1) {
      const details = failures
        .map(({ filePath, error }) => `${basename(filePath)}: ${error instanceof Error ? error.message : String(error)}`)
        .join('; ')
      throw new Error(`${failures.length} transcript files could not be written — ${details}`)
    }
  }

  async flush(): Promise<void> {
    if (this.flushTimer !== null) {
      stopTimeout(this.flushTimer)
      this.flushTimer = null
    }
    const inFlight = this.activeDrain
    if (inFlight !== null) {
      await inFlight
    }
    await this.runDrain()
    if (this.pendingWriteCount > 0) {
      await this.trackedWritesLanded()
    }
  }

  private trackedWritesLanded(): Promise<void> {
    return new Promise<void>(resolve => this.flushResolvers.push(resolve))
  }
}
