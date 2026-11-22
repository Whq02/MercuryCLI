import { z } from 'zod'
import { buildTool, type ToolPermissionContext } from '../../Tool.js'
import { zodToJsonSchema } from '../../utils/zodToJsonSchema.js'
import { getAgentContext } from '../../utils/agentContext.js'
import {
  isFlowGateEnabled,
  setPermissionModeWithGuards,
} from '../../utils/permissions/permissionSetup.js'
import {
  permissionModeTitle,
  type PermissionMode,
} from '../../utils/permissions/PermissionMode.js'
import {
  bootModeTransition,
  describeModeRoad,
  lastModeTransitionFrom,
} from '../../utils/permissions/modeTransitions.js'
import { APOLLO_REVIEW_TOOL_NAME, APOLLO_REVIEW_TOOL_PROMPT } from './prompt.js'
import * as UI from './UI.js'
import { unbuilt, type Unbuilt } from '../../pi/holes.js'

const RESULT_SIZE_CAP = 100_000

export function apolloReviewRefusal(mode: PermissionMode): string {
  const now = permissionModeTitle(mode)
  const exit = lastModeTransitionFrom('apollo')
  if (exit !== undefined) {
    return `Apollo Mode ended before this review: ${describeModeRoad(exit.road)} moved the session to ${permissionModeTitle(exit.to)}${exit.detail !== undefined ? ` (${exit.detail})` : ''}; the session is now in ${now}. ApolloReview closes only an Apollo pre-flight interview: if the interview should continue, ask the user to re-enter Apollo Mode (shift+tab cycles to it); if the spec was already approved, build it.`
  }
  const boot = bootModeTransition()
  const since = boot !== undefined ? `this runner started in ${permissionModeTitle(boot.to)} and ` : 'this runner '
  return `This session is not in Apollo Mode: it is in ${now}, and ${since}never entered Apollo Mode. ApolloReview only closes an Apollo pre-flight interview: enter Apollo Mode (shift+tab cycles to it) to run one, or build the spec if it was already approved.`
}

const inputSchema = z.object({
  summary: z
    .string()
    .min(1)
    .describe('Plain-language spec review; introduce technical terms only beside plain meanings'),
  blockers: z
    .array(z.string().min(1))
    .default([])
    .describe(
      'Remaining blockers to a one-shot prototype with short notes; [] asks the user to start building',
    ),
  specFiles: z
    .array(z.string())
    .default([])
    .describe('Absolute paths of produced spec files'),
  runNote: z
    .string()
    .optional()
    .describe('One plain line on where/how the prototype runs'),
  decision: z
    .enum(['build', 'build-ask-first', 'more-questions'])
    .optional()
    .describe(
      'Set by consent card — never author',
    ),
  refineNote: z
    .string()
    .optional()
    .describe(
      'Set by consent card — never author',
    ),
})

const modelInputSchema = z.strictObject({
  summary: inputSchema.shape.summary,
  blockers: inputSchema.shape.blockers,
  specFiles: inputSchema.shape.specFiles,
  runNote: inputSchema.shape.runNote,
})

const outputSchema = z.object({
  summary: z.string(),
  blockers: z.array(z.string()),
  specFiles: z.array(z.string()),
  runNote: z.string().optional(),
  buildStarted: z.boolean(),
  buildMode: z.string().optional(),
  buildModeTitle: z.string().optional(),
  interviewContinues: z.boolean().optional(),
  refineNote: z.string().optional(),
})

export type Input = z.infer<typeof inputSchema>
export type Output = z.infer<typeof outputSchema>

export const ApolloReviewTool: Unbuilt = unbuilt('src/tools/ApolloReviewTool/ApolloReviewTool.tsx:90')
