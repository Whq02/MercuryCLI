
import type { Message } from 'src/types/message.js'
import { toolMatchesName, type ToolUseContext } from '../../Tool.js'
import { getSessionId } from '../../bootstrap/state.js'
import {
  getEffectiveContextWindowSize,
  isAutoCompactEnabled,
} from '../../services/compact/autoCompact.js'
import { TASK_CREATE_TOOL_NAME } from '../../tools/TaskCreateTool/constants.js'
import { TASK_UPDATE_TOOL_NAME } from '../../tools/TaskUpdateTool/constants.js'
import { TODO_WRITE_TOOL_NAME } from '../../tools/TodoWriteTool/constants.js'
import { getContextWindowForModel } from '../context.js'
import { getSdkBetas } from '../../bootstrap/state.js'
import { isThinkingMessage } from '../messages.js'
import { isHumanTurn } from '../messagePredicates.js'
import {
  getTaskListId,
  isTodoV2Enabled,
  listTasks,
} from '../tasks.js'
import {
  tokenCountWithEstimation,
} from '../tokens.js'
import {
  CONTRACT_REMINDER_CONFIG,
  TODO_REMINDER_CONFIG,
  type Attachment,
} from './types.js'
import { flagEnv } from '../../substrate/flagRegistry.js'
import { CONTRACT_TOOL_NAME } from '../../tools/ContractTool/prompt.js'

const BRIEF_TOOL_NAME: string | null =
  null

function getTodoReminderTurnCounts(messages: Message[]): {
  turnsSinceLastTodoWrite: number
  turnsSinceLastReminder: number
} {
  let lastTodoWriteIndex = -1
  let lastReminderIndex = -1
  let assistantTurnsSinceWrite = 0
  let assistantTurnsSinceReminder = 0

  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i]

    if (message?.type === 'assistant') {
      if (isThinkingMessage(message)) {
        continue
      }

      if (
        lastTodoWriteIndex === -1 &&
        'message' in message &&
        Array.isArray(message.message?.content) &&
        message.message.content.some(
          block => block.type === 'tool_use' && block.name === 'TodoWrite',
        )
      ) {
        lastTodoWriteIndex = i
      }

      if (lastTodoWriteIndex === -1) assistantTurnsSinceWrite++
      if (lastReminderIndex === -1) assistantTurnsSinceReminder++
    } else if (
      lastReminderIndex === -1 &&
      message?.type === 'attachment' &&
      message.attachment.type === 'todo_reminder'
    ) {
      lastReminderIndex = i
    }

    if (lastTodoWriteIndex !== -1 && lastReminderIndex !== -1) {
      break
    }
  }

  return {
    turnsSinceLastTodoWrite: assistantTurnsSinceWrite,
    turnsSinceLastReminder: assistantTurnsSinceReminder,
  }
}

export async function getTodoReminderAttachments(
  messages: Message[] | undefined,
  toolUseContext: ToolUseContext,
): Promise<Attachment[]> {
  if (
    !toolUseContext.options.tools.some(t =>
      toolMatchesName(t, TODO_WRITE_TOOL_NAME),
    )
  ) {
    return []
  }

  if (
    BRIEF_TOOL_NAME &&
    toolUseContext.options.tools.some(t => toolMatchesName(t, BRIEF_TOOL_NAME))
  ) {
    return []
  }

  if (!messages || messages.length === 0) {
    return []
  }

  const { turnsSinceLastTodoWrite, turnsSinceLastReminder } =
    getTodoReminderTurnCounts(messages)

  if (
    turnsSinceLastTodoWrite >= TODO_REMINDER_CONFIG.TURNS_SINCE_WRITE &&
    turnsSinceLastReminder >= TODO_REMINDER_CONFIG.TURNS_BETWEEN_REMINDERS
  ) {
    const todoKey = toolUseContext.agentId ?? getSessionId()
    const appState = toolUseContext.getAppState()
    const todos = appState.todos[todoKey] ?? []
    return [
      {
        type: 'todo_reminder',
        content: todos,
        itemCount: todos.length,
      },
    ]
  }

  return []
}

function getTaskReminderTurnCounts(messages: Message[]): {
  turnsSinceLastTaskManagement: number
  turnsSinceLastReminder: number
} {
  let lastTaskManagementIndex = -1
  let lastReminderIndex = -1
  let assistantTurnsSinceTaskManagement = 0
  let assistantTurnsSinceReminder = 0

  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i]

    if (message?.type === 'assistant') {
      if (isThinkingMessage(message)) {
        continue
      }

      if (
        lastTaskManagementIndex === -1 &&
        'message' in message &&
        Array.isArray(message.message?.content) &&
        message.message.content.some(
          block =>
            block.type === 'tool_use' &&
            (block.name === TASK_CREATE_TOOL_NAME ||
              block.name === TASK_UPDATE_TOOL_NAME),
        )
      ) {
        lastTaskManagementIndex = i
      }

      if (lastTaskManagementIndex === -1) assistantTurnsSinceTaskManagement++
      if (lastReminderIndex === -1) assistantTurnsSinceReminder++
    } else if (
      lastReminderIndex === -1 &&
      message?.type === 'attachment' &&
      message.attachment.type === 'task_reminder'
    ) {
      lastReminderIndex = i
    }

    if (lastTaskManagementIndex !== -1 && lastReminderIndex !== -1) {
      break
    }
  }

  return {
    turnsSinceLastTaskManagement: assistantTurnsSinceTaskManagement,
    turnsSinceLastReminder: assistantTurnsSinceReminder,
  }
}

export async function getTaskReminderAttachments(
  messages: Message[] | undefined,
  toolUseContext: ToolUseContext,
): Promise<Attachment[]> {
  if (!isTodoV2Enabled()) {
    return []
  }

  if (
    BRIEF_TOOL_NAME &&
    toolUseContext.options.tools.some(t => toolMatchesName(t, BRIEF_TOOL_NAME))
  ) {
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
    turnsSinceLastTaskManagement >= TODO_REMINDER_CONFIG.TURNS_SINCE_WRITE &&
    turnsSinceLastReminder >= TODO_REMINDER_CONFIG.TURNS_BETWEEN_REMINDERS
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
  let lastTouchIndex = -1
  let lastReminderIndex = -1
  let assistantTurnsSinceTouch = 0
  let assistantTurnsSinceReminder = 0

  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i]

    if (message?.type === 'assistant') {
      if (isThinkingMessage(message)) {
        continue
      }

      if (
        lastTouchIndex === -1 &&
        'message' in message &&
        Array.isArray(message.message?.content) &&
        message.message.content.some(
          block => block.type === 'tool_use' && block.name === CONTRACT_TOOL_NAME,
        )
      ) {
        lastTouchIndex = i
      }

      if (lastTouchIndex === -1) assistantTurnsSinceTouch++
      if (lastReminderIndex === -1) assistantTurnsSinceReminder++
    } else if (
      lastReminderIndex === -1 &&
      message?.type === 'attachment' &&
      message.attachment.type === 'contract_reminder'
    ) {
      lastReminderIndex = i
    }

    if (lastTouchIndex !== -1 && lastReminderIndex !== -1) {
      break
    }
  }

  return {
    turnsSinceLastTouch: lastTouchIndex === -1 ? null : assistantTurnsSinceTouch,
    turnsSinceLastReminder: lastReminderIndex === -1 ? null : assistantTurnsSinceReminder,
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
    const { readSessionWorkers } = await import('../../daemon/concourseSupervisor.js')
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

export function getVerifyPlanReminderTurnCount(messages: Message[]): number {
  let turnCount = 0
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i]
    if (message && isHumanTurn(message)) {
      turnCount++
    }
    if (
      message?.type === 'attachment' &&
      message.attachment.type === 'plan_mode_exit'
    ) {
      return turnCount
    }
  }
  return 0
}

export async function getVerifyPlanReminderAttachment(
  _messages: Message[] | undefined,
  _toolUseContext: ToolUseContext,
): Promise<Attachment[]> {
  return []
}

export function getContextEfficiencyAttachment(
  messages: Message[],
): Attachment[] {
  {
    return []
  }
}
