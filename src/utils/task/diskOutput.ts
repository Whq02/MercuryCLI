import * as fs from 'node:fs'
import { join } from 'node:path'

import { readFileRange, tailFile } from '../fsOperations.js'
import { getErrnoCode } from '../errors.js'
import { logError } from '../log.js'
import { getPlatform } from '../platform.js'
import { getProjectTempDir } from '../permissions/filesystem.js'
import { getSessionId } from '../../bootstrap/state.js'


export const TASK_OUTPUT_RETRY_DELAY_MS = 50

export const MAX_TASK_OUTPUT_BYTES = 5 * 1024 * 1024 * 1024
export const MAX_TASK_OUTPUT_BYTES_DISPLAY = '5GB'

const DEFAULT_READ_BUDGET_BYTES = 8 * 1024 * 1024

let memoizedTasksDir: string | undefined

export function getTaskOutputDir(): string {
  if (memoizedTasksDir === undefined) {
    memoizedTasksDir = join(getProjectTempDir(), getSessionId(), 'tasks')
  }
  return memoizedTasksDir
}

export function getTaskOutputPath(taskId: string): string {
  return join(getTaskOutputDir(), `${taskId}.output`)
}

function ensureTasksDir(): Promise<void> {
  return fs.promises.mkdir(getTaskOutputDir(), { recursive: true }).then(() => {})
}

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
    if (getErrnoCode(error) === 'EEXIST') {
      logError(new Error(`task id collision: an output file already exists at ${path}`))
    }
    throw error
  }
  await handle.close()
  return path
}

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
      await fs.promises.unlink(path)
      await fs.promises.symlink(targetPath, path)
    }
    return path
  } catch (error) {
    logError(error)
    return initTaskOutput(taskId)
  }
}

export function initTaskOutputAsSymlink(taskId: string, targetPath: string): Promise<string> {
  return track(createTaskOutputSymlink(taskId, targetPath))
}

export class DiskTaskOutput {
  private readonly path: string
  private queue: string[] = []
  private draining = false
  private capped = false
  private totalLength = 0
  private flushPromise: Promise<void> = Promise.resolve()
  private lostChars = 0
  private lastWriteError: string | undefined

  constructor(taskId: string) {
    this.path = getTaskOutputPath(taskId)
  }

  pendingChars(): number {
    return this.queue.reduce((sum, chunk) => sum + chunk.length, 0)
  }

  append(content: string): void {
    if (this.capped) return
    if (this.totalLength + content.length > MAX_TASK_OUTPUT_BYTES) {
      this.capped = true
      this.queue.push(`\n<task output truncated: the ${MAX_TASK_OUTPUT_BYTES_DISPLAY} disk limit was exceeded>\n`)
      this.startDrain()
      return
    }
    this.totalLength += content.length
    this.queue.push(content)
    this.startDrain()
  }

  flush(): Promise<void> {
    return this.draining ? this.flushPromise : Promise.resolve()
  }

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
      logError(error)
      if (this.queue.length > 0) {
        await new Promise(r => setTimeout(r, TASK_OUTPUT_RETRY_DELAY_MS))
        try {
          await this.drainCycle()
        } catch (retryError) {
          logError(retryError)
          for (const chunk of this.queue) this.lostChars += chunk.length
          this.queue.length = 0
          this.lastWriteError = retryError instanceof Error ? retryError.message : String(retryError)
        }
      }
    }
  }

  private async writeLossNoteIfOwed(handle: fs.promises.FileHandle): Promise<void> {
    if (this.lostChars === 0) return
    const note = `\n<${this.lostChars.toLocaleString('en-US')} characters of task output were lost: the output file was unwritable (${this.lastWriteError ?? 'unknown error'})>\n`
    await handle.write(Buffer.from(note, 'utf8'))
    this.lostChars = 0
    this.lastWriteError = undefined
  }

  private async drainCycle(): Promise<void> {
    await ensureTasksDir()
    while (this.queue.length > 0) {
      const handle = await fs.promises.open(this.path, appendFlags())
      try {
        await this.writeLossNoteIfOwed(handle)
        while (this.queue.length > 0) {
          await handle.write(takeQueuedPayload(this.queue))
        }
      } finally {
        await handle.close()
      }
    }
  }
}

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

export function acquireTaskOutputWriter(taskId: string): DiskTaskOutput {
  let writer = writers.get(taskId)
  if (writer === undefined) {
    writer = new DiskTaskOutput(taskId)
    writers.set(taskId, writer)
  }
  return writer
}

export function evictTaskOutput(taskId: string): Promise<void> {
  const writer = writers.get(taskId)
  if (writer === undefined) return Promise.resolve()
  return track(
    writer.flush().then(() => {
      writers.delete(taskId)
    }),
  )
}

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
