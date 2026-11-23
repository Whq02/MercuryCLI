import { registerBundledSkill } from '../bundledSkills.js'
import {
  CRON_CREATE_TOOL_NAME,
  CRON_DELETE_TOOL_NAME,
  CRON_LIST_TOOL_NAME,
  isSaturnSchedulingEnabled,
} from '../../tools/ScheduleCronTool/prompt.js'
import { ASK_USER_QUESTION_TOOL_NAME } from '../../tools/AskUserQuestionTool/prompt.js'
import { SKILL_TOOL_NAME } from '../../constants/tools/skill.js'
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
    allowedTools: [
      CRON_CREATE_TOOL_NAME,
      CRON_DELETE_TOOL_NAME,
      CRON_LIST_TOOL_NAME,
      ASK_USER_QUESTION_TOOL_NAME,
    ],
    isEnabled: () => isSaturnSchedulingEnabled(),
    async getPromptForCommand(args: string) {
      const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone
      const daemonLine = await daemonStatusLine()
      const cwd = getCwd()
      const trimmed = args.trim()
      const firstStep =
        trimmed === ''
          ? `Call ${ASK_USER_QUESTION_TOOL_NAME} first with no preamble, using this exact question: "${OPENING_QUESTION}" — header "Action", options: Create / List / Update / Run now.`
          : 'The user intent is quoted at the end — skip the opening question and run the matching workflow.'
      const body = [
        'Manage daemon-scheduled local agents in Mercury.',
        '',
        `Local time zone: ${timeZone}`,
        `Project root: ${cwd}`,
        daemonLine,
        '',
        firstStep,
        '',
        'Workflows:',
        `- Create: gather the prompt, cadence or one-time expression in local time (${timeZone}), and whether it repeats (\`recurring: true\` for cron routines, \`recurring: false\` for one-shot future runs), then call ${CRON_CREATE_TOOL_NAME}.`,
        `- List: call ${CRON_LIST_TOOL_NAME} and present each job's id, schedule, recurrence, and prompt.`,
        `- Update: call ${CRON_LIST_TOOL_NAME} to locate the target id, confirm the replacement details, delete the old schedule with ${CRON_DELETE_TOOL_NAME}, and create the updated one with ${CRON_CREATE_TOOL_NAME}.`,
        `- Run now: call ${CRON_LIST_TOOL_NAME} to fetch the job's prompt and execute it directly (use ${SKILL_TOOL_NAME} when the prompt is a /slash-command).`,
      ].join('\n')
      const text =
        trimmed === ''
          ? body
          : `${body}\n\nUser request (start from this intent): "${trimmed}"`
      return [{ type: 'text', text }]
    },
  })
}
