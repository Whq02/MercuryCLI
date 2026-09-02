import { memoize } from 'lodash-es'
import { z } from 'zod'

import type { Tool } from '../../Tool.js'
import {
  SYNTHETIC_OUTPUT_TOOL_NAME,
  SyntheticOutputTool,
} from '../../tools/SyntheticOutputTool/SyntheticOutputTool.js'
import { substituteArguments } from '../argumentSubstitution.js'
import { hasSuccessfulToolCall } from '../messages.js'
import type { SetAppState } from '../messageQueueManager.js'
import { addFunctionHook } from './sessionHooks.js'


export const hookResponseSchema = memoize(() =>
  z.object({
    ok: z.boolean().describe('Whether the condition being verified was met.'),
    reason: z.string().optional().describe('When the condition was not met, what failed.'),
  }),
)

export type HookResponse = z.infer<ReturnType<typeof hookResponseSchema>>

export function addArgumentsToPrompt(prompt: string, jsonInput: string): string {
  return substituteArguments(prompt, jsonInput)
}

export function createStructuredOutputTool(): Tool {
  return {
    ...SyntheticOutputTool,
    inputSchema: hookResponseSchema(),
    inputJSONSchema: {
      type: 'object',
      properties: {
        ok: {
          type: 'boolean',
          description: 'Whether the condition being verified was met.',
        },
        reason: {
          type: 'string',
          description: 'When the condition was not met, a short explanation of what failed.',
        },
      },
      required: ['ok'],
      additionalProperties: false,
    },
    prompt: async () =>
      `Use this tool to return the verification result. It must be called exactly once, at the end of your response.`,
  } as Tool
}

const STRUCTURED_OUTPUT_ENFORCEMENT_HOOK_ID = 'structured-output-enforcement'

export function registerStructuredOutputEnforcement(setAppState: SetAppState, sessionId: string): void {
  addFunctionHook(
    setAppState,
    sessionId,
    'Stop',
    '',
    messages => hasSuccessfulToolCall(messages, SYNTHETIC_OUTPUT_TOOL_NAME),
    `The ${SYNTHETIC_OUTPUT_TOOL_NAME} tool must be called to complete this request. Call it now.`,
    { timeout: 5000, id: STRUCTURED_OUTPUT_ENFORCEMENT_HOOK_ID },
  )
}
