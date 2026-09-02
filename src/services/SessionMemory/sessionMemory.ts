import { dirname } from 'node:path'

import { isAutoCompactEnabled } from '../compact/autoCompact.js'
import { getIsRemoteMode } from '../../bootstrap/state.js'
import { getErrnoCode } from '../../utils/errors.js'
import { getFsImplementation } from '../../utils/fsOperations.js'
import { registerPostSamplingHook } from '../../utils/hooks/postSamplingHooks.js'
import type { REPLHookContext } from '../../utils/hooks/postSamplingHooks.js'
import { createUserMessage, hasToolCallsInLastAssistantTurn } from '../../utils/messages.js'
import type { Message } from '../../types/message.js'
import { getSessionMemoryPath } from '../../utils/permissions/filesystem.js'
import { sequential } from '../../utils/sequential.js'
import { writeFileSync_DEPRECATED } from '../../utils/slowOperations.js'
import { tokenCountWithEstimation } from '../../utils/tokens.js'
import {
  createSubagentContext,
  createCacheSafeParams,
  runForkedAgent,
} from '../../utils/forkedAgent.js'
import { cloneFileStateCache } from '../../utils/fileStateCache.js'
import {
  getFeatureValue_CACHED_MAY_BE_STALE,
  getDynamicConfig_CACHED_MAY_BE_STALE,
} from '../analytics/featureGates.js'
import type { CanUseToolFn } from '../../hooks/useCanUseTool.js'
import type { ToolUseContext } from '../../Tool.js'
import { FILE_EDIT_TOOL_NAME } from '../../tools/FileEditTool/constants.js'
import { FileReadTool } from '../../tools/FileReadTool/FileReadTool.js'
import {
  buildSessionMemoryUpdatePrompt,
  loadSessionMemoryTemplate,
} from './prompts.js'
import {
  getToolCallsBetweenUpdates,
  hasMetInitializationThreshold,
  hasMetUpdateThreshold,
  isSessionMemoryInitialized,
  markExtractionCompleted,
  markExtractionStarted,
  markSessionMemoryInitialized,
  recordExtractionTokenCount,
  setLastSummarizedMessageId,
  setSessionMemoryConfig,
} from './sessionMemoryUtils.js'


let configMaterialized = false

function isSessionMemoryGateOn(): boolean {
  return getFeatureValue_CACHED_MAY_BE_STALE<boolean>('mercury_session_memory', false) === true
}

function materializeConfigOnce(): void {
  if (configMaterialized) return
  configMaterialized = true
  const remote = getDynamicConfig_CACHED_MAY_BE_STALE<Record<string, unknown>>('mercury_sm_config', {})
  const positive = (value: unknown): number | undefined =>
    typeof value === 'number' && value > 0 ? value : undefined
  const init = positive(remote.minimumMessageTokensToInit)
  const between = positive(remote.minimumTokensBetweenUpdate)
  const toolCalls = positive(remote.toolCallsBetweenUpdates)
  setSessionMemoryConfig({
    ...(init === undefined ? {} : { minimumMessageTokensToInit: init }),
    ...(between === undefined ? {} : { minimumTokensBetweenUpdate: between }),
    ...(toolCalls === undefined ? {} : { toolCallsBetweenUpdates: toolCalls }),
  })
}


let lastMemoryMessageUuid: string | undefined

function messageUuid(message: Message | undefined): string | undefined {
  return (message as { uuid?: string } | undefined)?.uuid
}

function countToolCallsSinceAnchor(messages: Message[]): number {
  const anchorUuid = lastMemoryMessageUuid
  let counting = anchorUuid === undefined
  let count = 0
  for (const message of messages) {
    if (!counting) {
      if (messageUuid(message) === anchorUuid) counting = true
      continue
    }
    if (message.type !== 'assistant') continue
    const content = message.message?.content
    if (!Array.isArray(content)) continue
    count += content.filter(block => (block as { type?: string }).type === 'tool_use').length
  }
  return count
}

export function shouldExtractMemory(messages: Message[]): boolean {
  const tokens = tokenCountWithEstimation(messages)

  if (!isSessionMemoryInitialized()) {
    if (!hasMetInitializationThreshold(tokens)) return false
    markSessionMemoryInitialized()
  }

  if (!hasMetUpdateThreshold(tokens)) return false

  const toolCalls = countToolCallsSinceAnchor(messages)
  const lastTurnHadTools = hasToolCallsInLastAssistantTurn(messages)
  if (toolCalls < getToolCallsBetweenUpdates() && lastTurnHadTools) return false

  const lastUuid = messageUuid(messages[messages.length - 1])
  if (lastUuid !== undefined) lastMemoryMessageUuid = lastUuid
  return true
}


async function setupNotesFile(parentContext: ToolUseContext): Promise<{
  notesPath: string
  currentNotes: string
  isolatedContext: ToolUseContext
}> {
  const notesPath = getSessionMemoryPath()
  getFsImplementation().mkdirSync(dirname(notesPath), { mode: 0o700 })
  try {
    writeFileSync_DEPRECATED(notesPath, '', { flag: 'wx', mode: 0o600 })
    const template = await loadSessionMemoryTemplate()
    writeFileSync_DEPRECATED(notesPath, template, { mode: 0o600 })
  } catch (error) {
    if (getErrnoCode(error) !== 'EEXIST') throw error
  }

  const isolatedContext = createSubagentContext(parentContext, {
    readFileState: cloneFileStateCache(parentContext.readFileState),
  })

  isolatedContext.readFileState.delete?.(notesPath)
  const output = await FileReadTool.call(
    { file_path: notesPath } as never,
    isolatedContext as never,
  )
  const data = (output as { data?: unknown }).data
  const text = (data as { file?: { content?: unknown } } | undefined)?.file?.content
  const currentNotes = typeof text === 'string' ? text : ''

  return { notesPath, currentNotes, isolatedContext }
}


export function createMemoryFileCanUseTool(memoryPath: string): CanUseToolFn {
  const deny = () =>
    Promise.resolve({
      behavior: 'deny' as const,
      message: `session memory may only edit ${memoryPath} with the ${FILE_EDIT_TOOL_NAME} tool`,
      decisionReason: {
        type: 'other' as const,
        reason: `only editing ${memoryPath} is permitted during session-memory extraction`,
      },
    })
  return (async (tool, input) => {
    if ((tool as { name?: string }).name !== FILE_EDIT_TOOL_NAME) return deny()
    const path = (input as { file_path?: unknown }).file_path
    if (path !== memoryPath) return deny()
    return { behavior: 'allow' as const, updatedInput: input }
  }) as CanUseToolFn
}


async function runExtraction(context: REPLHookContext): Promise<void> {
  markExtractionStarted()
  const { notesPath, currentNotes, isolatedContext } = await setupNotesFile(
    context.toolUseContext,
  )
  const prompt = await buildSessionMemoryUpdatePrompt(currentNotes, notesPath)
  await runForkedAgent({
    promptMessages: [createUserMessage({ content: prompt })],
    cacheSafeParams: createCacheSafeParams(context),
    canUseTool: createMemoryFileCanUseTool(notesPath),
    querySource: 'session_memory',
    forkLabel: 'session_memory',
    overrides: { readFileState: isolatedContext.readFileState },
  })

  recordExtractionTokenCount(tokenCountWithEstimation(context.messages))
  if (!hasToolCallsInLastAssistantTurn(context.messages)) {
    const lastUuid = messageUuid(context.messages[context.messages.length - 1])
    if (lastUuid !== undefined) setLastSummarizedMessageId(lastUuid)
  }
  markExtractionCompleted()
}


const sessionMemoryHook = sequential(async (context: REPLHookContext): Promise<void> => {
  if (context.querySource !== 'repl_main_thread') return
  if (!isSessionMemoryGateOn()) return
  materializeConfigOnce()
  if (!shouldExtractMemory(context.messages)) return
  await runExtraction(context)
})

export function initSessionMemory(): void {
  if (getIsRemoteMode()) return
  if (!isAutoCompactEnabled()) return
  registerPostSamplingHook(sessionMemoryHook)
}


export function resetLastMemoryMessageUuid(): void {
  lastMemoryMessageUuid = undefined
}


export {
  buildSessionMemoryUpdatePrompt,
  DEFAULT_SESSION_MEMORY_TEMPLATE,
  isSessionMemoryEmpty,
  loadSessionMemoryPrompt,
  loadSessionMemoryTemplate,
  truncateSessionMemoryForCompact,
} from './prompts.js'
export {
  DEFAULT_SESSION_MEMORY_CONFIG,
  getSessionMemoryConfig,
  getToolCallsBetweenUpdates,
  hasMetInitializationThreshold,
  hasMetUpdateThreshold,
  isSessionMemoryInitialized,
  markExtractionCompleted,
  markExtractionStarted,
  markSessionMemoryInitialized,
  recordExtractionTokenCount,
  getLastSummarizedMessageId,
  setLastSummarizedMessageId,
  setSessionMemoryConfig,
  waitForSessionMemoryExtraction,
  resetSessionMemoryState,
  getSessionMemoryContent,
  type SessionMemoryConfig,
} from './sessionMemoryUtils.js'
