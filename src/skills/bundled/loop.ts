// ============================================================================
//  src/skills/bundled/loop.ts — /loop (alias /proactive): repeat a prompt or
//  slash command on a schedule — a fixed cron beat, or model self-paced
//  wakeups in dynamic mode.
// ============================================================================
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
import { TASK_LIST_TOOL_NAME } from '../../tools/TaskListTool/constants.js'
import { TASK_STOP_TOOL_NAME } from '../../tools/TaskStopTool/prompt.js'
import { SEND_MESSAGE_TOOL_NAME } from '../../tools/SendMessageTool/constants.js'
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

/** The fixed-pacing fallback cadence when no interval is given (the
 *  loopFire gates document the same 10m fallback). */
const DEFAULT_INTERVAL = '10m'

/** A bare interval token: digits + s|m|h|d. */
const INTERVAL_TOKEN_RE = /^\d+\s*[smhd]$/i
/** A whole-input "every N unit" clause (promptless invocation). */
const EVERY_CLAUSE_RE =
  /^every\s+\d+\s*(s|sec|secs|second|seconds|m|min|mins|minute|minutes|h|hr|hrs|hour|hours|d|day|days)$/i

const UNIT_OF: Record<string, 's' | 'm' | 'h' | 'd'> = {
  s: 's', sec: 's', secs: 's', second: 's', seconds: 's',
  m: 'm', min: 'm', mins: 'm', minute: 'm', minutes: 'm',
  h: 'h', hr: 'h', hrs: 'h', hour: 'h', hours: 'h',
  d: 'd', day: 'd', days: 'd',
}

/** The cadence a bare interval schedules: its cron expression, the words
 *  for it, the interval as typed, and whether the two differ (a rounding is
 *  named, never silent). */
export type LoopCadence = { cron: string; spoken: string; typed: string; rounded: boolean }

/** The divisor of `of` nearest to `n` (the lowest on a tie). */
function nearestDivisor(n: number, of: number): number {
  let best = 1
  for (let candidate = 1; candidate <= of; candidate++) {
    if (of % candidate === 0 && Math.abs(candidate - n) < Math.abs(best - n)) best = candidate
  }
  return best
}

/**
 * The cron cadence for a bare interval token or an "every N unit" clause —
 * the same rules the model is taught for a prompted invocation: seconds
 * round UP to one minute; minute counts move to the nearest divisor of 60,
 * hour counts to the nearest divisor of 24, so the hour's (day's) last gap
 * never runs short; days fire at local midnight. Null when the input is not
 * an interval at all.
 */
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

/** The clock line for a fixed cadence: the expression, its words, and the
 *  rounding when the cadence differs from what was typed. */
function clockLine(cadence: LoopCadence): string {
  const rounded = cadence.rounded ? ` — rounded from the ${cadence.typed} you typed` : ''
  return `\`cron\` = "${cadence.cron}" (${cadence.spoken}${rounded})`
}

const PARSING_RULES = `Find the interval in the input:
1. An input that LEADS with an interval token ("5m check the deploy") names its interval up front; everything after the token is the prompt.
2. An input that ENDS with an "every <number> <time unit>" clause ("poll the queue every 2 minutes") names it at the tail; strip the clause and keep the rest as the prompt. "Every" over anything that is not a span of time ("check every PR") belongs to the prompt and names no interval.`

const CRON_TABLE = `Interval → 5-field cron expression (local time; the scheduler's resolution is one minute):
- seconds round UP to one minute;
- 1–59 minutes → "*/N * * * *", exact only when N divides 60 — otherwise the hour's last gap runs short, so move to the nearest divisor of 60;
- whole hours that divide 24 → "0 */N * * *"; hour counts that do not divide 24 get the same last-gap unevenness, so move to a divisor;
- days → "0 0 */N * *", firing at local midnight.
Whenever the scheduled cadence differs from the words the user used, say what was actually scheduled before creating the job.`

function usageText(dynamic: boolean): string {
  return `Usage: /loop [interval] <prompt or /slash-command>

Repeats a prompt or slash command on a schedule.
Interval suffixes: s, m, h, d — 30s, 5m, 2h, 1d. One minute is the floor; seconds round up.
${dynamic ? 'Leave the interval out and the model paces itself between ticks.' : `Leave the interval out and the default is ${DEFAULT_INTERVAL}.`}

Examples:
- /loop 10m watch the CI run and report state changes
- /loop 2m /health
- /loop 4h triage any new issues
- /loop rebuild the search index every 30 minutes

The invocation carried no prompt: show the user this usage and schedule nothing.`
}

function fixedIntervalPrompt(input: string): string {
  return `The user invoked /loop with: ${input}

${PARSING_RULES}
3. No interval anywhere in the input: use the default ${DEFAULT_INTERVAL}, with the whole input as the prompt.
An empty prompt after parsing means show the usage and schedule nothing.

${CRON_TABLE}

Create the schedule with the ${CRON_CREATE_TOOL_NAME} tool: \`cron\` = the expression, \`prompt\` = the parsed prompt VERBATIM, \`recurring\` set. Then report what is on the clock: the cadence in plain words, the expression itself, that the ${SATURN_BOARD_COMMAND} board lists every schedule, and that ${CRON_DELETE_TOOL_NAME} (with the id ${CRON_LIST_TOOL_NAME} shows once the daemon applies the submission) cancels early. Then run the parsed prompt once, now — tick one does not wait out the first interval. A /slash-command prompt runs through the ${SKILL_TOOL_NAME} tool.`
}

function dynamicPrompt(input: string): string {
  return `The user invoked /loop with: ${input}

${PARSING_RULES}
3. No interval anywhere in the input: the whole input is the prompt, and the loop paces itself.
An empty prompt after parsing means show the usage and schedule nothing.

Self-paced loop:
1. Run the parsed prompt now — that is tick one. A /slash-command prompt runs through the ${SKILL_TOOL_NAME} tool.
2. A next tick that waits on an observable event (a build, a log line, a process exiting) deserves a watch, armed ONCE: the ${MONITOR_TOOL_NAME} tool with \`persistent\` set, or a \`run_in_background\` shell task where Monitor cannot express the condition. Watch events arrive as \`<task-notification>\` messages and wake the loop ahead of any timer. Consult ${TASK_LIST_TOOL_NAME} before arming — a loop that re-arms its watch every tick leaks tasks.
3. Report to the user in text BEFORE scheduling the wake — the wake call is the turn's final act, so anything said after it never lands this turn. Cover: the loop self-paces, what is watching (if anything), and the fallback delay.
4. Call ${SCHEDULE_WAKEUP_TOOL_NAME} last: \`prompt\` = the ENTIRE original invocation verbatim, prefixed with /loop, so the next fire re-enters this skill; \`delaySeconds\` chosen from the work's own rhythm — with a watch armed, lean long (1200–1800 seconds; the watch does the waking and the timer is only a heartbeat); \`reason\` = one line for your own continuity.
5. A tick woken by a \`<task-notification>\` handles that event first, then re-arms the same wake.
6. Ending the loop = three acts: no new wake; ${TASK_STOP_TOOL_NAME} any armed watch (${TASK_LIST_TOOL_NAME} finds its id); and a one-line outcome through ${SEND_MESSAGE_TOOL_NAME}, because the user may be away — skip that message when the user themselves just said stop.`
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
  const sentinelRules = `Schedule the SENTINEL, not the text above: the scheduled prompt is EXACTLY the string ${sentinel}. Mercury expands it at every fire — the full instructions on the first delivery${loopFile ? ', and again in full whenever the loop file changed since the last fire' : ''}, then a short per-tick reminder while nothing changed, which keeps the long text in the conversation's cached prefix instead of repeating it. Pasting the instructions into the scheduled prompt yourself defeats that mechanism.`
  if (dynamic) {
    return `${heading}

${body}

${sentinelRules}

Run tick one now. Then follow the self-paced steps: arm a watch when an observable event gates the next tick (${MONITOR_TOOL_NAME} with \`persistent\`, or a \`run_in_background\` shell task), report to the user in text, and end the turn with ${SCHEDULE_WAKEUP_TOOL_NAME} (\`delaySeconds\`, \`reason\`, \`prompt\` = the sentinel). A tick woken by a \`<task-notification>\` handles the event, then re-arms the same wake. Ending the loop = no new wake, ${TASK_STOP_TOOL_NAME} on any watch, and a one-line outcome through ${SEND_MESSAGE_TOOL_NAME} first (skipped when the user just asked for the stop).`
  }
  return `${heading}

${body}

${sentinelRules}

Create a recurring schedule with the ${CRON_CREATE_TOOL_NAME} tool: ${clockLine(cadence)}, \`prompt\` = the sentinel, \`recurring\` set. Report what is on the clock — the cadence in plain words${loopFile ? '' : ', and say plainly that this is the autonomous default loop'} — and that the ${SATURN_BOARD_COMMAND} board lists it — then run tick one now.`
}

/** The prompt /loop hands the model for one invocation (the skill's one
 *  dispatch, exported so the cadence law is provable without the registry). */
export function loopPromptForInput(args: string): string {
  const input = args.trim()
  const isEmpty = input === ''
  const isBareInterval = INTERVAL_TOKEN_RE.test(input) || EVERY_CLAUSE_RE.test(input)
  const dynamic = isDynamicLoopEnabled()
  if ((isEmpty || isBareInterval) && isLoopDefaultPromptEnabled()) {
    // A bare interval schedules the default loop at THAT cadence; only a
    // truly empty input in dynamic mode self-paces, and an empty input in
    // fixed mode takes the default cadence.
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
        ? 'Run a prompt or slash command repeatedly (for example /loop 10m /health); with no interval given, the model paces itself between ticks.'
        : `Run a prompt or slash command repeatedly (for example /loop 10m /health); with no interval given, the cadence is ${DEFAULT_INTERVAL}.`,
    menuDescription: 'Run a prompt on a schedule',
    argumentHint: () =>
      isLoopDefaultPromptEnabled() ? '[interval] [prompt or /slash-command]' : '[interval] <prompt or /slash-command>',
    whenToUse:
      'Use when work should re-run on a cadence: polling a build, watching a queue, periodic upkeep. A single future reminder is not a loop — schedule those directly as one-shot cron jobs.',
    isEnabled: () => isSaturnSchedulingEnabled(),
    getPromptForCommand: async args => [{ type: 'text', text: loopPromptForInput(args) }],
  })
}
