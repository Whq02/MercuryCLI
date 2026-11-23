import type { z } from 'zod/v4'
import { toJSONSchema } from 'zod/v4'
import type { ToolPermissionContext } from '../../tools/kit/tool.js'
import { routedCallModelSettled } from '../../models/roads/callModelRouter.js'
import { readCatalogueIfPending } from '../../models/roads/catalogueOnDemand.js'
import { declaredRouteOf } from '../../models/roads/routeLaw.js'
import { createCombinedAbortSignal } from '../../platform/async/combinedAbortSignal.js'
import { errorMessage } from '../../platform/errors/errors.js'
import { createUserMessage, extractTextContent } from '../../engine/messages/messages.js'
import { stripExplicitNulls } from '../../engine/message-shapes/structuredOutputDialect.js'
import { getEngineModel } from '../../models/catalogue/engineModel.js'
import { utilityCallFor } from '../../models/catalogue/utilityModel.js'
import { jsonParse } from '../../platform/logs/slowOperations.js'
import { asSystemPrompt } from '../../engine/system-prompt/systemPromptType.js'
import type { ModelHookEnd, ModelHookRun } from '../event-hooks/runnerRegistry.js'

export type { ModelHookEnd, ModelHookRun }
export function hookBrief(text: string, payloadJson: string): string {
  const placeholder = /\$EVENT(?!\w)/g
  if (placeholder.test(text)) return text.replace(placeholder, () => payloadJson)
  return `${text}\n\nEVENT: ${payloadJson}`
}

export function hookAnswerJsonSchema(schema: z.ZodType): Record<string, unknown> {
  const { $schema: _dialect, ...shape } = toJSONSchema(schema, { unrepresentable: 'any', target: 'draft-07' }) as Record<string, unknown>
  return shape
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
    await readCatalogueIfPending(declaredRouteOf(run.model ?? getEngineModel()) ?? '')
    const { thinkingConfig, ...call } = run.model === undefined ? utilityCallFor() : utilityCallFor(run.model, { named: true })
    const response = await routedCallModelSettled({
      messages: [createUserMessage({ content: hookBrief(run.text, run.payloadJson) })],
      systemPrompt,
      thinkingConfig,
      tools: [],
      signal: combined.signal,
      options: {
        getToolPermissionContext: async () => run.toolUseContext.getAppState().toolPermissionContext as ToolPermissionContext,
        ...call,
        effortPinned: true,
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
