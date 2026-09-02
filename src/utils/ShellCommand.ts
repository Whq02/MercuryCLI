import type { ChildProcess } from 'child_process'
import { stat } from 'node:fs/promises'

import { generateTaskId } from '../Task.js'
import { formatDuration } from './format.js'
import { endProcessTree, type ProcessTreeKillReceipt } from './processGroup.js'
import { MAX_TASK_OUTPUT_BYTES, MAX_TASK_OUTPUT_BYTES_DISPLAY } from './task/diskOutput.js'
import { TaskOutput } from './task/TaskOutput.js'

/**
 * Supervision of an already-spawned shell child: timeout, auto-backgrounding,
 * the absolute hard cap, the output-size watchdog, kill settlement with
 * honest provenance, and result assembly.
 *
 * Settlement law: the result hangs off the child's PROCESS-EXIT event, never
 * the stdio-closed event. Stdio-closed only arrives once every holder of the
 * inherited descriptors is absent, and a shell command may leave descendants
 * running past its own exit — waiting on it turns an ordinary command into
 * an unbounded hang. Process exit fires when the spawned shell itself
 * terminates, which is the moment the caller is owed a result.
 */

/** Multiplier for the absolute deadline a timeout-driven background re-arms. */
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
  /** The requested timeout, present when a timeout caused auto-backgrounding. */
  timeoutAutoBackgroundedAfterMs?: number
}

type OnTimeoutCallback = (backgroundFn: (taskId: string) => boolean) => void

export type ShellCommand = {
  /** Move a running command to the background; false from any other state. */
  background: (taskId: string) => boolean
  result: Promise<ExecResult>
  kill: () => void
  status: 'running' | 'backgrounded' | 'completed' | 'killed'
  cleanup: () => void
  /**
   * Present only when auto-backgrounding was requested at construction, so a
   * caller probing for it gets the honest answer that this command cannot
   * convert a timeout into a background task.
   */
  onTimeout?: (callback: OnTimeoutCallback) => void
  taskOutput: TaskOutput
  /**
   * The FIRST kill's tree receipt — how many processes the sweep ended and
   * which pids survived the bounded reap. Present only once kill() has run;
   * the stop path awaits it so the operator's receipt can say how many
   * processes the stop ended.
   */
  treeKillReceipt?: Promise<ProcessTreeKillReceipt>
}

type StreamWrapper = { cleanup: () => void }

/**
 * Funnel a child stream's chunks into a sink as UTF-8 strings (the encoding
 * is set on the stream rather than converting per chunk). Teardown is
 * idempotent and drops the wrapper's references to the stream and the sink
 * so both can be collected independently.
 */
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

  // Kill provenance. `interrupted` on the result derives ONLY from these —
  // never from the numeric exit code: a child is entitled to exit 137 on its
  // own (an OOM stop, a `timeout -s KILL` inside the command), and that is a
  // fact about the child, not a signal that the user stopped anything.
  let killedByMercury = false
  let killedByTimeoutPolicy = false
  let killedBySizeWatchdog = false
  let killedByHardCap = false

  // Sticky: once the timeout has elapsed into a registered callback, any
  // later background() still counts as timeout-driven and re-arms the
  // absolute deadline.
  let timeoutElapsed = false
  let timeoutFired = false
  let timeoutCallback: OnTimeoutCallback | undefined
  let backgroundTaskId: string | undefined

  let timeoutTimer: NodeJS.Timeout | undefined
  let sizeWatchdogTimer: NodeJS.Timeout | undefined
  let hardCapTimer: NodeJS.Timeout | undefined
  let graceTimer: NodeJS.Timeout | undefined
  let treeKillReceipt: Promise<ProcessTreeKillReceipt> | undefined

  // File mode (ordinary bash commands): both child fds are redirected to an
  // output file and no JS-side stream wrappers exist; progress is polled
  // from the file. Pipe mode (hooks): the streams exist and are wrapped.
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

  // Single-shot: whichever of the real exit event and the kill grace comes
  // first settles the code; the later one has no effect.
  let exitCodeSettled = false
  const settleExitCode = (code: number): void => {
    if (exitCodeSettled) return
    exitCodeSettled = true
    void assembleResult(code)
  }

  /** Exit-code derivation, in contract precedence order. */
  const deriveExitCode = (code: number | null, exitSignal: NodeJS.Signals | null): number => {
    if (code !== null && code !== undefined) return code
    if (exitSignal === 'SIGTERM') return 144
    if (killedByTimeoutPolicy) return 143
    if (killedByMercury) return 137
    return 1
  }

  const teardownListeners = (): void => {
    // Clears the watchdog, the timeout timer and the hard-cap timer, and
    // removes the abort listener. Runs ONLY on the background transition,
    // at settlement, and in cleanup() — never on kill(): after a kill the
    // foreground timeout timer stays armed and the abort listener stays
    // attached until settlement or cleanup. It deliberately LEAVES the
    // child's exit and error observers attached — they are what resolves
    // the result — and leaves the kill grace timer running: cancelling the
    // grace would leave the promise pending forever for a child that
    // survives SIGKILL. The grace is cleared only at real settlement.
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
    // Fallback code, used only if the real exit never arrives: 143 for the
    // plain foreground timeout policy kill, 137 for every other kill.
    const fallbackCode = killedByTimeoutPolicy ? 143 : 137
    if (!child?.pid) {
      // Spawn failed or the handle was torn down: nothing to signal.
      settleExitCode(fallbackCode)
      return
    }
    if (graceTimer === undefined) {
      // Bounded grace, armed on the first kill only; a repeated kill()
      // re-sends the signal but never re-arms the grace.
      graceTimer = setTimeout(() => settleExitCode(fallbackCode), KILL_GRACE_MS)
      graceTimer.unref()
    }
    // Do NOT fabricate the exit code here: the real exit event settles it.
    // The whole tree is ended — group strike, walked escapees, bounded reap —
    // and the FIRST kill's receipt is kept for the stop path's counted line.
    const sweep = endProcessTree(child, 'SIGKILL')
    treeKillReceipt ??= sweep
  }

  const onAbort = (): void => {
    // The exact reason string `interrupt` means the user submitted a new
    // message: the command is NOT killed — the caller is expected to
    // background it so the model can still see partial output. Any other
    // reason kills.
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
          // File not yet created, or unlinked mid-run: skip this tick.
          return
        }
        // Re-check after the await: a process that exited on its own while
        // the stat was in flight must not get mislabelled as a size kill.
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
    // Only a running command can be backgrounded: after exit the caller
    // settles the registered state instead of minting a phantom task.
    if (status !== 'running') return false
    backgroundTaskId = taskId
    status = 'backgrounded'
    // Includes the abort listener: once backgrounded, an abort of the
    // original signal no longer kills the command — only the size watchdog,
    // the absolute deadline, or an explicit kill() can.
    teardownListeners()
    if (fileMode) {
      startSizeWatchdog()
    } else {
      // Persist what is buffered so later inspection can find it on disk.
      taskOutput.spillToDisk()
    }
    // The absolute deadline applies only to a timeout-driven background. An
    // operator-chosen background is a request for a long-lived job; only
    // the size watchdog bounds it.
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
    // Move to completed BEFORE the drain, so background() refuses
    // throughout the settlement window.
    if (status === 'running' || status === 'backgrounded') {
      status = 'completed'
    }
    // One macrotask boundary before reading outputs: settlement is driven
    // by process exit, not stdio closure, so data the child already wrote
    // can still be sitting in queued stream callbacks. This tick is what
    // makes a write-then-exit command's last bytes appear in the result.
    await new Promise(resolve => setImmediate(resolve))
    const stdout = await taskOutput.getStdout()
    let stderr = taskOutput.getStderr()

    const interrupted =
      killedByMercury && !killedBySizeWatchdog && !killedByHardCap && !killedByTimeoutPolicy

    const execResult: ExecResult = { stdout, stderr, code, interrupted }

    // The settled result carries the task id only; the three background-
    // provenance flags (backgroundedByUser / assistantAutoBackgrounded /
    // timeoutAutoBackgroundedAfterMs) are owned by the calling tools.
    if (backgroundTaskId !== undefined) {
      execResult.backgroundTaskId = backgroundTaskId
    }

    if (fileMode && backgroundTaskId === undefined) {
      if (taskOutput.outputFileRedundant) {
        // Small enough that the full content is already in stdout.
        await taskOutput.deleteOutputFile()
      } else {
        execResult.outputFilePath = taskOutput.path
        execResult.outputFileSize = taskOutput.outputFileSize
        execResult.outputTaskId = taskOutput.taskId
      }
    }

    // Exactly one explanatory note, first match wins. The size note names
    // the display form of the DEFAULT byte budget deliberately, even when a
    // custom budget was compared against.
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
      // Provenance ONLY, never the numeric code (this module's own opening
      // law): a child is entitled to exit 143 on its own — the `|| code === 143`
      // arm labelled an instant `exit 143` 'Command timed out after 2m' and sent
      // the operator tuning a timeout that was never involved (TASK-017 S2,
      // shell-exit-143-fabricates-timeout-note).
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
    // Listener teardown MUST run before the abort-signal reference is
    // released: a kill queues settlement as a microtask, and settlement
    // removes the abort listener — nulling the signal first would crash it.
    teardownListeners()
    child = null
    signal = null
    timeoutCallback = undefined
  }

  // Construction-time wiring: abort listener (once), exit and error each
  // observed once, and the timeout timer armed. Unlike every other timer in
  // this module the timeout timer is an ordinary REFERENCED timer — it is
  // cleared by listener teardown, so it never outlives the foreground phase.
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
      // Recorded sticky; the process is not killed. If the callback
      // declines and nobody ever backgrounds, the command keeps running
      // with no timeout at all — the timer has fired and is absent.
      timeoutElapsed = true
      timeoutCallback(background)
    } else {
      // Policy kill: same kill path as every other kill (a process-group
      // SIGKILL — this module never sends SIGTERM); only the 143 fallback
      // and the stderr note distinguish it.
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
      // Last registration wins; registering after the timeout has already
      // elapsed has no effect.
      if (timeoutFired) return
      timeoutCallback = callback
    }
  }
  return command
}

/**
 * A handle for a command aborted before execution. It owns a fresh, empty,
 * file-less task output — nothing was ever spawned, so nothing may be read
 * from or deleted on disk.
 */
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

/**
 * A handle for a command that could not be spawned at all (e.g. the working
 * directory was deleted). Settles as completed with exit code 1 and the
 * pre-spawn error in both stderr and the dedicated field.
 */
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
