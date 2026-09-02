
import type { Message } from 'src/types/message.js'
import type { ToolUseContext } from '../../Tool.js'
import { getTotalCostUSD } from '../../bootstrap/state.js'
import {
  getAutoMemPath,
  isAutoMemoryEnabled,
} from '../../memdir/paths.js'
import {
  getTasteRecallContent,
  tasteLoopEnabled,
} from '../../memdir/tasteLoop.js'
import { buildImplementerAwarenessReminder } from '../scribe/implementerAwareness.js'
import { buildScribeAwarenessReminder } from '../scribe/scribeAwareness.js'
import type { Attachment } from './types.js'

export function getCriticalSystemReminderAttachment(
  toolUseContext: ToolUseContext,
  messages: readonly unknown[] = [],
): Attachment[] {
  const reminder = toolUseContext.criticalSystemReminder_EXPERIMENTAL
  if (!reminder) {
    return []
  }
  if (
    awarenessAlreadyEmittedThisTurn(
      messages,
      'critical_system_reminder',
      reminder,
    )
  ) {
    return []
  }
  return [{ type: 'critical_system_reminder', content: reminder }]
}

function awarenessAlreadyEmittedThisTurn(
  messages: readonly unknown[],
  type:
    | 'scribe_awareness'
    | 'implementer_awareness'
    | 'critical_system_reminder',
  content: string,
): boolean {
  const arr = messages as ReadonlyArray<{
    type?: string
    isMeta?: boolean
    toolUseResult?: unknown
    attachment?: { type?: string; content?: string }
  }>
  const lastUserIdx = arr.findLastIndex(
    m => m?.type === 'user' && !m.isMeta && !m.toolUseResult,
  )
  for (let i = arr.length - 1; i > lastUserIdx; i--) {
    const m = arr[i]
    if (
      m?.type === 'attachment' &&
      m.attachment?.type === type &&
      m.attachment?.content === content
    ) {
      return true
    }
  }
  return false
}

export function getScribeAwarenessAttachment(messages: readonly unknown[]): Attachment[] {
  const content = buildScribeAwarenessReminder(messages)
  if (!content) return []
  if (awarenessAlreadyEmittedThisTurn(messages, 'scribe_awareness', content)) return []
  return [{ type: 'scribe_awareness', content }]
}

export function getImplementerAwarenessAttachment(messages: readonly unknown[]): Attachment[] {
  const content = buildImplementerAwarenessReminder(messages)
  if (!content) return []
  if (awarenessAlreadyEmittedThisTurn(messages, 'implementer_awareness', content)) return []
  return [{ type: 'implementer_awareness', content }]
}

export async function getTasteRecallAttachment(
  toolUseContext: ToolUseContext,
  messages: Message[] | undefined,
): Promise<Attachment[]> {
  if (toolUseContext.agentId) return []
  if (!tasteLoopEnabled()) return []
  if (!isAutoMemoryEnabled()) return []
  const content = await getTasteRecallContent(getAutoMemPath(), messages ?? [])
  return content ? [{ type: 'taste_recall', content }] : []
}

export function getOutputTokenUsageAttachment(): Attachment[] {
  
  return []
}

export function getMaxBudgetUsdAttachment(maxBudgetUsd?: number): Attachment[] {
  if (maxBudgetUsd === undefined) {
    return []
  }

  const usedCost = getTotalCostUSD()
  const remainingBudget = maxBudgetUsd - usedCost

  return [
    {
      type: 'budget_usd',
      used: usedCost,
      total: maxBudgetUsd,
      remaining: remainingBudget,
    },
  ]
}
