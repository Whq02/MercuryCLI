// The Apollo closing-review tool (operator decision; part of the
// Apollo Mode full rebuild). The interview's ONE exit seam:
//
//   - renders the closing review card (the layman review of the completed
//     spec — summary, blockers, spec files, run note);
//   - with NO blockers it asks the user to begin the build. The consent has
//     THREE answers, and every YES completes the mode transition out of
//     Apollo — the two yes tiers differ in permission breadth only, never in
//     whether the mode moves:
//       · plain yes → the ruled build posture — flow when the live auto gate
//         allows it, implement otherwise — through the guarded mode setter
//         (the same seam the carousel and SDK set_permission_mode use), so
//         flow entry arms the classifier and strips dangerous rules exactly
//         like a shift+tab entry would;
//       · yes-but-ask-first → default (the build runs; each edit asks);
//       · ask-me-more-questions → nothing moves — the review is held, the
//         session and drafts stay, and the wire tells the model to resume
//         the interview (the discuss grammar the question tools speak).
//   - with blockers present it presents them and changes nothing.
//
// Session-level and main-agent-only, like plan-mode entry: agent contexts
// are refused at validation, and wrong-mode calls are refused there too so
// the consent dialog can never appear outside Apollo Mode.

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
import { APOLLO_REVIEW_TOOL_NAME, APOLLO_REVIEW_TOOL_PROMPT } from './prompt.js'
import * as UI from './UI.js'

const RESULT_SIZE_CAP = 100_000

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
  /** True when the user answered "ask me more questions": the review is
   *  held, the session stays in Apollo Mode, the interview resumes. */
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
    return true
  },
  /** Not read-only: a clean, approved review moves the session's permission
   *  mode to the build posture. */
  isReadOnly(): boolean {
    return false
  },
  userFacingName(): string {
    return ''
  },
  requiresUserInteraction(): boolean {
    return true
  },
  /** Rejecting wrong-context calls at VALIDATION keeps the consent dialog
   *  from appearing outside a main-session Apollo interview. */
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
        message:
          'This session is not in Apollo Mode. ApolloReview exists solely to close an Apollo pre-flight interview — if a spec was already approved, simply build it.',
        errorCode: 1,
      }
    }
    return { result: true as const }
  },
  /** A clean review asks (approval is the consent that moves the session to
   *  the build posture); a blockered review is informational and passes. */
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

    // The held review: the user answered "ask me more questions" on the
    // consent card. Nothing moves — the session stays in Apollo Mode with
    // the drafts held, and the wire tells the model to resume the interview.
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

    // Every yes completes the mode transition; the tiers differ in breadth
    // only. Plain yes (or a consent settled without a card, e.g. an SDK
    // allow) takes the ruled build posture: flow when the live auto gate
    // allows it, implement otherwise. Yes-but-ask-first takes default — the
    // build runs and each edit asks. The guarded setter runs the real
    // transition side effects; if flow raced unavailable between the check
    // and the set, fall through to implement (always available). Neither
    // default nor implement entry can be refused, so an approved review can
    // never leave the session stranded in Apollo Mode.
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
