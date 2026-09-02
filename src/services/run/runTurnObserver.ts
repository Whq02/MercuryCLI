
import type { QuerySource } from '../../constants/querySource.js'
import type { ToolUseContext } from '../../Tool.js'
import type { Message } from '../../types/message.js'
import {
  beginModelTurnExecution,
  settleModelTurnExecution,
} from '../primitives/canonicalStream.js'
import { acceptUserRequest, noteTurnEnd } from './runCoordinator.js'
import { ownerFromToolUseContext } from './resolveOwner.js'

function turnOwningSource(querySource: QuerySource | undefined): boolean {
  if (querySource === undefined) return false
  return (
    querySource.startsWith('repl_main_thread') ||
    querySource === 'sdk' ||
    querySource.startsWith('agent:')
  )
}

function lastRealUserMessage(messages: Message[]): { id: string | null; text: string } | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i] as
      | {
          type?: string
          isMeta?: boolean
          uuid?: string
          message?: { content?: unknown }
        }
      | undefined
    if (!m || m.type !== 'user' || m.isMeta) continue
    const content = m.message?.content
    if (typeof content === 'string') {
      return { id: m.uuid ?? null, text: content }
    }
    if (Array.isArray(content)) {
      if ((content as Array<{ type?: string }>).some(b => b?.type === 'tool_result')) continue
      const text = (content as Array<{ type?: string; text?: unknown }>)
        .filter(b => b?.type === 'text' && typeof b.text === 'string')
        .map(b => b.text as string)
        .join('\n')
      if (text.trim()) return { id: m.uuid ?? null, text }
    }
  }
  return null
}

export function objectiveFromRequest(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length > 240 ? `${flat.slice(0, 237)}…` : flat
}

export function noteQueryTurnStart(params: {
  messages: Message[]
  querySource: QuerySource
  toolUseContext: ToolUseContext
}): void {
  try {
    if (!turnOwningSource(params.querySource)) return
    const root = lastRealUserMessage(params.messages)
    if (!root) return
    const owner = ownerFromToolUseContext(params.toolUseContext)
    acceptUserRequest(owner, {
      objective: objectiveFromRequest(root.text),
      rootMessageId: root.id,
    })
    beginModelTurnExecution(owner, objectiveFromRequest(root.text))
  } catch {
  }
}

export async function noteQueryTurnEnd(params: {
  querySource: QuerySource
  toolUseContext: ToolUseContext
  reason: string
}): Promise<void> {
  try {
    if (!turnOwningSource(params.querySource)) return
    const owner = ownerFromToolUseContext(params.toolUseContext)
    const aborted = params.toolUseContext.abortController.signal.aborted
    await noteTurnEnd(owner, {
      reason: params.reason,
      aborted,
    })
    settleModelTurnExecution(owner, { aborted, reason: params.reason })
  } catch {
  }
}
