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

type ReminderClock = {
  touched: boolean
  reminded: boolean
  turnsSinceTouch: number
  turnsSinceReminder: number
}

function reminderClock(
  messages: Message[],
  kind: 'task_reminder' | 'contract_reminder',
  tools: readonly string[],
): ReminderClock {
  let touched = false
  let reminded = false
  let turnsSinceTouch = 0
  let turnsSinceReminder = 0
  for (let i = messages.length - 1; i >= 0; i--) {
    if (touched && reminded) break
    const message = messages[i]
    if (!message) continue
    if (message.type === 'attachment' && message.attachment.type === kind) {
      if (!reminded) reminded = true
      continue
    }
    if (message.type !== 'assistant' || isThinkingMessage(message)) continue
    if (!touched) {
      const content = message.message.content
      const hasTouch =
        Array.isArray(content) &&
        content.some(block => block.type === 'tool_use' && tools.includes(block.name))
      if (hasTouch) {
        touched = true
      } else {
        turnsSinceTouch++
      }
    }
    if (!reminded) {
      turnsSinceReminder++
    }
  }
  return { touched, reminded, turnsSinceTouch, turnsSinceReminder }
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
  if (!isTaskToolsEnabled()) return []
  if (!context.options.tools.some(tool => toolMatchesName(tool, TASK_UPDATE_TOOL_NAME))) {
    return []
  }
  if (!messages || messages.length === 0) return []
  if (!taskReminderDue(messages)) return []
  const content = await listTasks(getTaskListId())
  return [{ type: 'task_reminder', content, itemCount: content.length }]
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
  _messages: Message[],
): Attachment[] {
  return []
}
