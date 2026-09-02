
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { getProjectRoot } from '../bootstrap/state.js'
import { MONITOR_TOOL_NAME } from '../tools/MonitorTool/constants.js'
import { SEND_MESSAGE_TOOL_NAME } from '../tools/SendMessageTool/constants.js'
import { TASK_LIST_TOOL_NAME } from '../tools/TaskListTool/constants.js'
import { TASK_STOP_TOOL_NAME } from '../tools/TaskStopTool/prompt.js'
import { SCHEDULE_WAKEUP_TOOL_NAME } from '../tools/ScheduleWakeupTool/prompt.js'
import { getMercuryHome, isEnvTruthy } from '../utils/envUtils.js'
import { isENOENT } from '../utils/errors.js'
import { flagEnv } from '../substrate/flagRegistry.js'


export const LOOP_FILE_SENTINEL = '<<loop.md>>' as const
export const LOOP_FILE_DYNAMIC_SENTINEL = '<<loop.md-dynamic>>' as const
export const AUTONOMOUS_LOOP_SENTINEL = '<<autonomous-loop>>' as const
export const AUTONOMOUS_LOOP_DYNAMIC_SENTINEL = '<<autonomous-loop-dynamic>>' as const

export function isAutonomousLoopSentinel(prompt: string): boolean {
  return (
    prompt === AUTONOMOUS_LOOP_SENTINEL ||
    prompt === AUTONOMOUS_LOOP_DYNAMIC_SENTINEL
  )
}

export function isLoopFileSentinel(prompt: string): boolean {
  return prompt === LOOP_FILE_SENTINEL || prompt === LOOP_FILE_DYNAMIC_SENTINEL
}


const PREAMBLE_SENT_MARKER = '__autonomous_preamble__'

export interface LoopFireChainStateV1 {
  preambleSent: boolean
  lastExpandedBody: string | null
}

export function freshLoopFireChainState(): LoopFireChainStateV1 {
  return { preambleSent: false, lastExpandedBody: null }
}

const moduleChain: LoopFireChainStateV1 = freshLoopFireChainState()


export function isLoopPersistentPreambleEnabled(): boolean {
  if (isEnvTruthy(flagEnv('MERCURY_LOOP_PERSISTENT'))) {
    return true
  }
  return flagEnv('MERCURY_LOOP_PERSISTENT') !== '0'
}

export function isLoopDefaultPromptEnabled(): boolean {
  return flagEnv('MERCURY_LOOP_PROMPT') !== '0'
}

export function isDynamicLoopEnabled(): boolean {
  return flagEnv('MERCURY_LOOP_DYNAMIC') !== '0'
}

export function isLoopKeepaliveEnabled(): boolean {
  return flagEnv('MERCURY_LOOP_KEEPALIVE') !== '0'
}

function awayHintEnabled(): boolean {
  return flagEnv('MERCURY_LOOP_AWAY_HINT') !== '0'
}


const PREAMBLE_STANDARD = `# Autonomous loop

You are running an autonomous loop with no fixed task list. Each tick, do the most useful next thing for the current project: triage failing tests or CI, pick up the next item on an in-flight plan, review open diffs, or otherwise advance whatever work is in front of you. Keep each tick small and self-contained — finish one concrete unit, leave the tree in a clean state, and let the next tick continue.

If there is genuinely nothing to do this tick, say so briefly and end the tick — do not invent busywork.`

const PREAMBLE_PERSISTENT = `# Autonomous loop (persistent)

You are running a persistent autonomous loop with no fixed task list. Each tick, do the most useful next thing for the current project and keep the loop alive across ticks: triage failing tests or CI, advance an in-flight plan, review open diffs, or otherwise move the work forward. Keep each tick small and self-contained — finish one concrete unit and leave the tree clean for the next tick.

This loop is meant to keep running. End it only when you are newly blocked on a decision you cannot make alone, or the user tells you to stop. If a single tick has nothing to do, end that tick briefly and wait for the next — do not end the whole loop.`

export function getAutonomousLoopPreamble(): string {
  return isLoopPersistentPreambleEnabled() ? PREAMBLE_PERSISTENT : PREAMBLE_STANDARD
}

export function logAutonomousLoopActivation(): void {
}


function sendMessageOutcomeHint(isLoopFileMode = false): string {
  if (!awayHintEnabled()) return ''
  const softEnd = !isLoopFileMode && isLoopPersistentPreambleEnabled()
  const endCondition = softEnd
    ? "newly blocked on a decision you won't make alone, you're ending the loop"
    : "newly blocked on a decision you won't make alone, third straight tick with nothing to do, you're ending the loop"
  return `\n\nUse ${SEND_MESSAGE_TOOL_NAME} when the loop can't move further without the user, or when something landed that they'd want to act on now: ${endCondition}, or a major update arrived (CI went red, a review changes the plan). Progress you made yourself isn't a trigger — the transcript covers that. One ping per state, not per tick.`
}

const DYNAMIC_PACING_FOOTER = `\n\nIf the next tick is gated on an event, prefer a ${MONITOR_TOOL_NAME} watch on the log/process/command (or, for watches it doesn't fit, a long-running \`run_in_background\` Bash task — check ${TASK_LIST_TOOL_NAME}): its events arrive as \`<task-notification>\` messages and wake this loop immediately, so keep \`delaySeconds\` at 1200–1800s — the watch is your wake signal and this is only the fallback heartbeat. If you were woken by a \`<task-notification>\`, handle the event before rescheduling. To stop the loop, also ${TASK_STOP_TOOL_NAME} that watch (use ${TASK_LIST_TOOL_NAME} to find its task ID if it is no longer in context).`


const rescheduleReminder = (sentinel: string): string =>
  `You scheduled this tick via the ${SCHEDULE_WAKEUP_TOOL_NAME} tool (not a recurring cron). To keep the loop alive, call ${SCHEDULE_WAKEUP_TOOL_NAME} again at the end of this turn with \`prompt\` set to the literal sentinel \`${sentinel}\` — otherwise the loop ends after this tick.`

function autonomousFixedTick(): string {
  return `# Autonomous loop tick

Run the autonomous check using the loop instructions established earlier in this conversation. If you cannot find them, treat this as a no-op tick. The recurring cron will fire the next tick automatically — do not call ${SCHEDULE_WAKEUP_TOOL_NAME} from this tick.${sendMessageOutcomeHint()}`
}

function autonomousDynamicTick(): string {
  return `# Autonomous loop tick (dynamic pacing)

Run the autonomous check using the loop instructions established earlier in this conversation. If you cannot find them, treat this as a no-op tick.

${rescheduleReminder(AUTONOMOUS_LOOP_DYNAMIC_SENTINEL)}${DYNAMIC_PACING_FOOTER}${sendMessageOutcomeHint()}`
}

function loopFileFixedTick(): string {
  return `# /loop tick — loop.md tasks

Work the tasks from the loop.md contents established earlier in this conversation. If you cannot find them, treat this as a no-op tick. The recurring cron will fire the next tick automatically — do not call ${SCHEDULE_WAKEUP_TOOL_NAME} from this tick.${sendMessageOutcomeHint(true)}`
}

function loopFileDynamicTick(): string {
  return `# /loop tick — loop.md tasks (dynamic pacing)

Work the tasks from the loop.md contents established earlier in this conversation. If you cannot find them, treat this as a no-op tick.

${rescheduleReminder(LOOP_FILE_DYNAMIC_SENTINEL)}${DYNAMIC_PACING_FOOTER}${sendMessageOutcomeHint(true)}`
}

function loopFileAbsentDynamicTick(): string {
  return `# /loop tick — loop.md absent (dynamic pacing)

loop.md is not currently present. Run the autonomous check using the loop instructions established earlier in this conversation.

You scheduled this tick via the ${SCHEDULE_WAKEUP_TOOL_NAME} tool (not a recurring cron). To keep the loop alive — and to pick up loop.md if it is recreated — call ${SCHEDULE_WAKEUP_TOOL_NAME} again at the end of this turn with \`prompt\` set to the literal sentinel \`${LOOP_FILE_DYNAMIC_SENTINEL}\` — otherwise the loop ends after this tick.${DYNAMIC_PACING_FOOTER}${sendMessageOutcomeHint()}`
}


const LOOP_FILE_BYTE_CAP = 25000

function capLoopFile(content: string): string {
  if (content.length <= LOOP_FILE_BYTE_CAP) return content
  const boundary = content.lastIndexOf('\n', LOOP_FILE_BYTE_CAP)
  const cutAt = boundary > 0 ? boundary : LOOP_FILE_BYTE_CAP
  return `${content.slice(0, cutAt)}\n\n> WARNING: loop.md was truncated to ${LOOP_FILE_BYTE_CAP} bytes. Keep the task list concise.`
}

export interface LoopFile {
  path: string
  content: string
}

export function readLoopFile(): LoopFile | null {
  for (const candidate of [
    join(getMercuryHome(), 'loop.md'),
    join(getProjectRoot(), 'loop.md'),
  ]) {
    let raw: string
    try {
      raw = readFileSync(candidate, 'utf-8')
    } catch (err) {
      if (isENOENT(err) || (err as NodeJS.ErrnoException)?.code === 'EISDIR') {
        continue
      }
      throw err
    }
    const trimmed = raw.trim()
    if (trimmed.length === 0) continue
    return { path: candidate, content: capLoopFile(trimmed) }
  }
  return null
}


function resolveAutonomousWith(prompt: string, chain: LoopFireChainStateV1): string | null {
  if (!isAutonomousLoopSentinel(prompt)) return null
  if (!isLoopDefaultPromptEnabled()) return null
  logAutonomousLoopActivation()
  const tickBody =
    prompt === AUTONOMOUS_LOOP_DYNAMIC_SENTINEL
      ? autonomousDynamicTick()
      : autonomousFixedTick()
  if (chain.preambleSent || chain.lastExpandedBody !== null) return tickBody
  chain.preambleSent = true
  return `${getAutonomousLoopPreamble()}\n\n---\n\n${tickBody}`
}

function resolveLoopFileWith(
  prompt: string,
  chain: LoopFireChainStateV1,
  loopFile: LoopFile | null,
): string | null {
  if (!isLoopFileSentinel(prompt)) return null
  if (!isLoopDefaultPromptEnabled()) return null

  const isDynamic = prompt === LOOP_FILE_DYNAMIC_SENTINEL

  if (loopFile !== null) {
    const tickBody = isDynamic ? loopFileDynamicTick() : loopFileFixedTick()
    if (chain.lastExpandedBody === loopFile.content) return tickBody
    chain.lastExpandedBody = loopFile.content
    return `# /loop tick — tasks from ${loopFile.path}\n\nThe user configured a loop-tasks file. Work through the tasks defined below; these are the instructions for this tick and every subsequent tick (the reminder on later fires refers back to this message).\n\n---\n\n${loopFile.content}\n\n---\n\n${tickBody}`
  }

  logAutonomousLoopActivation()
  const fallbackBody = isDynamic ? loopFileAbsentDynamicTick() : autonomousFixedTick()
  if (chain.lastExpandedBody === PREAMBLE_SENT_MARKER || chain.preambleSent) {
    return fallbackBody
  }
  chain.lastExpandedBody = PREAMBLE_SENT_MARKER
  chain.preambleSent = true
  return `${getAutonomousLoopPreamble()}\n\n---\n\n${fallbackBody}`
}

export function resolveAutonomousLoopFire(prompt: string): string | null {
  return resolveAutonomousWith(prompt, moduleChain)
}

export function resolveLoopFileFire(prompt: string): string | null {
  return resolveLoopFileWith(prompt, moduleChain, readLoopFile())
}

export function resolveLoopDefaultFire(prompt: string): string {
  return (
    resolveAutonomousLoopFire(prompt) ?? resolveLoopFileFire(prompt) ?? prompt
  )
}

export function resolveLoopFireForWorkspace(
  prompt: string,
  workspaceDir: string,
  chain: LoopFireChainStateV1,
): string {
  return (
    resolveAutonomousWith(prompt, chain) ??
    resolveLoopFileWith(prompt, chain, readLoopFileFrom(workspaceDir)) ??
    prompt
  )
}

export function readLoopFileFrom(workspaceDir: string): LoopFile | null {
  for (const candidate of [join(getMercuryHome(), 'loop.md'), join(workspaceDir, 'loop.md')]) {
    let raw: string
    try {
      raw = readFileSync(candidate, 'utf-8')
    } catch (err) {
      if (isENOENT(err) || (err as NodeJS.ErrnoException)?.code === 'EISDIR') {
        continue
      }
      throw err
    }
    const trimmed = raw.trim()
    if (trimmed.length === 0) continue
    return { path: candidate, content: capLoopFile(trimmed) }
  }
  return null
}
