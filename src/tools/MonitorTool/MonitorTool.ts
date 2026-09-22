import { z } from 'zod/v4'
import { semanticBoolean } from '../../utils/semanticBoolean.js'
import { semanticNumber } from '../../utils/semanticNumber.js'
import { buildTool, stringInputField, type ToolDef } from '../../Tool.js'
import { spawnShellTask } from '../../tasks/LocalShellTask/LocalShellTask.js'
import { stopTask } from '../../tasks/stopTask.js'
import { enqueuePendingNotification } from '../../utils/messageQueueManager.js'
import { lazySchema } from '../../utils/lazySchema.js'
import { exec } from '../../utils/Shell.js'
import { MONITOR_TOOL_NAME } from './constants.js'
import { sessionLaneWall } from './laneWall.js'
import { BURST_WINDOW_MS, createWatchMailbox } from './watchMailbox.js'
import { monitorNoticeBlock, WATCH_STARTED_LINE } from './watchReceipts.js'

export { MONITOR_TOOL_NAME }

const DEFAULT_TIMEOUT_MS = 300_000
const MAX_TIMEOUT_MS = 3_600_000

const RATE_BURST = 20
const RATE_REFILL_PER_SEC = 10
const OVERFLOW_STOP_MS = 10_000

const DESCRIPTION = `Start a background monitor that streams events from a long-running script. Each stdout line is an event — you keep working and notifications arrive in the chat. Events arrive on their own schedule and are not replies from the user, even if one lands while you're waiting for the user to answer a question.

Pick by how many notifications you need:
- **One** ("tell me when the server is ready / the build finishes") → use **Bash with \`run_in_background\`** and a command that exits when the condition is true, e.g. \`until grep -q "Ready in" dev.log; do sleep 0.5; done\`. You get a single completion notification when it exits.
- **One per occurrence, indefinitely** ("tell me every time an ERROR line appears", "wake me on every line another agent appends to this file") → Monitor with an unbounded command (\`tail -f\`, \`inotifywait -m\`, \`while true\`) and \`persistent: true\`, so the watch runs until you stop it with TaskStop or the session ends.
- **One per occurrence, until a known end** ("emit each CI step result, stop when the run finishes") → Monitor with a command that exits when the watch is over.

A monitor without \`persistent\` expires after \`timeout_ms\` (default 5 minutes, at most 1 hour): it is killed and you get one expiry notice that says how to re-arm it. Lines that arrive within ${BURST_WINDOW_MS}ms fold into one notification. Events that land while the session's usage window is closed are held by the watch and delivered together, in one notification, on your first turn after the window reopens — they are not lost, and they never wake a session the provider would refuse once the session has met the closed window.`

const COMMAND_DESCRIPTION =
  'Shell command or script. Each stdout line is an event; exit ends the watch.'

export function monitorExpiryNotice(description: string, taskId: string, timeoutMs: number, events: number): string {
  return `[Monitor "${description}" (task ${taskId}) expired after ${Math.round(timeoutMs / 1000)}s with ${events} event${events === 1 ? '' : 's'}. Re-arm it by calling Monitor again with the same command if the watch is still wanted; set persistent: true for a watch that must outlive the deadline.]`
}

const inputSchema = lazySchema(() =>
  z
    .strictObject({
      description: z
        .string()
        .describe(
          'Short human-readable description of what you are monitoring (shown in notifications).',
        ),
      timeout_ms: semanticNumber(
        z.number().min(1000).optional().default(DEFAULT_TIMEOUT_MS),
      ).describe(
        `Kill the monitor after this deadline. Default ${DEFAULT_TIMEOUT_MS}ms, max ${MAX_TIMEOUT_MS}ms. Ignored when persistent is true.`,
      ),
      persistent: semanticBoolean(
        z.boolean().optional().default(false),
      ).describe(
        'Run for the lifetime of the session (no timeout): the watch runs until TaskStop or the session ends. Use for session-length watches like PR monitoring, log tails or a file other agents append to.',
      ),
      command: z.string().describe(COMMAND_DESCRIPTION),
    })
    .refine(v => v.persistent || v.timeout_ms <= MAX_TIMEOUT_MS, {
      message: `timeout_ms must be ≤ ${MAX_TIMEOUT_MS}`,
      path: ['timeout_ms'],
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
  }),
)
type OutputSchema = ReturnType<typeof outputSchema>
export type Output = z.infer<OutputSchema>

export const MonitorTool = buildTool({
  name: MONITOR_TOOL_NAME,
  shellCommandOf: (input: unknown) => stringInputField(input, 'command'),
  searchHint:
    'watch, monitor, or keep an eye on a process/log/command — stream each stdout line as a live notification',
  maxResultSizeChars: 10_000,
  userFacingName() {
    return 'Monitor'
  },
  straightQuoteInputs: ['command'],
  get inputSchema(): InputSchema {
    return inputSchema()
  },
  get outputSchema(): OutputSchema {
    return outputSchema()
  },
  shouldDefer: true,
  isEnabled() {
    return true
  },
  isConcurrencySafe() {
    return false
  },
  getActivityDescription(input) {
    return input?.description ? `Monitoring: ${input.description}` : 'Monitoring'
  },
  toAutoClassifierInput(input) {
    return input.command
  },
  async description() {
    return DESCRIPTION
  },
  async prompt() {
    return ''
  },
  mapToolResultToToolResultBlockParam(output, toolUseID) {
    return {
      tool_use_id: toolUseID,
      type: 'tool_result',
      content: `${WATCH_STARTED_LINE}${output.taskId}, ${
        output.persistent
          ? 'persistent — runs until TaskStop or session end'
          : `timeout ${output.timeoutMs}ms`
      }). You will be notified on each event. Keep working — do not poll or sleep. Events may arrive while you are waiting for the user — an event is not their reply.`,
    }
  },
  renderToolUseMessage(input) {
    return `Monitor: ${input.description ?? input.command ?? ''}`
  },
  async call({ command, description, timeout_ms, persistent }, context) {
    const { abortController, toolUseId, agentId } = context
    const setAppState = context.setAppStateForTasks ?? context.setAppState
    const getAppState = context.getAppState
    const timeoutMs = persistent
      ? 0
      : Math.min(timeout_ms ?? DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS)

    let taskId: string | undefined
    let stopped = false
    let events = 0

    let tokens = RATE_BURST
    let lastRefill = Date.now()
    let suppressed = 0
    let overflowStart: number | undefined
    function tryConsume(): boolean {
      const now = Date.now()
      tokens = Math.min(
        RATE_BURST,
        tokens + ((now - lastRefill) / 1000) * RATE_REFILL_PER_SEC,
      )
      lastRefill = now
      if (tokens >= 1) {
        tokens -= 1
        return true
      }
      return false
    }

    function emit(text: string): void {
      enqueuePendingNotification({
        value: monitorNoticeBlock(taskId ?? '', description, text),
        mode: 'task-notification',
        priority: 'next',
        agentId,
      })
    }

    const mailbox = createWatchMailbox({
      now: Date.now,
      wall: () => sessionLaneWall(),
      deliver: emit,
      setTimer: (fn, ms) => {
        const handle = setTimeout(fn, ms)
        handle.unref?.()
        return handle
      },
      clearTimer: handle => clearTimeout(handle as ReturnType<typeof setTimeout>),
    })

    function onData(chunk: string): void {
      if (stopped || !chunk) return
      if (tryConsume()) {
        if (suppressed > 0) {
          mailbox.push(
            `[${suppressed} events suppressed — output rate too high. Consider using TaskStop to restart this monitor with a more selective filter.]`,
          )
          suppressed = 0
          overflowStart = undefined
        }
        events++
        mailbox.push(chunk)
        return
      }
      suppressed++
      const now = Date.now()
      if (overflowStart === undefined) overflowStart = now
      if (now - overflowStart > OVERFLOW_STOP_MS) {
        stopped = true
        mailbox.push(
          `[Monitor stopped — your script produced too much output (${suppressed} events suppressed over ${Math.round(
            (now - overflowStart) / 1000,
          )}s). Write a new monitor command that filters more aggressively — a tighter grep --line-buffered pattern or a wrapper script that only emits the specific events you need.]`,
        )
        if (taskId) void stopTask(taskId, { getAppState, setAppState }).catch(() => {})
      }
    }

    const shellCommand = await exec(command, abortController.signal, 'bash', {
      preventCwdChanges: true,
      onStdout: onData,
    })
    const handle = await spawnShellTask(
      { command, description, shellCommand, toolUseId, agentId, kind: 'monitor' },
      { abortController, getAppState, setAppState },
    )
    taskId = handle.taskId

    let timer: ReturnType<typeof setTimeout> | undefined
    if (!persistent) {
      timer = setTimeout(() => {
        if (stopped) return
        stopped = true
        mailbox.push(monitorExpiryNotice(description, handle.taskId, timeoutMs, events))
        void stopTask(handle.taskId, { getAppState, setAppState }).catch(() => {})
      }, timeoutMs)
      timer.unref?.()
    }
    void shellCommand.result.then(async () => {
      await new Promise(resolve => setImmediate(resolve))
      stopped = true
      if (timer) clearTimeout(timer)
    })

    return {
      data: { taskId: handle.taskId, timeoutMs, persistent: persistent ?? false },
    }
  },
} satisfies ToolDef<InputSchema, Output>)
