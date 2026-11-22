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
import { notBuilt, type Unbuilt } from '../pi/holes.js'


export const HARD_CAP_MULTIPLIER = 10

const KILL_GRACE_MS = 2000
const SIZE_WATCHDOG_INTERVAL_MS = 5000

export type ExecResult = Unbuilt

export type ShellCommand = Unbuilt

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
  shouldAutoBackground?: boolean,
  maxOutputBytes?: number,
): ShellCommand {
  return notBuilt('src/utils/ShellCommand.ts:74')
}

export function createAbortedCommand(
  backgroundTaskId?: string,
  opts?: { stderr?: string; code?: number },
): ShellCommand {
  return notBuilt('src/utils/ShellCommand.ts:326')
}

export function createFailedCommand(preSpawnError: string): ShellCommand {
  return notBuilt('src/utils/ShellCommand.ts:350')
}
