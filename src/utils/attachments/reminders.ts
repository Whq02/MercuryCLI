// Reminder families — the TodoWrite/Task nag cadence (assistant-turn
// counted, Brief-gated off), the verify-plan reminder, the 1M-window
// compaction reminder, and the folded-dead context-efficiency nudge. Owned
// Mercury module.

import type { Message } from 'src/types/message.js'
import { toolMatchesName, type ToolUseContext } from '../../Tool.js'
import { getSessionId } from '../../bootstrap/state.js'
import { getFeatureValue_CACHED_MAY_BE_STALE } from '../../services/analytics/featureGates.js'
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

  // Newest-first walk; each counter freezes at its event.
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i]

    if (message?.type === 'assistant') {
      if (isThinkingMessage(message)) {
        // Thinking turns don't count against the cadence.
        continue
      }

      // The event check runs before the increment so the TodoWrite turn
      // itself never counts as "1 turn since write".
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
  // No TodoWrite tool ⇒ nothing to nag toward.
  if (
    !toolUseContext.options.tools.some(t =>
      toolMatchesName(t, TODO_WRITE_TOOL_NAME),
    )
  ) {
    return []
  }

  // A brief-first toolkit makes TodoWrite a side channel — the nag would
  // pull against the primary workflow, so it stays silent while the brief
  // tool is present. (BRIEF_TOOL_NAME is currently folded to null; the
  // gate is inert but keeps the shape for a re-enable.)
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

  // Both cadences must be due: enough turns without a write AND enough
  // since the last nag.
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

  // Same newest-first walk as the todo counter, keyed on task management.
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i]

    if (message?.type === 'assistant') {
      if (isThinkingMessage(message)) {
        continue
      }

      // Event check before increment — the managing turn itself is not
      // "a turn since management".
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

  // Same brief-first silencing as the todo nag (inert while
  // BRIEF_TOOL_NAME is folded to null).
  if (
    BRIEF_TOOL_NAME &&
    toolUseContext.options.tools.some(t => toolMatchesName(t, BRIEF_TOOL_NAME))
  ) {
    return []
  }

  // No TaskUpdate tool ⇒ nothing to nag toward.
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

  // Both cadences must be due, as with the todo nag.
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

  // The todo counter's newest-first walk, keyed on the contract tool.
  // null = the event NEVER happened (the never-surfaced case is the birth
  // ride: due immediately).
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

/**
 * WARM RE-SURFACING (coordinator-tooling ledger T3, mechanism 1 — the
 * abide design's no-agent-action half): the session's ADVISORY contract
 * re-enters context through the estate's one reminder plumbing. At birth —
 * a contract with no reminder in the transcript surfaces on the FIRST turn
 * (it "rides the agent's context at birth") — then periodically as the
 * session runs long, with the clock reset by the agent's own contract-tool
 * touches. Main session lane only (a subagent works its brief, not the
 * session's agreement); daemon-hosted sessions only (the role stamp);
 * closed contracts rest. Advisory always: the reminder informs, and
 * nothing anywhere gates on it.
 */
export async function getContractReminderAttachments(
  messages: Message[] | undefined,
  toolUseContext: ToolUseContext,
): Promise<Attachment[]> {
  // The session's own lane, not a subagent thread.
  if (toolUseContext.agentId !== undefined) return []
  // Only daemon-hosted session runners carry a contract record (the daemon
  // stamps MERCURY_CONCOURSE_WORKER=1 at spawn; fixed for the process life).
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
    // A torn record read is a quiet turn, never a turn failure.
    return []
  }
  if (contract === undefined || contract.status === 'closed') return []

  const { turnsSinceLastTouch, turnsSinceLastReminder } = getContractReminderTurnCounts(messages ?? [])
  const due =
    // The birth ride: never surfaced, never touched — inject now.
    (turnsSinceLastReminder === null && turnsSinceLastTouch === null) ||
    // The long-session cadence: both clocks past their thresholds (a
    // touch or a reminder each reset their own).
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

/**
 * Human turns since strategy mode exited (the plan_mode_exit attachment —
 * the moment implementation began); 0 when no exit marker exists.
 *
 * isHumanTurn does the load-bearing filtering: tool_result messages are
 * type:'user' without isMeta, and counting them would make a "10 human
 * turns" interval fire every ~10 tool calls instead.
 */
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

/**
 * Verify-plan reminder — FOLDED DEAD (always []). The original nudged the
 * model toward VerifyPlanExecution every N human turns after a strategy
 * exit; the fold kept the export and call site so a re-enable is one
 * body swap. getVerifyPlanReminderTurnCount above stays live — it is
 * parity-pinned and the cadence primitive a re-enable would use.
 */
export async function getVerifyPlanReminderAttachment(
  _messages: Message[] | undefined,
  _toolUseContext: ToolUseContext,
): Promise<Attachment[]> {
  return []
}

export function getCompactionReminderAttachment(
  messages: Message[],
  model: string,
): Attachment[] {
  if (!getFeatureValue_CACHED_MAY_BE_STALE('mercury_marble_fox', false)) {
    return []
  }

  if (!isAutoCompactEnabled()) {
    return []
  }

  const contextWindow = getContextWindowForModel(model, getSdkBetas())
  if (contextWindow < 1_000_000) {
    return []
  }

  const effectiveWindow = getEffectiveContextWindowSize(model)
  const usedTokens = tokenCountWithEstimation(messages)
  if (usedTokens < effectiveWindow * 0.25) {
    return []
  }

  return [{ type: 'compaction_reminder' }]
}

/**
 * The context-efficiency nudge — FOLDED DEAD (always []). When live, it
 * fired once per interval of unsnipped context growth, with all pacing
 * owned by shouldNudgeForSnips (the interval reset on nudges, snip
 * markers/boundaries, and compact boundaries).
 */
export function getContextEfficiencyAttachment(
  messages: Message[],
): Attachment[] {
  {
    return []
  }
  // (The snip-nudge tail — a gated require of the build-absent snipCompact.js —
  // was deleted: unreachable behind the folded return above, and minify already
  // tree-shook it out of every shipped bundle.)
}
