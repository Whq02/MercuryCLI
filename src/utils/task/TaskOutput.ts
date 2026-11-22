import * as fs from 'node:fs'

import { tailFile, readFileRange } from '../fsOperations.js'
import { CircularBuffer } from '../CircularBuffer.js'
import { getErrnoCode } from '../errors.js'
import { logForDebugging } from '../debug.js'
import { getMaxOutputLength, OUTPUT_HEAD_SHARE } from '../shell/outputLimits.js'
import { safeJoinLines } from '../stringUtils.js'
import { DiskTaskOutput, acquireTaskOutputWriter, getTaskOutputPath } from './diskOutput.js'
import { passedOver } from '../passedOver.js'
import { startInterval, stopInterval } from '../timers.js'
import { notBuilt, unbuilt, type Unbuilt } from '../../pi/holes.js'


type ProgressCallback = (...args: Unbuilt[]) => Unbuilt
const POLL_SAMPLE_BYTES: Unbuilt = unbuilt('src/utils/task/TaskOutput.ts:24')
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
    if (instance.stdoutToFile) void instance.sampleFileProgress()
    else instance.emitLiveView()
  }
}

function materialiseSegment(segment: string): string {
  return Buffer.from(segment, 'utf8').toString('utf8')
}

export class TaskOutput {
  readonly taskId: string
  readonly path: string
  readonly stdoutToFile: boolean

  onProgress: ProgressCallback | null
  private readonly maxMemoryBytes: number

  private stdoutChunks: string[] = []
  private stdoutLength = 0
  private stderrChunks: string[] = []
  private stderrLength = 0
  private spilled = false
  private diskWriter: DiskTaskOutput | null = null
  readonly recentLines = new CircularBuffer<string>(ROLLING_LINE_CAPACITY)

  lineCount = 0
  byteTotal = 0

  private liveNotice: string | null = null

  private fileRedundant = false
  private fileSize = 0

  constructor(
    taskId: string,
    onProgress: ProgressCallback | null,
    stdoutToFile?: boolean,
    maxMemoryBytes?: number,
  ) {
    notBuilt('src/utils/task/TaskOutput.ts:73')
  }

  static startPolling(taskId: string): void {
    return notBuilt('src/utils/task/TaskOutput.ts:89')
  }

  static stopPolling(taskId: string): void {
    activePolling.delete(taskId)
    if (activePolling.size === 0 && pollTimer !== null) {
      stopInterval(pollTimer)
      pollTimer = null
    }
  }

  hasProgressCallback(): boolean {
    return this.onProgress !== null
  }

  setLiveNotice(notice: string | null): void {
    this.liveNotice = notice
  }

  private viewOf(count: number): string {
    const lines = this.joinRecent(count)
    if (this.liveNotice === null) return lines
    return lines === '' ? this.liveNotice : `${this.liveNotice}\n${lines}`
  }

  private linesSoFar(): number {
    return this.atLineStart ? this.lineCount : this.lineCount + 1
  }

  emitLiveView(): void {
    this.onProgress?.(
      this.viewOf(RECENT_VIEW_LINES),
      this.viewOf(FULL_VIEW_LINES),
      this.linesSoFar(),
      this.byteTotal,
      this.spilled,
    )
  }

  sampleFileProgress(): Promise<void> { return sampleFileProgressOf.call(this) }

  writeStdout(data: string): void {
    return notBuilt('src/utils/task/TaskOutput.ts:137')
  }

  writeStderr(data: string): void {
    return notBuilt('src/utils/task/TaskOutput.ts:141')
  }

  private write(data: string, isStderr: boolean): void {
    this.byteTotal += data.length
    const harvestedAny = this.harvest(data)
    if (harvestedAny && this.onProgress) {
      this.onProgress(
        this.viewOf(RECENT_VIEW_LINES),
        this.viewOf(FULL_VIEW_LINES),
        this.linesSoFar(),
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
    if (this.diskWriter) this.writeToDisk(data, isStderr)
    if (isStderr) {
      this.stderrChunks.push(data)
      this.stderrLength += data.length
    } else {
      this.stdoutChunks.push(data)
      this.stdoutLength += data.length
    }
  }

  atLineStart = true

  private harvest(chunk: string): boolean { return harvestOf.call(this, chunk) }

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

  mirrorToDisk(): void {
    if (this.stdoutToFile || this.diskWriter) return
    this.diskWriter = acquireTaskOutputWriter(this.taskId)
    const bufferedStdout = this.stdoutChunks.join('')
    if (bufferedStdout.length > 0) this.diskWriter.append(bufferedStdout)
    const bufferedStderr = this.stderrChunks.join('')
    if (bufferedStderr.length > 0) this.diskWriter.append(`[stderr] ${bufferedStderr}`)
  }

  private spillBuffers(triggerChunk: string | undefined, triggerIsStderr: boolean): void {
    this.mirrorToDisk()
    if (triggerChunk !== undefined) this.writeToDisk(triggerChunk, triggerIsStderr)
    this.stdoutChunks = []
    this.stdoutLength = 0
    this.stderrChunks = []
    this.stderrLength = 0
    this.spilled = true
  }

  private async headAndTailExcerpt(head: { content: string; bytesRead: number; bytesTotal: number }, maxLength: number): Promise<string> {
    return notBuilt('src/utils/task/TaskOutput.ts:211')
  }

  async getStdout(): Promise<string> {
    return notBuilt('src/utils/task/TaskOutput.ts:229')
  }

  async getStdoutForDecision(maxBytes?: number): Promise<string> {
    return notBuilt('src/utils/task/TaskOutput.ts:261')
  }

  getStderr(): string {
    return notBuilt('src/utils/task/TaskOutput.ts:274')
  }

  get isOverflowed(): boolean {
    return notBuilt('src/utils/task/TaskOutput.ts:278')
  }

  get totalLines(): number {
    return notBuilt('src/utils/task/TaskOutput.ts:282')
  }

  get totalBytes(): number {
    return notBuilt('src/utils/task/TaskOutput.ts:286')
  }

  get outputFileRedundant(): boolean {
    return notBuilt('src/utils/task/TaskOutput.ts:290')
  }

  get outputFileSize(): number {
    return notBuilt('src/utils/task/TaskOutput.ts:294')
  }

  async flush(): Promise<void> {
    return notBuilt('src/utils/task/TaskOutput.ts:298')
  }

  async deleteOutputFile(): Promise<void> {
    return notBuilt('src/utils/task/TaskOutput.ts:302')
  }

  clear(): void {
    this.stdoutChunks = []
    this.stdoutLength = 0
    this.stderrChunks = []
    this.stderrLength = 0
    this.recentLines.clear()
    this.liveNotice = null
    this.onProgress = null
    this.diskWriter?.cancel()
    TaskOutput.stopPolling(this.taskId)
    pollRegistry.delete(this.taskId)
  }
}

async function sampleFileProgressOf(this: TaskOutput): Promise<void> {
  let sample: { content: string; bytesRead: number; bytesTotal: number }
  try {
    sample = await tailFile(this.path, POLL_SAMPLE_BYTES)
  } catch (error) {
    passedOver(error)
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
  let newlines = 0
  let recentBoundary = 0
  let fullBoundary = 0
  while (cursor > 0) {
    const newline = content.lastIndexOf('\n', cursor - 1)
    count++
    if (newline !== -1) newlines++
    if (count === RECENT_VIEW_LINES) recentBoundary = newline <= 0 ? 0 : newline + 1
    if (count === FULL_VIEW_LINES) fullBoundary = newline <= 0 ? 0 : newline + 1
    cursor = newline
  }

  const lines = content.endsWith('\n') ? newlines : newlines + 1
  const sampledWholeFile = sample.bytesRead === sample.bytesTotal
  const totalLines = sampledWholeFile
    ? lines
    : Math.max(Math.round(lines * (sample.bytesTotal / sample.bytesRead)), this.lineCount)
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

function harvestOf(this: TaskOutput, chunk: string): boolean {
  return notBuilt('src/utils/task/TaskOutput.ts:371')
}
