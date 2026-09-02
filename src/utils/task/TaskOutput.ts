import * as fs from 'node:fs'

import { tailFile, readFileRange } from '../fsOperations.js'
import { CircularBuffer } from '../CircularBuffer.js'
import { getErrnoCode } from '../errors.js'
import { logError } from '../log.js'
import { logForDebugging } from '../debug.js'
import { getMaxOutputLength, OUTPUT_HEAD_SHARE } from '../shell/outputLimits.js'
import { safeJoinLines } from '../stringUtils.js'
import { DiskTaskOutput, acquireTaskOutputWriter, getTaskOutputPath } from './diskOutput.js'


type ProgressCallback = (
  recentLines: string,
  fullRecentLines: string,
  totalLines: number,
  totalBytes: number,
  isPartialView: boolean,
) => void

const DEFAULT_MAX_MEMORY_BYTES = 8 * 1024 * 1024
const DEFAULT_DECISION_READ_BYTES = 1024 * 1024
const POLL_SAMPLE_BYTES = 4096
const POLL_INTERVAL_MS = 1000
const HARVEST_BUDGET_UNITS = 4096
const HARVEST_MAX_SEGMENTS = 100
const ROLLING_LINE_CAPACITY = 1000
const RECENT_VIEW_LINES = 5
const FULL_VIEW_LINES = 100

const pollRegistry = new Map<string, TaskOutput>()
const activePolling = new Set<string>()
let pollTimer: ReturnType<typeof setInterval> | null = null

function pollTick(): void {
  for (const taskId of activePolling) {
    const instance = pollRegistry.get(taskId)
    if (!instance || !instance.hasProgressCallback()) continue
    void instance.sampleFileProgress()
  }
}

function materialiseSegment(segment: string): string {
  return Buffer.from(segment, 'utf8').toString('utf8')
}

export class TaskOutput {
  readonly taskId: string
  readonly path: string
  readonly stdoutToFile: boolean

  private onProgress: ProgressCallback | null
  private readonly maxMemoryBytes: number

  private stdoutChunks: string[] = []
  private stdoutLength = 0
  private stderrChunks: string[] = []
  private stderrLength = 0
  private spilled = false
  private diskWriter: DiskTaskOutput | null = null
  private readonly recentLines = new CircularBuffer<string>(ROLLING_LINE_CAPACITY)

  private lineCount = 0
  private byteTotal = 0

  private fileRedundant = false
  private fileSize = 0

  constructor(
    taskId: string,
    onProgress: ProgressCallback | null,
    stdoutToFile = false,
    maxMemoryBytes: number = DEFAULT_MAX_MEMORY_BYTES,
  ) {
    this.taskId = taskId
    this.path = getTaskOutputPath(taskId)
    this.stdoutToFile = stdoutToFile
    this.onProgress = onProgress
    this.maxMemoryBytes = maxMemoryBytes
    if (stdoutToFile && onProgress) {
      pollRegistry.set(taskId, this)
    }
  }

  static startPolling(taskId: string): void {
    const instance = pollRegistry.get(taskId)
    if (!instance || !instance.hasProgressCallback()) return
    activePolling.add(taskId)
    if (pollTimer === null) {
      pollTimer = setInterval(pollTick, POLL_INTERVAL_MS)
      pollTimer.unref?.()
    }
  }

  static stopPolling(taskId: string): void {
    activePolling.delete(taskId)
    if (activePolling.size === 0 && pollTimer !== null) {
      clearInterval(pollTimer)
      pollTimer = null
    }
  }

  hasProgressCallback(): boolean {
    return this.onProgress !== null
  }

  async sampleFileProgress(): Promise<void> {
    let sample: { content: string; bytesRead: number; bytesTotal: number }
    try {
      sample = await tailFile(this.path, POLL_SAMPLE_BYTES)
    } catch {
      return
    }
    const onProgress = this.onProgress
    if (!onProgress) return

    if (sample.content.length === 0) {
      onProgress('', '', this.lineCount, sample.bytesTotal, false)
      return
    }

    const content = sample.content
    let cursor = content.length
    let count = 0
    let recentBoundary = 0
    let fullBoundary = 0
    while (cursor > 0) {
      const newline = content.lastIndexOf('\n', cursor - 1)
      count++
      if (count === RECENT_VIEW_LINES) recentBoundary = newline <= 0 ? 0 : newline + 1
      if (count === FULL_VIEW_LINES) fullBoundary = newline <= 0 ? 0 : newline + 1
      cursor = newline
    }

    const sampledWholeFile = sample.bytesRead === sample.bytesTotal
    const totalLines = sampledWholeFile
      ? count
      : Math.max(Math.round(count * (sample.bytesTotal / sample.bytesRead)), this.lineCount)
    this.lineCount = totalLines
    this.byteTotal = sample.bytesTotal
    onProgress(
      content.slice(recentBoundary),
      content.slice(fullBoundary),
      totalLines,
      sample.bytesTotal,
      !sampledWholeFile,
    )
  }

  writeStdout(data: string): void {
    this.write(data, false)
  }

  writeStderr(data: string): void {
    this.write(data, true)
  }

  private write(data: string, isStderr: boolean): void {
    this.byteTotal += data.length
    const harvestedAny = this.harvest(data)
    if (harvestedAny && this.onProgress) {
      this.onProgress(
        this.joinRecent(RECENT_VIEW_LINES),
        this.joinRecent(FULL_VIEW_LINES),
        this.lineCount,
        this.byteTotal,
        this.spilled,
      )
    }
    if (this.spilled) {
      this.writeToDisk(data, isStderr)
      return
    }
    if (this.stdoutLength + this.stderrLength + data.length > this.maxMemoryBytes) {
      this.spillBuffers(data, isStderr)
      return
    }
    if (isStderr) {
      this.stderrChunks.push(data)
      this.stderrLength += data.length
    } else {
      this.stdoutChunks.push(data)
      this.stdoutLength += data.length
    }
  }

  private harvest(chunk: string): boolean {
    const collected: string[] = []
    let budget = HARVEST_BUDGET_UNITS
    let cursor = chunk.length
    while (cursor > 0) {
      const newline = chunk.lastIndexOf('\n', cursor - 1)
      if (newline === -1) break
      this.lineCount++
      const segment = chunk.slice(newline + 1, cursor)
      if (
        collected.length < HARVEST_MAX_SEGMENTS &&
        segment.length > 0 &&
        segment.length <= budget &&
        segment.trim().length > 0
      ) {
        budget -= segment.length
        collected.push(materialiseSegment(segment))
      }
      cursor = newline
    }
    for (let i = collected.length - 1; i >= 0; i--) {
      this.recentLines.add(collected[i]!)
    }
    return collected.length > 0
  }

  private joinRecent(count: number): string {
    return safeJoinLines(this.recentLines.getRecent(count), '\n')
  }

  private writeToDisk(data: string, isStderr: boolean): void {
    this.diskWriter?.append(isStderr ? `[stderr] ${data}` : data)
  }

  spillToDisk(): void {
    if (this.spilled) return
    this.spillBuffers(undefined, false)
  }

  private spillBuffers(triggerChunk: string | undefined, triggerIsStderr: boolean): void {
    this.diskWriter = acquireTaskOutputWriter(this.taskId)
    const bufferedStdout = this.stdoutChunks.join('')
    if (bufferedStdout.length > 0) this.diskWriter.append(bufferedStdout)
    const bufferedStderr = this.stderrChunks.join('')
    if (bufferedStderr.length > 0) this.diskWriter.append(`[stderr] ${bufferedStderr}`)
    if (triggerChunk !== undefined) {
      this.diskWriter.append(triggerIsStderr ? `[stderr] ${triggerChunk}` : triggerChunk)
    }
    this.stdoutChunks = []
    this.stdoutLength = 0
    this.stderrChunks = []
    this.stderrLength = 0
    this.spilled = true
  }

  private async headAndTailExcerpt(head: { content: string; bytesRead: number; bytesTotal: number }, maxLength: number): Promise<string> {
    const noticeReserve = 160 + this.path.length
    const budget = Math.max(64, maxLength - noticeReserve)
    const headBudget = Math.floor(budget * OUTPUT_HEAD_SHARE)
    const tailBudget = Math.max(1, budget - headBudget)
    let headText = head.content.slice(0, headBudget)
    const headNewline = headText.lastIndexOf('\n')
    if (headNewline > headBudget / 2) headText = headText.slice(0, headNewline)
    const tail = await tailFile(this.path, tailBudget)
    let tailText = tail.content
    const tailNewline = tailText.indexOf('\n')
    if (tailNewline !== -1 && tailNewline < tailBudget / 2) tailText = tailText.slice(tailNewline + 1)
    const shownBytes = Buffer.byteLength(headText, 'utf8') + Buffer.byteLength(tailText, 'utf8')
    const omitted = Math.max(0, head.bytesTotal - shownBytes)
    const notice = `\n\n[${omitted} bytes truncated from the middle — the head and the tail of the output are shown; the complete output is saved at ${this.path}]\n\n`
    return headText + notice + tailText
  }

  async getStdout(): Promise<string> {
    if (this.stdoutToFile) {
      try {
        const maxLength = getMaxOutputLength()
        const result = await readFileRange(this.path, 0, maxLength)
        if (result === null) {
          this.fileRedundant = true
          return ''
        }
        this.fileSize = result.bytesTotal
        if (result.bytesRead === result.bytesTotal) {
          this.fileRedundant = true
          return result.content
        }
        this.fileRedundant = false
        return await this.headAndTailExcerpt(result, maxLength)
      } catch (error) {
        const code = getErrnoCode(error) ?? 'unknown'
        logForDebugging(`task output read failed: ${this.path} (${code}): ${String(error)}`)
        return `<command output unavailable: could not read ${this.path} (${code}) — most likely another Mercury process working in this project deleted it during its startup cleanup>`
      }
    }
    if (!this.spilled) {
      return this.stdoutChunks.join('')
    }
    const tail = this.recentLines.getRecent(RECENT_VIEW_LINES)
    const totalKb = Math.round(this.byteTotal / 1024)
    const notice = `\n<output truncated: ~${totalKb}KB captured in total — the complete output is saved at ${this.path}>`
    if (tail.length === 0) return notice.trimStart()
    return safeJoinLines(tail, '\n') + notice
  }

  async getStdoutForDecision(maxBytes: number = DEFAULT_DECISION_READ_BYTES): Promise<string> {
    if (!this.stdoutToFile && this.spilled) {
      if (this.diskWriter) await this.diskWriter.flush()
      try {
        const result = await tailFile(this.path, maxBytes)
        return result.content
      } catch {
        return this.getStdout()
      }
    }
    return this.getStdout()
  }

  getStderr(): string {
    return this.spilled ? '' : this.stderrChunks.join('')
  }

  get isOverflowed(): boolean {
    return this.spilled
  }

  get totalLines(): number {
    return this.lineCount
  }

  get totalBytes(): number {
    return this.byteTotal
  }

  get outputFileRedundant(): boolean {
    return this.fileRedundant
  }

  get outputFileSize(): number {
    return this.fileSize
  }

  async flush(): Promise<void> {
    if (this.spilled && this.diskWriter) await this.diskWriter.flush()
  }

  async deleteOutputFile(): Promise<void> {
    try {
      await fs.promises.unlink(this.path)
    } catch {
    }
  }

  clear(): void {
    this.stdoutChunks = []
    this.stdoutLength = 0
    this.stderrChunks = []
    this.stderrLength = 0
    this.recentLines.clear()
    this.onProgress = null
    this.diskWriter?.cancel()
    TaskOutput.stopPolling(this.taskId)
    pollRegistry.delete(this.taskId)
  }
}
