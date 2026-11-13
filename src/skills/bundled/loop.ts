import { registerBundledSkill } from '../bundledSkills.js'
import {
  CRON_CREATE_TOOL_NAME,
  CRON_DELETE_TOOL_NAME,
  CRON_LIST_TOOL_NAME,
  SATURN_BOARD_COMMAND,
  isSaturnSchedulingEnabled,
} from '../../tools/ScheduleCronTool/prompt.js'
import { SCHEDULE_WAKEUP_TOOL_NAME } from '../../tools/ScheduleWakeupTool/prompt.js'
import { MONITOR_TOOL_NAME } from '../../tools/MonitorTool/constants.js'
import { TASK_STOP_TOOL_NAME } from '../../tools/TaskStopTool/prompt.js'
import { SKILL_TOOL_NAME } from '../../tools/SkillTool/constants.js'
import {
  AUTONOMOUS_LOOP_DYNAMIC_SENTINEL,
  AUTONOMOUS_LOOP_SENTINEL,
  LOOP_FILE_DYNAMIC_SENTINEL,
  LOOP_FILE_SENTINEL,
  getAutonomousLoopPreamble,
  isDynamicLoopEnabled,
  isLoopDefaultPromptEnabled,
  logAutonomousLoopActivation,
  readLoopFile,
} from '../../services/loopFire.js'

const DEFAULT_INTERVAL = '10m'

const INTERVAL_TOKEN_RE = /^\d+\s*[smhd]$/i
const EVERY_CLAUSE_RE =
  /^every\s+\d+\s*(s|sec|secs|second|seconds|m|min|mins|minute|minutes|h|hr|hrs|hour|hours|d|day|days)$/i

const UNIT_OF: Record<string, 's' | 'm' | 'h' | 'd'> = {
  s: 's', sec: 's', secs: 's', second: 's', seconds: 's',
  m: 'm', min: 'm', mins: 'm', minute: 'm', minutes: 'm',
  h: 'h', hr: 'h', hrs: 'h', hour: 'h', hours: 'h',
  d: 'd', day: 'd', days: 'd',
}

export type LoopCadence = { cron: string; spoken: string; typed: string; rounded: boolean }

function nearestDivisor(n: number, of: number): number {
  let best = 1
  for (let candidate = 1; candidate <= of; candidate++) {
    if (of % candidate === 0 && Math.abs(candidate - n) < Math.abs(best - n)) best = candidate
  }
  return best
}

export function cadenceForInterval(input: string): LoopCadence | null {
  const match = /^(\d+)\s*([smhd])$/i.exec(input.trim()) ?? /^every\s+(\d+)\s*([a-z]+)$/i.exec(input.trim())
  if (!match) return null
  const count = Number.parseInt(match[1]!, 10)
  const unit = UNIT_OF[match[2]!.toLowerCase()]
  if (unit === undefined || !Number.isFinite(count) || count <= 0) return null
  const typed = `${count}${unit}`
  if (unit === 'd') {
    return { cron: `0 0 */${count} * *`, spoken: count === 1 ? 'every day at midnight' : `every ${count} days at midnight`, typed, rounded: false }
  }
  const minutes = unit === 's' ? Math.max(1, Math.ceil(count / 60)) : unit === 'm' ? count : count * 60
  if (minutes < 60) {
    const every = nearestDivisor(minutes, 60)
    return {
      cron: every === 1 ? '* * * * *' : `*/${every} * * * *`,
      spoken: every === 1 ? 'every minute' : `every ${every} minutes`,
      typed,
      rounded: unit === 's' || every !== count,
    }
  }
  const hours = nearestDivisor(Math.max(1, Math.round(minutes / 60)), 24)
  return {
    cron: `0 */${hours} * * *`,
    spoken: hours === 1 ? 'every hour' : `every ${hours} hours`,
    typed,
    rounded: unit === 's' || hours * 60 !== minutes,
  }
}

function clockLine(cadence: LoopCadence): string {
  const rounded = cadence.rounded ? ` — rounded from the ${cadence.typed} you typed` : ''
  return `\`cron\` = "${cadence.cron}" (${cadence.spoken}${rounded})`
}

const PARSING_RULES = `Parse the interval from the input:
1. Leading interval token ("5m check the deploy"): everything after it is the prompt.
2. Trailing "every <number> <time unit>" ("poll the queue every 2 minutes"): strip the clause and keep the rest as the prompt. Non-time "every" ("check every PR") stays in the prompt.`

const CRON_TABLE = `Interval → 5-field local-time cron (1-minute resolution):
- seconds round UP to one minute;
- 1–59 minutes → "*/N * * * *" when N divides 60, else the nearest divisor of 60;
- hours → "0 */N * * *" when N divides 24, else the nearest divisor of 24;
- days → "0 0 */N * *" (midnight).
If rounded, state the scheduled cadence before creating the job.`

function usageText(dynamic: boolean): string {
  return `Usage: /loop [interval] <prompt or /slash-command>

Repeats a prompt or slash command on a schedule. Suffixes: s, m, h, d (30s, 5m, 2h, 1d; 1-minute floor, seconds round up).
${dynamic ? 'Omit the interval to let the model pace itself between ticks.' : `Omit the interval for the ${DEFAULT_INTERVAL} default.`}

Examples:
- /loop 10m watch the CI run and report state changes
- /loop 2m /health
- /loop 4h triage any new issues
- /loop rebuild the search index every 30 minutes

No prompt was given: show this usage and schedule nothing.`
}

function fixedIntervalPrompt(input: string): string {
  return `Invoked /loop with: ${input}

${PARSING_RULES}
3. No interval: use ${DEFAULT_INTERVAL} and treat the whole input as the prompt.
If the parsed prompt is empty, show usage and schedule nothing.

${CRON_TABLE}

Call ${CRON_CREATE_TOOL_NAME} with \`cron\`, verbatim \`prompt\`, and \`recurring: true\`. Report the cadence, cron expression, ${SATURN_BOARD_COMMAND} board, and early cancel via ${CRON_DELETE_TOOL_NAME} with the returned id. Do not claim it is scheduled if ${CRON_CREATE_TOOL_NAME} returns an error or "Queued, not confirmed"; on "NOT confirmed", check ${CRON_LIST_TOOL_NAME} before retrying. Run tick one immediately (via ${SKILL_TOOL_NAME} if the prompt is a /slash-command).`
}

function dynamicPrompt(input: string): string {
  return `Invoked /loop with: ${input}

${PARSING_RULES}
3. No interval: the whole input is the prompt, self-paced.
If the parsed prompt is empty, show usage and schedule nothing.

Self-paced loop:
1. Run tick one now (via ${SKILL_TOOL_NAME} for a /slash-command).
2. When the next tick waits on an event (build, log line, process exit), arm ONE watch via ${MONITOR_TOOL_NAME} (\`persistent: true\`) or a \`run_in_background\` shell task. Events arrive as \`<task-notification>\` and wake the loop early. Keep the \`taskId\` from launch (or read \`mercury://execution\`); never re-arm an active watch.
3. Report to the user in text BEFORE calling ${SCHEDULE_WAKEUP_TOOL_NAME} (it ends the turn): state that the loop self-paces, any active watch, and the fallback delay.
4. Call ${SCHEDULE_WAKEUP_TOOL_NAME} last: \`prompt\` = the full original invocation prefixed with \`/loop\`, \`delaySeconds\` matched to the work (1200–1800s when a watch is armed), \`reason\` = one continuity line.
5. On a \`<task-notification>\` wake, handle that event first, then re-arm ${SCHEDULE_WAKEUP_TOOL_NAME}.
6. To end the loop: schedule no wake, call ${TASK_STOP_TOOL_NAME} on any armed watch (\`taskId\` from launch or \`mercury://execution\`), and a one-line outcome as the last line of your reply — skip it when the user themselves just said stop.`
}

function defaultPromptBody(dynamic: boolean, cadence: LoopCadence): string {
  const loopFile = readLoopFile()
  let heading: string
  let body: string
  let sentinel: string
  if (loopFile) {
    heading = `Loop instructions from ${loopFile.path}:`
    body = loopFile.content
    sentinel = dynamic ? LOOP_FILE_DYNAMIC_SENTINEL : LOOP_FILE_SENTINEL
  } else {
    heading = 'Autonomous default loop:'
    body = getAutonomousLoopPreamble()
    logAutonomousLoopActivation()
    sentinel = dynamic ? AUTONOMOUS_LOOP_DYNAMIC_SENTINEL : AUTONOMOUS_LOOP_SENTINEL
  }
  const sentinelRules = `Schedule the SENTINEL, not the text above: pass \`prompt\` = "${sentinel}" verbatim. Mercury expands it on first fire${loopFile ? ' and whenever the loop file changes' : ''}, sending a short reminder on unchanged ticks.`
  if (dynamic) {
    return `${heading}

${body}

${sentinelRules}

Run tick one now. Arm one watch if an event gates the next tick (${MONITOR_TOOL_NAME} with \`persistent: true\` or \`run_in_background\`), report to the user before waking, and end the turn with ${SCHEDULE_WAKEUP_TOOL_NAME} (\`delaySeconds\`, \`reason\`, \`prompt\` = "${sentinel}"). On a \`<task-notification>\` wake, handle the event then re-arm the wake. Ending the loop: no new wake, ${TASK_STOP_TOOL_NAME} on any watch, and a one-line outcome as the last line of your reply (skipped when the user just asked for the stop).`
  }
  return `${heading}

${body}

${sentinelRules}

Call ${CRON_CREATE_TOOL_NAME} with ${clockLine(cadence)}, \`prompt\` = "${sentinel}", and \`recurring: true\`. Report the cadence${loopFile ? '' : ' (noting this is the autonomous default loop)'} and ${SATURN_BOARD_COMMAND}, then run tick one now.`
}

export function loopPromptForInput(args: string): string {
  const input = args.trim()
  const isEmpty = input === ''
  const isBareInterval = INTERVAL_TOKEN_RE.test(input) || EVERY_CLAUSE_RE.test(input)
  const dynamic = isDynamicLoopEnabled()
  if ((isEmpty || isBareInterval) && isLoopDefaultPromptEnabled()) {
    const cadence = cadenceForInterval(isEmpty ? DEFAULT_INTERVAL : input)!
    return defaultPromptBody(isEmpty && dynamic, cadence)
  }
  if (dynamic) return isEmpty ? usageText(true) : dynamicPrompt(input)
  return isEmpty ? usageText(false) : fixedIntervalPrompt(input)
}

export function registerLoopSkill(): void {
  registerBundledSkill({
    name: 'loop',
    aliases: ['proactive'],
    description: () =>
      isDynamicLoopEnabled()
        ? 'Use when work should re-run on a cadence (polling a build, watching a queue, periodic upkeep, e.g. /loop 10m /health); without an interval the model paces itself between ticks. Not for one-shot future runs (use schedule).'
        : `Use when work should re-run on a cadence (polling a build, watching a queue, periodic upkeep, e.g. /loop 10m /health); default interval ${DEFAULT_INTERVAL}. Not for one-shot future runs (use schedule).`,
    menuDescription: 'Run a prompt on a schedule',
    argumentHint: () =>
      isLoopDefaultPromptEnabled() ? '[interval] [prompt or /slash-command]' : '[interval] <prompt or /slash-command>',
    isEnabled: () => isSaturnSchedulingEnabled(),
    getPromptForCommand: async args => [{ type: 'text', text: loopPromptForInput(args) }],
  })
}
