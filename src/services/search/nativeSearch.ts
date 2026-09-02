// ============================================================================
//  services/search/nativeSearch — the NATIVE doors: a nested model query on
//  the main model's OWN provider, carrying that wire's search construct
//  (the neutral NativeWebSearchRequest the lane maps onto its spelling), the
//  streamed blocks folded into hits and model commentary.
//
//  THE FAMILY LAW: this door opens only for a session whose main model's
//  route is a NATIVE_SEARCH_FAMILIES member, and the leg's model is that
//  main model — or the session's small-fast tier under the gate, admitted
//  ONLY when that id routes to the SAME family (nativeSearchLegModel: a
//  cross-family utility pin such as ANTHROPIC_SMALL_FAST_MODEL aimed at
//  another provider falls back to the main model — the original
//  WebSearchTool leak was exactly the cross-account class, so this door
//  carries the clamp the general utility posture does not). A credential of
//  another family is never spent here: the search door (searchDoor.ts)
//  decides the family, this module never re-decides it. The CALL rides
//  routedCallModel, the one provider-aware seam: the id decides the wire.
//
//  Credential absence is not preflighted (the usability owner's law): a
//  refused call settles as the typed provider-refused outcome, and the
//  search door falls to the next open door with the line naming why.
// ============================================================================
import type { ToolPermissionContext, ToolUseContext } from '../../Tool.js'
import { getFeatureValue_CACHED_MAY_BE_STALE } from '../analytics/featureGates.js'
import { routedCallModel } from '../providers/callModelRouter.js'
import { declaredRouteOf } from '../providers/routeLaw.js'
import type { WebSearchProgress } from '../../types/tools.js'
import type { ContentBlock } from '../../types/wire.js'
import { logError } from '../../utils/log.js'
import { createUserMessage } from '../../utils/messages.js'
import { getMainLoopModel } from '../../utils/model/model.js'
import { sessionSmallFastModel } from '../../utils/model/providerFrontier.js'
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

// Wire contract data (spec step 4): route the nested query to the session's
// small fast tier — default off.
const SMALL_MODEL_ROUTE_GATE = 'mercury_plum_vx3'
const MAX_SEARCH_USES = 8

export type SearchProgressSink = (progress: { toolUseID: string; data: WebSearchProgress }) => void

export function nativeBackendIdFor(family: NativeSearchFamily): SearchBackendId {
  return family === 'anthropic' ? 'anthropic-native' : 'openai-native'
}

/** The one model the native leg calls — PURE, pinned by
 *  scripts/search/prove-search-door.ts §5 (upgraded to a
 *  clamp): the resolved small-fast id is admitted only when its route IS
 *  this door's family; a cross-family utility pin (the operator aiming
 *  ANTHROPIC_SMALL_FAST_MODEL at another provider) must never spend that
 *  family's account on a search labelled `via <family>-native` — on a
 *  mismatch the leg is the session's own main model, plainly. */
export function nativeSearchLegModel(
  family: NativeSearchFamily,
  mainModel: string,
  smallFastResolved: string | undefined,
): { model: string; small: boolean } {
  const small = smallFastResolved !== undefined && declaredRouteOf(smallFastResolved) === family
  return { model: small ? smallFastResolved : mainModel, small }
}

/** Extract a complete `query` field from partial JSON, honouring escapes. */
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
  const useSmallModel = getFeatureValue_CACHED_MAY_BE_STALE(SMALL_MODEL_ROUTE_GATE, false)
  const mainModel = (context.options.mainLoopModel as string | undefined) || getMainLoopModel()
  const leg = nativeSearchLegModel(family, mainModel, useSmallModel ? sessionSmallFastModel() : undefined)
  const model = leg.model
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
    thinkingConfig: leg.small ? { type: 'disabled' } : context.options.thinkingConfig,
    tools: [],
    signal: context.abortController.signal,
    options: {
      getToolPermissionContext: async () => appState.toolPermissionContext as ToolPermissionContext,
      model,
      ...(leg.small ? { toolChoice: { type: 'tool' as const, name: 'web_search' } } : {}),
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
          // A lane that settles the call whole (the OpenAI lane) carries the
          // query in the start block; the Anthropic lane streams it below.
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
        // The leg failed on the provider — a TYPED outcome the door renders
        // (or falls through from), never raw API-error prose posing as a
        // search result.
        const errorText = (message.message.content as ContentBlock[])
          .map(block => (block.type === 'text' ? block.text : ''))
          .join('')
        return searchFailure('provider-refused', via, errorText || 'unknown provider error')
      }
      blocks.push(...(message.message.content as ContentBlock[]))
    }
  }
  if (context.abortController.signal.aborted) return searchFailure('aborted', via, 'cancelled')

  // Fold: text accumulates until a server tool-use begins a new group.
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
        // The domain law holds on every wire, the native filter included.
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
  // The trailing guard is on the UNTRIMMED length: a whitespace-only tail
  // pushes an empty-string entry (observable in persisted results).
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
