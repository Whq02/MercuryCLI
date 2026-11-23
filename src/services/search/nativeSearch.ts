import type { ToolPermissionContext, ToolUseContext } from '../../Tool.js'
import { routedCallModel } from '../providers/callModelRouter.js'
import type { WebSearchProgress } from '../../types/tools.js'
import type { ContentBlock } from '../../types/wire.js'
import { logError } from '../../utils/log.js'
import { createUserMessage } from '../messages.js'
import { getEngineModel } from '../model/model.js'
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
import { passedOver } from '../../utils/passedOver.js'

const MAX_SEARCH_USES = 8

export type SearchProgressSink = (progress: { toolUseID: string; data: WebSearchProgress }) => void

export function nativeBackendIdFor(family: NativeSearchFamily): SearchBackendId {
  return family === 'anthropic' ? 'anthropic-native' : 'openai-native'
}

interface NativeSearchIo {
  context: ToolUseContext
  onProgress?: SearchProgressSink
}

function queryPropertyOf(value: unknown): string | null {
  if (!value || typeof value !== 'object') return null
  const candidate = (value as { query?: unknown }).query
  if (typeof candidate !== 'string') return null
  const trimmed = candidate.trim()
  return trimmed !== '' ? trimmed : null
}

function extractQueryFromInput(input: unknown): string | null {
  if (typeof input === 'string') {
    try {
      const parsed: unknown = JSON.parse(input)
      const query = queryPropertyOf(parsed)
      if (query !== null) return query
    } catch (error) {
      passedOver(error)
    }
    const match = /"query"\s*:\s*"((?:[^"\\]|\\.)*)"/.exec(input)
    if (match?.[1] !== undefined) {
      try {
        const decoded: unknown = JSON.parse(`"${match[1]}"`)
        if (typeof decoded === 'string') {
          const trimmed = decoded.trim()
          return trimmed !== '' ? trimmed : null
        }
      } catch (error) {
        passedOver(error)
      }
    }
    return null
  }
  return queryPropertyOf(input)
}

function collectAssistantText(blocks: readonly ContentBlock[]): string {
  return blocks
    .filter((block): block is Extract<ContentBlock, { type: 'text' }> => block.type === 'text')
    .map(block => block.text)
    .join('\n')
    .trim()
}

export async function nativeSearch(
  family: NativeSearchFamily,
  request: SearchRequest,
  io: NativeSearchIo,
): Promise<SearchOutcome> {
  const via = nativeBackendIdFor(family)
  const signal = request.signal ?? io.context.abortController.signal
  if (signal.aborted) {
    return searchFailure('aborted', via, 'Web search cancelled')
  }

  const model = io.context.options.engineModel || getEngineModel()
  const thinkingConfig = io.context.options.thinkingConfig ?? { type: 'disabled' as const }
  const appState = io.context.getAppState()
  const allowedDomains = request.allowedDomains?.filter(domain => domain.trim() !== '')
  const blockedDomains = request.blockedDomains?.filter(domain => domain.trim() !== '')
  const nativeWebSearch = {
    maxUses: MAX_SEARCH_USES,
    ...(allowedDomains && allowedDomains.length > 0 ? { allowedDomains } : {}),
    ...(blockedDomains && blockedDomains.length > 0 ? { blockedDomains } : {}),
  }

  const activeSearchBlocks = new Map<number, { toolUseId: string; partialJson: string }>()
  const queryByToolUseId = new Map<string, string>()
  const lastEmittedQuery = new Map<string, string>()
  const assistantBlocks: ContentBlock[] = []

  const emitQueryUpdate = (toolUseId: string, query: string): void => {
    queryByToolUseId.set(toolUseId, query)
    if (lastEmittedQuery.get(toolUseId) === query) return
    lastEmittedQuery.set(toolUseId, query)
    io.onProgress?.({ toolUseID: toolUseId, data: { type: 'query_update', query } })
  }

  try {
    const stream = routedCallModel({
      messages: [createUserMessage({ content: `Perform a web search for the query: ${request.query}` })],
      systemPrompt: asSystemPrompt([
        'You are a web search assistant. Perform the requested web search and summarize the results clearly with citations.',
      ]),
      thinkingConfig,
      tools: [],
      signal,
      options: {
        model,
        querySource: 'web_search_tool',
        isNonInteractiveSession: io.context.options.isNonInteractiveSession,
        getToolPermissionContext: async (): Promise<ToolPermissionContext> =>
          io.context.getAppState().toolPermissionContext,
        agents: io.context.options.agentDefinitions.activeAgents,
        mcpTools: [],
        hasAppendSystemPrompt: Boolean(io.context.options.appendSystemPrompt),
        agentId: io.context.agentId,
        effortValue: appState.effortValue,
        nativeWebSearch,
      },
    })

    for await (const row of stream) {
      if (row.type === 'stream_event') {
        const event = row.event
        if (event.type === 'content_block_start') {
          const block = event.content_block
          if (block.type === 'server_tool_use' && block.name === 'web_search') {
            activeSearchBlocks.set(event.index, { toolUseId: block.id, partialJson: '' })
            const initialQuery = extractQueryFromInput(block.input)
            if (initialQuery !== null) emitQueryUpdate(block.id, initialQuery)
          } else if (block.type === 'web_search_tool_result') {
            const toolUseId = block.tool_use_id || 'web_search'
            const resultCount = Array.isArray(block.content) ? block.content.length : 0
            const query = queryByToolUseId.get(toolUseId) ?? request.query
            io.onProgress?.({
              toolUseID: toolUseId,
              data: { type: 'search_results_received', resultCount, query },
            })
          }
        } else if (event.type === 'content_block_delta' && event.delta.type === 'input_json_delta') {
          const active = activeSearchBlocks.get(event.index)
          if (active) {
            active.partialJson += event.delta.partial_json
            const extracted = extractQueryFromInput(active.partialJson)
            if (extracted !== null) emitQueryUpdate(active.toolUseId, extracted)
          }
        } else if (event.type === 'content_block_stop') {
          activeSearchBlocks.delete(event.index)
        }
      } else if (row.type === 'assistant') {
        if (row.isApiErrorMessage) {
          const detail = collectAssistantText(row.message.content)
          return searchFailure('provider-refused', via, detail || 'Unknown provider error')
        }
        assistantBlocks.push(...row.message.content)
      }
    }
  } catch (error) {
    if (signal.aborted) {
      return searchFailure('aborted', via, 'Web search cancelled')
    }
    logError(error)
    return searchFailure('provider-refused', via, error instanceof Error ? error.message : String(error))
  }

  if (signal.aborted) {
    return searchFailure('aborted', via, 'Web search cancelled')
  }

  const sequence: Array<string | { toolUseId: string; hits: SearchHit[] }> = []
  const allHits: SearchHit[] = []
  const observedQueriesById = new Map<string, string>()
  const pendingText: string[] = []

  const flushText = (): void => {
    if (pendingText.length === 0) return
    const combined = pendingText.join('').trim()
    pendingText.length = 0
    if (combined !== '') sequence.push(combined)
  }

  for (const block of assistantBlocks) {
    if (block.type === 'text') {
      pendingText.push(block.text)
    } else if (block.type === 'server_tool_use' && block.name === 'web_search') {
      flushText()
      const query = extractQueryFromInput(block.input) ?? queryByToolUseId.get(block.id)
      if (query !== undefined && query !== null && !observedQueriesById.has(block.id)) {
        observedQueriesById.set(block.id, query)
      }
    } else if (block.type === 'web_search_tool_result') {
      flushText()
      if (Array.isArray(block.content)) {
        const rawHits: SearchHit[] = block.content.map(item => ({
          title: item.title,
          url: item.url,
          snippet: '',
          source_type: 'provider',
        }))
        const filtered = filterHitsByDomain(rawHits, request.allowedDomains, request.blockedDomains)
        allHits.push(...filtered)
        sequence.push({ toolUseId: block.tool_use_id, hits: filtered })
      } else {
        const errorText = `Web search error: ${block.content.error_code}`
        logError(new Error(errorText))
        sequence.push(errorText)
      }
    }
  }
  flushText()

  const commentary = sequence.filter((entry): entry is string => typeof entry === 'string')
  const hits = normaliseHits(allHits, request.maxResults)

  return {
    ok: true,
    via,
    tier: 'native',
    hits,
    commentary,
    queries: [...observedQueriesById.values()],
    sequence,
  }
}
