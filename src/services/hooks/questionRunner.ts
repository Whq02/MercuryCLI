import type { z } from 'zod/v4'
import { toJSONSchema } from 'zod/v4'
import type { ToolPermissionContext } from '../../Tool.js'
import { routedCallModelSettled } from '../providers/callModelRouter.js'
import { readCatalogueIfPending } from '../providers/catalogueOnDemand.js'
import { declaredRouteOf } from '../providers/routeLaw.js'
import { createCombinedAbortSignal } from '../../utils/combinedAbortSignal.js'
import { errorMessage } from '../../utils/errors.js'
import { createUserMessage, extractTextContent } from '../messages.js'
import { stripExplicitNulls } from '../../utils/messages/structuredOutputDialect.js'
import { getEngineModel } from '../model/model.js'
import { utilityCallFor } from '../model/utilityModel.js'
import { jsonParse } from '../../utils/slowOperations.js'
import { asSystemPrompt } from '../../utils/systemPromptType.js'
import type { ModelHookEnd, ModelHookRun } from '../../utils/hooks/runnerRegistry.js'
import { notBuilt } from '../../pi/holes.js'

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
  return notBuilt('src/services/hooks/questionRunner.ts:29')
}
