// Session-context producers — the critical system reminder passthrough, the
// scribe/implementer per-turn awareness pair (content-aware per-turn throttle
// — an ungated generator re-injected every tool round), taste-loop recall,
// and the token/budget gauges.

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
  // The same per-turn dedup law the awareness pair carries:
  // getAttachments runs once per TOOL ROUND, and an ungated passthrough
  // re-injected the identical reminder on every round of a multi-round turn.
  // Changed content still fires immediately.
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

// PER-TURN throttle for the awareness attachments:
// getAttachments runs once per TOOL-ROUND inside queryLoop's while(true), so an
// ungated generator re-injected the (mostly static) reminder on EVERY round of a
// multi-round turn — permanent transcript bloat. Content-aware: suppress only
// when an IDENTICAL awareness attachment already landed since the last real user
// frame; changed content (a new inbound escalate mid-turn alters the built
// reminder) still fires. Mirrors the per-turn windowing the ultra_effort /
// memory-prefetch attachments already use.
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

// Scribe Mode "Amanuensis" per-turn awareness (W3c). Self-gated inside the builder
// (returns '' unless scribeModeEnabled() && isScribeRole()), so OFF /
// non-Scribe-process ⇒ [] ⇒ byte-identical. NOT behind feature() (those DCE).
export function getScribeAwarenessAttachment(messages: readonly unknown[]): Attachment[] {
  const content = buildScribeAwarenessReminder(messages)
  if (!content) return []
  if (awarenessAlreadyEmittedThisTurn(messages, 'scribe_awareness', content)) return []
  return [{ type: 'scribe_awareness', content }]
}

// Implementer per-turn awareness (mirror of scribe_awareness). Self-gated inside the
// builder (returns '' unless implementerModeEnabled() && isImplementerRole()), so OFF /
// non-Implementer-process ⇒ [] ⇒ byte-identical. NOT behind feature() (those DCE).
export function getImplementerAwarenessAttachment(messages: readonly unknown[]): Attachment[] {
  const content = buildImplementerAwarenessReminder(messages)
  if (!content) return []
  if (awarenessAlreadyEmittedThisTurn(messages, 'implementer_awareness', content)) return []
  return [{ type: 'implementer_awareness', content }]
}

// Taste Loop recall (fork). Main thread only (subagents carry their own doctrine,
// not the operator's session preferences). Self-gated: getTasteRecallContent returns
// null unless tasteLoopEnabled() AND the throttle allows AND promoted lessons exist,
// so OFF / throttled / empty ⇒ [] ⇒ byte-identical. NOT behind feature().
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
