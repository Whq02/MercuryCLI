import { CREWMATE_TOOL_NAME } from './names/crewmate.js'
import { APOLLO_REVIEW_TOOL_NAME } from './names/apolloReview.js'
import { ASK_ADVISOR_TOOL_NAME } from '../ask-advisor/constants.js'
import { ASK_USER_QUESTION_TOOL_NAME } from '../ask-question/prompt.js'
import { COMPUTER_TOOL_NAME } from '../../integrations/desktop/toolName.js'
import { SEND_MESSAGE_TOOL_NAME } from './names/sendMessage.js'
import { RESUME_CREWMATE_TOOL_NAME } from './names/resumeCrewmate.js'
import { CRON_CREATE_TOOL_NAME, CRON_DELETE_TOOL_NAME } from '../cron/prompt.js'
import { SCHEDULE_WAKEUP_TOOL_NAME } from '../schedule-wakeup/prompt.js'
import { RECORD_CONVENTION_TOOL_NAME } from '../record-convention/prompt.js'
import { JOURNAL_TOOL_NAME } from '../journal/prompt.js'

type BarReason = 'present human' | 'past its own work' | 'recursion'

export const CREWMATE_BARRED_TOOLS: Readonly<Record<string, BarReason>> = {
  [ASK_USER_QUESTION_TOOL_NAME]: 'present human',
  [APOLLO_REVIEW_TOOL_NAME]: 'present human',
  [ASK_ADVISOR_TOOL_NAME]: 'present human',
  [COMPUTER_TOOL_NAME]: 'past its own work',
  [JOURNAL_TOOL_NAME]: 'past its own work',
  [CRON_CREATE_TOOL_NAME]: 'past its own work',
  [CRON_DELETE_TOOL_NAME]: 'past its own work',
  [SCHEDULE_WAKEUP_TOOL_NAME]: 'past its own work',
  [RECORD_CONVENTION_TOOL_NAME]: 'past its own work',
  [CREWMATE_TOOL_NAME]: 'recursion',
}

export const ALL_CREWMATE_DISALLOWED_TOOLS: Set<string> = new Set(Object.keys(CREWMATE_BARRED_TOOLS))
export const CUSTOM_CREWMATE_DISALLOWED_TOOLS: Set<string> = ALL_CREWMATE_DISALLOWED_TOOLS

export const RULE_INHERITS: Readonly<Partial<Record<string, readonly string[]>>> = Object.freeze(
  Object.assign(Object.create(null) as Partial<Record<string, readonly string[]>>, {
    [RESUME_CREWMATE_TOOL_NAME]: [SEND_MESSAGE_TOOL_NAME],
  }),
)
