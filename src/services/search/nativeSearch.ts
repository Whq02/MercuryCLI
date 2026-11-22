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
import { notBuilt } from '../../pi/holes.js'

const MAX_SEARCH_USES = 8

export type SearchProgressSink = (progress: { toolUseID: string; data: WebSearchProgress }) => void

export function nativeBackendIdFor(family: NativeSearchFamily): SearchBackendId {
  return family === 'anthropic' ? 'anthropic-native' : 'openai-native'
}

interface NativeSearchIo {
  context: ToolUseContext
  onProgress?: SearchProgressSink
}

export async function nativeSearch(
  family: NativeSearchFamily,
  request: SearchRequest,
  io: NativeSearchIo,
): Promise<SearchOutcome> {
  return notBuilt('src/services/search/nativeSearch.ts:45')
}
