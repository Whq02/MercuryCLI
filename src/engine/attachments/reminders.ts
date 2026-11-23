import type { Message } from 'src/engine/message-shapes/message.js'
import { toolMatchesName, type ToolUseContext } from '../../tools/kit/tool.js'
import { TASK_CREATE_TOOL_NAME } from '../../tools/kit/names/taskCreate.js'
import { TASK_UPDATE_TOOL_NAME } from '../../tools/kit/names/taskUpdate.js'
import { isThinkingMessage } from '../messages/messages.js'
import {
  getTaskListId,
  isTaskToolsEnabled,
  listTasks,
} from '../task-framework/tasks.js'
import {
  TASK_REMINDER_CONFIG,
  type Attachment,
} from '../attachment-shapes/attachmentTypes.js'

type ReminderClock = {
  turnsSinceTouch: number
  turnsSinceReminder: number
}

function reminderClock(
  messages: Message[],
  kind: 'task_reminder',
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
  return { turnsSinceTouch, turnsSinceReminder }
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

export function getContextEfficiencyAttachment(
  _messages: Message[],
): Attachment[] {
  return []
}
