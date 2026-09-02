import type { ChildProcess } from 'child_process'
import { stat } from 'node:fs/promises'

import { generateTaskId } from '../Task.js'
import { formatDuration } from './format.js'
import { endProcessTree, type ProcessTreeKillReceipt } from './processGroup.js'
import { MAX_TASK_OUTPUT_BYTES, MAX_TASK_OUTPUT_BYTES_DISPLAY } from './task/diskOutput.js'
import { TaskOutput } from './task/TaskOutput.js'


export const HARD_CAP_MULTIPLIER = 10

const KILL_GRACE_MS = 2000
const SIZE_WATCHDOG_INTERVAL_MS = 5000

export type ExecResult = {
  stdout: string
  stderr: string
  code: number
  interrupted: boolean
  backgroundTaskId?: string
  backgroundedByUser?: boolean
  assistantAutoBackgrounded?: boolean
  outputFilePath?: string
  outputFileSize?: number
  outputTaskId?: string
  preSpawnError?: string
  timeoutAutoBackgroundedAfterMs?: number
}

type OnTimeoutCallback = (backgroundFn: (taskId: string) => boolean) => void

export type ShellCommand = {
  background: (taskId: string) => boolean
  result: Promise<ExecResult>
  kill: () => void
  status: 'running' | 'backgrounded' | 'completed' | 'killed'
  cleanup: () => void
  onTimeout?: (callback: OnTimeoutCallback) => void
  taskOutput: TaskOutput
  treeKillReceipt?: Promise<ProcessTreeKillReceipt>
}

type StreamWrapper = { cleanup: () => void }

function wrapOutputStream(
  stream: NodeJS.ReadableStream,
  sink: (data: string) => void,
): StreamWrapper {
  stream.setEncoding('utf8')
  let target: NodeJS.ReadableStream | null = stream
  let write: ((data: string) => void) | null = sink
  const onData = (chunk: string | Buffer): void => {
    write?.(typeof chunk === 'string' ? chunk : chunk.toString('utf8'))
  }
  stream.on('data', onData)
  return {
    cleanup(): void {
      if (!target) return
      target.off('data', onData)
      target = null
      write = null
    },
  }
}

export function wrapSpawn(
  childProcess: ChildProcess,
  abortSignal: AbortSignal,
  timeout: number,
  taskOutput: TaskOutput,
  shouldAutoBackground: boolean = false,
  maxOutputBytes: number = MAX_TASK_OUTPUT_BYTES,
): ShellCommand {
  let status: ShellCommand['status'] = 'running'
  let child: ChildProcess | null = childProcess
  let signal: AbortSignal | null = abortSignal

  let killedByMercury = false
  let killedByTimeoutPolicy = false
  let killedBySizeWatchdog = false
  let killedByHardCap = false

  let timeoutElapsed = false
  let timeoutFired = false
  let timeoutCallback: OnTimeoutCallback | undefined
  let backgroundTaskId: string | undefined

  let timeoutTimer: NodeJS.Timeout | undefined
  let sizeWatchdogTimer: NodeJS.Timeout | undefined
  let hardCapTimer: NodeJS.Timeout | undefined
  let graceTimer: NodeJS.Timeout | undefined
  let treeKillReceipt: Promise<ProcessTreeKillReceipt> | undefined

  const fileMode = childProcess.stdout == null
  let stdoutWrapper: StreamWrapper | null = null
  let stderrWrapper: StreamWrapper | null = null
  if (!fileMode) {
    if (childProcess.stdout) {
      stdoutWrapper = wrapOutputStream(childProcess.stdout, data => taskOutput.writeStdout(data))
    }
    if (childProcess.stderr) {
      stderrWrapper = wrapOutputStream(childProcess.stderr, data => taskOutput.writeStderr(data))
    }
  }

  let resolveResult!: (result: ExecResult) => void
  const result = new Promise<ExecResult>(resolve => {
    resolveResult = resolve
  })

  let exitCodeSettled = false
  const settleExitCode = (code: number): void => {
    if (exitCodeSettled) return
    exitCodeSettled = true
    void assembleResult(code)
  }

  const deriveExitCode = (code: number | null, exitSignal: NodeJS.Signals | null): number => {
    if (code !== null && code !== undefined) return code
    if (exitSignal === 'SIGTERM') return 144
    if (killedByTimeoutPolicy) return 143
    if (killedByMercury) return 137
    return 1
  }

  const teardownListeners = (): void => {
    if (sizeWatchdogTimer !== undefined) {
      clearInterval(sizeWatchdogTimer)
      sizeWatchdogTimer = undefined
    }
    if (timeoutTimer !== undefined) {
      clearTimeout(timeoutTimer)
      timeoutTimer = undefined
    }
    if (hardCapTimer !== undefined) {
      clearTimeout(hardCapTimer)
      hardCapTimer = undefined
    }
    if (signal) {
      signal.removeEventListener('abort', onAbort)
    }
  }

  const kill = (): void => {
    status = 'killed'
    killedByMercury = true
    const fallbackCode = killedByTimeoutPolicy ? 143 : 137
    if (!child?.pid) {
      settleExitCode(fallbackCode)
      return
    }
    if (graceTimer === undefined) {
      graceTimer = setTimeout(() => settleExitCode(fallbackCode), KILL_GRACE_MS)
      graceTimer.unref()
    }
    const sweep = endProcessTree(child, 'SIGKILL')
    treeKillReceipt ??= sweep
  }

  const onAbort = (): void => {
    if (signal?.reason === 'interrupt') return
    kill()
  }

  const startSizeWatchdog = (): void => {
    sizeWatchdogTimer = setInterval(() => {
      void (async () => {
        let size: number
        try {
          size = (await stat(taskOutput.path)).size
        } catch {
          return
        }
        if (sizeWatchdogTimer === undefined || status !== 'backgrounded') return
        if (size > maxOutputBytes) {
          killedBySizeWatchdog = true
          kill()
        }
      })()
    }, SIZE_WATCHDOG_INTERVAL_MS)
    sizeWatchdogTimer.unref()
  }

  const armHardCap = (): void => {
    hardCapTimer = setTimeout(() => {
      if (status !== 'backgrounded') return
      killedByHardCap = true
      kill()
    }, HARD_CAP_MULTIPLIER * timeout)
    hardCapTimer.unref()
  }

  const background = (taskId: string): boolean => {
    if (status !== 'running') return false
    backgroundTaskId = taskId
    status = 'backgrounded'
    teardownListeners()
    if (fileMode) {
      startSizeWatchdog()
    } else {
      taskOutput.spillToDisk()
    }
    if (timeoutElapsed) {
      armHardCap()
    }
    return true
  }

  const assembleResult = async (code: number): Promise<void> => {
    if (graceTimer !== undefined) {
      clearTimeout(graceTimer)
      graceTimer = undefined
    }
    teardownListeners()
    if (status === 'running' || status === 'backgrounded') {
      status = 'completed'
    }
    await new Promise(resolve => setImmediate(resolve))
    const stdout = await taskOutput.getStdout()
    let stderr = taskOutput.getStderr()

    const interrupted =
      killedByMercury && !killedBySizeWatchdog && !killedByHardCap && !killedByTimeoutPolicy

    const execResult: ExecResult = { stdout, stderr, code, interrupted }

    if (backgroundTaskId !== undefined) {
      execResult.backgroundTaskId = backgroundTaskId
    }

    if (fileMode && backgroundTaskId === undefined) {
      if (taskOutput.outputFileRedundant) {
        await taskOutput.deleteOutputFile()
      } else {
        execResult.outputFilePath = taskOutput.path
        execResult.outputFileSize = taskOutput.outputFileSize
        execResult.outputTaskId = taskOutput.taskId
      }
    }

    let note: string | undefined
    if (killedBySizeWatchdog) {
      note = `Background command killed: its output file exceeded the ${MAX_TASK_OUTPUT_BYTES_DISPLAY} output limit.`
    } else if (killedByHardCap) {
      note =
        `Background command killed: the absolute deadline elapsed (${HARD_CAP_MULTIPLIER}x the ` +
        `original ${formatDuration(timeout)} timeout — auto-backgrounding preserves the task's ` +
        `time bound). For a service-style command that should run indefinitely, background it ` +
        `explicitly instead.`
    } else if (killedByTimeoutPolicy) {
      note = `Command timed out after ${formatDuration(timeout)}.`
    }
    if (note !== undefined) {
      stderr = stderr ? `${note} ${stderr}` : note
      execResult.stderr = stderr
    }

    resolveResult(execResult)
  }

  const cleanup = (): void => {
    stdoutWrapper?.cleanup()
    stderrWrapper?.cleanup()
    stdoutWrapper = null
    stderrWrapper = null
    taskOutput.clear()
    teardownListeners()
    child = null
    signal = null
    timeoutCallback = undefined
  }

  abortSignal.addEventListener('abort', onAbort, { once: true })
  childProcess.once('exit', (code, exitSignal) => {
    settleExitCode(deriveExitCode(code, exitSignal))
  })
  childProcess.once('error', () => {
    settleExitCode(1)
  })
  timeoutTimer = setTimeout(() => {
    timeoutFired = true
    if (shouldAutoBackground && timeoutCallback !== undefined) {
      timeoutElapsed = true
      timeoutCallback(background)
    } else {
      killedByTimeoutPolicy = true
      kill()
    }
  }, timeout)

  const command: ShellCommand = {
    background,
    result,
    kill,
    get status() {
      return status
    },
    get treeKillReceipt() {
      return treeKillReceipt
    },
    cleanup,
    taskOutput,
  }
  if (shouldAutoBackground) {
    command.onTimeout = (callback: OnTimeoutCallback): void => {
      if (timeoutFired) return
      timeoutCallback = callback
    }
  }
  return command
}

export function createAbortedCommand(
  backgroundTaskId?: string,
  opts?: { stderr?: string; code?: number },
): ShellCommand {
  const taskOutput = new TaskOutput(generateTaskId('local_bash'), null, false)
  const execResult: ExecResult = {
    stdout: '',
    stderr: opts?.stderr ?? 'Command was aborted before execution',
    code: opts?.code ?? 145,
    interrupted: true,
  }
  if (backgroundTaskId !== undefined) {
    execResult.backgroundTaskId = backgroundTaskId
  }
  return {
    background: () => false,
    result: Promise.resolve(execResult),
    kill: () => {},
    status: 'killed',
    cleanup: () => {},
    taskOutput,
  }
}

export function createFailedCommand(preSpawnError: string): ShellCommand {
  const taskOutput = new TaskOutput(generateTaskId('local_bash'), null, false)
  const execResult: ExecResult = {
    stdout: '',
    stderr: preSpawnError,
    code: 1,
    interrupted: false,
    preSpawnError,
  }
  return {
    background: () => false,
    result: Promise.resolve(execResult),
    kill: () => {},
    status: 'completed',
    cleanup: () => {},
    taskOutput,
  }
}
