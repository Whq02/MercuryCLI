import { getSessionId, isRunInputClosed } from '../bootstrap/state.js'
import type { CanUseToolFn } from '../hooks/useCanUseTool.js'
import { getCommandQueue } from '../input-core/command-queue.js'
import type { Message } from '../types/message.js'
import type { PermissionDecision } from '../types/permissions.js'
import { logForDebugging } from '../utils/debug.js'
import { runForkedAgent, type CacheSafeParams, type ForkedAgentParams } from '../utils/forkedAgent.js'
import { createUserMessage } from '../utils/messages/factories.js'
import { ledgerEntryOf, recordHandoff } from './ledger.js'
import { mnemeEnabled } from './mnemeGates.js'
import { mnemeProjectKey } from './paths.js'
import { sessionCloseAsks } from './sessionClose.js'

export const HANDOFF_ASK =
  'This session is ending. Leave the note for the next session of this work, in your own words: what the work is for, what was decided and why, what is still to do, what you got wrong — and nothing else. Keep it short. Reply with the note alone; it is stored exactly as written.'

export const HANDOFF_ASK_BUDGET_MS = 120_000

const asked = new Set<string>()

export function sessionEndsWithThisTurn(): boolean {
  return isRunInputClosed() && !getCommandQueue().some(command => command.agentId === undefined)
}

export function handoffAskDue(input: { agentId?: string; querySource?: string; sessionId?: string }): boolean {
  if (!mnemeEnabled()) return false
  if (input.agentId !== undefined) return false
  if (input.querySource !== 'sdk' && input.querySource !== 'main_thread') return false
  const sessionId = input.sessionId ?? String(getSessionId())
  if (asked.has(sessionId)) return false
  if (!sessionEndsWithThisTurn()) return false
  const entry = ledgerEntryOf(mnemeProjectKey(), sessionId)
  return entry !== null && entry.handoff === null
}

function textOf(message: Message): string {
  if (message.type !== 'assistant' || message.isApiErrorMessage === true) return ''
  const parts: string[] = []
  for (const block of message.message.content) {
    if (block.type === 'text' && typeof block.text === 'string') parts.push(block.text)
  }
  return parts.join('\n').trim()
}

export function assistantText(messages: readonly Message[]): string {
  for (let index = messages.length - 1; index >= 0; index--) {
    const text = textOf(messages[index]!)
    if (text !== '') return text
  }
  return ''
}

export function handoffAskText(sessionId: string): { text: string; tools: Set<string> } {
  const extra = sessionCloseAsks(sessionId)
  const tools = new Set<string>()
  for (const ask of extra) for (const tool of ask.tools ?? []) tools.add(tool)
  return { text: [HANDOFF_ASK, ...extra.map(ask => ask.line.trim())].join('\n'), tools }
}

export type AskRunner = (params: ForkedAgentParams) => Promise<{ messages: Message[] }>

export async function askForHandoff(input: {
  cacheSafeParams: CacheSafeParams
  sessionId?: string
  signal?: AbortSignal
  budgetMs?: number
  canUseTool?: CanUseToolFn
  run?: AskRunner
}): Promise<{ text: string; stored: boolean } | null> {
  const sessionId = input.sessionId ?? String(getSessionId())
  if (asked.has(sessionId)) return null
  asked.add(sessionId)
  const abortController = new AbortController()
  const budget = setTimeout(() => abortController.abort(new Error('the handoff ask ran past its budget')), input.budgetMs ?? HANDOFF_ASK_BUDGET_MS)
  const onParentAbort = (): void => abortController.abort(input.signal?.reason)
  input.signal?.addEventListener('abort', onParentAbort, { once: true })
  const ask = handoffAskText(sessionId)
  const denied: PermissionDecision = {
    behavior: 'deny',
    message: 'the note is written from what is already known; tools are unavailable while leaving it',
    decisionReason: { type: 'other', reason: 'the session is leaving its note' },
  }
  const canUseTool: CanUseToolFn = async (tool, toolInput, toolUseContext, assistantMessage, toolUseID, forceDecision) => {
    if (!ask.tools.has(tool.name)) return denied
    if (input.canUseTool === undefined) return { behavior: 'allow' }
    return input.canUseTool(tool, toolInput, toolUseContext, assistantMessage, toolUseID, forceDecision)
  }
  try {
    const run: AskRunner = input.run ?? runForkedAgent
    const result = await run({
      promptMessages: [createUserMessage({ content: ask.text, isMeta: true })],
      cacheSafeParams: input.cacheSafeParams,
      canUseTool,
      querySource: 'side_question',
      forkLabel: 'handoff',
      overrides: { abortController, alwaysCallCanUseTool: true },
      maxTurns: ask.tools.size > 0 ? 4 : 2,
      skipTranscript: true,
      skipCacheWrite: true,
    } as ForkedAgentParams)
    const text = assistantText(result.messages)
    if (text === '') return null
    const entry = recordHandoff(mnemeProjectKey(), sessionId, text)
    return { text, stored: entry?.handoff?.text === text || (entry?.handoff !== null && entry?.handoff !== undefined && text.startsWith(entry.handoff.text)) }
  } catch (error) {
    logForDebugging(`handoff ask failed for ${sessionId}: ${error instanceof Error ? error.message : String(error)}`)
    return null
  } finally {
    clearTimeout(budget)
    input.signal?.removeEventListener('abort', onParentAbort)
  }
}

export function _resetHandoffAskForTesting(): void {
  asked.clear()
}
