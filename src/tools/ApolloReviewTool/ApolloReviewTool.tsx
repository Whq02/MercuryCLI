
import { z } from 'zod'
import { buildTool, type ToolPermissionContext } from '../../Tool.js'
import { getAgentContext } from '../../utils/agentContext.js'
import {
  isAutoModeGateEnabled,
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

const RESULT_SIZE_CAP = 100_000

export function apolloReviewRefusal(mode: PermissionMode): string {
  const now = permissionModeTitle(mode)
  const exit = lastModeTransitionFrom('apollo')
  if (exit !== undefined) {
    return `Apollo Mode ended before this review: ${describeModeRoad(exit.road)} moved the session to ${permissionModeTitle(exit.to)}${exit.detail !== undefined ? ` (${exit.detail})` : ''}; the session is now in ${now}. ApolloReview closes only an Apollo pre-flight interview — if the interview should continue, ask the user to re-enter Apollo Mode (shift+tab cycles to it); if the spec was already approved, simply build it.`
  }
  const boot = bootModeTransition()
  const since = boot !== undefined ? `this runner started in ${permissionModeTitle(boot.to)} and ` : 'this runner '
  return `This session is not in Apollo Mode: it is in ${now}, and ${since}never entered Apollo Mode. ApolloReview exists solely to close an Apollo pre-flight interview — enter Apollo Mode (shift+tab cycles to it) to run one; if a spec was already approved, simply build it.`
}

const inputSchema = z.object({
  summary: z
    .string()
    .min(1)
    .describe('The layman review of the completed spec — concise plain language'),
  blockers: z
    .array(z.string().min(1))
    .default([])
    .describe(
      'What still prevents a one-shot prototype, each with a short comment; EMPTY when nothing blocks',
    ),
  specFiles: z
    .array(z.string())
    .default([])
    .describe('Absolute paths of the spec files the interview produced'),
  runNote: z
    .string()
    .optional()
    .describe('Where and how the prototype will be run, one plain line'),
  decision: z
    .enum(['build', 'build-ask-first', 'more-questions'])
    .optional()
    .describe(
      "Written by the consent card with the user's choice — never author this field",
    ),
  refineNote: z
    .string()
    .optional()
    .describe(
      "Written by the consent card — the user's note on what still needs asking. Never author this field",
    ),
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

export const ApolloReviewTool = buildTool({
  name: APOLLO_REVIEW_TOOL_NAME,
  inputSchema,
  outputSchema,
  maxResultSizeChars: RESULT_SIZE_CAP,
  shouldDefer: true,
  searchHint: 'present the completed Apollo pre-flight spec for review',
  async description() {
    return 'Present the closing review of a completed Apollo pre-flight spec'
  },
  async prompt() {
    return APOLLO_REVIEW_TOOL_PROMPT
  },
  isConcurrencySafe(): boolean {
    return false
  },
  isReadOnly(): boolean {
    return false
  },
  userFacingName(): string {
    return ''
  },
  requiresUserInteraction(): boolean {
    return true
  },
  async validateInput(_input: Input, context) {
    if (getAgentContext() !== undefined || context.agentId) {
      return {
        result: false as const,
        message:
          'Apollo Mode is a session-level concept — a subagent cannot close its review.',
        errorCode: 1,
      }
    }
    const mode = context.getAppState().toolPermissionContext.mode
    if (mode !== 'apollo') {
      return {
        result: false as const,
        message: apolloReviewRefusal(mode),
        errorCode: 1,
      }
    }
    return { result: true as const }
  },
  async checkPermissions(input: Input) {
    if ((input.blockers ?? []).length === 0) {
      return {
        behavior: 'ask' as const,
        message: 'Begin the prototype build?',
        updatedInput: input,
      }
    }
    return { behavior: 'allow' as const, updatedInput: input }
  },
  async call(input: Input, context) {
    const blockers = input.blockers ?? []
    const specFiles = input.specFiles ?? []
    const base = {
      summary: input.summary,
      blockers,
      specFiles,
      ...(input.runNote ? { runNote: input.runNote } : {}),
    }

    if (blockers.length > 0) {
      return { data: { ...base, buildStarted: false } as Output }
    }

    if (input.decision === 'more-questions') {
      return {
        data: {
          ...base,
          buildStarted: false,
          interviewContinues: true,
          ...(input.refineNote ? { refineNote: input.refineNote } : {}),
        } as Output,
      }
    }

    const updateAppState = (
      updater: (ctx: ToolPermissionContext) => ToolPermissionContext,
    ): void => {
      context.setAppState(prev => ({
        ...prev,
        toolPermissionContext: updater(
          prev.toolPermissionContext as ToolPermissionContext,
        ) as typeof prev.toolPermissionContext,
      }))
    }
    const targets: PermissionMode[] =
      input.decision === 'build-ask-first'
        ? ['default']
        : isAutoModeGateEnabled()
          ? ['flow', 'implement']
          : ['implement']
    let settled: PermissionMode | null = null
    for (const target of targets) {
      const result = setPermissionModeWithGuards(
        target,
        context.getAppState().toolPermissionContext as ToolPermissionContext,
        updateAppState,
        'review-approval',
      )
      if (result.ok) {
        settled = result.mode
        break
      }
    }

    return {
      data: {
        ...base,
        buildStarted: true,
        ...(settled
          ? { buildMode: settled, buildModeTitle: permissionModeTitle(settled) }
          : {}),
      } as Output,
    }
  },
  mapToolResultToToolResultBlockParam(output: Output, toolUseID: string) {
    let content: string
    if (output.interviewContinues) {
      content = [
        'The user is NOT ready to build — they asked for more questions. Nothing changed hands; the session stays in Apollo Mode with the spec drafts held.',
        ...(output.refineNote
          ? [`What they want settled, in their words: ${JSON.stringify(output.refineNote)}`]
          : []),
        'Resume the interview from here: work out what is still open, poll again with the question tool in plain language, fold the answers into the spec, then present the review afresh.',
      ].join('\n')
    } else if (!output.buildStarted) {
      const count = output.blockers.length
      content = [
        `The review stands with ${count} blocker${count === 1 ? '' : 's'}. Nothing changed hands.`,
        'Resolve the blockers with the user — more polls or discussion, in plain language — then present the review again.',
      ].join('\n')
    } else {
      content = [
        `The user approved the review — the build begins NOW. The session moved to ${output.buildModeTitle ?? 'the build posture'}.`,
        ...(output.buildMode === 'default'
          ? [
              'The user chose to approve edits as they come: each edit will ask for their confirmation — request edits normally and continue on each approval.',
            ]
          : []),
        'Build the prototype in one autonomous run with the completed spec as the brief. The bar: for a game, a playable demo with UI/UX and some example animations; for software, the equivalent runnable slice.',
        'Finish by telling the user, in plain terms, what was built and how to run it.',
      ].join('\n')
    }
    return {
      type: 'tool_result' as const,
      tool_use_id: toolUseID,
      content,
    }
  },
  renderToolUseMessage() {
    return null
  },
  renderToolResultMessage: UI.renderToolResultMessage,
  renderToolUseRejectedMessage: UI.renderToolUseRejectedMessage,
})
