import * as fs from 'node:fs'
import { join } from 'node:path'

import { readFileRange, tailFile } from '../fsOperations.js'
import { getErrnoCode } from '../errors.js'
import { logError } from '../log.js'
import { getPlatform } from '../platform.js'
import { getProjectTempDir } from '../permissions/filesystem.js'
import { getSessionId } from '../../bootstrap/state.js'

/**
 * Where task output lives on disk: session-scoped path naming, queued async
 * appends under a hard disk cap, and bounded readers.
 *
 * Two shape facts are cross-subsystem contract data: the directory segment
 * `tasks` under `<project temp dir>/<session id>/`, and the `.output` file
 * suffix — the file-read result UI and the permission layer's auto-allowed
 * read rule both pattern-match on them.
 */

/** The one retry's pause — durablePublish's first rung, so a transient win32
 *  hold has actually had time to clear before the discard decision. */
export const TASK_OUTPUT_RETRY_DELAY_MS = 50

/** Shared with the shell layer's background size watchdog — the two caps must stay identical. */
export const MAX_TASK_OUTPUT_BYTES = 5 * 1024 * 1024 * 1024
export const MAX_TASK_OUTPUT_BYTES_DISPLAY = '5GB'

const DEFAULT_READ_BUDGET_BYTES = 8 * 1024 * 1024

let memoizedTasksDir: string | undefined

/**
 * Memoized for the process lifetime: the session id regenerates on clear and
 * changes on resume, and a per-call re-derivation would strand every live
 * output owner on the old directory while new opens target the new one.
 * The session id in the path is what stops one Mercury process's startup
 * cleanup from unlinking another's in-flight files.
 */
export function getTaskOutputDir(): string {
  if (memoizedTasksDir === undefined) {
    memoizedTasksDir = join(getProjectTempDir(), getSessionId(), 'tasks')
  }
  return memoizedTasksDir
}

export function getTaskOutputPath(taskId: string): string {
  return join(getTaskOutputDir(), `${taskId}.output`)
}

// The directory appears only on the first create or write, never from a
// path query.
function ensureTasksDir(): Promise<void> {
  return fs.promises.mkdir(getTaskOutputDir(), { recursive: true }).then(() => {})
}

/**
 * Fire-and-forget operations are tracked so their rejections are absorbed
 * (callers do not await these promises) while still rejecting for callers
 * that do. Entries remove themselves on settlement.
 */
const pendingOperations = new Set<Promise<unknown>>()

function track<T>(promise: Promise<T>): Promise<T> {
  const guarded: Promise<unknown> = promise
    .catch(() => {})
    .finally(() => {
      pendingOperations.delete(guarded)
    })
  pendingOperations.add(guarded)
  return promise
}

/**
 * A sandboxed process can plant a symlink in the tasks directory; without
 * symlink refusal the host process would write through it to an arbitrary
 * file. On Windows the string flag form is required — the numeric
 * combination surfaces EINVAL through libuv. Where O_NOFOLLOW does not
 * exist it contributes nothing rather than failing.
 */
function exclusiveCreateFlags(): string | number {
  if (getPlatform() === 'windows') return 'wx'
  return fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | (fs.constants.O_NOFOLLOW ?? 0)
}

function appendFlags(): string | number {
  if (getPlatform() === 'windows') return 'a'
  return fs.constants.O_WRONLY | fs.constants.O_APPEND | fs.constants.O_CREAT | (fs.constants.O_NOFOLLOW ?? 0)
}

async function createTaskOutputFile(taskId: string): Promise<string> {
  const path = getTaskOutputPath(taskId)
  await ensureTasksDir()
  let handle: fs.promises.FileHandle
  try {
    handle = await fs.promises.open(path, exclusiveCreateFlags())
  } catch (error) {
    // Task ids carry no registry uniqueness check and callers do not await
    // this promise, so without this log a collision would be invisible. The
    // diagnostic is in addition to the rejection, never in place of it.
    if (getErrnoCode(error) === 'EEXIST') {
      logError(new Error(`task id collision: an output file already exists at ${path}`))
    }
    throw error
  }
  await handle.close()
  return path
}

/** Rejects on exclusive-create failure; the file is left empty. */
export function initTaskOutput(taskId: string): Promise<string> {
  return track(createTaskOutputFile(taskId))
}

async function createTaskOutputSymlink(taskId: string, targetPath: string): Promise<string> {
  const path = getTaskOutputPath(taskId)
  await ensureTasksDir()
  try {
    try {
      await fs.promises.symlink(targetPath, path)
    } catch {
      // Unconditional: when nothing exists at the path, the unlink's own
      // failure is what reaches the outer handler. A live task id being
      // re-linked (session change re-pointing a preserved agent task) takes
      // this branch deliberately.
      await fs.promises.unlink(path)
      await fs.promises.symlink(targetPath, path)
    }
    return path
  } catch (error) {
    logError(error)
    // Falls back to the plain exclusive create (a second tracked promise).
    return initTaskOutput(taskId)
  }
}

/** The target is never validated — a dangling symlink is a success. */
export function initTaskOutputAsSymlink(taskId: string, targetPath: string): Promise<string> {
  return track(createTaskOutputSymlink(taskId, targetPath))
}

/**
 * A per-task disk writer: synchronous, non-throwing appends into a queue
 * drained by a single loop that owns the file handle.
 */
export class DiskTaskOutput {
  private readonly path: string
  private queue: string[] = []
  private draining = false
  private capped = false
  // UTF-16 code units, not encoded bytes — a deliberate coarse guard that
  // avoids re-scanning every chunk; undercounts non-ASCII by up to ~3x.
  private totalLength = 0
  private flushPromise: Promise<void> = Promise.resolve()
  // The unwritable-file ledger: content a persistently-failing drain had to
  // discard, counted so the file states the loss the moment it heals. The
  // alternative — leaving the queue for a later drain — grows the heap with
  // every byte a producer emits against a broken disk (ENOSPC, a revoked
  // directory), which is a slow OOM wearing a retry's clothes.
  private lostChars = 0
  private lastWriteError: string | undefined

  constructor(taskId: string) {
    this.path = getTaskOutputPath(taskId)
  }

  /** Queued-but-unwritten characters — the prover's memory-bound window. */
  pendingChars(): number {
    return this.queue.reduce((sum, chunk) => sum + chunk.length, 0)
  }

  append(content: string): void {
    if (this.capped) return
    if (this.totalLength + content.length > MAX_TASK_OUTPUT_BYTES) {
      // The triggering content is dropped; the marker's own length is not
      // counted, and the cap is never reset — not even by cancel.
      this.capped = true
      this.queue.push(`\n<task output truncated: the ${MAX_TASK_OUTPUT_BYTES_DISPLAY} disk limit was exceeded>\n`)
      this.startDrain()
      return
    }
    this.totalLength += content.length
    this.queue.push(content)
    this.startDrain()
  }

  /** Resolves when the in-flight drain completes; never rejects, never hangs. */
  flush(): Promise<void> {
    return this.draining ? this.flushPromise : Promise.resolve()
  }

  /** Drops queued-but-unwritten content; written bytes and the capped flag stay. */
  cancel(): void {
    this.queue.length = 0
  }

  private startDrain(): void {
    if (this.draining) return
    this.draining = true
    let resolveFlush!: () => void
    this.flushPromise = new Promise<void>(resolve => {
      resolveFlush = resolve
    })
    void track(
      this.drain().finally(() => {
        this.draining = false
        resolveFlush()
      }),
    )
  }

  private async drain(): Promise<void> {
    try {
      await this.drainCycle()
    } catch (error) {
      // Transient in the field: descriptor exhaustion on busy CI, a
      // pending-delete EPERM on Windows. Retry once when content is still
      // queued (an open failure leaves it queued). The flush promise
      // resolves on every path — an unhandled rejection escape while
      // callers observed an empty file with no error at all.
      logError(error)
      if (this.queue.length > 0) {
        // A retry issued in the SAME tick saw the same pending-delete EPERM /
        // descriptor state and failed the same way — the errno class this
        // module names is the one durablePublish rides out over 50/100/200ms;
        // one bounded pause makes the retry a real test of 'did it clear'
        // (TASK-017 S2, task-output-retry-has-no-delay-then-discards).
        await new Promise(r => setTimeout(r, TASK_OUTPUT_RETRY_DELAY_MS))
        try {
          await this.drainCycle()
        } catch (retryError) {
          logError(retryError)
          // Persistent failure: DISCARD the queue into the loss ledger.
          // Keeping it "for a later drain" retained every byte a producer
          // emitted against an unwritable file — unbounded heap growth. A
          // later successful drain writes the loss note first, so the file
          // itself names what the broken window cost.
          for (const chunk of this.queue) this.lostChars += chunk.length
          this.queue.length = 0
          this.lastWriteError = retryError instanceof Error ? retryError.message : String(retryError)
        }
      }
    }
  }

  /** Write the loss note owed after an unwritable window. The ledger zeroes
   *  only AFTER the write lands — a throw here keeps the debt on the books
   *  for the next healed drain. */
  private async writeLossNoteIfOwed(handle: fs.promises.FileHandle): Promise<void> {
    if (this.lostChars === 0) return
    const note = `\n<${this.lostChars.toLocaleString('en-US')} characters of task output were lost: the output file was unwritable (${this.lastWriteError ?? 'unknown error'})>\n`
    await handle.write(Buffer.from(note, 'utf8'))
    this.lostChars = 0
    this.lastWriteError = undefined
  }

  private async drainCycle(): Promise<void> {
    // The directory is created lazily immediately before any write — a
    // spill may be the first disk touch for a task nothing initialised.
    await ensureTasksDir()
    // Content that arrives while the handle is closing restarts the whole
    // cycle, reopening the file.
    while (this.queue.length > 0) {
      const handle = await fs.promises.open(this.path, appendFlags())
      try {
        await this.writeLossNoteIfOwed(handle)
        while (this.queue.length > 0) {
          // One write per batch: the queue is emptied in place and encoded
          // once, and the payload is never bound to a local that outlives
          // the await — queued chunks must become collectable as soon as
          // their write is issued, or memory grows with total bytes written
          // under a producer that outruns the disk.
          await handle.write(takeQueuedPayload(this.queue))
        }
      } finally {
        await handle.close()
      }
    }
  }
}

/**
 * Splice the queue in place, sum each chunk's UTF-8 byte length, allocate
 * ONE buffer of that size, and write each chunk at its running offset —
 * never an intermediate joined string, which doubles peak transient memory
 * for a large backlog.
 */
function takeQueuedPayload(queue: string[]): Buffer {
  const chunks = queue.splice(0, queue.length)
  let total = 0
  for (const chunk of chunks) total += Buffer.byteLength(chunk, 'utf8')
  const payload = Buffer.allocUnsafe(total)
  let offset = 0
  for (const chunk of chunks) {
    offset += payload.write(chunk, offset, 'utf8')
  }
  return payload
}

const writers = new Map<string, DiskTaskOutput>()

/** Get-or-create the shared per-task writer (the spill target). */
export function acquireTaskOutputWriter(taskId: string): DiskTaskOutput {
  let writer = writers.get(taskId)
  if (writer === undefined) {
    writer = new DiskTaskOutput(taskId)
    writers.set(taskId, writer)
  }
  return writer
}

/**
 * Flush, then drop the writer from the registry. Does not delete the file —
 * the model can still read it afterwards. A missing writer resolves as a
 * no-op.
 */
export function evictTaskOutput(taskId: string): Promise<void> {
  const writer = writers.get(taskId)
  if (writer === undefined) return Promise.resolve()
  return track(
    writer.flush().then(() => {
      writers.delete(taskId)
    }),
  )
}

/**
 * Ranged read from `fromOffset`, at most `maxBytes`; never the whole file.
 * Total functions all three: a missing file is an empty/zero result with no
 * log (discriminated by errno, not a pre-existence check); other errors log
 * and return the empty result. All three address the file by path, so a
 * symlinked task output resolves through the link.
 */
export async function getTaskOutputDelta(
  taskId: string,
  fromOffset: number,
  maxBytes: number = DEFAULT_READ_BUDGET_BYTES,
): Promise<{ content: string; newOffset: number }> {
  try {
    const result = await readFileRange(getTaskOutputPath(taskId), fromOffset, maxBytes)
    if (result === null) return { content: '', newOffset: fromOffset }
    return { content: result.content, newOffset: fromOffset + result.bytesRead }
  } catch (error) {
    if (getErrnoCode(error) === 'ENOENT') return { content: '', newOffset: fromOffset }
    logError(error)
    return { content: '', newOffset: fromOffset }
  }
}

/** The last `maxBytes` of the file, prefixed by an omitted-amount notice when over budget. */
export async function getTaskOutput(taskId: string, maxBytes: number = DEFAULT_READ_BUDGET_BYTES): Promise<string> {
  try {
    const result = await tailFile(getTaskOutputPath(taskId), maxBytes)
    if (result.bytesTotal > result.bytesRead) {
      const omittedKb = Math.round((result.bytesTotal - result.bytesRead) / 1024)
      return `<${omittedKb}KB of earlier output omitted>\n${result.content}`
    }
    return result.content
  } catch (error) {
    if (getErrnoCode(error) === 'ENOENT') return ''
    logError(error)
    return ''
  }
}
