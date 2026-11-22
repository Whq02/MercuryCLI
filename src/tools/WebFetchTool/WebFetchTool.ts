import { z } from 'zod'

import { buildTool, type ToolPermissionContext, type ToolUseContext } from '../../Tool.js'
import { formatFileSize } from '../../utils/format.js'
import { createPermissionRequestMessage } from '../../utils/permissions/decision/requestMessage.js'
import { getRuleByContentsForToolName } from '../../utils/permissions/decision/rules.js'
import { suggestionForExactCommand } from '../../utils/permissions/shellRuleMatching.js'
import { ruleSentence } from '../../utils/permissions/ruleReason.js'
import type { PermissionDecisionReason } from '../../utils/permissions/PermissionResult.js'
import type { PermissionRule } from '../../types/permissions.js'
import { isPreapprovedHost } from './preapproved.js'
import { DESCRIPTION, getPrompt, WEB_FETCH_TOOL_NAME } from './prompt.js'
import { getToolUseSummary, renderToolResultMessage, renderToolUseMessage, renderToolUseProgressMessage } from './UI.js'
import { applyPromptToMarkdown, getURLMarkdownContent, isPreapprovedUrl } from './utils.js'
import { pageSlice } from './pageBudget.js'
import { normaliseForMatch } from '../../utils/text/normaliseForMatch.js'
import { FetchRefusedError } from './fetchErrors.js'
import { metadataRefusal } from './privateHost.js'
import { withFetchSession } from './fetchTransport.js'
import { ownerFromToolUseContext } from '../../utils/run/resolveOwner.js'
import { passedOver } from '../../utils/passedOver.js'
import { webFetchRuleMatches } from '../../utils/permissions/webFetchRuleMatches.js'
import { unbuilt, type Unbuilt } from '../../pi/holes.js'


const inputSchema = z.strictObject({
  url: z.string().url().optional().describe('Single URL (use url or urls)'),
  urls: z.array(z.string().url().max(2000)).min(1).max(3).optional().describe('1–3 URLs in order, each with its own result and permission; page text is bounded to 38,000 bytes each, total result 132,000 bytes'),
  from: z.number().int().nonnegative().optional().describe('Continue at the character offset the previous result names'),
  prompt: z.string().optional().describe('Ask a model for a reading of the page; omit to receive the page’s own words'),
}).refine(input => (input.url === undefined) !== (input.urls === undefined), { message: 'Pass either url or urls, not both' })

type Input = z.infer<typeof inputSchema>
type SingleInput = Omit<Input, 'url' | 'urls'> & { url: string }

const fetchResultSchema: Unbuilt = unbuilt('src/tools/WebFetchTool/WebFetchTool.ts:35')

const outputSchema = fetchResultSchema.extend({ results: z.array(fetchResultSchema).optional() })
export type Output = z.infer<typeof outputSchema>

function ruleContentFor(input: Input): string {
  try {
    return `domain:${new URL(input.url ?? '').hostname}`
  } catch {
    return `input:${JSON.stringify(input)}`
  }
}

function matchingRule(
  context: ToolPermissionContext,
  requestContent: string,
  behavior: 'allow' | 'deny' | 'ask',
): PermissionRule | undefined {
  const rules = getRuleByContentsForToolName(context, WEB_FETCH_TOOL_NAME, behavior)
  const exact = rules.get(requestContent)
  if (exact !== undefined) return exact
  for (const [content, rule] of rules) if (webFetchRuleMatches(content, requestContent)) return rule
  return undefined
}

function ruleReason(
  rule: PermissionRule | undefined,
  requestContent: string,
  behavior: 'allow' | 'deny' | 'ask',
): Extract<PermissionDecisionReason, { type: 'rule' }> {
  return {
    type: 'rule',
    rule: rule ?? {
      source: 'localSettings',
      ruleBehavior: behavior,
      ruleValue: { toolName: WEB_FETCH_TOOL_NAME, ruleContent: requestContent },
    },
  }
}

const REDIRECT_PHRASES: Record<number, string> = {
  301: 'Moved Permanently',
  308: 'Permanent Redirect',
  307: 'Temporary Redirect',
}

export const WebFetchTool: Unbuilt = unbuilt('src/tools/WebFetchTool/WebFetchTool.ts:146')

export { DESCRIPTION }
