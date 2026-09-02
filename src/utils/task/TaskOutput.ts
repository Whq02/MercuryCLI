import * as fs from 'node:fs'

import { tailFile, readFileRange } from '../fsOperations.js'
import { CircularBuffer } from '../CircularBuffer.js'
import { getErrnoCode } from '../errors.js'
import { logError } from '../log.js'
import { logForDebugging } from '../debug.js'
import { getMaxOutputLength, OUTPUT_HEAD_SHARE } from '../shell/outputLimits.js'
import { safeJoinLines } from '../stringUtils.js'
import { DiskTaskOutput, acquireTaskOutputWriter, getTaskOutputPath } from './diskOutput.js'

/**
 * The single owner of one shell command's stdout/stderr. Two mutually
 * exclusive capture modes, chosen at construction:
 *
 *  - file mode: the child writes both streams straight into the output file
 *    through inherited descriptors — no output byte ever enters the JS
 *    heap — and progress is derived by sampling the file's tail through a
 *    shared poller;
 *  - pipe mode: bytes are pushed through the write entry points, buffered
 *    in memory, and spilled to the per-task disk writer past the ceiling.
 *
 * The write entry points behave identically in both modes; "callers never
 * write in file mode" is a caller convention, not enforced here.
 */

/**
 * Positional contract: most recent 5 lines; most recent 100 lines; running
 * line count; running size; and "the consumer is looking at a partial view
 * of a larger whole" — which means "sampled a fraction of the file" in file
 * mode and "already spilled to disk" in pipe mode.
 */
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

// The poller's backing: every eligible instance, and the actively polled
// subset a single shared timer serves. UI mount/unmount drives the active
// set, so an off-screen task costs nothing.
const pollRegistry = new Map<string, TaskOutput>()
const activePolling = new Set<string>()
let pollTimer: ReturnType<typeof setInterval> | null = null

function pollTick(): void {
  // Never serialise on the I/O: each instance's read is issued and handled
  // independently so one slow read cannot delay or stack the next tick.
  for (const taskId of activePolling) {
    const instance = pollRegistry.get(taskId)
    if (!instance || !instance.hasProgressCallback()) continue
    void instance.sampleFileProgress()
  }
}

/** A standalone string independent of the chunk it was sliced from, so the
 * chunk can be collected while harvested lines are retained. The UTF-8
 * round trip's one observable consequence: an unpaired surrogate becomes a
 * replacement character in the progress view. */
function materialiseSegment(segment: string): string {
  return Buffer.from(segment, 'utf8').toString('utf8')
}

export class TaskOutput {
  readonly taskId: string
  /** Frozen at construction — an instance created before a session-id change must keep reaching its file. */
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

  // Running totals: lines from the newline scans; bytes in UTF-16 code
  // units for pipe mode and real file sizes in file mode.
  private lineCount = 0
  private byteTotal = 0

  // Meaningful only after a successful file-mode standard read.
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

  /** Start the shared 1 s poll for one task. Unknown id or dropped callback ⇒ silent no-op. */
  static startPolling(taskId: string): void {
    const instance = pollRegistry.get(taskId)
    if (!instance || !instance.hasProgressCallback()) return
    activePolling.add(taskId)
    if (pollTimer === null) {
      pollTimer = setInterval(pollTick, POLL_INTERVAL_MS)
      // The shared timer must never keep the process alive.
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

  /** One poll sample: tail the file, count lines backwards, extrapolate, report. */
  async sampleFileProgress(): Promise<void> {
    let sample: { content: string; bytesRead: number; bytesTotal: number }
    try {
      // Raw tail — no omitted-bytes notice may contaminate the sample.
      sample = await tailFile(this.path, POLL_SAMPLE_BYTES)
    } catch {
      // The file may not exist yet.
      return
    }
    // The callback can be dropped during the await.
    const onProgress = this.onProgress
    if (!onProgress) return

    if (sample.content.length === 0) {
      // Still invoked, or a consumer that only wakes on output hangs forever
      // on a silent command. Remembered totals are left untouched here.
      onProgress('', '', this.lineCount, sample.bytesTotal, false)
      return
    }

    // Backward scan. Every step counts — including the final step that
    // finds no newline — so the count is one plus the number of newlines at
    // any position other than the sample's first character. This scan is
    // deliberately different from the pipe-mode harvest scan; do not unify.
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
    // A whole-file sample is exact and may legitimately decrease; a partial
    // sample extrapolates by size ratio and is clamped monotone so varying
    // line lengths never show a shrinking counter.
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
    // Order is observable: the size total first, then progress (so the
    // chunk that triggers the spill still reports a pre-spill fifth
    // argument), then routing.
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

  /**
   * Pipe-mode harvest: scan backwards; when no newline remains, stop
   * immediately without counting — so the total rises by exactly the number
   * of newlines in the chunk, and the LEADING fragment is never harvested.
   * That miss is load-bearing: it is why the decision read exists.
   */
  private harvest(chunk: string): boolean {
    const collected: string[] = []
    let budget = HARVEST_BUDGET_UNITS
    let cursor = chunk.length
    while (cursor > 0) {
      const newline = chunk.lastIndexOf('\n', cursor - 1)
      if (newline === -1) break
      this.lineCount++
      // First step: the trailing fragment; later steps: complete lines.
      // Skipped segments (empty, whitespace-only, over-budget) consume no
      // budget and never stop the scan, so a long line does not suppress
      // the shorter lines before it; the budget is charged untrimmed.
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
    // Oldest-first into the rolling window.
    for (let i = collected.length - 1; i >= 0; i--) {
      this.recentLines.add(collected[i]!)
    }
    return collected.length > 0
  }

  private joinRecent(count: number): string {
    return safeJoinLines(this.recentLines.getRecent(count), '\n')
  }

  private writeToDisk(data: string, isStderr: boolean): void {
    // Stderr segments carry a stream tag so the interleaved file stays
    // readable; no reader parses the literal.
    this.diskWriter?.append(isStderr ? `[stderr] ${data}` : data)
  }

  /** Idempotent public entry — used when a foreground piped command is backgrounded. */
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
    // One-way for the life of the instance.
    this.spilled = true
  }

  /** The over-budget file read: the head (already in hand) and the tail of
   *  the file around one notice that names the cut and the file. Both ends
   *  snap to a line boundary when one sits in their outer half, so neither
   *  opens or closes mid-line (and a multi-byte character split by the byte
   *  range never reaches the model). */
  private async headAndTailExcerpt(head: { content: string; bytesRead: number; bytesTotal: number }, maxLength: number): Promise<string> {
    // The whole excerpt — its own notice included — fits the budget: the
    // head/tail shares once consumed maxLength alone, so every spilled
    // read came back over the cap by the notice's length (the tail-truth
    // prover's §4 red at cap+306 — "fix the
    // bound at the owner, never widen the slack"). The reserve is computed
    // from the known path plus the template and a digits allowance.
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

  /** The read would otherwise build a tool result. */
  async getStdout(): Promise<string> {
    if (this.stdoutToFile) {
      try {
        // The shell output limit is a character budget in its own domain,
        // used here as the byte budget for the range read.
        const maxLength = getMaxOutputLength()
        const result = await readFileRange(this.path, 0, maxLength)
        if (result === null) {
          // A null from offset 0 means the file exists and is empty; the
          // recorded size keeps whatever it had.
          this.fileRedundant = true
          return ''
        }
        this.fileSize = result.bytesTotal
        if (result.bytesRead === result.bytesTotal) {
          this.fileRedundant = true
          return result.content
        }
        // Past the budget: the head AND the tail around one notice, the
        // same law as the in-memory format. This sink returned the first
        // budget of bytes alone, cut mid-line with no notice and no
        // pointer, so a 5,000-line run handed the model its beginning and
        // hid the verdict at its end (TASK-014 w4-f01-01 — the ledger's
        // T4 failing on Windows through the spill path).
        this.fileRedundant = false
        return await this.headAndTailExcerpt(result, maxLength)
      } catch (error) {
        // Returning an empty string here produced an effectively empty tool
        // result that confused context assembly and hid the cause; the
        // marker names the path, the code, and the likely culprit instead.
        const code = getErrnoCode(error) ?? 'unknown'
        logForDebugging(`task output read failed: ${this.path} (${code}): ${String(error)}`)
        return `<command output unavailable: could not read ${this.path} (${code}) — most likely another Mercury process working in this project deleted it during its startup cleanup>`
      }
    }
    if (!this.spilled) {
      return this.stdoutChunks.join('')
    }
    // Spilled pipe mode returns a view, never the content. The size figure
    // is the running UTF-16 total, not the on-disk size — deliberately.
    const tail = this.recentLines.getRecent(RECENT_VIEW_LINES)
    const totalKb = Math.round(this.byteTotal / 1024)
    const notice = `\n<output truncated: ~${totalKb}KB captured in total — the complete output is saved at ${this.path}>`
    if (tail.length === 0) return notice.trimStart()
    return safeJoinLines(tail, '\n') + notice
  }

  /**
   * The async-hook decision read. A JSON decision written as the first line
   * of its chunk is the leading fragment the harvest never keeps, so the
   * standard read's view drops it; the tail of the file does not. The tail
   * comes back alone — no omitted-bytes prefix, no notice — and neither
   * recorded file field is touched.
   */
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

  /** Reports on the spill state, not the capture mode: empty once spilled. */
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

  /** Unlinks the output file; safe to call fire-and-forget. */
  async deleteOutputFile(): Promise<void> {
    try {
      await fs.promises.unlink(this.path)
    } catch {
      // Missing file included: every error is swallowed.
    }
  }

  /**
   * A partial reset by design: buffers, rolling lines, the callback, queued
   * disk content, and the poll registration go; the disk writer reference,
   * the overflow flag, the running totals, the recorded file fields, and
   * everything on disk stay — a later write still routes to disk.
   */
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
