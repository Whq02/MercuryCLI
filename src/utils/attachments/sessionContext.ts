
import type { Message } from 'src/types/message.js'
import type { ToolUseContext } from '../../Tool.js'
import { getTotalCostUSD } from '../../bootstrap/state.js'
import { providerLimitWarningFacts } from '../../services/providers/limitWarning.js'
import { getSettings_DEPRECATED } from '../settings/settings.js'
import type { Attachment } from './types.js'

export function getCriticalSystemReminderAttachment(
  toolUseContext: ToolUseContext,
  messages: readonly unknown[] = [],
): Attachment[] {
  const reminder = toolUseContext.standingRule
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
  type: 'critical_system_reminder',
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

export function getOutputTokenUsageAttachment(): Attachment[] {

  return []
}

const usageLimitNoticed = new Set<string>()

export function getUsageLimitNoticeAttachment(
  toolUseContext: ToolUseContext,
  messages: readonly unknown[] = [],
  reads?: NonNullable<Parameters<typeof providerLimitWarningFacts>[0]>['reads'],
): Attachment[] {
  if (getSettings_DEPRECATED().engine?.usageNotice !== true) return []
  let facts: ReturnType<typeof providerLimitWarningFacts>
  try {
    facts = providerLimitWarningFacts({ model: toolUseContext.options.engineModel, ...(reads !== undefined ? { reads } : {}) })
  } catch {
    return []
  }
  if (facts === null) return []
  const key = facts.view.key ?? `${facts.view.provider}|${facts.windowKey}|${facts.resetsAtSeconds ?? ''}`
  if (usageLimitNoticed.has(key) || usageLimitNoticeAlreadyInTranscript(messages, key)) return []
  usageLimitNoticed.add(key)
  return [
    {
      type: 'usage_limit_notice',
      key,
      provider: facts.view.provider,
      window: facts.windowName,
      pct: facts.pct,
      ...(facts.resetsAtSeconds !== undefined ? { resetsAt: facts.resetsAtSeconds } : {}),
      text: facts.view.text,
    },
  ]
}

function usageLimitNoticeAlreadyInTranscript(messages: readonly unknown[], key: string): boolean {
  const arr = messages as ReadonlyArray<{
    type?: string
    attachment?: { type?: string; key?: string }
  }>
  for (let i = arr.length - 1; i >= 0; i--) {
    const m = arr[i]
    if (m?.type === 'attachment' && m.attachment?.type === 'usage_limit_notice' && m.attachment.key === key) {
      return true
    }
  }
  return false
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
