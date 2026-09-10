import './computerProofKit.ts'
import { getEmptyToolPermissionContext, type ToolPermissionContext, type ToolUseContext } from '../../src/Tool.ts'
import { createAssistantMessage, createUserMessage } from '../../src/utils/messages.ts'
import { ownerFromToolUseContext } from '../../src/services/run/resolveOwner.ts'
import type { OwnerKey } from '../../src/services/run/ownerKey.ts'
import type { Message } from '../../src/types/message.ts'

export const PROOF_MODEL = 'claude-opus-5'
export const COMPUTER_ACTIONS = ['screenshot', 'click', 'doubleClick', 'rightClick', 'move', 'drag', 'scroll', 'type', 'key', 'hold', 'wait', 'cursor', 'displays', 'frontmost'] as const
export const COMPUTER_READS = ['screenshot', 'wait', 'cursor', 'displays', 'frontmost'] as const
export const COMPUTER_ACTS = ['click', 'doubleClick', 'rightClick', 'move', 'drag', 'scroll', 'type', 'key', 'hold'] as const

export interface ContextOptions {
  agentId?: string
  model?: string
  messages?: Message[]
  allow?: string[]
  deny?: string[]
  ask?: string[]
  controller?: AbortController
  interactive?: boolean
}

export function toolContext(options: ContextOptions = {}): ToolUseContext {
  const permission: ToolPermissionContext = {
    ...getEmptyToolPermissionContext(),
    alwaysAllowRules: options.allow ? { localSettings: options.allow } : {},
    alwaysDenyRules: options.deny ? { localSettings: options.deny } : {},
    alwaysAskRules: options.ask ? { localSettings: options.ask } : {},
  }
  const context = {
    options: {
      mainLoopModel: options.model ?? PROOF_MODEL,
      tools: [],
      commands: [],
      verbose: false,
      mcpClients: [],
      isNonInteractiveSession: options.interactive === false,
      agentDefinitions: { activeAgents: [], allAgents: [] },
    },
    abortController: options.controller ?? new AbortController(),
    messages: options.messages ?? [],
    readFileState: new Map(),
    getAppState: () => ({ toolPermissionContext: permission }),
    setAppState: () => undefined,
    setResponseLength: () => undefined,
    updateFileHistoryState: () => undefined,
    updateAttributionState: () => undefined,
    ...(options.agentId ? { agentId: options.agentId } : {}),
  }
  return context as unknown as ToolUseContext
}

export function ownerOf(context: ToolUseContext): OwnerKey {
  return ownerFromToolUseContext(context as { owner?: OwnerKey; agentId?: string })
}

export function toolUseTurn(toolUseId: string, name: string, input: Record<string, unknown>): Message {
  return createAssistantMessage({ content: [{ type: 'tool_use', id: toolUseId, name, input }] as never }) as Message
}

export function toolResultTurn(block: unknown): Message {
  return createUserMessage({ content: [block] as never }) as Message
}

export const allowEverything = (async () => ({ behavior: 'allow' as const })) as never

export function resultOf(answer: unknown): { result: string; outcome: string; imagePath?: string; inlinePath?: string; screen?: Record<string, unknown> } {
  const data = (answer as { data?: Record<string, unknown> }).data ?? {}
  return {
    result: String(data.result ?? ''),
    outcome: String(data.outcome ?? ''),
    ...(typeof data.imagePath === 'string' ? { imagePath: data.imagePath } : {}),
    ...(typeof data.inlinePath === 'string' ? { inlinePath: data.inlinePath } : {}),
    ...(data.screen && typeof data.screen === 'object' ? { screen: data.screen as Record<string, unknown> } : {}),
  }
}
