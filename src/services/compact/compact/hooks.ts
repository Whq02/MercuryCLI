import type { ToolUseContext } from '../../../Tool.js'
import type { Message } from '../../../types/message.js'
import { createAttachmentMessage } from '../../../utils/attachments/orchestrator.js'
import { fireHooks, type HookFireResult } from '../../../utils/hooks/fire.js'
import { boundHookContext } from '../../../utils/hooks/contextBound.js'
import { hookRowsOfResult } from '../../../utils/hooks/rows.js'
import { getSessionId } from '../../../bootstrap/state.js'
import { createUserMessage } from '../../../utils/messages.js'

function compactionHookScope(context: ToolUseContext): { sessionId: string; crewmateId?: string } {
  return { sessionId: String(getSessionId()), ...(context.agentId !== undefined ? { crewmateId: context.agentId } : {}) }
}

export async function compactionBeforeHooks(context: ToolUseContext, facts: { trigger: 'manual' | 'auto' | 'overflow'; instructions?: string; tokens: number }): Promise<HookFireResult> {
  context.onCompactProgress?.({ type: 'hooks_start', hookType: 'pre_compact' })
  return fireHooks('compaction.before', { trigger: facts.trigger, ...(facts.instructions !== undefined ? { instructions: facts.instructions } : {}), tokens: facts.tokens }, { scope: compactionHookScope(context), signal: context.abortController.signal, toolUseContext: context })
}

export async function compactionAfterHooks(context: ToolUseContext, facts: { method: 'summary' | 'notes' | 'digest'; trigger: 'manual' | 'auto' | 'overflow'; tokensBefore: number; tokensAfter: number; summary?: string }): Promise<Message[]> {
  context.onCompactProgress?.({ type: 'hooks_start', hookType: 'post_compact' })
  const result = await fireHooks(
    'compaction.after',
    { method: facts.method, trigger: facts.trigger, tokens_before: facts.tokensBefore, tokens_after: facts.tokensAfter, ...(facts.summary !== undefined ? { summary: facts.summary } : {}) },
    { scope: compactionHookScope(context), signal: context.abortController.signal, toolUseContext: context },
  )
  const rows: Message[] = hookRowsOfResult(result).map(row => createAttachmentMessage(row))
  for (const words of result.answer.contexts) rows.push(createUserMessage({ content: boundHookContext(words, 'compaction-after-context').text, isMeta: true }))
  return rows
}
