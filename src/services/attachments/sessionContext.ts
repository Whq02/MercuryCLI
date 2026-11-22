import type { ToolUseContext } from '../../Tool.js'
import { getTotalCostUSD } from '../../bootstrap/state.js'
import { providerLimitWarningFacts } from '../providers/limitWarning.js'
import { getInitialSettings } from '../../utils/settings/settings.js'
import type { Attachment } from '../../utils/attachments/types.js'
import { passedOver } from '../../utils/passedOver.js'
import { notBuilt } from '../../pi/holes.js'

export function getCriticalSystemReminderAttachment(
  toolUseContext: ToolUseContext,
  messages?: readonly unknown[],
): Attachment[] {
  return notBuilt('src/services/attachments/sessionContext.ts:9')
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

const usageLimitNoticed = new Set<string>()

export function getUsageLimitNoticeAttachment(
  toolUseContext: ToolUseContext,
  messages: readonly unknown[] = [],
  reads?: NonNullable<Parameters<typeof providerLimitWarningFacts>[0]>['reads'],
): Attachment[] {
  if (getInitialSettings().engine?.usageNotice !== true) return []
  let facts: ReturnType<typeof providerLimitWarningFacts>
  try {
    facts = providerLimitWarningFacts({ model: toolUseContext.options.engineModel, ...(reads !== undefined ? { reads } : {}) })
  } catch (error) {
    passedOver(error)
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
  return notBuilt('src/services/attachments/sessionContext.ts:88')
}

export function getMaxBudgetUsdAttachment(maxBudgetUsd?: number): Attachment[] {
  return notBuilt('src/services/attachments/sessionContext.ts:102')
}
