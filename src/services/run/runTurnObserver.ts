// ============================================================================
//  runTurnObserver — the query lifecycle's two run-kernel touchpoints
//
//
//  query() calls these at its single entry and single exit, for TURN-OWNING
//  sources only (repl main thread, sdk, agent lanes — the same predicate the
//  deepthink turn-effort floor uses). Service loops (compact, classifiers,
//  forked bookkeeping agents with non-turn sources) never create runs.
//
//  Kept out of query.ts so the off-distribution core gains two calls, not a
//  subsystem; kept out of runCoordinator so the coordinator stays free of
//  message-shape knowledge.
// ============================================================================

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

/** The last REAL user prompt (non-meta, non-tool-result) — the run's root. */
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

/** One-line objective from the request text (bounded, newline-free). */
export function objectiveFromRequest(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length > 240 ? `${flat.slice(0, 237)}…` : flat
}

/** query() entry: begin/reconcile the owner's run for this turn. */
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
    // model turn = execution (bounded plane ring, Δ6).
    beginModelTurnExecution(owner, objectiveFromRequest(root.text))
  } catch {
    /* run observation must never break the turn */
  }
}

/** query() exit: record the terminal outcome + force the atomic flush. */
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
    // settle the turn's execution record.
    settleModelTurnExecution(owner, { aborted, reason: params.reason })
  } catch {
    /* run observation must never break the turn */
  }
}
