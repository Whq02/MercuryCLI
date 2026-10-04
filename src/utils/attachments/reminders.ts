
import type { Message } from 'src/types/message.js'
import { toolMatchesName, type ToolUseContext } from '../../Tool.js'
import { getSessionId } from '../../bootstrap/state.js'
import {
  getEffectiveContextWindowSize,
  isAutoCompactEnabled,
} from '../../services/compact/autoCompact.js'
import { TASK_CREATE_TOOL_NAME } from '../../tools/TaskCreateTool/constants.js'
import { TASK_UPDATE_TOOL_NAME } from '../../tools/TaskUpdateTool/constants.js'
import { getContextWindowForModel } from '../context.js'
import { getSdkBetas } from '../../bootstrap/state.js'
import { isThinkingMessage } from '../messages.js'
import {
  getTaskListId,
  isTaskToolsEnabled,
  listTasks,
} from '../tasks.js'
import {
  tokenCountWithEstimation,
} from '../tokens.js'
import {
  CONTRACT_REMINDER_CONFIG,
  TASK_REMINDER_CONFIG,
  type Attachment,
} from './types.js'
import { flagEnv } from '../../substrate/flagRegistry.js'
import { CONTRACT_TOOL_NAME } from '../../tools/ContractTool/prompt.js'

function reminderClock(messages: Message[], kind: 'task_reminder' | 'contract_reminder', tools: readonly string[]) {
  let touched = false
  let reminded = false
  let turnsSinceTouch = 0
  let turnsSinceReminder = 0
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i]
    if (message?.type === 'assistant' && !isThinkingMessage(message)) {
      touched ||= Array.isArray(message.message.content) && message.message.content.some(
        block => block.type === 'tool_use' && tools.includes(block.name),
      )
      if (!touched) turnsSinceTouch++
      if (!reminded) turnsSinceReminder++
    } else if (message?.type === 'attachment' && message.attachment.type === kind) {
      reminded = true
    }
    if (touched && reminded) break
  }
  return { touched, reminded, turnsSinceTouch, turnsSinceReminder }
}

function getTaskReminderTurnCounts(messages: Message[]): {
  turnsSinceLastTaskManagement: number
  turnsSinceLastReminder: number
} {
  const clock = reminderClock(messages, 'task_reminder', [TASK_CREATE_TOOL_NAME, TASK_UPDATE_TOOL_NAME])
  return { turnsSinceLastTaskManagement: clock.turnsSinceTouch, turnsSinceLastReminder: clock.turnsSinceReminder }
}

export async function getTaskReminderAttachments(
  messages: Message[] | undefined,
  toolUseContext: ToolUseContext,
): Promise<Attachment[]> {
  if (!isTaskToolsEnabled()) {
    return []
  }

  if (
    !toolUseContext.options.tools.some(t =>
      toolMatchesName(t, TASK_UPDATE_TOOL_NAME),
    )
  ) {
    return []
  }

  if (!messages || messages.length === 0) {
    return []
  }

  const { turnsSinceLastTaskManagement, turnsSinceLastReminder } =
    getTaskReminderTurnCounts(messages)

  if (
    turnsSinceLastTaskManagement >= TASK_REMINDER_CONFIG.TURNS_SINCE_WRITE &&
    turnsSinceLastReminder >= TASK_REMINDER_CONFIG.TURNS_BETWEEN_REMINDERS
  ) {
    const tasks = await listTasks(getTaskListId())
    return [
      {
        type: 'task_reminder',
        content: tasks,
        itemCount: tasks.length,
      },
    ]
  }

  return []
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
  } catch {
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
  {
    return []
  }
}
