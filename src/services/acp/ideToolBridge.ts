import { existsSync, readFileSync, statSync } from 'node:fs'
import { runtimeKernel } from '../primitives/runtimeKernel.js'
import type { ParamsOf, ResultOf } from '../../runner/wire/methods.js'
import type { ReadFileRangeResult } from '../../utils/readFileInRange.js'
import type { LineEndingType } from '../../utils/fileRead.js'
import { detectLineEndingsForString } from '../../utils/fileRead.js'
import { writeTextContent } from '../../utils/file.js'
import { TaskOutput } from '../../utils/task/TaskOutput.js'
import { generateTaskId } from '../../Task.js'
import { createAbortedCommand, createFailedCommand, type ExecResult, type ShellCommand } from '../../utils/ShellCommand.js'
import type { ProcessTreeKillReceipt } from '../../utils/processGroup.js'
import { MAX_TASK_OUTPUT_BYTES } from '../../utils/task/diskOutput.js'
import { subprocessEnv } from '../../utils/subprocessEnv.js'
import { scrubSessionEnvStamps } from '../../substrate/envStamps.js'

export interface IdeToolCapabilities {
  readTextFile: boolean
  writeTextFile: boolean
  terminal: boolean
}

export interface IdeToolDoor {
  capabilities(): IdeToolCapabilities
  readTextFile(params: ParamsOf<'fs/read_text_file'>, signal?: AbortSignal): Promise<ResultOf<'fs/read_text_file'>>
  writeTextFile(params: ParamsOf<'fs/write_text_file'>, signal?: AbortSignal): Promise<ResultOf<'fs/write_text_file'>>
  terminalCreate(params: ParamsOf<'terminal/create'>, signal?: AbortSignal): Promise<ResultOf<'terminal/create'>>
  terminalOutput(params: ParamsOf<'terminal/output'>, signal?: AbortSignal): Promise<ResultOf<'terminal/output'>>
  terminalWaitForExit(params: ParamsOf<'terminal/wait_for_exit'>, signal?: AbortSignal): Promise<ResultOf<'terminal/wait_for_exit'>>
  terminalKill(params: ParamsOf<'terminal/kill'>, signal?: AbortSignal): Promise<ResultOf<'terminal/kill'>>
  terminalRelease(params: ParamsOf<'terminal/release'>, signal?: AbortSignal): Promise<ResultOf<'terminal/release'>>
}

let activeDoor: IdeToolDoor | null = null
const virtualGenerations = new Map<string, { generation: string; mtimeMs: number; content: string }>()

export function registerIdeToolDoor(door: IdeToolDoor | null): void {
  activeDoor = door
  if (door === null) virtualGenerations.clear()
}

export function ideReadTextAvailable(): boolean {
  return activeDoor !== null && activeDoor.capabilities().readTextFile
}

export function ideWriteTextAvailable(): boolean {
  return activeDoor !== null && activeDoor.capabilities().writeTextFile
}

export function ideTerminalAvailable(): boolean {
  return activeDoor !== null && activeDoor.capabilities().terminal
}

function generationForContent(content: string, mtimeMs: number): string {
  const bytes = Buffer.from(content, 'utf8')
  const digest = runtimeKernel().hash.sha256Hex(bytes).slice(0, 12)
  return `m${Math.floor(mtimeMs)}:${bytes.byteLength}:${digest}`
}

function recordIdeBufferGeneration(resolvedPath: string, content: string): { generation: string; mtimeMs: number } {
  let mtimeMs = Date.now()
  try {
    mtimeMs = statSync(resolvedPath).mtimeMs
  } catch {
    mtimeMs = Date.now()
  }
  const generation = generationForContent(content, mtimeMs)
  virtualGenerations.set(resolvedPath, { generation, mtimeMs, content })
  return { generation, mtimeMs }
}

export function ideFileGeneration(resolvedPath: string): string | null {
  const entry = virtualGenerations.get(resolvedPath)
  if (!entry) return null
  if (existsSync(resolvedPath)) {
    try {
      const disk = readFileSync(resolvedPath, 'utf8')
      if (disk === entry.content) {
        const st = statSync(resolvedPath)
        const digest = runtimeKernel().hash.sha256Hex(Buffer.from(disk, 'utf8')).slice(0, 12)
        return `m${Math.floor(st.mtimeMs)}:${st.size}:${digest}`
      }
    } catch {
      return entry.generation
    }
  }
  return entry.generation
}

const MAX_IDE_READ_BYTES = 10 * 1024 * 1024

function stripBom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text
}

function normalizeLine(line: string): string {
  return line.endsWith('\r') ? line.slice(0, -1) : line
}

function makeEnoent(resolvedPath: string): NodeJS.ErrnoException {
  return Object.assign(new Error(`ENOENT: no such file or directory, open '${resolvedPath}'`), { code: 'ENOENT' })
}

export async function readWholeTextViaIde(
  resolvedPath: string,
  signal?: AbortSignal,
): Promise<{ content: string; rawContent: string; encoding: BufferEncoding; lineEndings: LineEndingType; losslessDecode: boolean; mtimeMs: number } | null> {
  if (!ideReadTextAvailable() || activeDoor === null) return null
  let res: ResultOf<'fs/read_text_file'>
  try {
    res = await activeDoor.readTextFile({ path: resolvedPath }, signal)
  } catch (err) {
    if (!existsSync(resolvedPath)) throw makeEnoent(resolvedPath)
    throw err
  }
  const rawContent = res.content
  if (Buffer.byteLength(rawContent, 'utf8') > MAX_IDE_READ_BYTES) {
    throw new Error(`Editor buffer for ${resolvedPath} exceeds ${MAX_IDE_READ_BYTES} bytes.`)
  }
  const content = rawContent.replace(/\r\n/g, '\n')
  const lineEndings = detectLineEndingsForString(rawContent.slice(0, 4096))
  const { mtimeMs } = recordIdeBufferGeneration(resolvedPath, content)
  return {
    content,
    rawContent,
    encoding: 'utf8',
    lineEndings,
    losslessDecode: true,
    mtimeMs,
  }
}

export async function readRangeViaIde(
  resolvedPath: string,
  offset: number = 0,
  maxLines?: number,
  maxBytes?: number,
  signal?: AbortSignal,
): Promise<ReadFileRangeResult | null> {
  if (!ideReadTextAvailable() || activeDoor === null) return null
  let res: ResultOf<'fs/read_text_file'>
  try {
    res = await activeDoor.readTextFile({ path: resolvedPath }, signal)
  } catch (err) {
    if (!existsSync(resolvedPath)) throw makeEnoent(resolvedPath)
    throw err
  }
  const raw = res.content
  const totalBytes = Buffer.byteLength(raw, 'utf8')
  if (maxBytes !== undefined && totalBytes > maxBytes) {
    const { FileTooLargeError } = await import('../../utils/readFileInRange.js')
    const lineCount = stripBom(raw).split('\n').length
    throw new FileTooLargeError(totalBytes, maxBytes, lineCount)
  }
  const normalized = stripBom(raw).replace(/\r\n/g, '\n')
  const { mtimeMs } = recordIdeBufferGeneration(resolvedPath, raw.replace(/\r\n/g, '\n'))
  const lines = stripBom(raw).split('\n')
  const totalLines = lines.length
  const end = maxLines === undefined ? totalLines : Math.min(offset + maxLines, totalLines)
  const selected = lines.slice(offset, Math.max(end, offset)).map(normalizeLine)
  const content = selected.join('\n')
  return {
    content,
    lineCount: selected.length,
    totalLines,
    totalBytes,
    readBytes: Buffer.byteLength(content, 'utf8'),
    mtimeMs,
    endsWithNewline: normalized.endsWith('\n'),
  }
}

export interface IdeWriteOutcome {
  finalContent: string
  diverged: boolean
  mtimeMs: number
  generation: string
}

export async function writeTextViaIdeWithReadBack(
  resolvedPath: string,
  content: string,
  encoding: BufferEncoding,
  keepBom: boolean,
  signal?: AbortSignal,
): Promise<IdeWriteOutcome | null> {
  if (!ideWriteTextAvailable() || activeDoor === null) return null
  const door = activeDoor
  const payload = keepBom && content.charCodeAt(0) !== 0xfeff ? `\uFEFF${content}` : content
  await door.writeTextFile({ path: resolvedPath, content: payload }, signal)
  const normalizedWritten = content.replaceAll('\r\n', '\n')
  let finalContent = normalizedWritten
  let readBackSucceeded = false
  if (door.capabilities().readTextFile) {
    try {
      const back = await door.readTextFile({ path: resolvedPath }, signal)
      if (Buffer.byteLength(back.content, 'utf8') <= MAX_IDE_READ_BYTES) {
        finalContent = stripBom(back.content).replaceAll('\r\n', '\n')
        readBackSucceeded = true
      }
    } catch {
      readBackSucceeded = false
    }
  }
  if (!readBackSucceeded && existsSync(resolvedPath)) {
    try {
      const disk = readFileSync(resolvedPath, encoding)
      finalContent = stripBom(disk).replaceAll('\r\n', '\n')
    } catch {
      readBackSucceeded = false
    }
  } else if (!existsSync(resolvedPath)) {
    try {
      writeTextContent(resolvedPath, finalContent, encoding, 'LF', { keepBom })
    } catch {
      readBackSucceeded = false
    }
  }
  const diverged = finalContent !== normalizedWritten
  const { generation, mtimeMs } = recordIdeBufferGeneration(resolvedPath, finalContent)
  return { finalContent, diverged, mtimeMs, generation }
}

export async function execViaIdeTerminal(
  command: string,
  abortSignal: AbortSignal,
  options: {
    cwd: string
    timeout: number
    shouldAutoBackground?: boolean
    inheritSessionEnv?: boolean
    onProgress?: (recent: string, all: string, lines: number, bytes: number, incomplete: boolean) => void
  },
): Promise<ShellCommand | null> {
  if (!ideTerminalAvailable() || activeDoor === null) return null
  const door = activeDoor
  if (abortSignal.aborted) return createAbortedCommand()

  const base = options.inheritSessionEnv === true
    ? { env: subprocessEnv(), scrubbed: [] as string[] }
    : scrubSessionEnvStamps(subprocessEnv())

  const envList: Array<{ name: string; value: string }> = []
  for (const [k, v] of Object.entries(base.env)) {
    if (typeof v === 'string') envList.push({ name: k, value: v })
  }

  let terminalId: string
  try {
    const created = await door.terminalCreate(
      {
        command,
        cwd: options.cwd,
        env: envList,
        outputByteLimit: MAX_TASK_OUTPUT_BYTES,
      },
      abortSignal,
    )
    terminalId = created.terminalId
  } catch (error) {
    return createFailedCommand(error instanceof Error ? error.message : String(error))
  }

  const taskId = generateTaskId('local_bash')
  const taskOutput = new TaskOutput(taskId, options.onProgress ?? null, false)
  let status: ShellCommand['status'] = 'running'
  let killedByUs = false
  let killedByTimeout = false
  let timeoutCallback: ((bg: (id: string) => boolean) => void) | undefined
  let backgroundTaskId: string | undefined
  let released = false
  let lastOutput = ''

  const releaseOnce = async (): Promise<void> => {
    if (released) return
    released = true
    try {
      await door.terminalRelease({ terminalId })
    } catch {
      released = true
    }
  }

  const killTerminal = async (): Promise<ProcessTreeKillReceipt> => {
    if (status === 'completed' || status === 'killed') {
      return { killedCount: 0, survivors: [] }
    }
    status = 'killed'
    killedByUs = true
    try {
      await door.terminalKill({ terminalId })
    } catch {
      killedByUs = true
    }
    await releaseOnce()
    return { killedCount: 1, survivors: [] }
  }

  const onAbort = (): void => {
    void killTerminal()
  }
  abortSignal.addEventListener('abort', onAbort, { once: true })

  let timeoutTimer: NodeJS.Timeout | undefined = setTimeout(() => {
    if (status !== 'running') return
    if (options.shouldAutoBackground && timeoutCallback) {
      timeoutCallback((id: string) => {
        if (status !== 'running') return false
        status = 'backgrounded'
        backgroundTaskId = id
        return true
      })
      return
    }
    killedByTimeout = true
    void killTerminal()
  }, options.timeout)
  timeoutTimer.unref?.()

  let pollTimer: NodeJS.Timeout | undefined = setInterval(() => {
    if (status !== 'running' && status !== 'backgrounded') return
    void door
      .terminalOutput({ terminalId })
      .then(snap => {
        if (snap.output.length > lastOutput.length) {
          const delta = snap.output.slice(lastOutput.length)
          lastOutput = snap.output
          taskOutput.writeStdout(delta)
        }
      })
      .catch(() => {})
  }, 150)
  pollTimer.unref?.()

  const resultPromise: Promise<ExecResult> = (async () => {
    try {
      const exit = await door.terminalWaitForExit({ terminalId }, abortSignal)
      if (timeoutTimer !== undefined) clearTimeout(timeoutTimer)
      if (pollTimer !== undefined) clearInterval(pollTimer)
      let finalSnap = lastOutput
      try {
        const snap = await door.terminalOutput({ terminalId })
        if (snap.output.length > lastOutput.length) {
          taskOutput.writeStdout(snap.output.slice(lastOutput.length))
        }
        finalSnap = snap.output
      } catch {
        finalSnap = lastOutput
      }
      await releaseOnce()
      await taskOutput.flush()
      if (status === 'running' || status === 'backgrounded') status = 'completed'
      const code = typeof exit.exitCode === 'number' ? exit.exitCode : killedByUs ? 137 : 1
      const stderr = killedByTimeout ? `Command timed out after ${Math.round(options.timeout / 1000)}s` : ''
      return {
        stdout: finalSnap,
        stderr,
        code,
        interrupted: killedByUs && !killedByTimeout,
        ...(backgroundTaskId !== undefined ? { backgroundTaskId } : {}),
      }
    } catch (error) {
      if (timeoutTimer !== undefined) clearTimeout(timeoutTimer)
      if (pollTimer !== undefined) clearInterval(pollTimer)
      await releaseOnce()
      await taskOutput.flush()
      return {
        stdout: lastOutput,
        stderr: error instanceof Error ? error.message : String(error),
        code: 1,
        interrupted: abortSignal.aborted,
      }
    } finally {
      abortSignal.removeEventListener('abort', onAbort)
    }
  })()

  const handle: ShellCommand = {
    background(id: string): boolean {
      if (status !== 'running') return false
      status = 'backgrounded'
      backgroundTaskId = id
      return true
    },
    result: resultPromise,
    kill(): void {
      handle.treeKillReceipt = killTerminal()
    },
    get status() {
      return status
    },
    cleanup(): void {
      if (timeoutTimer !== undefined) clearTimeout(timeoutTimer)
      if (pollTimer !== undefined) clearInterval(pollTimer)
      taskOutput.clear()
      void releaseOnce()
    },
    ...(options.shouldAutoBackground
      ? {
          onTimeout(cb: (bg: (id: string) => boolean) => void) {
            timeoutCallback = cb
          },
        }
      : {}),
    taskOutput,
    scrubbedSessionEnv: base.scrubbed,
  }
  return handle
}
