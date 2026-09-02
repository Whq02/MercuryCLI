// Present the plan for approval and restore the pre-plan permission mode
// Mercury layer: the autopilot downshift nudge.
//
// Two behaviours are PRESENT IN SHAPE BUT INERT in this build (a
// deliberate keep): reconciling stripped
// dangerous permission rules, and the automatic-mode circuit-breaker
// fallback. Both resolve through nulled handles below; the call sites fall
// back to the unchanged context. Wiring them live would ADD behaviour.

import { writeFile } from 'node:fs/promises'
import { z } from 'zod'
import { buildTool } from '../../Tool.js'
import { getAgentContext } from '../../utils/agentContext.js'
import { logForDebugging } from '../../utils/debug.js'
import { errorMessage } from '../../utils/errors.js'
import { getPlan, getPlanFilePath } from '../../utils/plans.js'
import { isAgentSwarmsEnabled } from '../../utils/agentSwarmsEnabled.js'
import {
  getAgentName,
  getTeamName,
  isPlanModeRequired,
  isTeammate,
} from '../../utils/teammate.js'
import { writeToMailbox } from '../../utils/teammateMailbox.js'
import {
  findInProcessTeammateTaskId,
  setAwaitingPlanApproval,
} from '../../utils/inProcessTeammateHelpers.js'
import { AGENT_TOOL_NAME } from '../AgentTool/constants.js'
import {
  EXIT_PLAN_MODE_TOOL_NAME,
  EXIT_PLAN_MODE_V2_TOOL_PROMPT,
} from './prompt.js'
import * as UI from './UI.js'

const RESULT_SIZE_CAP = 100_000

/** INERT handles: the modules that would reconcile stripped
 *  dangerous rules and rewrite a no-longer-permitted automatic restore mode
 *  are nulled in this build — both call sites fall back to the unchanged
 *  context, and the breaker notification condition is never set. */
function getStrippedRuleReconciler(): {
  reconcile: (mode: string, context: unknown) => unknown
} | null {
  return null
}
const AUTOMATIC_MODE_BREAKER_TRIPPED = false

export type AllowedPrompt = { tool: 'Bash'; prompt: string }

/** Permissive: the normalizer injects plan/planFilePath for SDK/hooks. */
const inputSchema = z.object({
  allowedPrompts: z
    .array(z.object({ tool: z.literal('Bash'), prompt: z.string() }))
    .optional()
    .describe(
      'Categories of action needed to implement the plan (not specific commands)',
    ),
})

/** SDK-facing input: the internal one plus the injected plan fields. */
export const _sdkInputSchema = inputSchema.extend({
  plan: z.string().optional(),
  planFilePath: z.string().optional(),
})

export const outputSchema = z.object({
  plan: z.string().nullable(),
  isAgent: z.boolean(),
  filePath: z.string().optional(),
  hasTaskTool: z.boolean().optional(),
  planWasEdited: z.boolean().optional(),
  awaitingLeaderApproval: z.boolean().optional(),
  requestId: z.string().optional(),
  autopilotDownshiftNudge: z.boolean().optional(),
})

export type Input = z.infer<typeof inputSchema> & {
  plan?: string
  planFilePath?: string
}
export type Output = z.infer<typeof outputSchema>

const DOWNSHIFT_NUDGE_TEXT =
  'Entering the planning phase pushed reasoning effort up to the tier planning warrants. Execution is starting now: purely mechanical work does not need that tier — you may lower it (downshift via SetTier), saying why, scoping the change to the current turn unless the nature of the work has genuinely changed for good.'

export const ExitPlanModeV2Tool = buildTool({
  name: EXIT_PLAN_MODE_TOOL_NAME,
  inputSchema,
  outputSchema,
  maxResultSizeChars: RESULT_SIZE_CAP,
  shouldDefer: true,
  searchHint: 'present the finished plan for user approval',
  async description() {
    return 'Signal that the plan is ready for the user to review and approve'
  },
  async prompt() {
    return EXIT_PLAN_MODE_V2_TOOL_PROMPT
  },
  isConcurrencySafe(): boolean {
    return true
  },
  /** Not read-only: it writes the plan file. */
  isReadOnly(): boolean {
    return false
  },
  userFacingName(): string {
    return ''
  },
  /** Teammates bypass the permission UI: the lead approves by mailbox, or
   * plan mode was voluntary and exits locally. */
  requiresUserInteraction(): boolean {
    return !isTeammate()
  },
  async checkPermissions(input: Input, context) {
    if (isTeammate()) {
      return { behavior: 'allow' as const, updatedInput: input }
    }
    void context
    return {
      behavior: 'ask' as const,
      message: 'Exit strategy mode?',
      updatedInput: input,
    }
  },
  /** Rejecting a wrong-mode call at VALIDATION keeps the approval dialog
   *  from appearing (the deferred listing advertises the tool regardless
   * of mode). */
  async validateInput(_input: Input, context) {
    if (isTeammate()) return { result: true as const }
    const mode = context.getAppState().toolPermissionContext.mode
    if (mode !== 'strategy') {
      return {
        result: false as const,
        message:
          'This session is not planning. ExitPlanMode exists solely to leave a planning phase once a plan has been written — if a plan was already approved, simply carry it out.',
        errorCode: 1,
      }
    }
    return { result: true as const }
  },
  async call(input: Input, context) {
    const agentContext = getAgentContext()
    const filePath = getPlanFilePath(
      agentContext && 'agentId' in agentContext
        ? String(agentContext.agentId)
        : undefined,
    )

    // The plan: from the input when a string was supplied (an edited plan
    // arrives that way), else from disk. An input-supplied plan is written
    // back so later readers see the edit (write failures log only).
    const planWasEdited = typeof input.plan === 'string'
    let plan: string | null = planWasEdited ? input.plan! : getPlan()
    if (planWasEdited) {
      try {
        await writeFile(filePath, input.plan!, 'utf-8')
      } catch (error) {
        logForDebugging(
          `ExitPlanMode: plan write-back failed: ${errorMessage(error)}`,
        )
      }
    }

    // Teammate requiring lead approval: the mailbox arm.
    if (isTeammate() && isPlanModeRequired()) {
      if (!plan || plan.trim() === '') {
        throw new Error(
          `A plan is required for lead approval and none was found at ${filePath}. Write the plan there first.`,
        )
      }
      const agentName = getAgentName() ?? 'teammate'
      const teamName = getTeamName()
      const requestId = `plan-approval-${agentName}-${Date.now().toString(36)}`
      await writeToMailbox(
        teamName ? `lead@${teamName}` : 'lead',
        {
          type: 'plan_approval_request',
          from: agentName,
          timestamp: new Date().toISOString(),
          planFilePath: filePath,
          planContent: plan,
          requestId,
        } as never,
        teamName,
      )
      const taskId = findInProcessTeammateTaskId(
        agentName,
        context.getAppState(),
      )
      if (taskId) {
        setAwaitingPlanApproval(taskId, context.setAppState as never, true)
      }
      return {
        data: {
          plan,
          // This arm reports the agent flag true unconditionally.
          isAgent: true,
          filePath,
          awaitingLeaderApproval: true,
          requestId,
        } as Output,
      }
    }

    // Compute the downshift flag BEFORE touching state — reading after the
    // restore would find the record already cleared.
    const permissionContext = context.getAppState().toolPermissionContext
    const prePlanMode = permissionContext.prePlanMode as string | undefined
    const autopilotDownshiftNudge =
      permissionContext.mode === 'strategy' && prePlanMode === 'autopilot'

    // Restore the permission context: no-op when not in plan mode;
    // otherwise restore the pre-plan mode (default when none) and clear
    // the record. The stripped-rule reconciliation and the breaker
    // fallback are inert shapes (nulled handles above).
    if (permissionContext.mode === 'strategy') {
      let restoreMode = prePlanMode ?? 'default'
      if (AUTOMATIC_MODE_BREAKER_TRIPPED) {
        restoreMode = 'default'
      }
      context.setAppState(prev => {
        let nextContext = {
          ...prev.toolPermissionContext,
          mode: restoreMode as never,
          prePlanMode: undefined,
        }
        const reconciler = getStrippedRuleReconciler()
        if (reconciler) {
          nextContext = reconciler.reconcile(
            restoreMode,
            nextContext,
          ) as typeof nextContext
        }
        return { ...prev, toolPermissionContext: nextContext }
      })
    }

    // Whether the agent tool is available in this context.
    const hasTaskTool =
      isAgentSwarmsEnabled() &&
      context.options.tools.some(tool => tool.name === AGENT_TOOL_NAME)

    return {
      data: {
        plan,
        isAgent: Boolean(agentContext),
        filePath,
        hasTaskTool,
        planWasEdited,
        ...(autopilotDownshiftNudge ? { autopilotDownshiftNudge } : {}),
      } as Output,
    }
  },
  mapToolResultToToolResultBlockParam(output: Output, toolUseID: string) {
    let content: string
    if (output.awaitingLeaderApproval) {
      content = [
        `Plan submitted to the team lead for approval. Plan file: ${output.filePath}.`,
        'What happens next: wait for the lead\'s review; an inbox message will carry the approval or rejection; proceed on approval; refine the plan on rejection.',
        'Do NOT proceed until the approval arrives — check your inbox.',
        `Request id: ${output.requestId}`,
      ].join('\n')
    } else if (output.isAgent) {
      content =
        'Plan approved — nothing further is needed from you. Acknowledge briefly.'
    } else if (!output.plan || output.plan.trim() === '') {
      content = 'The user approved exiting plan mode. Work may proceed.'
    } else {
      const parts = [
        'The plan was approved — coding may start, beginning with a todo-list update when applicable.',
        `The plan is saved at ${output.filePath}; refer back to it as you work.`,
      ]
      if (output.hasTaskTool) {
        parts.push(
          'If the plan decomposes into independent tasks, consider the team-creation tool to parallelise them.',
        )
      }
      if (output.autopilotDownshiftNudge) {
        parts.push(DOWNSHIFT_NUDGE_TEXT)
      }
      parts.push(
        `## The plan${output.planWasEdited ? ' (edited by the user)' : ''}\n${output.plan}`,
      )
      content = parts.join('\n\n')
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
