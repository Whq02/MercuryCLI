import { AGENT_TOOL_NAME } from '../tools/AgentTool/constants.js'
import { APOLLO_REVIEW_TOOL_NAME } from '../tools/ApolloReviewTool/constants.js'
import { ASK_ADVISOR_TOOL_NAME } from '../tools/AskAdvisorTool/constants.js'
import { ASK_USER_QUESTION_TOOL_NAME } from '../tools/AskUserQuestionTool/prompt.js'
import { COMPUTER_TOOL_NAME } from '../services/desktop/toolName.js'
import { SEND_MESSAGE_TOOL_NAME } from '../tools/SendMessageTool/constants.js'
import { RESUME_AGENT_TOOL_NAME } from '../tools/ResumeAgentTool/constants.js'
import { CRON_CREATE_TOOL_NAME, CRON_DELETE_TOOL_NAME } from '../tools/ScheduleCronTool/prompt.js'
import { SCHEDULE_WAKEUP_TOOL_NAME } from '../tools/ScheduleWakeupTool/prompt.js'
import { RECORD_CONVENTION_TOOL_NAME } from '../tools/RecordConventionTool/prompt.js'
import { WORKFLOW_TOOL_NAME } from '../tools/WorkflowTool/constants.js'
import { JOURNAL_TOOL_NAME } from '../tools/JournalTool/prompt.js'

type BarReason = 'present human' | 'past its own work' | 'recursion'

export const CREWMATE_BARRED_TOOLS: Readonly<Record<string, BarReason>> = {
  [ASK_USER_QUESTION_TOOL_NAME]: 'present human',
  [APOLLO_REVIEW_TOOL_NAME]: 'present human',
  [ASK_ADVISOR_TOOL_NAME]: 'present human',
  [COMPUTER_TOOL_NAME]: 'past its own work',
  [JOURNAL_TOOL_NAME]: 'past its own work',
  [WORKFLOW_TOOL_NAME]: 'past its own work',
  [CRON_CREATE_TOOL_NAME]: 'past its own work',
  [CRON_DELETE_TOOL_NAME]: 'past its own work',
  [SCHEDULE_WAKEUP_TOOL_NAME]: 'past its own work',
  [RECORD_CONVENTION_TOOL_NAME]: 'past its own work',
  [AGENT_TOOL_NAME]: 'recursion',
}

export const ALL_AGENT_DISALLOWED_TOOLS: Set<string> = new Set(Object.keys(CREWMATE_BARRED_TOOLS))
export const CUSTOM_AGENT_DISALLOWED_TOOLS: Set<string> = ALL_AGENT_DISALLOWED_TOOLS

export const RULE_INHERITS: Readonly<Partial<Record<string, readonly string[]>>> = {
  [RESUME_AGENT_TOOL_NAME]: [SEND_MESSAGE_TOOL_NAME],
}
