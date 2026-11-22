import { z } from 'zod/v4'
import { semanticNumber } from '../../utils/semanticNumber.js'
import { Text } from '../../ink.js'
import { buildTool, type ToolDef } from '../../Tool.js'
import { isRunInputClosed } from '../../bootstrap/state.js'
import type { AppState } from '../../state/AppState.js'
import { lazySchema } from '../../utils/lazySchema.js'
import { jsonStringify } from '../../utils/slowOperations.js'
import { clampWait } from '../../utils/waitCeiling.js'
import { DESCRIPTION, SLEEP_TOOL_NAME, SLEEP_TOOL_PROMPT } from './prompt.js'
import { passedOver } from '../../utils/passedOver.js'
import { pollUntil } from '../../utils/deadline.js'
import { startTimeout, stopTimeout } from '../../utils/timers.js'
import { unbuilt, type Unbuilt } from '../../pi/holes.js'

const MAX_SLEEP_SECONDS = 3600
const MIN_SLEEP_SECONDS = 1

function paintedWait(seconds: unknown): string | null {
  if (typeof seconds !== 'number') return null
  const wait = clampWait('seconds', seconds, MIN_SLEEP_SECONDS, MAX_SLEEP_SECONDS, 's')
  const label = `${Math.round(wait.value)}s`
  return wait.clause === null ? label : `${label} · ${wait.clause}`
}

export const TRACKED_SETTLE_POLL_MS = 250

export const TRACKED_ARM_GRACE_TICKS = 4

const TRACKED_AGENT_TASK_TYPES: ReadonlySet<string> = new Set([
  'local_agent',
  'remote_agent',
])

export const UNTRACKED_TASK_TYPES: ReadonlyMap<string, string> = new Map([
  ['local_bash', "an open session's main thread leaves shells out: a background shell's notice arrives between turns on its own; a waiter's OWN shells are the exception, SUBAGENT_TRACKED_TASK_TYPES"],
  ['monitor_mcp', 'gated off by the MONITOR_TOOL feature macro in Mercury — no producer'],
])

const SUBAGENT_TRACKED_TASK_TYPES: ReadonlyMap<string, string> = new Map([
  ['local_bash', "a waiter's own background shells: a crewmate's wait ends when the shells it launched settle (a shell task carries the spawning crewmate's id), and a one-prompt run's wait — its input closed, so the run ends with the turn and no notice could reach it between turns — ends when the run's own shells settle"],
])

export const TERMINAL_TASK_STATUSES: ReadonlySet<string> = new Set([
  'completed',
  'failed',
  'killed',
])

export function countTrackedRunningAgents(
  getAppState: () => AppState,
  selfTaskId?: string,
): number {
  let running = 0
  try {
    for (const task of Object.values(getAppState().tasks ?? {})) {
      const t = task as { id?: unknown; status?: unknown; type?: unknown; agentId?: unknown }
      if (typeof t.status === 'string' && TERMINAL_TASK_STATUSES.has(t.status)) continue
      if (selfTaskId !== undefined && t.id === selfTaskId) continue
      if (typeof t.type === 'string' && TRACKED_AGENT_TASK_TYPES.has(t.type)) running++
      else if ((selfTaskId !== undefined || isRunInputClosed()) && typeof t.type === 'string' && SUBAGENT_TRACKED_TASK_TYPES.has(t.type) && t.agentId === selfTaskId) running++
    }
  } catch (error) {
    passedOver(error)
    return 0
  }
  return running
}

const inputSchema = lazySchema(() =>
  z.strictObject({
    seconds: semanticNumber(z.number().min(0))
      .describe(
        `Seconds to wait (min ${MIN_SLEEP_SECONDS}, max ${MAX_SLEEP_SECONDS}; clamped outside bounds).`,
      ),
  }),
)
type InputSchema = ReturnType<typeof inputSchema>

const outputSchema = lazySchema(() =>
  z.object({
    message: z.string().describe('Human-readable result of the wait'),
    slept_seconds: z.number().describe('Seconds actually waited'),
    interrupted: z.boolean().describe('True if the user/turn interrupted the wait'),
    clamped: z.string().optional().describe('The clamp applied to the requested seconds, when one was'),
  }),
)
type OutputSchema = ReturnType<typeof outputSchema>
type Output = z.infer<OutputSchema>

export const SleepTool: Unbuilt = unbuilt('src/tools/SleepTool/SleepTool.tsx:90')
