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


type ProgressCallback = (
  recentLines: string,
  allLines: string,
  lineCount: number,
  byteCount: number,
  isIncomplete: boolean,
) => void
const POLL_SAMPLE_BYTES = 4096
const DEFAULT_MAX_MEMORY_BYTES = 8 * 1024 * 1024
const DECISION_TAIL_BYTES = 1024 * 1024
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
    stdoutToFile: boolean = false,
    maxMemoryBytes: number = DEFAULT_MAX_MEMORY_BYTES,
  ) {
    this.taskId = taskId
    this.path = getTaskOutputPath(taskId)
    this.onProgress = onProgress
    this.stdoutToFile = stdoutToFile
    this.maxMemoryBytes = maxMemoryBytes
    if (onProgress !== null) {
      pollRegistry.set(taskId, this)
    }
  }

  static startPolling(taskId: string): void {
    const instance = pollRegistry.get(taskId)
    if (!instance || !instance.hasProgressCallback()) return
    activePolling.add(taskId)
    if (pollTimer === null) {
      pollTimer = startInterval(pollTick, POLL_INTERVAL_MS)
      pollTimer.unref?.()
    }
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

  private async headAndTailExcerpt(
    head: { content: string; bytesRead: number; bytesTotal: number },
    maxLength: number,
  ): Promise<string> {
    const noticeReserve = 160 + this.path.length
    const excerptBudget = Math.max(64, maxLength - noticeReserve)
    const headBudget = Math.floor(excerptBudget * OUTPUT_HEAD_SHARE)
    const tailBudget = excerptBudget - headBudget

    const rawHead = head.content.slice(0, headBudget)
    const lastHeadNewline = rawHead.lastIndexOf('\n')
    const headText =
      lastHeadNewline >= Math.floor(rawHead.length / 2)
        ? rawHead.slice(0, lastHeadNewline)
        : rawHead

    const tailRead = await tailFile(this.path, tailBudget)
    const rawTail = tailRead.content
    const firstTailNewline = rawTail.indexOf('\n')
    const tailText =
      firstTailNewline !== -1 && firstTailNewline < Math.ceil(rawTail.length / 2)
        ? rawTail.slice(firstTailNewline + 1)
        : rawTail

    const omittedBytes = Math.max(
      0,
      head.bytesTotal - Buffer.byteLength(headText, 'utf8') - Buffer.byteLength(tailText, 'utf8'),
    )
    const notice = `\n\n[${omittedBytes} bytes truncated from the middle — the head and the tail of the output are shown; the complete output is saved at ${this.path}]\n\n`
    return `${headText}${notice}${tailText}`
  }

  async getStdout(): Promise<string> {
    if (this.stdoutToFile) {
      const maxLength = getMaxOutputLength()
      try {
        const head = await readFileRange(this.path, 0, maxLength)
        if (head === null) {
          this.fileSize = 0
          this.fileRedundant = true
          return ''
        }
        this.fileSize = head.bytesTotal
        if (head.bytesRead >= head.bytesTotal) {
          this.fileRedundant = true
          return head.content
        }
        this.fileRedundant = false
        return await this.headAndTailExcerpt(head, maxLength)
      } catch (error) {
        const code = getErrnoCode(error)
        if (code === 'ENOENT') {
          this.fileSize = 0
          this.fileRedundant = true
          return ''
        }
        const detail = code ?? (error instanceof Error ? error.message : String(error))
        logForDebugging(`task output read failed: ${this.path} (${detail})`)
        return `<command output unavailable: could not read ${this.path} (${detail}) — most likely another Mercury process working in this project deleted it during its startup cleanup>`
      }
    }
    if (this.spilled) {
      const tail = this.joinRecent(RECENT_VIEW_LINES)
      const totalKb = Math.round(this.byteTotal / 1024)
      const notice = `<output truncated: ~${totalKb}KB captured in total — the complete output is saved at ${this.path}>`
      return tail === '' ? notice : `${tail}\n${notice}`
    }
    return this.stdoutChunks.join('')
  }

  async getStdoutForDecision(maxBytes: number = DECISION_TAIL_BYTES): Promise<string> {
    if (!this.stdoutToFile && this.spilled) {
      await this.flush()
      try {
        return (await tailFile(this.path, maxBytes)).content
      } catch (error) {
        passedOver(error)
        return this.getStdout()
      }
    }
    return this.getStdout()
  }

  getStderr(): string {
    return this.spilled || this.stdoutToFile ? '' : this.stderrChunks.join('')
  }

  get isOverflowed(): boolean {
    return this.spilled
  }

  get totalLines(): number {
    return this.linesSoFar()
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
    if (this.diskWriter) {
      await this.diskWriter.flush()
    }
  }

  async deleteOutputFile(): Promise<void> {
    try {
      await fs.promises.unlink(this.path)
    } catch (error) {
      passedOver(error)
    }
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
  if (chunk.length === 0) return false
  const startedAtLineStart = this.atLineStart
  let newlineCount = 0
  let pos = chunk.indexOf('\n')
  while (pos !== -1) {
    newlineCount++
    pos = chunk.indexOf('\n', pos + 1)
  }
  this.lineCount += newlineCount
  this.atLineStart = chunk.charCodeAt(chunk.length - 1) === 10

  const collected: string[] = []
  let budget = HARVEST_BUDGET_UNITS
  let end = chunk.length
  while (end > 0 && collected.length < HARVEST_MAX_SEGMENTS && budget > 0) {
    const nl = chunk.lastIndexOf('\n', end - 1)
    const isFirstSegment = nl === -1
    const start = isFirstSegment ? 0 : nl + 1
    if (!isFirstSegment || (startedAtLineStart && newlineCount > 0)) {
      const raw = chunk.slice(start, end)
      if (raw.trim().length > 0) {
        if (raw.length > budget) break
        collected.push(materialiseSegment(raw))
        budget -= raw.length
      }
    }
    end = nl
  }

  if (collected.length === 0) return false
  for (let i = collected.length - 1; i >= 0; i--) {
    this.recentLines.add(collected[i]!)
  }
  return true
}
