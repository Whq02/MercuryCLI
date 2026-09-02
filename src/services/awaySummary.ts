import type { ToolPermissionContext } from '../Tool.js'
import type { Message } from '../types/message.js'
import { logForDebugging } from '../utils/debug.js'
import { createUserMessage } from '../utils/messages.js'
import { sessionSmallFastModel } from '../utils/model/providerFrontier.js'
import { asSystemPrompt } from '../utils/systemPromptType.js'
import { routedCallModelSettled } from './providers/callModelRouter.js'
import { APIUserAbortError } from './api/sdkErrors.js'
import { getSessionMemoryContent } from './SessionMemory/sessionMemoryUtils.js'


const RECENT_MESSAGE_WINDOW = 30

const RECAP_INSTRUCTION = [
  'The operator has just returned after being away from this session.',
  'Write a recap of 1 to 3 short sentences.',
  'State the high-level task first — the thing being built or debugged — never implementation detail.',
  'Then state the concrete next step.',
  'Do not report status and do not recap commit by commit.',
].join(' ')

export async function generateAwaySummary(
  messages: Message[],
  signal: AbortSignal,
): Promise<string | null> {
  try {
    if (messages.length === 0) return null
    if (signal.aborted) return null
    const recent = messages.slice(-RECENT_MESSAGE_WINDOW)
    let instructionText = RECAP_INSTRUCTION
    try {
      const memory = await getSessionMemoryContent()
      if (memory) {
        instructionText = `Broader session context:\n${memory}\n\n${RECAP_INSTRUCTION}`
      }
    } catch {
    }
    const instruction = createUserMessage({ content: instructionText, isMeta: true })
    const result = await routedCallModelSettled({
      messages: [...recent, instruction],
      systemPrompt: asSystemPrompt([]),
      thinkingConfig: { type: 'disabled' },
      tools: [],
      signal,
      options: {
        getToolPermissionContext: async () => ({}) as ToolPermissionContext,
        model: sessionSmallFastModel(),
        isNonInteractiveSession: false,
        querySource: 'away_summary',
        agents: [],
        hasAppendSystemPrompt: false,
        skipCacheWrite: true,
        mcpTools: [],
      },
    })
    if ((result as { isApiErrorMessage?: boolean }).isApiErrorMessage) {
      logForDebugging('awaySummary: API error response; no recap')
      return null
    }
    const content = result.message.content
    if (typeof content === 'string') return content
    if (Array.isArray(content)) {
      const text = content
        .filter(block => (block as { type?: string }).type === 'text')
        .map(block => (block as { text?: string }).text ?? '')
        .join('')
        .trim()
      return text !== '' ? text : null
    }
    return null
  } catch (err) {
    if (err instanceof APIUserAbortError || signal.aborted) return null
    logForDebugging(`awaySummary: recap failed silently: ${String(err)}`)
    return null
  }
}
