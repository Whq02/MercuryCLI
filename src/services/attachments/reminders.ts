import type { Message } from 'src/types/message.js'
import { toolMatchesName, type ToolUseContext } from '../../Tool.js'
import { getSessionId } from '../../bootstrap/state.js'
import { TASK_CREATE_TOOL_NAME } from '../../constants/tools/taskCreate.js'
import { TASK_UPDATE_TOOL_NAME } from '../../constants/tools/taskUpdate.js'
import { isThinkingMessage } from '../messages.js'
import {
  getTaskListId,
  isTaskToolsEnabled,
  listTasks,
} from '../../utils/tasks.js'
import {
  CONTRACT_REMINDER_CONFIG,
  TASK_REMINDER_CONFIG,
  type Attachment,
} from '../../utils/attachments/types.js'
import { flagEnv } from '../../substrate/flagRegistry.js'
import { CONTRACT_TOOL_NAME } from '../../constants/tools/contract.js'
import { passedOver } from '../../utils/passedOver.js'
import { notBuilt, type Unbuilt } from '../../pi/holes.js'

function reminderClock(messages: Message[], kind: 'task_reminder' | 'contract_reminder', tools: readonly string[]): Unbuilt {
  return notBuilt('src/services/attachments/reminders.ts:22')
}

function taskReminderDue(messages: Message[]): boolean {
  const clock = reminderClock(messages, 'task_reminder', [TASK_CREATE_TOOL_NAME, TASK_UPDATE_TOOL_NAME])
  return [
    clock.turnsSinceTouch - TASK_REMINDER_CONFIG.TURNS_SINCE_WRITE,
    clock.turnsSinceReminder - TASK_REMINDER_CONFIG.TURNS_BETWEEN_REMINDERS,
  ].every(remaining => remaining >= 0)
}

export async function getTaskReminderAttachments(
  messages: Message[] | undefined,
  context: ToolUseContext,
): Promise<Attachment[]> {
  return notBuilt('src/services/attachments/reminders.ts:51')
}

function getContractReminderTurnCounts(messages: Message[]): {
  turnsSinceLastTouch: number | null
  turnsSinceLastReminder: number | null
} {
  const clock = reminderClock(messages, 'contract_reminder', [CONTRACT_TOOL_NAME])
  return {
    turnsSinceLastTouch: clock.touched ? clock.turnsSinceTouch : null,
    turnsSinceLastReminder: clock.reminded ? clock.turnsSinceReminder : null,
  }
}

export async function getContractReminderAttachments(
  messages: Message[] | undefined,
  toolUseContext: ToolUseContext,
): Promise<Attachment[]> {
  if (toolUseContext.agentId !== undefined) return []
  if (flagEnv('MERCURY_CONCOURSE_WORKER') !== '1') return []

  let contract: { text: string; status: string; amendments: { length: number } } | undefined
  try {
    const { readSessionWorkers } = await import('../../daemon/concourseWorkers.js')
    const sessionId = getSessionId()
    const rec = Object.values(readSessionWorkers()).find(
      r => r.sessionId === sessionId && r.endedAt === undefined,
    )
    contract = rec?.contract
  } catch (error) {
    passedOver(error)
    return []
  }
  if (contract === undefined || contract.status === 'closed') return []

  const { turnsSinceLastTouch, turnsSinceLastReminder } = getContractReminderTurnCounts(messages ?? [])
  const due =
    (turnsSinceLastReminder === null && turnsSinceLastTouch === null) ||
    ((turnsSinceLastReminder === null || turnsSinceLastReminder >= CONTRACT_REMINDER_CONFIG.TURNS_BETWEEN_REMINDERS) &&
      (turnsSinceLastTouch === null || turnsSinceLastTouch >= CONTRACT_REMINDER_CONFIG.TURNS_SINCE_TOUCH))
  if (!due) return []

  return [
    {
      type: 'contract_reminder',
      text: contract.text,
      status: contract.status,
      amendments: contract.amendments.length,
      ackOwed: contract.status === 'draft' || contract.status === 'amended',
    },
  ]
}

export function getContextEfficiencyAttachment(
  messages: Message[],
): Attachment[] {
  return notBuilt('src/services/attachments/reminders.ts:113')
}
