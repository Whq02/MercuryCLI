import { z } from 'zod/v4'
import { semanticNumber } from '../../utils/semanticNumber.js'
import * as React from 'react'
import { Text } from '../../ink.js'
import { buildTool, type ToolDef } from '../../Tool.js'
import type { AppState } from '../../state/AppState.js'
import { lazySchema } from '../../utils/lazySchema.js'
import { jsonStringify } from '../../utils/slowOperations.js'
import { DESCRIPTION, SLEEP_TOOL_NAME, SLEEP_TOOL_PROMPT } from './prompt.js'

// A generous ceiling — a single wait shouldn't pin the turn open for longer than
// an hour. The model is told to balance against the 5-minute prompt-cache TTL.
const MAX_SLEEP_SECONDS = 3600

/** How often the wait checks whether the tracked work it is shadowing has
 *  settled. Short enough that the redirect is felt, long enough to be free. */
export const TRACKED_SETTLE_POLL_MS = 250

/** Same-block dispatches register while Sleep is already entering — tool
 *  calls in one assistant block start CONCURRENTLY, so the sibling Agent
 *  dispatch can lose the race to Sleep's entry check (found by driving the
 *  shipped binary: [Agent(bg), Sleep] in one block never redirected). The
 *  wait may ARM during this window; past it, an unarmed wait is never
 *  relabelled by later-appearing work. */
export const TRACKED_ARM_GRACE_TICKS = 4 // × TRACKED_SETTLE_POLL_MS = 1 s

/** The task types whose completion the harness delivers on its own. Named
 *  explicitly rather than pattern-matched (`in_process_teammate` contains no
 *  "agent"), and held TOTAL against the TaskType union by
 *  prove-sleep-redirect: every union member is either tracked here or named
 *  in the documented exclusions below, so an eighth task type forces a
 *  decision instead of a silent miss. */
export const TRACKED_AGENT_TASK_TYPES: ReadonlySet<string> = new Set([
  'local_agent',
  'in_process_teammate',
  'remote_agent', // tasks/RemoteAgentTask — cloud sessions, harness-delivered
  'local_workflow', // tasks/LocalWorkflowTask — async orchestration; print.ts already awaits it
])

/** TaskType members deliberately NOT tracked, with the reason on the record.
 *  The prover holds TRACKED ∪ EXCLUDED === the TaskType union. */
export const UNTRACKED_TASK_TYPES: ReadonlyMap<string, string> = new Map([
  ['local_bash', 'the follow-up scopes the redirect to SUBAGENT work; shell waits are a different contract'],
  ['monitor_mcp', 'gated off by the MONITOR_TOOL feature macro in Mercury — no producer'],
  ['dream', 'internal daemon work; never model-awaited'],
])

/** Terminal statuses, MIRRORED from Task.ts isTerminalTaskStatus: importing
 *  the owner as a value drags Task.ts's disk-output chain into this tool and
 *  lands in a tools.ts TDZ cycle (§DEPS-TDZ). prove-sleep-redirect pins this
 *  mirror to the owner's literals, so they cannot drift apart silently. */
export const TERMINAL_TASK_STATUSES: ReadonlySet<string> = new Set([
  'completed',
  'failed',
  'killed',
])

/**
 * Agent tasks the HARNESS is tracking and still running.
 *
 * The measured waste class this guards: a model issues minutes of Sleep
 * (75+90+120+120 s in one benchmarked mission) polling a verification agent
 * whose completion the harness already owns. This is the mechanical half of
 * the fix — a fact the tool can check, rather than an instruction the model
 * is asked to remember.
 */
export function countTrackedRunningAgents(
  getAppState: () => AppState,
  selfTaskId?: string,
): number {
  let running = 0
  try {
    for (const task of Object.values(getAppState().tasks ?? {})) {
      const t = task as { id?: unknown; status?: unknown; type?: unknown }
      // Any NON-TERMINAL state counts: a just-dispatched task can sit
      // 'pending' for its first beat, and a wait issued in that beat is
      // exactly the dispatch-then-wait pattern this exists for.
      if (typeof t.status === 'string' && TERMINAL_TASK_STATUSES.has(t.status)) continue
      // A subagent's own task must not count as work it is waiting on —
      // local_agent task ids ARE the agent id, so an in-process subagent's
      // Sleep excludes itself. (A teammate's task id differs from its agent
      // id; its self-count keeps such waits at full duration — same as
      // before this fix, and benign.)
      if (selfTaskId !== undefined && t.id === selfTaskId) continue
      if (typeof t.type === 'string' && TRACKED_AGENT_TASK_TYPES.has(t.type)) running++
    }
  } catch {
    // A tool that cannot read the task registry simply waits as before —
    // the redirect is an optimisation, never a dependency.
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

/**
 * Sleep — wait for a specified duration without holding a shell process (unlike
 * `Bash(sleep …)`). Concurrency-safe: it can run alongside other tools and is
 * interruptible at any time via the turn's abort signal. The 'Sleep' name is
 * load-bearing — REPL's
 * isOnlySleeping() check keys off SLEEP_TOOL_NAME to keep the spinner calm.
 */
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
    // Per the tool prompt: "call this concurrently with other tools — it won't
    // interfere with them." A pure timer mutates nothing.
    return true
  },
  isReadOnly() {
    return true
  },
  // No security relevance — an explicit (unmarked) opt-out so the auto-mode
  // fail-closed classifier guard never blocks a benign wait.
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
    // a BACKGROUND session must never hold
    // its turn open to fake idling — ending the turn IS idle there (the
    // switchboard wakes it on the next delivery), and a fake-sleeping
    // worker blocks the operator's enter at the turn boundary. Short real
    // backoffs stay lawful; long waits refuse with the law.
    const { flagEnv } = await import('../../substrate/flagRegistry.js')
    if (flagEnv('MERCURY_CONCOURSE_WORKER') === '1' && seconds > 300) {
      throw new Error(
        'refused: this background session must not hold its turn open — ending the turn IS idling here; the switchboard wakes it on the next delivery. Use waits under 300s only for real short backoffs.',
      )
    }
    const ms = Math.max(0, Math.min(seconds, MAX_SLEEP_SECONDS)) * 1000
    const start = Date.now()
    let interrupted = false
    // THE REDIRECT. Polling harness-tracked work with
    // model-issued sleeps can dominate a mission's wall clock (28.5%
    // measured). Refusing the wait outright would take away the only way to
    // await async work in a headless run, so the wait REDIRECTS instead —
    // it settles the moment the tracked work does. The requested duration
    // stays the ceiling, the abort stays the floor, and a wait with nothing
    // tracked is unchanged.
    //
    // ARMING: decided at entry, OR within the first grace window — tool
    // calls in one assistant block start concurrently, so the canonical
    // dispatch-then-wait block registers its agent a beat after Sleep
    // enters. Past the grace window an unarmed wait is never relabelled by
    // later-appearing work.
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
            // Nothing tracked appeared in time — a plain wait from here on,
            // with zero steady-state cost.
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
