import { z } from 'zod'

import { buildTool, type ToolUseContext } from '../../Tool.js'
import { nativeSearch } from '../../services/search/nativeSearch.js'
import { nativeSearchFamilyOf } from '../../services/search/searchDoor.js'
import { failureLine } from '../../services/search/searchContract.js'
import { TOOL_SUMMARY_MAX_LENGTH } from '../../constants/toolLimits.js'
import type { WebSearchProgress } from '../../types/tools.js'
import { AbortError } from '../../utils/errors.js'
import { getEngineModel } from '../../services/model/model.js'
import { suggestionForExactCommand } from '../../utils/permissions/shellRuleMatching.js'
import { truncate } from '../../utils/format.js'
import { getProviderSearchPrompt, PROVIDER_SEARCH_TOOL_NAME } from './prompt.js'
import { mapSearchResult, outputSchema, type Output } from './searchOutput.js'
import { getToolUseSummary, renderToolResultMessage, renderToolUseMessage, renderToolUseProgressMessage } from './UI.js'
import { unbuilt, type Unbuilt } from '../../pi/holes.js'


const inputSchema: Unbuilt = unbuilt('src/tools/WebSearchTool/ProviderSearchTool.ts:18')

type Input = z.infer<typeof inputSchema>

const providerSearchOutputSchema = outputSchema

export const ProviderSearchTool: Unbuilt = unbuilt('src/tools/WebSearchTool/ProviderSearchTool.ts:67')
