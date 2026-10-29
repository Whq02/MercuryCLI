import { getSessionId, isRunInputClosed } from '../bootstrap/state.js'
import type { CanUseToolFn } from '../hooks/useCanUseTool.js'
import { getCommandQueue } from '../input-core/command-queue.js'
import type { Message } from '../types/message.js'
import type { PermissionDecision } from '../types/permissions.js'
import { logForDebugging } from '../utils/debug.js'
import { isUnattendedRun } from '../utils/cockpit/runtimePosture.js'
import { runForkedAgent, type CacheSafeParams, type ForkedAgentParams } from '../utils/forkedAgent.js'
import { EMPTY_USAGE, type NonNullableUsage } from '../services/api/emptyUsage.js'
import { accumulateUsage } from '../services/providers/anthropic/cacheAndUsage.js'
import { createUserMessage } from '../utils/messages/factories.js'
import { handoffReask, measureNovelty, noveltyRecord } from './handoffNovelty.js'
import { HANDOFF_TEXT_CAP, ledgerEntryOf, recordHandoff } from './ledger.js'
import { lineageJoined } from './lineageSession.js'
import { mnemeProjectKey } from './paths.js'
import { sessionCloseAsks } from './sessionClose.js'

export const inThousands = (n: number): string => n.toLocaleString('en-US')

export const HANDOFF_ASK =
  `The session is ending. Leave one note for the next session to orient itself just enough for the next session to know the repo\'s workings, nothing else. Keep prose concise, effective, and short. Reply with the note alone; it is stored exactly as written, up to ${inThousands(HANDOFF_TEXT_CAP)} characters.`

export const HANDOFF_ASK_BUDGET_MS = 120_000

const asked = new Set<string>()

export function handoffAsked(sessionId: string): boolean {
  return asked.has(sessionId)
}

export function sessionEndsWithThisTurn(): boolean {
  return isRunInputClosed() && !getCommandQueue().some(command => command.agentId === undefined)
}

export function handoffAskDue(input: { agentId?: string; querySource?: string; sessionId?: string }): boolean {
  if (!lineageJoined() || isUnattendedRun()) return false
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
  return parts.join('\n')
}

export function assistantText(messages: readonly Message[]): string {
  const message = messages.findLast(row => row.type === 'assistant' || row.type === 'user')
  if (message?.type !== 'assistant' || message.message.content.some(block => block.type === 'tool_use')) return ''
  return textOf(message)
}

function finalAssistant(messages: readonly Message[]): Message | null {
  const message = messages.findLast(row => row.type === 'assistant' || row.type === 'user')
  return message?.type === 'assistant' ? message : null
}

export function handoffAskText(sessionId: string): { text: string; tools: Set<string> } {
  const extra = sessionCloseAsks(sessionId)
  const tools = new Set<string>()
  for (const ask of extra) for (const tool of ask.tools ?? []) tools.add(tool)
  return { text: [HANDOFF_ASK, ...extra.map(ask => ask.line.trim())].join('\n'), tools }
}

export function handoffNotice(note: { text: string; stored: boolean; overCap?: boolean } | null): string {
  if (note === null) return 'the session ends with no note left for the next one'
  if (note.overCap === true) return `the note was not stored: ${inThousands(note.text.length)} characters, and a note is stored exactly as written only up to ${inThousands(HANDOFF_TEXT_CAP)}; the session ends with no note left for the next one`
  if (!note.stored) return 'the note could not be stored; the session ends with no note left for the next one'
  return `the note for the next session is in the ledger (${note.text.length} characters)`
}

export type AskRunner = (params: ForkedAgentParams) => Promise<{ messages: Message[]; terminal?: { reason: string }; totalUsage?: NonNullableUsage }>

export async function askForHandoff(input: {
  cacheSafeParams: CacheSafeParams
  sessionId?: string
  signal?: AbortSignal
  budgetMs?: number
  canUseTool?: CanUseToolFn
  run?: AskRunner
  onUsage?: (usage: NonNullableUsage) => void
}): Promise<{ text: string; stored: boolean; reasked: boolean; overCap?: boolean } | null> {
  const sessionId = input.sessionId ?? String(getSessionId())
  if (!lineageJoined() || asked.has(sessionId)) return null
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
    const askMessage = createUserMessage({ content: ask.text, isMeta: true })
    const params = (promptMessages: Message[]): ForkedAgentParams =>
      ({
        promptMessages,
        cacheSafeParams: input.cacheSafeParams,
        canUseTool,
        querySource: 'side_question',
        forkLabel: 'handoff',
        overrides: { abortController, alwaysCallCanUseTool: true },
        maxTurns: ask.tools.size > 0 ? 4 : 2,
        skipTranscript: true,
        skipCacheWrite: true,
      }) as ForkedAgentParams
    const result = await run(params([askMessage]))
    let usage = result.totalUsage ?? EMPTY_USAGE
    if (result.terminal?.reason !== 'completed' || abortController.signal.aborted) {
      input.onUsage?.(usage)
      return null
    }
    const first = assistantText(result.messages)
    if (first.trim() === '' || !lineageJoined()) {
      input.onUsage?.(usage)
      return null
    }
    let text = first
    let reasked = false
    const measure = measureNovelty(first, noveltyRecord(mnemeProjectKey(), sessionId))
    const answer = finalAssistant(result.messages)
    if (measure.reask && answer !== null) {
      reasked = true
      try {
        const again = await run(params([askMessage, answer, createUserMessage({ content: handoffReask(measure), isMeta: true })]))
        usage = accumulateUsage(usage, again.totalUsage ?? EMPTY_USAGE)
        const second = again.terminal?.reason === 'completed' && !abortController.signal.aborted ? assistantText(again.messages) : ''
        if (second.trim() !== '') text = second
      } catch (error) {
        logForDebugging(`handoff re-ask failed for ${sessionId}; the first note stands: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
    input.onUsage?.(usage)
    if (text.length > HANDOFF_TEXT_CAP) {
      logForDebugging(`handoff note for ${sessionId} not stored: ${text.length} characters over the ${HANDOFF_TEXT_CAP} cap`)
      return { text, stored: false, reasked, overCap: true }
    }
    const entry = recordHandoff(mnemeProjectKey(), sessionId, text)
    return { text, stored: entry?.handoff?.text === text, reasked }
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
