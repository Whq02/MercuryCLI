import { constants as fsConstants, existsSync, readFileSync, statSync } from 'node:fs'
import { writeFile } from 'node:fs/promises'
import { getFsImplementation } from '../../platform/files/fsOperations.js'
import { runtimeKernel } from '../../engine/runtime-kernel/runtimeKernel.js'
import type { ParamsOf, ResultOf } from '../../daemon/runner-wire/methods.js'
import { PeerDeadline } from '../../daemon/runner-wire/peer.js'
import type { ReadFileRangeResult } from '../../platform/files/readFileInRange.js'
import type { LineEndingType } from '../../platform/files/syncFileRead.js'
import { detectLineEndingsForString } from '../../platform/files/syncFileRead.js'
import { writeTextContent } from '../../platform/files/file.js'
import { TaskOutput } from '../../engine/task-framework/taskOutput.js'
import { generateTaskId } from '../../engine/tasks/taskBase.js'
import { createAbortedCommand, createFailedCommand, type ExecResult, type ShellCommand } from '../../platform/shell/shellProcess.js'
import { pollUntil } from '../../platform/async/deadline.js'
import type { ProcessTreeKillReceipt } from '../../platform/processes/processGroup.js'
import { getTaskOutputDir } from '../../engine/task-framework/diskOutput.js'
import { passedOver } from '../../platform/errors/passedOver.js'
import { startTimeout, stopTimeout } from '../../platform/async/timers.js'

interface IdeToolCapabilities {
  readTextFile: boolean
  writeTextFile: boolean
  terminal: boolean
}

interface IdeToolDoor {
  capabilities(): IdeToolCapabilities
  readTextFile(params: ParamsOf<'fs/read_text_file'>, signal?: AbortSignal): Promise<ResultOf<'fs/read_text_file'>>
  writeTextFile(params: ParamsOf<'fs/write_text_file'>, signal?: AbortSignal): Promise<ResultOf<'fs/write_text_file'>>
  terminalCreate(params: ParamsOf<'terminal/create'>, signal?: AbortSignal): Promise<ResultOf<'terminal/create'>>
  terminalOutput(params: ParamsOf<'terminal/output'>, signal?: AbortSignal): Promise<ResultOf<'terminal/output'>>
  terminalWaitForExit(params: ParamsOf<'terminal/wait_for_exit'>, signal?: AbortSignal): Promise<ResultOf<'terminal/wait_for_exit'>>
  terminalKill(params: ParamsOf<'terminal/kill'>, signal?: AbortSignal): Promise<ResultOf<'terminal/kill'>>
  terminalRelease(params: ParamsOf<'terminal/release'>, signal?: AbortSignal): Promise<ResultOf<'terminal/release'>>
}

export class IdeTerminalUnavailableError extends Error {}

const IDE_TERMINAL_OUTPUT_BYTES = 8 * 1024 * 1024

let activeDoor: IdeToolDoor | null = null
const virtualGenerations = new Map<string, { generation: string; mtimeMs: number; digest: string }>()

export function registerIdeToolDoor(door: IdeToolDoor | null): void {
  activeDoor = door
  editorShellAsked = null
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

function digestOfText(text: string): string {
  return runtimeKernel().hash.sha256Hex(Buffer.from(text, 'utf8'))
}

function generationForContent(content: string, digest: string, mtimeMs: number): string {
  return `m${Math.floor(mtimeMs)}:${Buffer.byteLength(content, 'utf8')}:${digest.slice(0, 12)}`
}

function recordIdeBufferGeneration(resolvedPath: string, content: string): { generation: string; mtimeMs: number } {
  let mtimeMs = Date.now()
  try {
    mtimeMs = statSync(resolvedPath).mtimeMs
  } catch {
    mtimeMs = Date.now()
  }
  const digest = digestOfText(content)
  const generation = generationForContent(content, digest, mtimeMs)
  virtualGenerations.set(resolvedPath, { generation, mtimeMs, digest })
  return { generation, mtimeMs }
}

export function ideFileGeneration(resolvedPath: string): string | null {
  const entry = virtualGenerations.get(resolvedPath)
  if (!entry) return null
  if (existsSync(resolvedPath)) {
    try {
      const disk = readFileSync(resolvedPath, 'utf8')
      const diskDigest = digestOfText(disk)
      if (diskDigest === entry.digest) {
        const st = statSync(resolvedPath)
        return `m${Math.floor(st.mtimeMs)}:${st.size}:${diskDigest.slice(0, 12)}`
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
    const { FileTooLargeError } = await import('../../platform/files/readFileInRange.js')
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

interface IdeWriteOutcome {
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

async function settleCapturedOutput(text: string): Promise<Pick<ExecResult, 'stdout' | 'outputFilePath' | 'outputFileSize' | 'outputTaskId'>> {
  try {
    const outputTaskId = generateTaskId('local_bash')
    const output = new TaskOutput(outputTaskId, null, true)
    await getFsImplementation().mkdir(getTaskOutputDir())
    const noFollow = typeof fsConstants.O_NOFOLLOW === 'number' ? fsConstants.O_NOFOLLOW : 0
    await writeFile(output.path, text, { flag: fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_TRUNC | noFollow })
    const stdout = await output.getStdout()
    if (output.outputFileRedundant) {
      await output.deleteOutputFile()
      return { stdout }
    }
    return { stdout, outputFilePath: output.path, outputFileSize: output.outputFileSize, outputTaskId }
  } catch {
    return { stdout: text }
  }
}

type EditorTerminalShell = {
  file: string
  args: string[]
  argsFor: (line: string) => string[]
  env: NodeJS.ProcessEnv
  scrubbed: readonly string[]
  leftBehind: readonly string[]
}

const EDITOR_SHELL_PROBE_MS = 10_000
const EDITOR_OUTPUT_POLL_MS = 100
const EDITOR_OUTPUT_QUIET_MS = 1_000
const EDITOR_OUTPUT_BOUND_MS = 3_000

async function outputAfterExit(door: IdeToolDoor, terminalId: string, wait: boolean, signal?: AbortSignal): Promise<{ output: string; notes: string[] }> {
  let snap = await door.terminalOutput({ terminal_id: terminalId }, signal)
  let changed = Date.now()
  if (wait && snap.exit_status == null) {
    let first = true
    await pollUntil(
      async () => {
        if (first) {
          first = false
          return undefined
        }
        const next = await door.terminalOutput({ terminal_id: terminalId }, signal)
        if (next.output !== snap.output) changed = Date.now()
        snap = next
        if (snap.exit_status != null || Date.now() - changed >= EDITOR_OUTPUT_QUIET_MS) return true
        return undefined
      },
      EDITOR_OUTPUT_POLL_MS,
      EDITOR_OUTPUT_BOUND_MS,
      () => false,
      { signal },
    )
  }
  const notes: string[] = []
  if (wait && snap.exit_status == null && Date.now() - changed < EDITOR_OUTPUT_QUIET_MS) {
    notes.push(`The editor's terminal was still printing ${EDITOR_OUTPUT_BOUND_MS / 1000} s after the command ended, so the end of its output may be missing here.`)
  }
  if (snap.truncated) notes.push("The editor's terminal kept only the end of this output: it reports the output as truncated.")
  return { output: snap.output, notes }
}

let editorShellAsked: { refusal: Promise<string | null>; said: boolean } | null = null

async function editorShellRefusal(
  door: IdeToolDoor,
  shell: EditorTerminalShell,
  env: Array<{ name: string; value: string }>,
  cwd: string,
  abortSignal: AbortSignal,
): Promise<string | null> {
  const word = `mercury-shell-${Math.random().toString(16).slice(2, 14)}`
  const bound = AbortSignal.any([abortSignal, AbortSignal.timeout(EDITOR_SHELL_PROBE_MS)])
  let terminalId: string
  try {
    const created = await door.terminalCreate(
      { command: shell.file, args: shell.argsFor(`printf '%s\\n' ${word}`), cwd, env, output_byte_limit: 4096 },
      bound,
    )
    terminalId = created.terminal_id
  } catch (error) {
    return error instanceof Error ? error.message : String(error)
  }
  let refusal: string | null
  try {
    await door.terminalWaitForExit({ terminal_id: terminalId }, bound)
    let said = (await door.terminalOutput({ terminal_id: terminalId }, bound)).output
    if (!said.includes(word)) said = (await outputAfterExit(door, terminalId, true, bound)).output
    refusal = said.includes(word) ? null : `asked to start ${shell.file} on one line, it did not print what that line prints`
  } catch (error) {
    refusal = `asked to start ${shell.file} on one line, it did not answer within ${EDITOR_SHELL_PROBE_MS / 1000} s: ${error instanceof Error ? error.message : String(error)}`
    try {
      await door.terminalKill({ terminal_id: terminalId })
    } catch (killError) {
      refusal = `${refusal}; ending that terminal failed too: ${killError instanceof Error ? killError.message : String(killError)}`
    }
  }
  try {
    await door.terminalRelease({ terminal_id: terminalId })
  } catch (releaseError) {
    if (refusal !== null) refusal = `${refusal}; releasing that terminal failed too: ${releaseError instanceof Error ? releaseError.message : String(releaseError)}`
  }
  return refusal
}

export async function execViaIdeTerminal(
  abortSignal: AbortSignal,
  options: {
    cwd: string
    timeout: number
    shell: EditorTerminalShell
    shouldAutoBackground?: boolean
    onProgress?: (recent: string, all: string, lines: number, bytes: number, incomplete: boolean) => void
  },
): Promise<ShellCommand | null> {
  if (!ideTerminalAvailable() || activeDoor === null) return null
  const door = activeDoor
  if (abortSignal.aborted) return createAbortedCommand()
  const shell = options.shell

  const envList: Array<{ name: string; value: string }> = []
  for (const [k, v] of Object.entries(shell.env)) {
    if (typeof v === 'string') envList.push({ name: k, value: v })
  }

  editorShellAsked ??= { refusal: editorShellRefusal(door, shell, envList, options.cwd, abortSignal), said: false }
  const asked = editorShellAsked
  const refusal = await asked.refusal
  if (abortSignal.aborted) {
    if (refusal !== null && !asked.said && editorShellAsked === asked) editorShellAsked = null
    return createAbortedCommand()
  }
  if (refusal !== null) {
    if (asked.said) return null
    asked.said = true
    throw new IdeTerminalUnavailableError(`The editor's terminal could not start Mercury's shell (${refusal}); this command ran in the local shell, and so will the rest of this session's.`)
  }

  let terminalId: string
  try {
    const created = await door.terminalCreate(
      {
        command: shell.file,
        args: shell.args,
        cwd: options.cwd,
        env: envList,
        output_byte_limit: IDE_TERMINAL_OUTPUT_BYTES,
      },
      abortSignal,
    )
    terminalId = created.terminal_id
  } catch (error) {
    if (abortSignal.aborted) return createAbortedCommand()
    if (error instanceof PeerDeadline) {
      return createFailedCommand(`The editor did not answer the request for a terminal within ${Math.round(error.deadlineMs / 1000)} s, so this command may be running in the editor's terminal; it was not run again in the local shell. Look at the editor's terminal before you run it again.`)
    }
    throw new IdeTerminalUnavailableError(`The editor could not open a terminal (${error instanceof Error ? error.message : String(error)}); this command ran in the local shell.`)
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
      await door.terminalRelease({ terminal_id: terminalId })
    } catch {
      released = true
    }
  }

  const killTerminal = async (): Promise<ProcessTreeKillReceipt> => {
    if (status === 'completed' || status === 'killed') {
      return { ended: 0, survivors: [] }
    }
    status = 'killed'
    killedByUs = true
    try {
      await door.terminalKill({ terminal_id: terminalId })
    } catch {
      killedByUs = true
    }
    await releaseOnce()
    return { ended: 1, survivors: [] }
  }

  const onAbort = (): void => {
    void killTerminal()
  }
  abortSignal.addEventListener('abort', onAbort, { once: true })

  let timeoutTimer: NodeJS.Timeout | undefined = startTimeout(() => {
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

  const pollAbort = new AbortController()
  let firstPoll = true
  void pollUntil(
    async () => {
      if (status !== 'running' && status !== 'backgrounded') return true
      if (firstPoll) {
        firstPoll = false
        return undefined
      }
      try {
        const snap = await door.terminalOutput({ terminal_id: terminalId })
        if (!pollAbort.signal.aborted && snap.output.length > lastOutput.length) {
          const delta = snap.output.slice(lastOutput.length)
          lastOutput = snap.output
          taskOutput.writeStdout(delta)
        }
      } catch (error) {
        passedOver(error)
      }
      return undefined
    },
    150,
    Infinity,
    () => false,
    { signal: pollAbort.signal, onAbort: () => false, unref: true },
  )

  const resultPromise: Promise<ExecResult> = (async () => {
    try {
      const exit = await door.terminalWaitForExit({ terminal_id: terminalId }, abortSignal)
      if (timeoutTimer !== undefined) stopTimeout(timeoutTimer)
      pollAbort.abort()
      let finalSnap = lastOutput
      let notes: string[] = []
      try {
        const snap = await outputAfterExit(door, terminalId, !killedByUs)
        if (snap.output.length > lastOutput.length) {
          taskOutput.writeStdout(snap.output.slice(lastOutput.length))
        }
        finalSnap = snap.output
        notes = snap.notes
      } catch {
        finalSnap = lastOutput
      }
      await releaseOnce()
      await taskOutput.flush()
      if (status === 'running' || status === 'backgrounded') status = 'completed'
      const code = typeof exit.exit_code === 'number' ? exit.exit_code : killedByUs ? 137 : 1
      const stderr = [...(killedByTimeout ? [`Command timed out after ${Math.round(options.timeout / 1000)}s`] : []), ...notes].join('\n')
      return {
        ...(backgroundTaskId === undefined ? await settleCapturedOutput(finalSnap) : { stdout: finalSnap }),
        stderr,
        code,
        interrupted: killedByUs && !killedByTimeout,
        ...(backgroundTaskId !== undefined ? { backgroundTaskId } : {}),
      }
    } catch (error) {
      if (timeoutTimer !== undefined) stopTimeout(timeoutTimer)
      pollAbort.abort()
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
      void Promise.allSettled(shell.leftBehind.map(path => getFsImplementation().unlink(path)))
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
      if (timeoutTimer !== undefined) stopTimeout(timeoutTimer)
      pollAbort.abort()
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
    scrubbedSessionEnv: shell.scrubbed,
  }
  return handle
}
