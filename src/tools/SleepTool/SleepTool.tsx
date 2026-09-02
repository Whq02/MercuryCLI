import { z } from 'zod/v4'
import { semanticNumber } from '../../utils/semanticNumber.js'
import * as React from 'react'
import { Text } from '../../ink.js'
import { buildTool, type ToolDef } from '../../Tool.js'
import type { AppState } from '../../state/AppState.js'
import { lazySchema } from '../../utils/lazySchema.js'
import { jsonStringify } from '../../utils/slowOperations.js'
import { DESCRIPTION, SLEEP_TOOL_NAME, SLEEP_TOOL_PROMPT } from './prompt.js'

const MAX_SLEEP_SECONDS = 3600

export const TRACKED_SETTLE_POLL_MS = 250

export const TRACKED_ARM_GRACE_TICKS = 4

export const TRACKED_AGENT_TASK_TYPES: ReadonlySet<string> = new Set([
  'local_agent',
  'in_process_teammate',
  'remote_agent',
  'local_workflow',
])

export const UNTRACKED_TASK_TYPES: ReadonlyMap<string, string> = new Map([
  ['local_bash', 'the follow-up scopes the redirect to SUBAGENT work; shell waits are a different contract'],
  ['monitor_mcp', 'gated off by the MONITOR_TOOL feature macro in Mercury — no producer'],
  ['dream', 'internal daemon work; never model-awaited'],
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
      const t = task as { id?: unknown; status?: unknown; type?: unknown }
      if (typeof t.status === 'string' && TERMINAL_TASK_STATUSES.has(t.status)) continue
      if (selfTaskId !== undefined && t.id === selfTaskId) continue
      if (typeof t.type === 'string' && TRACKED_AGENT_TASK_TYPES.has(t.type)) running++
    }
  } catch {
    return 0
  }
  return running
}

const inputSchema = lazySchema(() =>
  z.strictObject({
    seconds: semanticNumber(z.number().positive().max(MAX_SLEEP_SECONDS))
      .describe(
        'How many seconds to wait before returning. The user can interrupt the ' +
          'sleep at any time (it resolves early, reporting the elapsed time).',
      ),
  }),
)
type InputSchema = ReturnType<typeof inputSchema>

const outputSchema = lazySchema(() =>
  z.object({
    message: z.string().describe('Human-readable result of the wait'),
    slept_seconds: z.number().describe('Seconds actually waited'),
    interrupted: z.boolean().describe('True if the user/turn interrupted the wait'),
  }),
)
type OutputSchema = ReturnType<typeof outputSchema>
export type Output = z.infer<OutputSchema>

export const SleepTool = buildTool({
  name: SLEEP_TOOL_NAME,
  searchHint: 'wait / pause / rest for a duration without a shell',
  maxResultSizeChars: 10_000,
  userFacingName: () => 'Sleep',
  get inputSchema(): InputSchema {
    return inputSchema()
  },
  get outputSchema(): OutputSchema {
    return outputSchema()
  },
  isConcurrencySafe() {
    return true
  },
  isReadOnly() {
    return true
  },
  toAutoClassifierInput() {
    return ''
  },
  async description() {
    return DESCRIPTION
  },
  async prompt() {
    return SLEEP_TOOL_PROMPT
  },
  getActivityDescription(input) {
    const s = input?.seconds
    return typeof s === 'number' ? `Sleeping for ${Math.round(s)}s` : 'Sleeping'
  },
  renderToolUseMessage(input) {
    const s = input?.seconds
    return typeof s === 'number' ? `${Math.round(s)}s` : ''
  },
  renderToolResultMessage(output) {
    return (
      <Text color={output.interrupted ? 'warning' : undefined} dimColor={!output.interrupted}>
        {output.message}
      </Text>
    )
  },
  mapToolResultToToolResultBlockParam(output, toolUseID) {
    return {
      tool_use_id: toolUseID,
      type: 'tool_result',
      content: jsonStringify(output),
    }
  },
  async call({ seconds }, { abortController, getAppState, agentId }) {
    const { flagEnv } = await import('../../substrate/flagRegistry.js')
    if (flagEnv('MERCURY_CONCOURSE_WORKER') === '1' && seconds > 300) {
      throw new Error(
        'refused: this background session must not hold its turn open — ending the turn IS idling here; the switchboard wakes it on the next delivery. Use waits under 300s only for real short backoffs.',
      )
    }
    const ms = Math.max(0, Math.min(seconds, MAX_SLEEP_SECONDS)) * 1000
    const start = Date.now()
    let interrupted = false
    let armed = countTrackedRunningAgents(getAppState, agentId) > 0
    await new Promise<void>(resolve => {
      const signal = abortController.signal
      const cleanup = (): void => {
        clearTimeout(timer)
        clearInterval(watch)
        signal.removeEventListener('abort', onAbort)
      }
      const onAbort = (): void => {
        interrupted = true
        cleanup()
        resolve()
      }
      const timer = setTimeout(() => {
        cleanup()
        resolve()
      }, ms)
      let tick = 0
      const watch = setInterval(() => {
        tick++
        if (!armed) {
          if (tick > TRACKED_ARM_GRACE_TICKS) {
            clearInterval(watch)
            return
          }
          armed = countTrackedRunningAgents(getAppState, agentId) > 0
          if (!armed) return
        }
        if (countTrackedRunningAgents(getAppState, agentId) === 0) {
          cleanup()
          resolve()
        }
      }, TRACKED_SETTLE_POLL_MS)
      watch?.unref?.()
      if (signal.aborted) {
        interrupted = true
        cleanup()
        resolve()
        return
      }
      signal.addEventListener('abort', onAbort)
    })
    const sleptSeconds = Math.round((Date.now() - start) / 1000)
    const settledEarly =
      armed && !interrupted && Date.now() - start < ms - TRACKED_SETTLE_POLL_MS
    return {
      data: {
        message: interrupted
          ? `Sleep interrupted after ${sleptSeconds}s`
          : settledEarly
            ? `Returned after ${sleptSeconds}s — the tracked work you were waiting on finished. ` +
              'Mercury tracks agent tasks for you; their completion arrives on its own, so a wait ' +
              'never needs to run its full duration to poll one.'
            : `Slept for ${sleptSeconds}s`,
        slept_seconds: sleptSeconds,
        interrupted,
      },
    }
  },
} satisfies ToolDef<InputSchema, Output>)
