import { z } from 'zod'

import { buildTool, type ToolUseContext } from '../../Tool.js'
import { performWebSearch } from '../../services/search/searchDoor.js'
import { mapSearchResult, outputSchema, type Output } from './searchOutput.js'
export type { Output } from './searchOutput.js'
import { TOOL_SUMMARY_MAX_LENGTH } from '../../constants/toolLimits.js'
import type { WebSearchProgress } from '../../types/tools.js'
import { suggestionForExactCommand } from '../../utils/permissions/shellRuleMatching.js'
import { truncate } from '../../utils/format.js'
import { getWebSearchPrompt, SEARCH_QUERY_FIELD, WEB_SEARCH_TOOL_NAME } from './prompt.js'
import { getToolUseSummary, renderToolResultMessage, renderToolUseMessage, renderToolUseProgressMessage } from './UI.js'
import { unbuilt, type Unbuilt } from '../../pi/holes.js'


const inputSchema: Unbuilt = unbuilt('src/tools/WebSearchTool/WebSearchTool.ts:15')

type Input = z.infer<typeof inputSchema>

export const WebSearchTool: Unbuilt = unbuilt('src/tools/WebSearchTool/WebSearchTool.ts:54')
