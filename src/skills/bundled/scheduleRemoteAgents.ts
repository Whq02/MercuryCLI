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
      return `Daemon: RUNNING — pid ${status.daemon.pid}, up ${status.daemon.uptimeSec}s, in ${status.daemon.dir}; ${control}.`
    }
    return `Daemon: NOT running. Schedules only fire in the background while a daemon runs (without a daemon session record, ${CRON_CREATE_TOOL_NAME} refuses). Start one in the project directory with \`${binaryName()} daemon\` (or \`${binaryName()} daemon run\` in the foreground).`
  } catch (error) {
    logForDebugging(`schedule: daemon probe failed: ${String(error)}`, { level: 'warn' })
    return 'Daemon: status unknown. Background firing requires a running daemon.'
  }
}

export function registerScheduleRemoteAgentsSkill(): void {
  registerBundledSkill({
    name: 'schedule',
    description:
      'Use when creating, listing, updating, or running daemon-scheduled local agents (cron routines, recurring background tasks, or a one-time future run like "at 3pm"). Not for in-session cadence polling (/loop).',
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
        ? 'The user intent is quoted at the end — skip the opening question and run the matching workflow.'
        : `Call ${ASK_USER_QUESTION_TOOL_NAME} first with no preamble, using this exact question: "${OPENING_QUESTION}" — header "Action", options: Create / List / Update / Run now.`

      const text = `Manage scheduled local agents. Schedules fire into this session (even when parked) via the local daemon under the user's own credentials with local tools — never cloud agents, and with no separate trigger object (to birth a brand-new scheduled session instead, the user presses \`a\` on \`/saturn\`).

${daemonLine}
Project root: ${projectRoot}
User time zone: ${timeZone}

Tools: ${CRON_CREATE_TOOL_NAME} (\`cron\` + \`recurring\` for repeating, or \`at\` / \`delayMinutes\` for one-shot, plus optional \`title\` and \`onParked\`); ${CRON_LIST_TOOL_NAME}; ${CRON_DELETE_TOOL_NAME} (by id). Each schedule is a SESSION FACT on the durable session record, persisting across restarts.

${firstStep}

Cron format: 5-field expressions in local time (${timeZone}), never UTC-converted:
- \`"0 9 * * 1-5"\` — 09:00 weekdays
- \`"*/15 * * * *"\` — every 15 minutes
- \`"30 18 * * 5"\` — 18:30 Fridays
- \`"0 0 1 * *"\` — midnight on the 1st
- \`"45 7 * * *"\` — 07:45 daily
When the requested time is approximate, pick an off-minute rather than \`:00\` or \`:30\`; use \`:00\`/\`:30\` only when explicitly requested. Always display cron expressions alongside a human-readable cadence.

Workflows:
- CREATE: write a self-contained \`prompt\` (each fire runs unattended in ${projectRoot} without memory of why it was scheduled: state the task, target files/areas, actions, and success criteria). Confirm the cadence, then call ${CRON_CREATE_TOOL_NAME}. Report the returned id, expression, human-readable cadence, next fire time, and cancel path (${CRON_DELETE_TOOL_NAME} with that id). Never claim a job is scheduled if ${CRON_CREATE_TOOL_NAME} returns an error or "Queued, not confirmed"; on "NOT confirmed", check ${CRON_LIST_TOOL_NAME} before retrying. If no daemon is running, note that background fires wait until one starts (foreground-only until then).
- LIST: call ${CRON_LIST_TOOL_NAME}; show id (and title if set), human-readable cadence, kind (\`fire\` or \`birth\`), and next fire or paused state.
- UPDATE: no in-place update exists — list, confirm the change, delete the old id, create the replacement, and report the new id.
- RUN NOW: identify the job (listing first if unspecified) and execute its prompt immediately in this session (via ${SKILL_TOOL_NAME} when it is a slash command), or schedule a one-shot with \`delayMinutes: 1\` if the user explicitly wants a scheduler fire.

Limits & board: \`/saturn\` shows next fires, kinds, and held fires. \`MERCURY_DAEMON_MAX_INFLIGHT\` (default 4), the loop-stop brake, and the circuit breaker bound concurrent fires.${
        trimmed
          ? `\n\nUser request (start from this intent): "${trimmed}"`
          : ''
      }`
      return [{ type: 'text', text }]
    },
  })
}
