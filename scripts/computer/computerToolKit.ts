import './computerProofKit.ts'
import { getEmptyToolPermissionContext, type ToolPermissionContext, type ToolUseContext } from '../../src/Tool.ts'
import { createAssistantMessage, createUserMessage } from '../../src/utils/messages.ts'
import { ownerFromToolUseContext } from '../../src/services/run/resolveOwner.ts'
import { setIsInteractive } from '../../src/bootstrap/state.ts'
import type { OwnerKey } from '../../src/services/run/ownerKey.ts'
import type { Message } from '../../src/types/message.ts'

setIsInteractive(true)

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

export interface ScreenshotInContext {
  context: ToolUseContext
  toolUseId: string
  result: string
  outcome: string
  messages: Message[]
  screen: Record<string, unknown>
}

export function pixelOfPointOn(screen: Record<string, unknown>, x: number, y: number): { x: number; y: number } {
  const imageWidth = Number(screen.imageWidth)
  const imageHeight = Number(screen.imageHeight)
  const pointWidth = Number(screen.pointWidth)
  const pointHeight = Number(screen.pointHeight)
  const originX = Number(screen.originX)
  const originY = Number(screen.originY)
  return { x: Math.round(((x - originX) * imageWidth) / pointWidth), y: Math.round(((y - originY) * imageHeight) / pointHeight) }
}

export function pointOfPixelOn(screen: Record<string, unknown>, x: number, y: number): { x: number; y: number } {
  const imageWidth = Number(screen.imageWidth)
  const imageHeight = Number(screen.imageHeight)
  const pointWidth = Number(screen.pointWidth)
  const pointHeight = Number(screen.pointHeight)
  const originX = Number(screen.originX)
  const originY = Number(screen.originY)
  return { x: Math.round(originX + (x * pointWidth) / imageWidth), y: Math.round(originY + (y * pointHeight) / imageHeight) }
}

export async function withScreenshot(
  tool: { call: (...args: never[]) => Promise<unknown>; mapToolResultToToolResultBlockParam: (output: never, id: string) => unknown },
  base: ToolUseContext,
  toolUseId: string,
  input: Record<string, unknown> = { action: 'screenshot' },
): Promise<ScreenshotInContext> {
  const parent = toolUseTurn(toolUseId, 'Computer', input)
  const answer = (await tool.call(input as never, base as never, allowEverything, parent as never)) as { data: Record<string, unknown> }
  const out = resultOf(answer)
  const recorded = typeof out.screen?.toolUseId === 'string' ? out.screen.toolUseId : toolUseId
  const block = tool.mapToolResultToToolResultBlockParam(answer.data as never, recorded)
  const messages = [...base.messages, parent, toolResultTurn(block)]
  const context = { ...base, messages } as ToolUseContext
  return { context, toolUseId: recorded, result: out.result, outcome: out.outcome, messages, screen: out.screen ?? {} }
}

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
