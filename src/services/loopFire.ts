
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { getProjectRoot } from '../bootstrap/state.js'
import { MONITOR_TOOL_NAME } from '../tools/MonitorTool/constants.js'
import { TASK_STOP_TOOL_NAME } from '../tools/TaskStopTool/prompt.js'
import { SCHEDULE_WAKEUP_TOOL_NAME } from '../tools/ScheduleWakeupTool/prompt.js'
import { getMercuryHome, isEnvTruthy } from '../utils/envUtils.js'
import { isENOENT } from '../utils/errors.js'
import { flagEnv } from '../substrate/flagRegistry.js'


export const LOOP_FILE_SENTINEL = '<<loop.md>>' as const
export const LOOP_FILE_DYNAMIC_SENTINEL = '<<loop.md-dynamic>>' as const
export const AUTONOMOUS_LOOP_SENTINEL = '<<autonomous-loop>>' as const
export const AUTONOMOUS_LOOP_DYNAMIC_SENTINEL = '<<autonomous-loop-dynamic>>' as const

function isAutonomousLoopSentinel(prompt: string): boolean {
  return (
    prompt === AUTONOMOUS_LOOP_SENTINEL ||
    prompt === AUTONOMOUS_LOOP_DYNAMIC_SENTINEL
  )
}

function isLoopFileSentinel(prompt: string): boolean {
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

function awayHintEnabled(): boolean {
  return flagEnv('MERCURY_LOOP_AWAY_HINT') !== '0'
}


const PREAMBLE_STANDARD = `# Autonomous loop

You are running an autonomous loop with no fixed task list. Each tick, advance the most useful next unit for this project (triage failing tests or CI, take the next in-flight plan item, review open diffs), keeping each tick small and leaving the tree clean.

If nothing needs doing this tick, say so briefly and end the tick without inventing busywork.`

const PREAMBLE_PERSISTENT = `# Autonomous loop (persistent)

You are running a persistent autonomous loop with no fixed task list. Each tick, advance the most useful next unit for this project (triage failing tests or CI, advance an in-flight plan, review open diffs), keeping each tick small and leaving the tree clean for the next tick.

End the loop only when newly blocked on a decision you cannot make alone or when the user tells you to stop; an idle tick ends briefly and waits for the next.`

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
  return `\n\nSay so in one line of your reply when the loop can't move further without the user, or when something landed that they'd want to act on now: ${endCondition}, or a major update arrived (CI went red, a review changes the plan). Progress you made yourself isn't a trigger — the transcript covers that. One ping per state, not per tick.`
}

const DYNAMIC_PACING_FOOTER = `\n\nIf the next tick waits on an event, arm one ${MONITOR_TOOL_NAME} watch with \`persistent: true\` (or a \`run_in_background\` shell task when ${MONITOR_TOOL_NAME} cannot express it; keep the \`taskId\` from launch or read \`mercury://execution\`, never re-arming an active watch): events arrive as \`<task-notification>\` messages and wake the loop early, so set \`delaySeconds\` to 1200–1800s as a fallback heartbeat. On a \`<task-notification>\` wake, handle the event before rescheduling. To stop the loop, also call ${TASK_STOP_TOOL_NAME} on that watch (\`taskId\` from launch or \`mercury://execution\`).`


const rescheduleReminder = (sentinel: string): string =>
  `Scheduled via ${SCHEDULE_WAKEUP_TOOL_NAME} (one-shot, not cron): call ${SCHEDULE_WAKEUP_TOOL_NAME} again at the end of this turn with \`prompt\` = \`${sentinel}\`, or the loop ends after this tick.`

function autonomousFixedTick(): string {
  return `# Autonomous loop tick

Run the autonomous check from the loop instructions earlier in this conversation (no-op if absent). The recurring cron fires the next tick — do not call ${SCHEDULE_WAKEUP_TOOL_NAME}.${sendMessageOutcomeHint()}`
}

function autonomousDynamicTick(): string {
  return `# Autonomous loop tick (dynamic pacing)

Run the autonomous check from the loop instructions earlier in this conversation (no-op if absent).

${rescheduleReminder(AUTONOMOUS_LOOP_DYNAMIC_SENTINEL)}${DYNAMIC_PACING_FOOTER}${sendMessageOutcomeHint()}`
}

function loopFileFixedTick(): string {
  return `# /loop tick — loop.md tasks

Work the tasks from loop.md earlier in this conversation (no-op if absent). The recurring cron fires the next tick — do not call ${SCHEDULE_WAKEUP_TOOL_NAME}.${sendMessageOutcomeHint(true)}`
}

function loopFileDynamicTick(): string {
  return `# /loop tick — loop.md tasks (dynamic pacing)

Work the tasks from loop.md earlier in this conversation (no-op if absent).

${rescheduleReminder(LOOP_FILE_DYNAMIC_SENTINEL)}${DYNAMIC_PACING_FOOTER}${sendMessageOutcomeHint(true)}`
}

function loopFileAbsentDynamicTick(): string {
  return `# /loop tick — loop.md absent (dynamic pacing)

loop.md is absent; run the autonomous check from the loop instructions earlier in this conversation.

${rescheduleReminder(LOOP_FILE_DYNAMIC_SENTINEL)}${DYNAMIC_PACING_FOOTER}${sendMessageOutcomeHint()}`
}


const LOOP_FILE_BYTE_CAP = 25000

function capLoopFile(content: string): string {
  if (content.length <= LOOP_FILE_BYTE_CAP) return content
  const boundary = content.lastIndexOf('\n', LOOP_FILE_BYTE_CAP)
  const cutAt = boundary > 0 ? boundary : LOOP_FILE_BYTE_CAP
  return `${content.slice(0, cutAt)}\n\n> WARNING: loop.md was truncated to ${LOOP_FILE_BYTE_CAP} bytes. Keep the task list concise.`
}

interface LoopFile {
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

function readLoopFileFrom(workspaceDir: string): LoopFile | null {
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
