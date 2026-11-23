import { z } from 'zod/v4'
import { semanticBoolean } from '../../utils/semanticBoolean.js'
import { semanticNumber } from '../../utils/semanticNumber.js'
import { buildTool, stringInputField, type ToolDef, type ToolPermissionContext } from '../../Tool.js'
import { shellCommandHasPermission } from '../BashTool/bashPermissions.js'
import { oneLineCommandDisplay } from '../commandDisplay.js'
import { spawnShellTask } from '../../tasks/LocalShellTask/LocalShellTask.js'
import { stopTask } from '../../tasks/stopTask.js'
import { enqueuePendingNotification } from '../../utils/messageQueueManager.js'
import { lazySchema } from '../../utils/lazySchema.js'
import { exec } from '../../utils/Shell.js'
import { ShellError } from '../../utils/errors.js'
import { clampWait } from '../../utils/waitCeiling.js'
import { MONITOR_TOOL_NAME } from '../../constants/tools/monitor.js'
import { sessionLaneWall } from './laneWall.js'
import { BURST_WINDOW_MS, DELIVERY_INTERVAL_MS, createWatchMailbox } from './watchMailbox.js'
import { monitorNoticeBlock, WATCH_STARTED_LINE } from './watchReceipts.js'
import { logForDebugging } from '../../utils/debug.js'
import { startImmediate, startTimeout, stopTimeout } from '../../utils/timers.js'

export { MONITOR_TOOL_NAME }

const DEFAULT_TIMEOUT_MS = 300_000
const MIN_TIMEOUT_MS = 1_000
const MAX_TIMEOUT_MS = 3_600_000

const RATE_BURST = 20
const RATE_REFILL_PER_SEC = 10
const OVERFLOW_STOP_MS = 10_000

const DESCRIPTION = `Starts a background watch on a command and delivers each line of its stdout as a notification in the chat while you keep working. A notification is an event of the watch, not a reply from the user, even when it lands while you are waiting for their answer; lines within ${BURST_WINDOW_MS}ms fold into one notification, ongoing output is delivered at most once every ${DELIVERY_INTERVAL_MS / 1000} seconds with its line count and last line, and events that land while the session's usage window is closed are held and delivered together on your first turn after it reopens. The watch ends when the command exits, when its timeout passes with one expiry notice, or, with persistent, when it is stopped or the session ends.`

const COMMAND_DESCRIPTION =
  'The shell command; each stdout line is an event, and its exit ends the watch.'

export function monitorExpiryNotice(description: string, taskId: string, timeoutMs: number, events: number): string {
  return `[Monitor "${description}" (task ${taskId}) expired after ${Math.round(timeoutMs / 1000)}s with ${events} event${events === 1 ? '' : 's'}. Re-arm it by calling Monitor again with the same command if the watch is still wanted; set persistent: true for a watch that must outlive the deadline.]`
}

export function monitorDeadline(timeoutMs: number | undefined, persistent: boolean | undefined): { timeoutMs: number; clamped: string | null } {
  if (persistent) return { timeoutMs: 0, clamped: null }
  const wait = clampWait('timeout_ms', timeoutMs ?? DEFAULT_TIMEOUT_MS, MIN_TIMEOUT_MS, MAX_TIMEOUT_MS, 'ms')
  return { timeoutMs: wait.value, clamped: wait.clause }
}

const inputSchema = lazySchema(() =>
  z.strictObject({
    description: z
      .string()
      .describe('A few words naming what is watched, shown in each notification.'),
    timeout_ms: semanticNumber(
      z.number().min(0).optional().default(DEFAULT_TIMEOUT_MS),
    ).describe(
      `The watch is killed after this many milliseconds. Default ${DEFAULT_TIMEOUT_MS}, min ${MIN_TIMEOUT_MS}, max ${MAX_TIMEOUT_MS}; a value outside the bounds is clamped to them and the result says so. Ignored when persistent is true.`,
    ),
    persistent: semanticBoolean(
      z.boolean().optional().default(false),
    ).describe(
      'true runs the watch for the life of the session, with no timeout, until it is stopped or the session ends.',
    ),
    command: z.string().describe(COMMAND_DESCRIPTION),
  }),
)
type InputSchema = ReturnType<typeof inputSchema>

const outputSchema = lazySchema(() =>
  z.object({
    taskId: z.string().describe('ID of the background monitor task.'),
    timeoutMs: z
      .number()
      .describe('Timeout deadline in milliseconds (0 when persistent).'),
    persistent: z
      .boolean()
      .optional()
      .describe('No timeout — runs until TaskStop or session end.'),
    clamped: z
      .string()
      .optional()
      .describe('The clamp applied to timeout_ms, when one was.'),
  }),
)
type OutputSchema = ReturnType<typeof outputSchema>
export type Output = z.infer<OutputSchema>

export const MonitorTool = buildTool({
  name: MONITOR_TOOL_NAME,
  userFacingName: () => 'Monitor',
  searchHint: 'watch a command, log or process and deliver each new line as a notification',
  shouldDefer: true,
  isEnabled: () => true,
  isConcurrencySafe: () => false,
  maxResultSizeChars: 10_000,
  straightQuoteInputs: ['command'],
  shellCommandOf(input: unknown) {
    return stringInputField(input, 'command')
  },
  get inputSchema(): InputSchema {
    return inputSchema()
  },
  get outputSchema(): OutputSchema {
    return outputSchema()
  },
  async description() {
    return DESCRIPTION
  },
  async prompt() {
    return DESCRIPTION
  },
  getActivityDescription(input?: { description?: string }) {
    return input?.description ? `Monitoring: ${input.description}` : 'Monitoring'
  },
  renderToolUseMessage(
    input?: { command?: unknown; description?: string },
    options?: { verbose?: boolean },
  ) {
    const command =
      typeof input?.command === 'string'
        ? options?.verbose
          ? input.command
          : oneLineCommandDisplay(input.command)
        : ''
    return input?.description ? `${command} — ${input.description}` : command
  },
  async checkPermissions(input, context) {
    const permissionContext: ToolPermissionContext = context.getAppState().toolPermissionContext
    const result = await shellCommandHasPermission(
      MONITOR_TOOL_NAME,
      { command: input.command },
      permissionContext,
    )
    if (result.behavior !== 'allow') return result
    const approvedCommand =
      typeof result.updatedInput?.command === 'string'
        ? result.updatedInput.command
        : input.command
    return {
      ...result,
      updatedInput: {
        ...input,
        command: approvedCommand,
      },
    }
  },
  async call(input, context) {
    const setAppState = context.setAppStateForTasks ?? context.setAppState
    const persistent = input.persistent === true
    const { timeoutMs, clamped } = monitorDeadline(input.timeout_ms, persistent)

    let taskId = ''
    let shellCommand: Awaited<ReturnType<typeof exec>> | null = null
    let stopped = false
    let admittedEvents = 0
    let expiryTimer: ReturnType<typeof startTimeout> | null = null

    const mailbox = createWatchMailbox({
      now: () => Date.now(),
      wall: () => sessionLaneWall(),
      deliver: (text, summary) => {
        enqueuePendingNotification({
          value: monitorNoticeBlock(taskId, input.description, text, summary),
          mode: 'task-notification',
          priority: 'next',
          agentId: context.agentId,
        })
      },
      setTimer: (fn, ms) => {
        const handle = startTimeout(fn, ms)
        handle.unref?.()
        return handle
      },
      clearTimer: handle => {
        stopTimeout(handle)
      },
    })

    const requestStop = (reason: 'timeout' | 'overflow'): void => {
      if (taskId) {
        void stopTask(taskId, {
          getAppState: context.getAppState,
          setAppState,
        }).catch((error: unknown) => {
          logForDebugging(
            `monitor ${taskId}: stopTask failed on ${reason}, killing process directly: ${error instanceof Error ? error.message : String(error)}`,
            { level: 'warn' },
          )
          shellCommand?.kill()
        })
      } else {
        shellCommand?.kill()
      }
    }

    let tokens = RATE_BURST
    let lastRefill = Date.now()
    let suppressedCount = 0
    let suppressedSince: number | null = null

    const onStdout = (chunk: string): void => {
      if (stopped || chunk === '') return
      const now = Date.now()
      const elapsedSec = (now - lastRefill) / 1000
      if (elapsedSec > 0) {
        tokens = Math.min(RATE_BURST, tokens + elapsedSec * RATE_REFILL_PER_SEC)
        lastRefill = now
      }
      if (tokens >= 1) {
        tokens -= 1
        if (suppressedCount > 0) {
          mailbox.push(
            `[${suppressedCount} events suppressed — output rate too high. Consider using TaskStop to restart this monitor with a more selective filter.]`,
          )
          suppressedCount = 0
          suppressedSince = null
        }
        admittedEvents += 1
        mailbox.push(chunk)
        return
      }
      suppressedCount += 1
      if (suppressedSince === null) {
        suppressedSince = now
      }
      const streakMs = now - suppressedSince
      if (streakMs > OVERFLOW_STOP_MS) {
        const seconds = Math.round(streakMs / 1000)
        mailbox.push(
          `[Monitor stopped: your script produced too much output (${suppressedCount} events suppressed over ${seconds}s). Start a new monitor with a tighter filter, such as grep --line-buffered or a wrapper script that emits only the events you need.]`,
        )
        stopped = true
        if (expiryTimer !== null) {
          stopTimeout(expiryTimer)
          expiryTimer = null
        }
        requestStop('overflow')
      }
    }

    shellCommand = await exec(input.command, context.abortController.signal, 'bash', {
      preventCwdChanges: true,
      onStdout,
    })

    const handle = await spawnShellTask(
      {
        command: input.command,
        description: input.description,
        shellCommand,
        toolUseId: context.toolUseId,
        agentId: context.agentId,
        kind: 'monitor',
        persistent,
      },
      {
        abortController: context.abortController,
        getAppState: context.getAppState,
        setAppState,
      },
    )
    taskId = handle.taskId

    if (handle.accepted === false) {
      const result = await shellCommand.result
      if (result.preSpawnError !== undefined) {
        stopped = true
        throw new ShellError('', result.preSpawnError, result.code, result.interrupted, false)
      }
    }

    void shellCommand.result.finally(() => {
      startImmediate(() => {
        stopped = true
        if (expiryTimer !== null) {
          stopTimeout(expiryTimer)
          expiryTimer = null
        }
      })
    })

    if (!stopped && !persistent && timeoutMs > 0) {
      expiryTimer = startTimeout(() => {
        expiryTimer = null
        if (stopped) return
        stopped = true
        mailbox.push(monitorExpiryNotice(input.description, taskId, timeoutMs, admittedEvents))
        requestStop('timeout')
      }, timeoutMs)
      expiryTimer.unref?.()
    }

    return {
      data: {
        taskId,
        timeoutMs,
        persistent,
        ...(clamped !== null ? { clamped } : {}),
      },
    }
  },
  mapToolResultToToolResultBlockParam(output: Output, toolUseID: string) {
    const schedule = output.persistent
      ? 'persistent — runs until TaskStop or session end'
      : `timeout ${output.timeoutMs}ms${output.clamped ? `; ${output.clamped}` : ''}`
    return {
      tool_use_id: toolUseID,
      type: 'tool_result' as const,
      content: `${WATCH_STARTED_LINE}${output.taskId}, ${schedule}). You will receive batched events, at most once every 30 seconds during ongoing output. Keep working — do not poll or sleep. Events may arrive while you are waiting for the user — an event is not their reply.`,
    }
  },
} satisfies ToolDef<InputSchema, Output>)
