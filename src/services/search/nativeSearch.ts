import type { ToolPermissionContext, ToolUseContext } from '../../Tool.js'
import { routedCallModel } from '../providers/callModelRouter.js'
import type { WebSearchProgress } from '../../types/tools.js'
import type { ContentBlock } from '../../types/wire.js'
import { logError } from '../../utils/log.js'
import { createUserMessage } from '../../utils/messages.js'
import { getMainLoopModel } from '../../utils/model/model.js'
import { asSystemPrompt } from '../../utils/systemPromptType.js'
import type { NativeSearchFamily } from './nativeSearchRequest.js'
import {
  filterHitsByDomain,
  normaliseHits,
  searchFailure,
  type SearchBackendId,
  type SearchHit,
  type SearchOutcome,
  type SearchRequest,
} from './searchContract.js'

const MAX_SEARCH_USES = 8

export type SearchProgressSink = (progress: { toolUseID: string; data: WebSearchProgress }) => void

export function nativeBackendIdFor(family: NativeSearchFamily): SearchBackendId {
  return family === 'anthropic' ? 'anthropic-native' : 'openai-native'
}

export function extractQueryFromPartialJson(partial: string): string | undefined {
  const match = /"query"\s*:\s*"((?:[^"\\]|\\.)*)"/.exec(partial)
  if (!match) return undefined
  try {
    return JSON.parse(`"${match[1]}"`) as string
  } catch {
    return undefined
  }
}

export interface NativeSearchIo {
  context: ToolUseContext
  onProgress?: SearchProgressSink
}

export async function nativeSearch(
  family: NativeSearchFamily,
  request: SearchRequest,
  io: NativeSearchIo,
): Promise<SearchOutcome> {
  const { context } = io
  const via = nativeBackendIdFor(family)
  const model = (context.options.mainLoopModel as string | undefined) || getMainLoopModel()
  const appState = context.getAppState()

  const blocks: ContentBlock[] = []
  const queriesByToolUse = new Map<string, string>()
  let currentToolUseId: string | undefined
  let partialJson = ''
  let progressCounter = 0
  const noteQuery = (toolUseId: string, query: string): void => {
    if (queriesByToolUse.get(toolUseId) === query) return
    queriesByToolUse.set(toolUseId, query)
    io.onProgress?.({ toolUseID: `query-${++progressCounter}`, data: { type: 'query_update', query } })
  }

  const stream = routedCallModel({
    messages: [createUserMessage({ content: `Perform a web search for the query: ${request.query}` })],
    systemPrompt: asSystemPrompt(['You are an assistant performing a web-search tool use.']),
    thinkingConfig: context.options.thinkingConfig,
    tools: [],
    signal: context.abortController.signal,
    options: {
      getToolPermissionContext: async () => appState.toolPermissionContext as ToolPermissionContext,
      model,
      isNonInteractiveSession: context.options.isNonInteractiveSession,
      nativeWebSearch: {
        ...(request.allowedDomains && request.allowedDomains.length > 0 ? { allowedDomains: request.allowedDomains } : {}),
        ...(request.blockedDomains && request.blockedDomains.length > 0 ? { blockedDomains: request.blockedDomains } : {}),
        maxUses: MAX_SEARCH_USES,
      },
      querySource: 'web_search_tool',
      agents: context.options.agentDefinitions?.activeAgents ?? [],
      hasAppendSystemPrompt: Boolean(context.options.appendSystemPrompt),
      mcpTools: [],
      agentId: context.agentId,
      effortValue: appState.effortValue,
    },
  })

  for await (const message of stream) {
    if (message.type === 'stream_event') {
      const event = message.event
      if (event.type === 'content_block_start') {
        const block = event.content_block
        if (block.type === 'server_tool_use') {
          currentToolUseId = block.id
          partialJson = ''
          const query = (block.input as { query?: unknown } | undefined)?.query
          if (typeof query === 'string' && query !== '') noteQuery(block.id, query)
        } else if (block.type === 'web_search_tool_result') {
          const count = Array.isArray(block.content) ? block.content.length : 0
          const query = queriesByToolUse.get(block.tool_use_id) ?? request.query
          io.onProgress?.({
            toolUseID: block.tool_use_id || `search-${++progressCounter}`,
            data: { type: 'search_results_received', resultCount: count, query },
          })
        }
      } else if (event.type === 'content_block_delta' && event.delta.type === 'input_json_delta' && currentToolUseId) {
        partialJson += event.delta.partial_json
        const query = extractQueryFromPartialJson(partialJson)
        if (query !== undefined) noteQuery(currentToolUseId, query)
      }
      continue
    }
    if (message.type === 'assistant') {
      if (message.isApiErrorMessage === true) {
        const errorText = (message.message.content as ContentBlock[])
          .map(block => (block.type === 'text' ? block.text : ''))
          .join('')
        return searchFailure('provider-refused', via, errorText || 'unknown provider error')
      }
      blocks.push(...(message.message.content as ContentBlock[]))
    }
  }
  if (context.abortController.signal.aborted) return searchFailure('aborted', via, 'cancelled')

  const sequence: Array<string | { toolUseId: string; hits: SearchHit[] }> = []
  const allHits: SearchHit[] = []
  let accumulated = ''
  let groupEnded = false
  for (const block of blocks) {
    if (block.type === 'server_tool_use') {
      if (accumulated.trim().length > 0) sequence.push(accumulated.trim())
      accumulated = ''
      groupEnded = false
    } else if (block.type === 'web_search_tool_result') {
      if (!Array.isArray(block.content)) {
        const note = `Web search error: ${block.content.error_code}`
        logError(new Error(note))
        sequence.push(note)
      } else {
        const hits = filterHitsByDomain(
          block.content.map(hit => ({ title: hit.title, url: hit.url })),
          request.allowedDomains,
          request.blockedDomains,
        )
        allHits.push(...hits)
        sequence.push({ toolUseId: block.tool_use_id, hits })
      }
      groupEnded = true
    } else if (block.type === 'text') {
      if (groupEnded) {
        accumulated = ''
        groupEnded = false
      }
      accumulated += block.text
    }
  }
  if (accumulated.length > 0) sequence.push(accumulated.trim())

  return {
    ok: true,
    via,
    tier: 'native',
    hits: normaliseHits(allHits, Number.MAX_SAFE_INTEGER),
    commentary: sequence.filter((entry): entry is string => typeof entry === 'string'),
    queries: [...queriesByToolUse.values()],
    sequence,
  }
}
