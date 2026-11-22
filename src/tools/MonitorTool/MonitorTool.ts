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
import { unbuilt, type Unbuilt } from '../../pi/holes.js'

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

export const MonitorTool: Unbuilt = unbuilt('src/tools/MonitorTool/MonitorTool.ts:85')
