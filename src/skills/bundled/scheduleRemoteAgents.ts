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
import { notBuilt } from '../../pi/holes.js'

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
  return notBuilt('src/skills/bundled/scheduleRemoteAgents.ts:34')
}
