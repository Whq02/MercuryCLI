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

/** The deferral policy's MCP test is the `isMcp` flag alone — no name-prefix fallback. */
function isMcpToolLike(tool: Tool): boolean {
  return 'isMcp' in tool && tool.isMcp === true
}

/**
 * Whether a tool is announced by name only (schema fetched on demand).
 * Order matters: the always-load opt-out is checked FIRST so MCP tools can
 * opt out; MCP tools are otherwise always deferred (workflow-specific);
 * the search tool itself never is; the two scheduling/notification channels
 * are force-loaded while their gates are on (a self-paced loop tick must
 * re-arm without a discovery round-trip); the Apollo closing-review tool is force-loaded
 * while the session mode is 'apollo' — the mode's entire exit funnels to
 * that ONE call, so it must never hide behind a discovery round-trip in the
 * only mode that can call it (callers that know the live mode pass it;
 * callers that don't get the conservative deferred answer); everything else
 * defers exactly when it declares itself deferrable.
 */
export function isDeferredTool(tool: Tool, permissionMode?: string): boolean {
  // Mode-independent by law: the tools array is part of the prefix every
  // thinking block is bound to, so a tool's listing may not follow the
  // permission mode. The Apollo closing-review tool is loaded in full in
  // every mode and refuses outside apollo at call time (its own
  // validateInput); the mode argument is kept for callers and ignored.
  void permissionMode
  if (tool.alwaysLoad) return false
  if (isMcpToolLike(tool)) return true
  if (tool.name === TOOL_SEARCH_TOOL_NAME) return false
  if (tool.name === SATURN_EXEMPT_TOOL_A && isSaturnExemptAEnabled()) return false
  if (tool.name === SATURN_EXEMPT_TOOL_B && isSaturnExemptBEnabled()) return false
  if (tool.name === APOLLO_REVIEW_TOOL_NAME) return false
  return Boolean(tool.shouldDefer)
}

/** One announcement line — the bare tool name; the builders join these directly. */
export function formatDeferredToolLine(tool: Tool): string {
  return tool.name
}

/**
 * The tool's own description, honest per WIRE FORM. On the block form the
 * server expands each match into its schema inside the result (the text
 * below is that wire's, byte-for-byte as before); on the text form the
 * result names the admitted tools and their schemas ride the tool list of
 * every request from then on. The wire form is the deferralWire owner's
 * per-route capability; callers pass the form resolved for the model the
 * text is rendered for.
 */
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
