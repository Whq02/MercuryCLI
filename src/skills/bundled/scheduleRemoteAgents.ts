import { registerBundledSkill } from '../bundledSkills.js'
import {
  CRON_CREATE_TOOL_NAME,
  CRON_DELETE_TOOL_NAME,
  CRON_LIST_TOOL_NAME,
  isSaturnSchedulingEnabled,
} from '../../tools/ScheduleCronTool/prompt.js'
import { ASK_USER_QUESTION_TOOL_NAME } from '../../tools/AskUserQuestionTool/prompt.js'
import { SKILL_TOOL_NAME } from '../../tools/SkillTool/constants.js'
import { getMercuryDaemonStatus } from '../../daemon/status.js'
import { getCwd } from '../../utils/cwd.js'
import { binaryName } from '../../utils/config/derived.js'
import { logForDebugging } from '../../utils/debug.js'

const OPENING_QUESTION =
  'What would you like to do with scheduled agents? Create a new one, list the existing ones, update one, or run one now?'

async function daemonStatusLine(): Promise<string> {
  try {
    const status = await getMercuryDaemonStatus()
    if (status.daemon) {
      const control = status.controlReachable
        ? 'control channel reachable'
        : 'control channel not answering'
      return `Daemon: RUNNING — pid ${status.daemon.pid}, up ${status.daemon.uptimeSec}s, in ${status.daemon.dir}; ${control}. Durable jobs will fire with this session closed as long as that daemon stays up.`
    }
    return `Daemon: NOT running. Schedules live on the daemon-hosted session record and only fire while a daemon is running (inside a run without a daemon session record, ${CRON_CREATE_TOOL_NAME} refuses). Start one in the project directory with: ${binaryName()} daemon (or ${binaryName()} daemon run to stay in the foreground).`
  } catch (error) {
    logForDebugging(`schedule: daemon probe failed: ${String(error)}`, { level: 'warn' })
    return 'Daemon: status could not be determined. Schedules live on the daemon-hosted session record and only fire while a daemon is alive.'
  }
}

export function registerScheduleRemoteAgentsSkill(): void {
  registerBundledSkill({
    name: 'schedule',
    description:
      'Create, update, list, or run scheduled local agents (routines) that execute on a cron schedule via the daemon',
    whenToUse:
      'Use when the user wants a recurring agent, automated background tasks, a cron job for the harness, or management of existing scheduled agents. Also for a one-time scheduled run ("run this once at 3pm").',
    isEnabled: () => isSaturnSchedulingEnabled(),
    allowedTools: [
      CRON_CREATE_TOOL_NAME,
      CRON_DELETE_TOOL_NAME,
      CRON_LIST_TOOL_NAME,
      ASK_USER_QUESTION_TOOL_NAME,
    ],
    getPromptForCommand: async args => {
      const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone
      const daemonLine = await daemonStatusLine()
      const projectRoot = getCwd()
      const trimmed = args.trim()

      const firstStep = trimmed
        ? 'The user already said what they want (quoted at the end) — skip the opening question and go straight to the matching workflow, starting from their intent.'
        : `Your FIRST action must be a single ${ASK_USER_QUESTION_TOOL_NAME} call with no preamble. Use EXACTLY this question, not paraphrased or shortened: "${OPENING_QUESTION}" — header "Action", four options: Create / List / Update / Run now.`

      const text = `Manage scheduled local agents. These are LOCAL schedules on this session's durable record, fired by the daemon into this session (even when parked) under the user's own credentials, with full local tool access — not cloud agents. There is no separate trigger object and no remote run (to start a brand-new scheduled session on a clock instead of firing into this session, the user presses \`a\` on the /saturn board).

${daemonLine}
Project root: ${projectRoot}
User time zone: ${timeZone}

Tools: ${CRON_CREATE_TOOL_NAME} creates a schedule (\`cron\` for repeating, or \`at\` / \`delayMinutes\` for one-shot, plus optional \`title\` and \`onParked\`); ${CRON_LIST_TOOL_NAME} lists them; ${CRON_DELETE_TOOL_NAME} cancels one by id. A schedule is a SESSION FACT on the durable session record — it persists with the session and survives restarts (the daemon fires it); \`recurring\` (with \`cron\`) or \`at\`/\`delayMinutes\` picks a standing job versus a one-shot.

${firstStep}

Cron guidance: five-field expressions in the user's LOCAL time zone (${timeZone}) — no UTC conversion. Examples:
- "0 9 * * 1-5" — 09:00 every weekday
- "*/15 * * * *" — every 15 minutes
- "30 18 * * 5" — 18:30 on Fridays
- "0 0 1 * *" — midnight on the 1st of the month
- "45 7 * * *" — 07:45 daily
Scheduling hygiene: when the requested time is approximate, nudge off the :00 and :30 marks to an off-minute; pin those marks only when that exact minute came from the user.

Workflows:
- CREATE: understand what the agent must do on each fire. The prompt comes back verbatim at each fire in ${projectRoot} with no memory of why it was set and often with no human watching, so the per-fire prompt must be self-contained: the task, what success is, the files/areas involved, the actions to take. Set the schedule, confirm the cadence, then create with \`cron\` (and \`recurring\`), \`at\`, or \`delayMinutes\`, the verbatim \`prompt\`, and an optional \`title\` (a schedule is a session fact on the durable record — it survives restarts and the daemon fires it). Confirm from ${CRON_CREATE_TOOL_NAME}'s answer: the id, the expression, the human-readable cadence, the next fire time, and the cancel path (${CRON_DELETE_TOOL_NAME} with that id); if it answered with an error or "Queued, not confirmed", do not claim the job is scheduled. For "NOT confirmed", check ${CRON_LIST_TOOL_NAME} before retrying. When no daemon is running, tell the user it will not fire in the background until they start one.
- LIST: ${CRON_LIST_TOOL_NAME}, then show id (and title when set), human-readable timing, kind (fire or birth), and the next fire (or paused state).
- UPDATE: there is NO in-place update. List, confirm the change, delete the old schedule, create a new one, and tell the user the old id was replaced.
- RUN NOW: identify the job (list when the user did not say which) and execute its prompt IMMEDIATELY in this session — via the ${SKILL_TOOL_NAME} tool when it is a slash command — rather than waiting for the next fire. Optionally also schedule a one-shot with delayMinutes: 1 when the user specifically wants it to go through the scheduler.

Notes:
- Local, headless, own credentials, no human in the loop.
- A durable job only fires in the background while a daemon runs; otherwise only while a foreground session is open.
- The scheduling board shows every schedule — next fire, kind, held fires: /saturn.
- The daemon caps concurrent fires via MERCURY_DAEMON_MAX_INFLIGHT (default 4) and carries a loop-stop brake and circuit breaker, so a fast cadence cannot spawn unbounded agents.
- Always convert cron to a human-readable cadence when displaying it.${
        trimmed
          ? `\n\nUser request (start from this intent): "${trimmed}"`
          : ''
      }`
      return [{ type: 'text', text }]
    },
  })
}
