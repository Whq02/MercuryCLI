import type { ToolUseContext } from '../../../tools/kit/tool.js'
import type { Message } from '../../message-shapes/message.js'
import { createAttachmentMessage } from '../../attachments/turnAttachments.js'
import { fireHooks, type HookFireResult } from '../../../integrations/event-hooks/fire.js'
import { boundHookContext } from '../../../integrations/event-hooks/contextBound.js'
import { hookRowsOfResult } from '../../../integrations/event-hooks/rows.js'
import { getSessionId } from '../../../boot/process-state/processState.js'
import { createUserMessage } from '../../messages/messages.js'

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
