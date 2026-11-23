import * as fs from 'node:fs'
import { basename, dirname, join, relative, resolve, sep } from 'node:path'

import { subscribeUiClock } from '../../screen/cockpit/uiClock.js'
import { readFileRange } from '../../platform/files/fsOperations.js'
import { getErrnoCode } from '../../platform/errors/errors.js'
import { logError } from '../../platform/logs/errorLog.js'
import { appendNoFollowFlags, exclusiveCreateNoFollowFlags, symlinksMayRequirePrivilege } from '../../platform/host-os/files.js'
import { rememberedPlatform } from '../../platform/host-os/host.js'
import { getProjectTempDir } from '../../permissions/rules/filesystem.js'
import { getSessionId } from '../../boot/process-state/processState.js'
import { sleep } from '../../platform/async/sleep.js'
import { startTimeout, stopTimeout } from '../../platform/async/timers.js'
import { resolveWatchRoot } from '../../platform/processes/watchRoot.js'
import { passedOver, passedOverAs } from '../../platform/errors/passedOver.js'


export const TASK_OUTPUT_RETRY_DELAY_MS = 50

export const MAX_TASK_OUTPUT_BYTES: number = 5 * 1024 * 1024 * 1024
export const MAX_TASK_OUTPUT_BYTES_DISPLAY: string = '5GB'

const DEFAULT_READ_BUDGET_BYTES: number = 8 * 1024 * 1024

let memoizedTasksDir: { sessionId: string; projectTemp: string; dir: string } | null = null

export function getTaskOutputDir(): string {
  const sessionId = getSessionId()
  const projectTemp = getProjectTempDir()
  if (
    memoizedTasksDir !== null &&
    memoizedTasksDir.sessionId === sessionId &&
    memoizedTasksDir.projectTemp === projectTemp
  ) {
    return memoizedTasksDir.dir
  }
  const dir = join(projectTemp, sessionId, 'tasks')
  memoizedTasksDir = { sessionId, projectTemp, dir }
  return dir
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
    .catch(passedOver)
    .finally(() => {
      pendingOperations.delete(guarded)
    })
  pendingOperations.add(guarded)
  return promise
}

function exclusiveCreateFlags(): string | number {
  return exclusiveCreateNoFollowFlags(rememberedPlatform())
}

function appendFlags(): string | number {
  return appendNoFollowFlags()
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
  notifyTaskOutputPath(path)
  return path
}

function initTaskOutput(taskId: string): Promise<string> {
  return track(createTaskOutputFile(taskId))
}

const outputsAwaitingTranscript = new Map<string, string>()

function transcriptKey(transcriptPath: string): string {
  return resolve(transcriptPath).toLowerCase()
}

async function replaceEmptyOutputWithLink(outputPath: string, transcriptPath: string): Promise<void> {
  try {
    const stub = await fs.promises.lstat(outputPath)
    if (!stub.isFile() || stub.size !== 0) return
    await fs.promises.unlink(outputPath)
    try {
      await fs.promises.link(transcriptPath, outputPath)
    } catch {
      await fs.promises.writeFile(outputPath, '', { flag: 'wx' })
    }
    notifyTaskOutputPath(outputPath)
  } catch (error) {
    passedOver(error)
  }
}

async function linkWhenAwaited(transcriptPath: string): Promise<void> {
  const key = transcriptKey(transcriptPath)
  const outputPath = outputsAwaitingTranscript.get(key)
  if (outputPath === undefined) return
  outputsAwaitingTranscript.delete(key)
  await replaceEmptyOutputWithLink(outputPath, transcriptPath)
}

export function linkTaskOutputToTranscript(transcriptPath: string): void {
  if (outputsAwaitingTranscript.size === 0) return
  void track(linkWhenAwaited(transcriptPath))
}

export async function settleTaskOutputOperations(): Promise<void> {
  while (pendingOperations.size > 0) await Promise.allSettled([...pendingOperations])
}

async function awaitTranscriptFor(outputPath: string, transcriptPath: string): Promise<void> {
  outputsAwaitingTranscript.set(transcriptKey(transcriptPath), outputPath)
  const landed = await fs.promises.access(transcriptPath).then(() => true, passedOverAs(false))
  if (landed) await linkWhenAwaited(transcriptPath)
}

function forgetOutputAwaiting(taskId: string): void {
  if (outputsAwaitingTranscript.size === 0) return
  const outputPath = getTaskOutputPath(taskId)
  for (const [key, awaiting] of outputsAwaitingTranscript) {
    if (awaiting === outputPath) outputsAwaitingTranscript.delete(key)
  }
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
    notifyTaskOutputPath(path)
    return path
  } catch (error) {
    logError(error)
    if (!symlinksMayRequirePrivilege(rememberedPlatform())) return initTaskOutput(taskId)
    const stub = await initTaskOutput(taskId)
    await awaitTranscriptFor(stub, targetPath)
    return stub
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
    if (this.capped || content.length === 0) return
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
    return this.flushPromise
  }

  cancel(): void {
    this.queue = []
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
    } catch (firstError) {
      logError(firstError)
      if (this.queue.length === 0) return
      await sleep(TASK_OUTPUT_RETRY_DELAY_MS, undefined, { unref: true })
      if (this.queue.length === 0) return
      try {
        await this.drainCycle()
      } catch (secondError) {
        logError(secondError)
        this.lostChars += this.pendingChars()
        this.queue = []
        this.lastWriteError = secondError instanceof Error ? secondError.message : String(secondError)
      }
    }
  }

  private async writeLossNoteIfOwed(handle: fs.promises.FileHandle): Promise<void> {
    if (this.lostChars === 0) return
    const note = `\n<${this.lostChars.toLocaleString('en-US')} characters of task output were lost: the output file was unwritable (${this.lastWriteError ?? 'unknown error'})>\n`
    await handle.write(Buffer.from(note, 'utf8'))
    this.lostChars = 0
    this.lastWriteError = undefined
    notifyTaskOutputPath(this.path)
  }

  private async drainCycle(): Promise<void> {
    await ensureTasksDir()
    while (this.queue.length > 0) {
      const handle = await fs.promises.open(this.path, appendFlags())
      try {
        await this.writeLossNoteIfOwed(handle)
        while (this.queue.length > 0) {
          await handle.write(takeQueuedPayload(this.queue))
          notifyTaskOutputPath(this.path)
        }
      } finally {
        await handle.close()
      }
    }
  }
}

function takeQueuedPayload(queue: string[]): Buffer {
  const payload = queue.splice(0, queue.length).join('')
  return Buffer.from(payload, 'utf8')
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
  forgetOutputAwaiting(taskId)
  const writer = writers.get(taskId)
  if (writer === undefined) return Promise.resolve()
  return track(
    writer.flush().finally(() => {
      if (writers.get(taskId) === writer) {
        writers.delete(taskId)
      }
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

const TASK_OUTPUT_COALESCE_MS = 50
const TASK_OUTPUT_FALLBACK_POLL_MS = 200

type OutputWatchEntry = {
  path: string
  listeners: Set<() => void>
  fileWatcher: fs.FSWatcher | null
  dirWatcher: fs.FSWatcher | null
  fallbackStop: (() => void) | null
  coalesceTimer: ReturnType<typeof setTimeout> | null
  dirty: boolean
  closed: boolean
}

const outputWatchers = new Map<string, OutputWatchEntry>()

function closeWatcher(watcher: fs.FSWatcher | null): void {
  if (watcher === null) return
  try {
    watcher.close()
  } catch (error) {
    passedOver(error)
  }
}

function stopFallback(entry: OutputWatchEntry): void {
  if (entry.fallbackStop === null) return
  const stop = entry.fallbackStop
  entry.fallbackStop = null
  stop()
}

function closeTaskOutputEntry(entry: OutputWatchEntry): void {
  closeWatcher(entry.fileWatcher)
  entry.fileWatcher = null
  closeWatcher(entry.dirWatcher)
  entry.dirWatcher = null
  stopFallback(entry)
  if (entry.coalesceTimer !== null) {
    stopTimeout(entry.coalesceTimer)
    entry.coalesceTimer = null
  }
  entry.dirty = false
}

function flushTaskOutputListeners(entry: OutputWatchEntry): void {
  if (entry.closed) return
  for (const listener of [...entry.listeners]) {
    try {
      listener()
    } catch (error) {
      passedOver(error)
    }
  }
}

function emitTaskOutput(entry: OutputWatchEntry): void {
  if (entry.closed) return
  if (entry.coalesceTimer !== null) {
    entry.dirty = true
    return
  }
  flushTaskOutputListeners(entry)
  if (entry.closed) return
  entry.coalesceTimer = startTimeout(() => {
    entry.coalesceTimer = null
    if (!entry.dirty || entry.closed) return
    entry.dirty = false
    emitTaskOutput(entry)
  }, TASK_OUTPUT_COALESCE_MS)
  entry.coalesceTimer.unref?.()
}

function armFallbackClock(entry: OutputWatchEntry): void {
  if (entry.closed || entry.fallbackStop !== null) return
  entry.fallbackStop = subscribeUiClock(TASK_OUTPUT_FALLBACK_POLL_MS, () => {
    if (entry.closed) return
    if (entry.fileWatcher === null && tryArmFileWatcher(entry)) {
      closeWatcher(entry.dirWatcher)
      entry.dirWatcher = null
    }
    emitTaskOutput(entry)
  })
}

function nearestExistingDir(targetPath: string): string | null {
  let current = dirname(targetPath)
  for (;;) {
    if (fs.existsSync(current)) return current
    const parent = dirname(current)
    if (parent === current) return null
    current = parent
  }
}

function tryArmFileWatcher(entry: OutputWatchEntry): boolean {
  if (entry.closed) return false
  if (entry.fileWatcher !== null) return true
  try {
    const watcher = fs.watch(resolveWatchRoot(entry.path), { persistent: false }, event => {
      if (entry.closed) return
      if (event === 'rename') {
        closeWatcher(entry.fileWatcher)
        entry.fileWatcher = null
        armTaskOutputWatcher(entry)
      }
      emitTaskOutput(entry)
    })
    watcher.on('error', () => {
      if (entry.closed) return
      closeWatcher(entry.fileWatcher)
      entry.fileWatcher = null
      armTaskOutputWatcher(entry)
    })
    watcher.unref?.()
    entry.fileWatcher = watcher
    return true
  } catch (error) {
    passedOver(error)
    return false
  }
}

function armTaskOutputWatcher(entry: OutputWatchEntry): void {
  if (entry.closed) return
  if (tryArmFileWatcher(entry)) {
    closeWatcher(entry.dirWatcher)
    entry.dirWatcher = null
    return
  }
  let isDanglingLink = false
  try {
    isDanglingLink = fs.lstatSync(entry.path).isSymbolicLink()
  } catch (error) {
    passedOver(error)
  }
  if (isDanglingLink) {
    armFallbackClock(entry)
    return
  }
  if (entry.dirWatcher !== null) return
  const watchDir = nearestExistingDir(entry.path)
  if (watchDir === null) {
    armFallbackClock(entry)
    return
  }
  const parentDir = dirname(entry.path)
  const fileName = basename(entry.path)
  const nextChild = watchDir === parentDir ? null : relative(watchDir, parentDir).split(sep)[0] ?? null
  try {
    const watcher = fs.watch(resolveWatchRoot(watchDir), { persistent: false }, (_event, changed) => {
      if (entry.closed) return
      if (watchDir === parentDir && changed !== null && String(changed) !== fileName) return
      if (watchDir !== parentDir && changed !== null && nextChild !== null && String(changed) !== nextChild) return
      if (tryArmFileWatcher(entry)) {
        closeWatcher(entry.dirWatcher)
        entry.dirWatcher = null
        emitTaskOutput(entry)
      } else if (watchDir !== parentDir) {
        const deeper = nearestExistingDir(entry.path)
        if (deeper !== null && deeper !== watchDir) {
          closeWatcher(entry.dirWatcher)
          entry.dirWatcher = null
          armTaskOutputWatcher(entry)
        }
      }
    })
    watcher.on('error', () => {
      if (entry.closed) return
      closeWatcher(entry.dirWatcher)
      entry.dirWatcher = null
      armFallbackClock(entry)
    })
    watcher.unref?.()
    entry.dirWatcher = watcher
    if (fs.existsSync(entry.path) && tryArmFileWatcher(entry)) {
      closeWatcher(entry.dirWatcher)
      entry.dirWatcher = null
      emitTaskOutput(entry)
    }
  } catch (error) {
    passedOver(error)
    armFallbackClock(entry)
  }
}

function notifyTaskOutputPath(path: string): void {
  const entry = outputWatchers.get(resolve(path))
  if (entry === undefined) return
  if (entry.fileWatcher === null) armTaskOutputWatcher(entry)
  emitTaskOutput(entry)
}

export function subscribeTaskOutputPath(path: string, listener: () => void): () => void {
  const key = resolve(path)
  let entry = outputWatchers.get(key)
  if (entry === undefined) {
    entry = {
      path: key,
      listeners: new Set(),
      fileWatcher: null,
      dirWatcher: null,
      fallbackStop: null,
      coalesceTimer: null,
      dirty: false,
      closed: false,
    }
    outputWatchers.set(key, entry)
    armTaskOutputWatcher(entry)
    armFallbackClock(entry)
  }
  entry.listeners.add(listener)
  return () => {
    entry.listeners.delete(listener)
    if (entry.listeners.size > 0) return
    entry.closed = true
    closeTaskOutputEntry(entry)
    outputWatchers.delete(key)
  }
}
