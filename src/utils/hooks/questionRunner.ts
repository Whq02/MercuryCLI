import type { z } from 'zod/v4'
import { toJSONSchema } from 'zod/v4'
import type { ToolPermissionContext, ToolUseContext } from '../../Tool.js'
import { routedCallModelSettled } from '../../services/providers/callModelRouter.js'
import { createCombinedAbortSignal } from '../combinedAbortSignal.js'
import { errorMessage } from '../errors.js'
import { createUserMessage, extractTextContent } from '../messages.js'
import { stripExplicitNulls } from '../messages/structuredOutputDialect.js'
import { sessionSmallFastModel } from '../model/providerFrontier.js'
import { jsonParse } from '../slowOperations.js'
import { asSystemPrompt } from '../systemPromptType.js'

export type ModelHookRun = {
  text: string
  name: string
  event: string
  payloadJson: string
  answerSchema: z.ZodType
  model?: string
  timeoutMs: number
  signal?: AbortSignal
  toolUseContext: ToolUseContext
}

export type ModelHookEnd =
  | { kind: 'answered'; answer: unknown; durationMs: number }
  | { kind: 'timed_out'; durationMs: number }
  | { kind: 'cancelled'; durationMs: number }
  | { kind: 'failed'; detail: string; durationMs: number }

export function hookBrief(text: string, payloadJson: string): string {
  const placeholder = /\$EVENT(?!\w)/g
  if (placeholder.test(text)) return text.replace(placeholder, () => payloadJson)
  return `${text}\n\nEVENT: ${payloadJson}`
}

export function hookAnswerJsonSchema(schema: z.ZodType): Record<string, unknown> {
  return toJSONSchema(schema as never, { unrepresentable: 'any' }) as Record<string, unknown>
}

export async function runQuestionHook(run: ModelHookRun): Promise<ModelHookEnd> {
  const startedAt = Date.now()
  const combined = createCombinedAbortSignal(run.signal, { timeoutMs: run.timeoutMs })
  const ended = (end: ModelHookEnd): ModelHookEnd => end
  try {
    const systemPrompt = asSystemPrompt([
      `You are answering a hook in Mercury at the moment ${run.event}. The hook's question follows, with the moment's facts as JSON.`,
      'Answer with exactly one JSON object of the hook answer shape; {} when you have nothing to say.',
    ])
    const response = await routedCallModelSettled({
      messages: [createUserMessage({ content: hookBrief(run.text, run.payloadJson) })],
      systemPrompt,
      thinkingConfig: { type: 'disabled' },
      tools: [],
      signal: combined.signal,
      options: {
        getToolPermissionContext: async () => run.toolUseContext.getAppState().toolPermissionContext as ToolPermissionContext,
        model: run.model ?? sessionSmallFastModel(),
        isNonInteractiveSession: true,
        querySource: 'hook_prompt',
        agents: [],
        hasAppendSystemPrompt: false,
        mcpTools: [],
        agentId: run.toolUseContext.agentId,
        outputFormat: { type: 'json_schema', schema: hookAnswerJsonSchema(run.answerSchema) },
      },
    })
    const durationMs = Date.now() - startedAt
    if (combined.signal.aborted) return ended(run.signal?.aborted ? { kind: 'cancelled', durationMs } : { kind: 'timed_out', durationMs })
    const text = extractTextContent(response.message.content).trim()
    run.toolUseContext.setResponseLength?.(prev => prev + text.length)
    if ((response as { isApiErrorMessage?: boolean }).isApiErrorMessage) return ended({ kind: 'failed', detail: text || 'the model call failed', durationMs })
    const parsed = jsonParse(text)
    if (parsed === undefined || parsed === null || typeof parsed !== 'object') return ended({ kind: 'failed', detail: `the model answered with something other than a JSON object: ${text.slice(0, 200)}`, durationMs })
    return ended({ kind: 'answered', answer: stripExplicitNulls(parsed), durationMs })
  } catch (error) {
    const durationMs = Date.now() - startedAt
    if (combined.signal.aborted) return ended(run.signal?.aborted ? { kind: 'cancelled', durationMs } : { kind: 'timed_out', durationMs })
    return ended({ kind: 'failed', detail: errorMessage(error), durationMs })
  } finally {
    combined.cleanup()
  }
}
