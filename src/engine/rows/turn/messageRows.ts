import { refusalAnsweredBy } from '../../../models/roads/toolCallGate.js'
import type { AssistantMessage, Message, ProgressMessage } from '../../message-shapes/message.js'
import type { EvalToolProgress, MCPProgress, ShellProgress } from '../../../tools/kit/toolProgress.js'
import type { HookProgress } from '../../../integrations/event-hooks/hookProgress.js'
import { normalizeMessages } from '../../messages/messages.js'
import { isNotEmptyMessage } from '../../message-shapes/text.js'
import { isEphemeralToolProgress } from '../../../sessions/transcripts/paths.js'
import { childRowsOf } from '../child.js'
import { itemRowsOf, refusedCallRowsOf, toolResultRowsOf, toolUpdateRow, type RowDraft, type RowScope } from '../project.js'
import type { StepLedger } from './steps.js'

const TOOL_UPDATE_BEAT_MS = 250
const TOOL_UPDATE_MAP_CAP = 100
const TOOL_UPDATE_LINE_MAX = 300
const toolUpdateState = new Map<string, { lastEmitMs: number; tick: number }>()

function latestLineOf(text: string | undefined): string | undefined {
  if (typeof text !== 'string' || text === '') return undefined
  const lines = text.split('\n')
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]!.trim()
    if (line === '') continue
    return line.length > TOOL_UPDATE_LINE_MAX ? `${line.slice(0, TOOL_UPDATE_LINE_MAX)}…` : line
  }
  return undefined
}

interface MessageRowsNeeds {
  scope: RowScope
  steps: StepLedger
  toolOutcomes: Map<string, 'ok' | 'error' | 'aborted'>
  callScopes: Map<string, RowScope>
}

export function messageRowsOf({ scope, steps, toolOutcomes, callScopes }: MessageRowsNeeds): (message: Message, parentCallId: string | undefined) => RowDraft[] {
  const scopeFor = (parentCallId: string | undefined): RowScope => (parentCallId === undefined ? scope : { ...scope, parent_call_id: parentCallId })
  const rowsOfMessage = (message: Message, parentCallId: string | undefined): RowDraft[] => {
    const rows: RowDraft[] = []
    const rowScope = scopeFor(parentCallId)
    if (parentCallId !== undefined && (message.type === 'assistant' || message.type === 'user')) {
      const child = childRowsOf({ ...scope, parent_call_id: parentCallId }, message)
      for (const row of child) {
        const call = row as RowDraft & { call_id?: string }
        if (call.type === 'tool_call' && call.call_id !== undefined) callScopes.set(call.call_id, rowScope)
      }
      return child
    }
    if (message.type === 'assistant') {
      const assistant = message as AssistantMessage & { isApiErrorMessage?: boolean }
      if (assistant.isApiErrorMessage === true) return rows
      const content = assistant.message.content
      const refused = (assistant.refusedToolCalls ?? []).filter(refusal => !refusalAnsweredBy(refusal, [assistant]))
      const hasContent = isNotEmptyMessage(message)
      if (!hasContent && refused.length === 0) return rows
      const messageId = assistant.message.id ?? (assistant.uuid as string)
      const base = steps.blocks.get(messageId) ?? 0
      const length = hasContent ? (Array.isArray(content) ? content.length : 1) : 0
      steps.blocks.set(messageId, base + length + refused.length)
      let block = base
      if (hasContent) {
        for (const normalized of normalizeMessages([message])) {
          const pieces = (normalized as AssistantMessage).message.content
          const items = itemRowsOf(rowScope, messageId, pieces, block, assistant.inReplyTo)
          for (const item of items) if (item.type === 'tool_call') callScopes.set(item.call_id, rowScope)
          rows.push(...items)
          block += Array.isArray(pieces) ? pieces.length : 1
        }
      }
      if (refused.length > 0) rows.push(...refusedCallRowsOf(rowScope, messageId, refused, base + length))
      return rows
    }
    if (message.type === 'user') {
      rows.push(...toolResultRowsOf(rowScope, (message as { message: { content: unknown } }).message.content, (callId, isError) => toolOutcomes.get(callId) ?? (isError ? 'error' : 'ok')))
      return rows
    }
    if (message.type === 'progress') {
      const progress = message as ProgressMessage
      const data = progress.data as { type?: string; message?: Message; elapsedTimeSeconds?: number }
      if (data.type === 'agent_progress' || data.type === 'skill_progress') {
        const inner = data.message as Message
        return rowsOfMessage(inner, progress.parentToolUseID)
      }
      const evalRunning = data.type === 'eval_progress' && (data as { kind?: string }).kind === 'running' ? (data as Extract<EvalToolProgress, { kind: 'running' }>) : null
      const hookWaiting = data.type === 'hook_progress' && (data as { state?: string }).state === 'waiting' ? (data as HookProgress) : null
      if (isEphemeralToolProgress(data.type) || evalRunning !== null || hookWaiting !== null) {
        const callId = callScopes.has(progress.toolUseID) ? progress.toolUseID : progress.parentToolUseID
        const updateScope = callScopes.get(callId) ?? rowScope
        const key = JSON.stringify([scope.session_id, callId])
        const now = Date.now()
        const state = toolUpdateState.get(key)
        const hookWaitEnded = hookWaiting !== null && hookWaiting.line === undefined
        if (!hookWaitEnded) {
          if (state !== undefined && now - state.lastEmitMs < TOOL_UPDATE_BEAT_MS) return rows
        }
        while (toolUpdateState.size >= TOOL_UPDATE_MAP_CAP) {
          const oldest = toolUpdateState.keys().next()
          if (oldest.done) break
          toolUpdateState.delete(oldest.value)
        }
        const tick = (state?.tick ?? 0) + 1
        toolUpdateState.set(key, { lastEmitMs: now, tick })
        if (hookWaiting !== null) {
          rows.push(
            toolUpdateRow(updateScope, {
              callId,
              tick,
              source: 'hook',
              ...(hookWaiting.line !== undefined ? { line: hookWaiting.line } : {}),
              ...(hookWaiting.elapsedS !== undefined ? { elapsedS: hookWaiting.elapsedS } : {}),
              ...(hookWaiting.timeoutS !== undefined && hookWaiting.timeoutS > 0 ? { budgetMs: hookWaiting.timeoutS * 1000 } : {}),
            }),
          )
          return rows
        }
        if (evalRunning !== null) {
          rows.push(
            toolUpdateRow(updateScope, {
              callId,
              tick,
              source: 'eval',
              line: latestLineOf(evalRunning.tail),
              elapsedS: evalRunning.elapsedSeconds,
              budgetMs: evalRunning.budgetMs,
            }),
          )
          return rows
        }
        const shell = data as Partial<ShellProgress>
        const mcp = data as Partial<MCPProgress>
        const isMcp = data.type === 'mcp_progress'
        rows.push(
          toolUpdateRow(updateScope, {
            callId,
            tick,
            source: isMcp ? 'mcp' : data.type === 'powershell_progress' ? 'powershell' : 'shell',
            line: isMcp ? latestLineOf(mcp.progressMessage) : latestLineOf(shell.output),
            elapsedS: typeof data.elapsedTimeSeconds === 'number' ? data.elapsedTimeSeconds : undefined,
            lines: !isMcp && typeof shell.totalLines === 'number' ? shell.totalLines : undefined,
            bytes: !isMcp && typeof shell.totalBytes === 'number' ? shell.totalBytes : undefined,
            budgetMs: !isMcp && typeof shell.budgetMs === 'number' ? shell.budgetMs : undefined,
            progress: isMcp && typeof mcp.progress === 'number' ? mcp.progress : undefined,
            total: isMcp && typeof mcp.total === 'number' ? mcp.total : undefined,
          }),
        )
      }
      return rows
    }
    return rows
  }
  return rowsOfMessage
}
