import { randomUUID } from 'node:crypto'

import type { HookEvent } from 'src/entrypoints/agentSdkTypes.js'
import type { Message } from '../../types/message.js'
import type { ToolPermissionContext, ToolUseContext } from '../../Tool.js'
import { routedCallModelSettled } from '../../services/providers/callModelRouter.js'
import { createAttachmentMessage } from '../attachments.js'
import { createCombinedAbortSignal } from '../combinedAbortSignal.js'
import { createUserMessage, extractTextContent } from '../messages.js'
import { sessionSmallFastModel } from '../model/providerFrontier.js'
import { jsonParse } from '../slowOperations.js'
import { stripExplicitNulls } from '../messages/structuredOutputDialect.js'
import { asSystemPrompt } from '../systemPromptType.js'
import type { HookCommand } from '../settings/types.js'
import { addArgumentsToPrompt, hookResponseSchema } from './hookHelpers.js'
import type { HookResult } from './types.js'

type PromptHook = Extract<HookCommand, { type: 'prompt' }>

const DEFAULT_PROMPT_HOOK_TIMEOUT_MS = 30_000

/** Exported for the structured-output dialect prover: `reason` is optional
 *  in the plain spelling; the OpenAI bridge wears the strict dialect. */
export const VERDICT_JSON_SCHEMA = {
  type: 'object',
  properties: {
    ok: { type: 'boolean' },
    reason: { type: 'string' },
  },
  required: ['ok'],
  additionalProperties: false,
} as const

/**
 * Executor for `prompt`-type hooks: one settled model call returning a
 * structured met / not-met verdict. The call rides the routed one-shot seam,
 * so a hook that names no model judges on the SESSION family's small-fast
 * tier (an Anthropic session keeps its Haiku tier; a session on another
 * provider judges on its own wire and wallet), and a hook naming a model
 * rides that id's own family by the routing law.
 */
export async function execPromptHook(
  hook: PromptHook,
  hookName: string,
  hookEvent: HookEvent,
  jsonInput: string,
  signal: AbortSignal,
  toolUseContext: ToolUseContext,
  messages?: Message[],
  toolUseID?: string,
): Promise<HookResult> {
  const timeoutMs = hook.timeout ? hook.timeout * 1000 : DEFAULT_PROMPT_HOOK_TIMEOUT_MS
  const { signal: combinedSignal, cleanup } = createCombinedAbortSignal(signal, { timeoutMs })
  const resolvedToolUseId = toolUseID ?? `hook-${randomUUID()}`

  try {
    const prompt = addArgumentsToPrompt(hook.prompt, jsonInput)
    const promptMessage = createUserMessage({ content: prompt })
    const conversation = messages ? [...messages, promptMessage] : [promptMessage]

    const systemPrompt = asSystemPrompt([
      'You are evaluating a hook in Mercury. Judge whether the stated condition is met.',
      'Respond with a JSON object matching exactly one of these two schemas:',
      '{"ok": true}',
      '{"ok": false, "reason": "<what failed>"}',
    ])

    const response = await routedCallModelSettled({
      messages: conversation,
      systemPrompt,
      thinkingConfig: { type: 'disabled' },
      tools: toolUseContext.options.tools ?? [],
      signal: combinedSignal,
      options: {
        getToolPermissionContext: async () =>
          toolUseContext.getAppState().toolPermissionContext as ToolPermissionContext,
        model: hook.model ?? sessionSmallFastModel(),
        // Regardless of the real session, hook evaluation is non-interactive.
        isNonInteractiveSession: true,
        querySource: 'hook_prompt',
        agents: [],
        hasAppendSystemPrompt: false,
        mcpTools: [],
        agentId: toolUseContext.agentId,
        outputFormat: { type: 'json_schema', schema: VERDICT_JSON_SCHEMA },
      },
    })
    cleanup()

    const text = extractTextContent(response.message.content).trim()
    toolUseContext.setResponseLength?.(prev => prev + text.length)

    const parsed = jsonParse(text)
    if (parsed === undefined) {
      return {
        message: createAttachmentMessage({
          type: 'hook_non_blocking_error',
          hookName,
          toolUseID: resolvedToolUseId,
          hookEvent,
          stderr: 'JSON validation failed',
          stdout: text,
          exitCode: 1,
        }),
        outcome: 'non_blocking_error',
        hook,
      }
    }
    // The strict wire dialect answers optional-and-absent as an explicit
    // null — restore absent-means-absent before the zod verdict.
    const verdict = hookResponseSchema().safeParse(stripExplicitNulls(parsed))
    if (!verdict.success) {
      return {
        message: createAttachmentMessage({
          type: 'hook_non_blocking_error',
          hookName,
          toolUseID: resolvedToolUseId,
          hookEvent,
          stderr: `Schema validation failed: ${verdict.error.message}`,
          stdout: text,
          exitCode: 1,
        }),
        outcome: 'non_blocking_error',
        hook,
      }
    }

    if (!verdict.data.ok) {
      return {
        blockingError: {
          blockingError: `Prompt hook condition was not met: ${verdict.data.reason}`,
          command: hook.prompt,
        },
        outcome: 'blocking',
        preventContinuation: true,
        stopReason: verdict.data.reason,
        hook,
      }
    }

    return {
      message: createAttachmentMessage({
        type: 'hook_success',
        hookName,
        toolUseID: resolvedToolUseId,
        hookEvent,
        content: '',
      }),
      outcome: 'success',
      hook,
    }
  } catch (error) {
    cleanup()
    if (combinedSignal.aborted || (error instanceof Error && error.name === 'AbortError')) {
      return { outcome: 'cancelled', hook }
    }
    return {
      message: createAttachmentMessage({
        type: 'hook_non_blocking_error',
        hookName,
        toolUseID: resolvedToolUseId,
        hookEvent,
        stderr: `Executing the prompt hook failed: ${error instanceof Error ? error.message : String(error)}`,
        stdout: '',
        exitCode: 1,
      }),
      outcome: 'non_blocking_error',
      hook,
    }
  }
}
