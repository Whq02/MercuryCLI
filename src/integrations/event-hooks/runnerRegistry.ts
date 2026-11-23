import type { z } from 'zod/v4'
import type { ToolUseContext } from '../../tools/kit/tool.js'

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

interface ModelHookRunners {
  runCrewmateHook(run: ModelHookRun): Promise<ModelHookEnd>
  runQuestionHook(run: ModelHookRun): Promise<ModelHookEnd>
}

let registered: ModelHookRunners | undefined

export function registerModelHookRunners(runners: ModelHookRunners): void {
  registered = runners
}

export function modelHookRunners(): ModelHookRunners {
  if (registered === undefined) {
    throw new Error('model hook runners are not registered: call registerBootDoors() at startup')
  }
  return registered
}
