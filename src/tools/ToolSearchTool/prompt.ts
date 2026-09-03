import type { Tool } from '../../Tool.js'
import { TOOL_SEARCH_TOOL_NAME } from './constants.js'
import { APOLLO_REVIEW_TOOL_NAME } from '../ApolloReviewTool/constants.js'
import {
  isSaturnExemptAEnabled,
  isSaturnExemptBEnabled,
  SATURN_EXEMPT_TOOL_A,
  SATURN_EXEMPT_TOOL_B,
} from '../saturnExemptTools.js'
import { isDeferredToolsDeltaEnabled } from '../../utils/toolSearchFlags.js'

export { TOOL_SEARCH_TOOL_NAME }

function isMcpToolLike(tool: Tool): boolean {
  return 'isMcp' in tool && tool.isMcp === true
}

export function isDeferredTool(tool: Tool, permissionMode?: string): boolean {
  void permissionMode
  void APOLLO_REVIEW_TOOL_NAME
  if (tool.alwaysLoad) return false
  if (isMcpToolLike(tool)) return true
  if (tool.name === TOOL_SEARCH_TOOL_NAME) return false
  if (tool.name === SATURN_EXEMPT_TOOL_A && isSaturnExemptAEnabled()) return false
  if (tool.name === SATURN_EXEMPT_TOOL_B && isSaturnExemptBEnabled()) return false
  return Boolean(tool.shouldDefer)
}

export function formatDeferredToolLine(tool: Tool): string {
  return tool.name
}

export function getPrompt(wireForm: 'block' | 'text' = 'block'): string {
  const head = `Load the full schemas of deferred tools so they become callable.

`
  const location = isDeferredToolsDeltaEnabled()
    ? `Deferred tools surface name-only inside <system-reminder> messages.`
    : `Deferred tools surface name-only inside <available-deferred-tools> messages.`
  const queryForms = `Query forms:
- \`select:Read,Edit,Grep\` — pull exactly the tools named
- \`notebook jupyter\` — keyword search returning the best matches, max_results at most
- \`+slack send\` — "slack" must appear in the name; remaining terms only rank`
  if (wireForm === 'text') {
    const tail = ` Before that fetch, the name is all you hold — without a parameter schema the tool stays uncallable. Hand it a query; it matches against the deferred roster and admits each match: the result names the admitted tools, and from that request on their complete definitions are in your tool list, no different from the tools the prompt opened with.

`
    return head + location + tail + queryForms
  }
  const tail = ` Before that fetch, the name is all you hold — without a parameter schema the tool stays uncallable. Hand it a query; it matches against the deferred roster and answers with the complete JSONSchema definition of each match, inside a <functions> block. A schema landing in that result makes its tool callable, no different from the tools the prompt opened with.

Shape of the result: every match lands as its own \`<function>{"description": "...", "name": "...", "parameters": {...}}</function>\` line inside the <functions> block, encoded the way the opening tool list is.

`
  return head + location + tail + queryForms
}
