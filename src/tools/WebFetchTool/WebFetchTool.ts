import { z } from 'zod'

import { buildTool, type ToolPermissionContext, type ToolUseContext } from '../../Tool.js'
import { formatFileSize } from '../../utils/format.js'
import { createPermissionRequestMessage, getRuleByContentsForToolName } from '../../utils/permissions/permissions.js'
import { suggestionForExactCommand } from '../../utils/permissions/shellRuleMatching.js'
import type { PermissionDecisionReason } from '../../utils/permissions/PermissionResult.js'
import { isPreapprovedHost } from './preapproved.js'
import { DESCRIPTION, getPrompt, WEB_FETCH_TOOL_NAME } from './prompt.js'
import { getToolUseSummary, renderToolResultMessage, renderToolUseMessage, renderToolUseProgressMessage } from './UI.js'
import { applyPromptToMarkdown, getURLMarkdownContent, isPreapprovedUrl, MAX_MARKDOWN_LENGTH } from './utils.js'

/**
 * Model-facing tool: fetch a URL, convert it, and summarise it with a
 * secondary model under a hostname-scoped permission model.
 */

const inputSchema = z.strictObject({
  url: z.string().url().describe('The URL to fetch content from'),
  prompt: z.string().describe('The prompt to run on the fetched content'),
})

type Input = z.infer<typeof inputSchema>

const outputSchema = z.object({
  bytes: z.number().describe('Byte size of the fetched content'),
  code: z.number().describe('HTTP status code of the response'),
  codeText: z.string().describe('HTTP status text of the response'),
  result: z.string().describe('The processed result of the fetch'),
  durationMs: z.number().describe('Elapsed fetch time in milliseconds'),
  url: z.string().describe('The URL that was fetched'),
})

export type Output = z.infer<typeof outputSchema>

/**
 * The permission rule key: `domain:<hostname>` is what users type into
 * permission settings and what is persisted; an unparseable input degrades
 * to `input:<stringified input>`.
 */
function ruleContentFor(input: Input): string {
  try {
    return `domain:${new URL(input.url).hostname}`
  } catch {
    return `input:${JSON.stringify(input)}`
  }
}

function ruleReason(
  context: ToolPermissionContext,
  ruleContent: string,
  behavior: 'allow' | 'deny' | 'ask',
): PermissionDecisionReason {
  const rule = getRuleByContentsForToolName(context, WEB_FETCH_TOOL_NAME, behavior).get(ruleContent)
  return {
    type: 'rule',
    rule: rule ?? {
      source: 'localSettings',
      ruleBehavior: behavior,
      ruleValue: { toolName: WEB_FETCH_TOOL_NAME, ruleContent },
    },
  }
}

const REDIRECT_PHRASES: Record<number, string> = {
  301: 'Moved Permanently',
  308: 'Permanent Redirect',
  307: 'Temporary Redirect',
}

async function runFetch(input: Input, context: ToolUseContext): Promise<Output> {
  const startTime = Date.now()
  const fetched = await getURLMarkdownContent(input.url, context.abortController)

  // Only the redirect shape carries a `type` member, so the `in` check alone
  // discriminates the union (and lets the fall-through narrow to fetched content).
  if ('type' in fetched) {
    // A cross-host redirect is reported back, never followed.
    const phrase = REDIRECT_PHRASES[fetched.statusCode] ?? 'Found'
    const message = `CROSS-HOST REDIRECT: this URL answers with a redirect to a different host, which is reported rather than followed.

Original URL: ${fetched.originalUrl}
Redirect URL: ${fetched.redirectUrl}
Status: ${fetched.statusCode} ${phrase}

To complete the request, call ${WEB_FETCH_TOOL_NAME} again with url: "${fetched.redirectUrl}" and the same prompt: "${input.prompt}".`
    return {
      bytes: Buffer.byteLength(message, 'utf8'),
      code: fetched.statusCode,
      codeText: phrase,
      result: message,
      durationMs: Date.now() - startTime,
      url: input.url,
    }
  }

  const preapproved = isPreapprovedUrl(input.url)
  let result: string
  if (preapproved && fetched.contentType.includes('text/markdown') && fetched.content.length < MAX_MARKDOWN_LENGTH) {
    // Preapproved markdown under the ceiling bypasses the model entirely.
    result = fetched.content
  } else {
    result = await applyPromptToMarkdown(
      input.prompt,
      fetched.content,
      context.abortController.signal,
      context.options.isNonInteractiveSession,
      preapproved,
    )
  }

  if (fetched.persistedPath) {
    const size = formatFileSize(fetched.persistedSize ?? fetched.bytes)
    result += `\n\n[Binary content (${fetched.contentType}, ${size}) was saved to ${fetched.persistedPath} — inspect the original if this summary is insufficient.]`
  }

  return {
    bytes: fetched.bytes,
    code: fetched.code,
    codeText: fetched.codeText,
    result,
    durationMs: Date.now() - startTime,
    url: input.url,
  }
}

export const WebFetchTool = buildTool({
  name: WEB_FETCH_TOOL_NAME,
  userFacingName: () => 'Fetch',
  searchHint: 'fetches and extracts content from a URL',
  shouldDefer: true,
  maxResultSizeChars: 100_000,
  inputSchema,
  outputSchema,
  isReadOnly: () => true,
  isConcurrencySafe: () => true,
  async description(input: Partial<Input>): Promise<string> {
    try {
      return `Mercury wants to fetch content from ${new URL(input.url ?? '').hostname}`
    } catch {
      return 'Mercury wants to fetch content from this URL'
    }
  },
  async prompt(): Promise<string> {
    return getPrompt()
  },
  getActivityDescription(input: Partial<Input> | undefined): string {
    if (!input?.url) return 'Fetching a web page'
    return `Fetching ${getToolUseSummary(input)}`
  },
  getToolUseSummary,
  toAutoClassifierInput(input: Input): string {
    return input.prompt ? `${input.url}: ${input.prompt}` : input.url
  },
  async validateInput(input: Input) {
    try {
      new URL(input.url)
      return { result: true as const }
    } catch {
      return {
        result: false as const,
        message: `The URL "${input.url}" could not be parsed.`,
        meta: { reason: 'invalid_url' },
        errorCode: 1,
      }
    }
  },
  async checkPermissions(input: Input, context: ToolUseContext) {
    const permissionContext = context.getAppState().toolPermissionContext as ToolPermissionContext
    try {
      const parsed = new URL(input.url)
      if (isPreapprovedHost(parsed.hostname, parsed.pathname)) {
        return {
          behavior: 'allow' as const,
          updatedInput: input,
          decisionReason: { type: 'other' as const, reason: 'Preapproved documentation host' },
        }
      }
    } catch {
      // Falls through to the rule lookup on the degraded key.
    }
    const ruleContent = ruleContentFor(input)
    const message = createPermissionRequestMessage(WEB_FETCH_TOOL_NAME)
    const suggestions = suggestionForExactCommand(WEB_FETCH_TOOL_NAME, ruleContent)
    // Deny → ask → allow, each a lookup by rule content in this tool's map.
    if (getRuleByContentsForToolName(permissionContext, WEB_FETCH_TOOL_NAME, 'deny').has(ruleContent)) {
      return {
        behavior: 'deny' as const,
        message: `${WEB_FETCH_TOOL_NAME} is denied for ${ruleContent} by a permission rule.`,
        decisionReason: ruleReason(permissionContext, ruleContent, 'deny'),
      }
    }
    if (getRuleByContentsForToolName(permissionContext, WEB_FETCH_TOOL_NAME, 'ask').has(ruleContent)) {
      return {
        behavior: 'ask' as const,
        message,
        decisionReason: ruleReason(permissionContext, ruleContent, 'ask'),
        suggestions,
      }
    }
    if (getRuleByContentsForToolName(permissionContext, WEB_FETCH_TOOL_NAME, 'allow').has(ruleContent)) {
      return {
        behavior: 'allow' as const,
        updatedInput: input,
        decisionReason: ruleReason(permissionContext, ruleContent, 'allow'),
      }
    }
    return { behavior: 'ask' as const, message, suggestions }
  },
  async call(input: Input, context: ToolUseContext) {
    return { data: await runFetch(input, context) }
  },
  mapToolResultToToolResultBlockParam(output: Output, toolUseID: string) {
    return { tool_use_id: toolUseID, type: 'tool_result' as const, content: output.result }
  },
  extractSearchText(output: Output): string {
    return output.result
  },
  renderToolUseMessage,
  renderToolUseProgressMessage,
  renderToolResultMessage,
  renderToolUseQueuedMessage: () => null,
  renderToolUseRejectedMessage: () => null,
  renderToolUseErrorMessage: () => null,
})

export { DESCRIPTION }
