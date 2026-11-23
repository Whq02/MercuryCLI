import type { ChildProcess } from 'child_process'
import type { VerificationStart } from './verification/verificationState.js'
import { stat } from 'node:fs/promises'

import { generateTaskId } from '../Task.js'
import { formatDuration } from './format.js'
import { endProcessTree, type ProcessTreeKillReceipt } from './processGroup.js'
import { MAX_TASK_OUTPUT_BYTES, MAX_TASK_OUTPUT_BYTES_DISPLAY } from './task/diskOutput.js'
import { TaskOutput } from './task/TaskOutput.js'
import { passedOver } from './passedOver.js'
import { startImmediate, startInterval, startTimeout, stopInterval, stopTimeout } from './timers.js'
import { isOwnKillExitCode } from './platform/processes.js'


export const HARD_CAP_MULTIPLIER = 10

const KILL_GRACE_MS = 2000
const SIZE_WATCHDOG_INTERVAL_MS = 5000

export type ExecResult = {
  stdout: string
  stderr: string
  code: number
  interrupted: boolean
  pipelineStatus?: number[]
  backgroundTaskId?: string
  backgroundedByUser?: boolean
  outputFilePath?: string
  outputFileSize?: number
  outputTaskId?: string
  preSpawnError?: string
  timeoutAutoBackgroundedAfterMs?: number
}

export type ShellCommand = {
  background: (taskId: string) => boolean
  result: Promise<ExecResult>
  kill: () => void
  readonly status: 'running' | 'backgrounded' | 'completed' | 'killed'
  cleanup: () => void
  onTimeout?: (callback: (background: (taskId: string) => boolean) => void) => void
  taskOutput: TaskOutput
  pid?: number
  treeKillReceipt?: Promise<ProcessTreeKillReceipt>
  verificationStart?: VerificationStart
  scrubbedSessionEnv?: readonly string[]
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

type SettleInput = {
  taskOutput: TaskOutput
  code: number | null
  signal: NodeJS.Signals | null
  errorMessage?: string
  timeout: number
  isFileMode: boolean
  backgroundTaskId?: string
  killedByUs: boolean
  killedByTimeout: boolean
  killedByHardCap: boolean
  killedBySize: boolean
}

function policyNoticeFor(
  killedBySize: boolean,
  killedByHardCap: boolean,
  killedByTimeout: boolean,
  timeout: number,
): string | undefined {
  if (killedBySize) {
    return `Background command killed: its output file exceeded the ${MAX_TASK_OUTPUT_BYTES_DISPLAY} output limit.`
  }
  if (killedByHardCap) {
    return (
      `Background command killed: the absolute deadline elapsed (${HARD_CAP_MULTIPLIER}x the original ${formatDuration(timeout)} timeout — auto-backgrounding preserves the task's ` +
      'time bound). For a service-style command that should run indefinitely, background it ' +
      'explicitly.'
    )
  }
  if (killedByTimeout) {
    return `Command timed out after ${formatDuration(timeout)}.`
  }
  return undefined
}

async function finalizeExecResult(input: SettleInput): Promise<ExecResult> {
  const {
    taskOutput,
    code,
    signal,
    errorMessage,
    timeout,
    isFileMode,
    backgroundTaskId,
    killedByUs,
    killedByTimeout,
    killedByHardCap,
    killedBySize,
  } = input

  try {
    await taskOutput.flush()
  } catch (error) {
    passedOver(error)
  }

  const stdout = await taskOutput.getStdout()
  let stderr = taskOutput.getStderr()
  if (errorMessage) {
    stderr = stderr ? `${stderr}\n${errorMessage}` : errorMessage
  }

  const policyNotice = policyNoticeFor(killedBySize, killedByHardCap, killedByTimeout, timeout)
  if (policyNotice !== undefined) {
    stderr = stderr ? `${policyNotice} ${stderr}` : policyNotice
  }

  const finalCode =
    errorMessage !== undefined
      ? 1
      : code !== null && !isOwnKillExitCode(killedByUs, code)
        ? code
        : signal === 'SIGTERM'
          ? 144
          : killedByTimeout
            ? 143
            : killedByUs
              ? 137
              : 1

  const interrupted = killedByUs && !killedByTimeout && !killedByHardCap && !killedBySize

  let outputFilePath: string | undefined
  let outputFileSize: number | undefined
  let outputTaskId: string | undefined
  if (isFileMode && backgroundTaskId === undefined) {
    if (taskOutput.outputFileRedundant) {
      try {
        await taskOutput.deleteOutputFile()
      } catch (error) {
        passedOver(error)
      }
    } else {
      outputFilePath = taskOutput.path
      outputFileSize = taskOutput.outputFileSize
      outputTaskId = taskOutput.taskId
    }
  }

  return {
    stdout,
    stderr,
    code: finalCode,
    interrupted,
    ...(backgroundTaskId !== undefined ? { backgroundTaskId } : {}),
    ...(outputFilePath !== undefined ? { outputFilePath, outputFileSize, outputTaskId } : {}),
  }
}

export function wrapSpawn(
  childProcess: ChildProcess,
  abortSignal: AbortSignal,
  timeout: number,
  taskOutput: TaskOutput,
  shouldAutoBackground?: boolean,
  maxOutputBytes?: number,
): ShellCommand {
  let status: ShellCommand['status'] = 'running'
  let settled = false
  let killedByUs = false
  let killedByTimeout = false
  let killedByHardCap = false
  let killedBySize = false
  let timeoutFired = false
  let backgroundTaskId: string | undefined
  let timeoutCallback: ((background: (taskId: string) => boolean) => void) | undefined
  let timeoutTimer: NodeJS.Timeout | undefined
  let hardCapTimer: NodeJS.Timeout | undefined
  let killGraceTimer: NodeJS.Timeout | undefined
  let sizeWatchdog: NodeJS.Timeout | undefined
  let childRef: ChildProcess | null = childProcess
  let signalRef: AbortSignal | null = abortSignal

  const isFileMode = childProcess.stdout === null
  const sizeCap: number = maxOutputBytes ?? MAX_TASK_OUTPUT_BYTES

  let stdoutWrapper: StreamWrapper | null = childProcess.stdout
    ? wrapOutputStream(childProcess.stdout, data => taskOutput.writeStdout(data))
    : null
  let stderrWrapper: StreamWrapper | null = childProcess.stderr
    ? wrapOutputStream(childProcess.stderr, data => taskOutput.writeStderr(data))
    : null

  let resolveResult!: (result: ExecResult) => void
  const resultPromise = new Promise<ExecResult>(resolve => {
    resolveResult = resolve
  })

  const clearForegroundTimers = (): void => {
    if (timeoutTimer !== undefined) {
      stopTimeout(timeoutTimer)
      timeoutTimer = undefined
    }
    if (signalRef !== null) {
      signalRef.removeEventListener('abort', onAbort)
    }
  }

  const clearAllTimers = (): void => {
    clearForegroundTimers()
    if (hardCapTimer !== undefined) {
      stopTimeout(hardCapTimer)
      hardCapTimer = undefined
    }
    if (killGraceTimer !== undefined) {
      stopTimeout(killGraceTimer)
      killGraceTimer = undefined
    }
    if (sizeWatchdog !== undefined) {
      stopInterval(sizeWatchdog)
      sizeWatchdog = undefined
    }
  }

  const detachStreams = (): void => {
    stdoutWrapper?.cleanup()
    stdoutWrapper = null
    stderrWrapper?.cleanup()
    stderrWrapper = null
  }

  const settle = async (
    code: number | null,
    signal: NodeJS.Signals | null,
    errorMessage?: string,
  ): Promise<void> => {
    if (settled) return
    settled = true
    clearAllTimers()
    childRef?.off('exit', onExit)
    childRef?.off('error', onError)
    if (status === 'running' || status === 'backgrounded') {
      status = 'completed'
    }

    await new Promise<void>(resolve => startImmediate(resolve))
    detachStreams()

    resolveResult(
      await finalizeExecResult({
        taskOutput,
        code,
        signal,
        errorMessage,
        timeout,
        isFileMode,
        backgroundTaskId,
        killedByUs,
        killedByTimeout,
        killedByHardCap,
        killedBySize,
      }),
    )
  }

  const kill = (): void => {
    if (settled) return
    killedByUs = true
    status = 'killed'
    clearForegroundTimers()
    if (hardCapTimer !== undefined) {
      stopTimeout(hardCapTimer)
      hardCapTimer = undefined
    }
    if (sizeWatchdog !== undefined) {
      stopInterval(sizeWatchdog)
      sizeWatchdog = undefined
    }
    if (!childRef?.pid) {
      void settle(null, null)
      return
    }
    const receipt = endProcessTree(childRef, 'SIGKILL')
    if (handle.treeKillReceipt === undefined) {
      handle.treeKillReceipt = receipt
    }
    void receipt.catch(passedOver)
    if (killGraceTimer === undefined) {
      killGraceTimer = startTimeout(() => {
        killGraceTimer = undefined
        void settle(null, null)
      }, KILL_GRACE_MS)
      killGraceTimer.unref?.()
    }
  }

  const onAbort = (): void => {
    if (signalRef?.reason === 'interrupt') return
    kill()
  }

  const onExit = (code: number | null, signal: NodeJS.Signals | null): void => {
    void settle(code, signal)
  }

  const onError = (error: Error): void => {
    void settle(1, null, error.message)
  }

  const startSizeWatchdog = (): void => {
    if (sizeWatchdog !== undefined) return
    sizeWatchdog = startInterval(() => {
      if (settled) return
      void stat(taskOutput.path).then(
        info => {
          if (!settled && info.size > sizeCap) {
            killedBySize = true
            kill()
          }
        },
        error => {
          passedOver(error)
        },
      )
    }, SIZE_WATCHDOG_INTERVAL_MS)
    sizeWatchdog.unref?.()
  }

  const transitionToBackground = (taskId: string, armHardCap: boolean): boolean => {
    if (status !== 'running' || settled) return false
    status = 'backgrounded'
    backgroundTaskId = taskId
    clearForegroundTimers()
    if (!isFileMode) {
      taskOutput.spillToDisk()
    }
    startSizeWatchdog()
    if (armHardCap && timeout > 0 && Number.isFinite(timeout)) {
      const hardCapMs = timeout * HARD_CAP_MULTIPLIER
      hardCapTimer = startTimeout(() => {
        hardCapTimer = undefined
        if (settled) return
        killedByHardCap = true
        kill()
      }, hardCapMs)
      hardCapTimer.unref?.()
    }
    return true
  }

  const handle: ShellCommand = {
    background(taskId: string): boolean {
      return transitionToBackground(taskId, false)
    },
    result: resultPromise,
    kill,
    get status() {
      return status
    },
    cleanup(): void {
      detachStreams()
      clearAllTimers()
      childRef?.off('exit', onExit)
      childRef?.off('error', onError)
      taskOutput.clear()
      timeoutCallback = undefined
      childRef = null
      signalRef = null
    },
    ...(shouldAutoBackground
      ? {
          onTimeout(callback: (background: (taskId: string) => boolean) => void): void {
            if (timeoutFired || settled || status !== 'running') return
            timeoutCallback = callback
          },
        }
      : {}),
    taskOutput,
    ...(childProcess.pid !== undefined ? { pid: childProcess.pid } : {}),
  }

  childProcess.once('exit', onExit)
  childProcess.once('error', onError)

  if (childProcess.exitCode !== null || childProcess.signalCode !== null) {
    void settle(childProcess.exitCode, childProcess.signalCode)
    return handle
  }

  if (abortSignal.aborted) {
    onAbort()
  } else {
    abortSignal.addEventListener('abort', onAbort, { once: true })
  }

  if (!settled && status === 'running' && timeout > 0 && Number.isFinite(timeout)) {
    timeoutTimer = startTimeout(() => {
      timeoutTimer = undefined
      timeoutFired = true
      if (settled || status !== 'running') return
      if (shouldAutoBackground && timeoutCallback !== undefined) {
        const cb = timeoutCallback
        timeoutCallback = undefined
        cb(taskId => transitionToBackground(taskId, true))
        return
      }
      killedByTimeout = true
      kill()
    }, timeout)
    timeoutTimer.unref?.()
  }

  return handle
}

export function createAbortedCommand(
  backgroundTaskId?: string,
  opts?: { stderr?: string; code?: number },
): ShellCommand {
  const taskOutput = new TaskOutput(generateTaskId('local_bash'), null)
  const result: ExecResult = {
    stdout: '',
    stderr: opts?.stderr ?? 'Command was aborted before execution',
    code: opts?.code ?? 145,
    interrupted: true,
    ...(backgroundTaskId !== undefined ? { backgroundTaskId } : {}),
  }
  return {
    background: () => false,
    result: Promise.resolve(result),
    kill: () => {},
    status: 'killed',
    cleanup: () => {},
    taskOutput,
  }
}

export function createFailedCommand(preSpawnError: string): ShellCommand {
  const taskOutput = new TaskOutput(generateTaskId('local_bash'), null)
  const result: ExecResult = {
    stdout: '',
    stderr: preSpawnError,
    code: 1,
    interrupted: false,
    preSpawnError,
  }
  return {
    background: () => false,
    result: Promise.resolve(result),
    kill: () => {},
    status: 'completed',
    cleanup: () => {},
    taskOutput,
  }
}
