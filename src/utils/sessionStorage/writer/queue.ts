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
  writeQueues = new Map<
    string,
    Array<{ line: string; resolve: () => void }>
  >()
  private flushTimer: ReturnType<typeof setTimeout> | null = null
  private activeDrain: Promise<void> | null = null
  private FLUSH_INTERVAL_MS = 100
  private readonly MAX_CHUNK_BYTES = 100 * 1024 * 1024
  private fileWriteChain: Promise<unknown> = Promise.resolve()

  _resetFlushState(): void {
    this.pendingWriteCount = 0
    this.flushResolvers = []
    if (this.flushTimer) stopTimeout(this.flushTimer)
    this.flushTimer = null
    this.activeDrain = null
    this.fileWriteChain = Promise.resolve()
    this.writeQueues = new Map()
  }

  private settleFlushWaiters(): void {
    for (const resolve of this.flushResolvers.splice(0)) resolve()
  }

  async trackWrite<T>(fn: () => Promise<T>): Promise<T> {
    this.pendingWriteCount++
    try {
      return await fn()
    } finally {
      if (--this.pendingWriteCount === 0) this.settleFlushWaiters()
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
    return this.enqueueRawLine(
      filePath,
      encodeTranscriptLine(filePath, entry as Record<string, unknown>).line,
    )
  }

  enqueueRawLine(
    filePath: string,
    line: string,
    capture?: (item: { line: string; resolve: () => void }) => void,
  ): Promise<void> {
    return new Promise<void>(resolve => {
      let queue = this.writeQueues.get(filePath)
      if (!queue) {
        queue = []
        this.writeQueues.set(filePath, queue)
      }
      const item = { line, resolve }
      queue.push(item)
      capture?.(item)
      this.scheduleDrain()
    })
  }

  private drainFailureStreak = 0

  private scheduleDrain(): void {
    if (this.flushTimer) {
      return
    }
    const interval = Math.min(this.FLUSH_INTERVAL_MS * 2 ** this.drainFailureStreak, 5_000)
    this.flushTimer = startTimeout(() => {
      this.flushTimer = null
      this.runDrain().catch(passedOver)
    }, interval)
  }

  private runDrain(): Promise<void> {
    const run = this.drainWriteQueue()
    this.activeDrain = run
    return run
      .then(
        () => {
          this.drainFailureStreak = 0
          setStoreHealth({ failing: false, sentence: null })
        },
        err => {
          if (this.drainFailureStreak === 0) logError(err)
          this.drainFailureStreak++
          if (this.drainFailureStreak >= 2) {
            setStoreHealth({ failing: true, sentence: err instanceof Error ? err.message : String(err) })
          }
          throw err
        },
      )
      .finally(() => {
        if (this.activeDrain === run) this.activeDrain = null
        if (this.writeQueues.size > 0) {
          this.scheduleDrain()
        }
      })
  }

  private async appendToFile(filePath: string, data: string): Promise<void> {
    try {
      await fsAppendFile(filePath, data, { mode: 0o600 })
    } catch {
      try {
        await mkdir(dirname(filePath), { recursive: true, mode: 0o700 })
        await fsAppendFile(filePath, data, { mode: 0o600 })
      } catch (error) {
        throw describeTranscriptStoreFailure(filePath, error)
      }
    }
    linkTaskOutputToTranscript(filePath)
  }

  private drainWriteQueue(): Promise<void> {
    return this.serializeWrite(() => this._drainWriteQueueInner())
  }

  async _drainWriteQueueInner(): Promise<void> {
    const failures: Array<{ filePath: string; error: unknown }> = []
    for (const [filePath, queue] of this.writeQueues) {
      if (queue.length === 0) {
        continue
      }
      const batch = queue.splice(0)

      let landed = 0

      try {
        let content = ''
        let pending = 0

        for (const { line } of batch) {
          if (content.length + line.length >= this.MAX_CHUNK_BYTES) {
            await this.appendToFile(filePath, content)
            for (let i = landed; i < landed + pending; i++) {
              batch[i]!.resolve()
            }
            landed += pending
            pending = 0
            content = ''
          }

          content += line
          pending++
        }

        if (content.length > 0) {
          await this.appendToFile(filePath, content)
          for (let i = landed; i < landed + pending; i++) {
            batch[i]!.resolve()
          }
          landed += pending
        }
      } catch (err) {
        queue.unshift(...batch.slice(landed))
        failures.push({ filePath, error: err })
      }
    }

    for (const [filePath, queue] of this.writeQueues) {
      if (queue.length === 0) {
        this.writeQueues.delete(filePath)
      }
    }

    if (failures.length === 1) throw failures[0]!.error
    if (failures.length > 1) {
      const detail = failures
        .map(({ filePath, error }) => `${basename(filePath)}: ${error instanceof Error ? error.message : String(error)}`)
        .join('; ')
      throw new Error(`${failures.length} transcript files could not be written — ${detail}`)
    }
  }

  async flush(): Promise<void> {
    if (this.flushTimer) stopTimeout(this.flushTimer)
    this.flushTimer = null
    const inFlight = this.activeDrain
    if (inFlight) await inFlight
    await this.runDrain()
    if (this.pendingWriteCount > 0) await this.trackedWritesLanded()
  }

  private trackedWritesLanded(): Promise<void> {
    return new Promise<void>(resolve => this.flushResolvers.push(resolve))
  }
}
