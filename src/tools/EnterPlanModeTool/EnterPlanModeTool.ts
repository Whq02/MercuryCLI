// Transition the session into plan mode. Mercury layer: the
// autopilot effort raise (a raise only, never a lowering; numeric operator
// pins untouched) surfaced through an immediate warning notification.
//
// No permission check of its own: the default-filling constructor supplies
// the fail-safe allow, and the user approval its prompt promises is
// produced by the generic permission pipeline (QC pass 2 note).

import { z } from 'zod'
import { enqueueNotification } from '../../context/notifications.js'
import { buildTool } from '../../Tool.js'
import { getAgentContext } from '../../utils/agentContext.js'
import { EFFORT_LEVELS, isEffortLevel, type EffortLevel } from '../../utils/effort.js'
import { prepareContextForPlanMode } from '../../utils/permissions/permissionSetup.js'
import { isPlanModeInterviewPhaseEnabled } from '../../utils/planModeV2.js'
import { ENTER_PLAN_MODE_TOOL_NAME, getEnterPlanModeToolPrompt } from './prompt.js'
import * as UI from './UI.js'

const RESULT_SIZE_CAP = 100_000

const inputSchema = z.object({}).strict()

export type Output = { message: string }

const ENTERED_MESSAGE =
  'Entered plan mode. The focus now is exploring the codebase and designing an implementation approach.'

const TERSE_WORKFLOW =
  'Do not write or edit any file except the plan file. Detailed planning instructions follow.'

const CHECKLIST_WORKFLOW = `Plan-mode workflow:
1. Read the codebase widely enough to know its existing patterns.
2. Locate comparable features and the architecture they use.
3. Weigh more than one approach against its trade-offs.
4. Reach for the question tool when the approach needs clarifying.
5. Settle on one concrete strategy.
6. Call the plan-exit tool to put it up for approval.
Nothing may be written or edited yet — this phase only reads and designs.`

export const EnterPlanModeTool = buildTool({
  name: ENTER_PLAN_MODE_TOOL_NAME,
  inputSchema,
  maxResultSizeChars: RESULT_SIZE_CAP,
  shouldDefer: true,
  searchHint: 'enter plan mode to design an approach before coding',
  async description() {
    return 'Enter plan mode: explore the codebase and design an implementation approach before writing code'
  },
  async prompt() {
    return getEnterPlanModeToolPrompt()
  },
  isReadOnly(): boolean {
    return true
  },
  isConcurrencySafe(): boolean {
    return true
  },
  userFacingName(): string {
    return ''
  },
  async call(_input: Record<string, never>, context) {
    // The mode is a session-level concept — refuse inside an agent context.
    if (getAgentContext() !== undefined || context.agentId) {
      throw new Error(
        'Plan mode is a session-level concept — a subagent cannot enter it.',
      )
    }

    const appState = context.getAppState()
    const currentMode = appState.toolPermissionContext.mode

    // Autopilot raise (tool-entry only — an operator cycling into plan mode
    // by keyboard is steering manually and is not retuned). Raise only,
    // never a lowering; numeric operator pins untouched.
    if (appState.toolPermissionContext.mode === 'autopilot') {
      const current = appState.effortValue
      const shouldRaise =
        current === undefined ||
        (typeof current === 'string' &&
          isEffortLevel(current) &&
          EFFORT_LEVELS.indexOf(current) < EFFORT_LEVELS.indexOf('high'))
      if (shouldRaise) {
        context.setAppState(prev => ({
          ...prev,
          effortValue: 'high' as EffortLevel,
        }))
        // Through the channel's own door (a bare queue push never promoted —
        // the line sat invisible until something else raised a notification —
        // and its `as never` cast hid the missing priority).
        enqueueNotification(context.setAppState, {
          key: 'autopilot-plan-effort-raise',
          text: 'Autopilot plan entry raised reasoning effort to the planning tier (high).',
          color: 'warning',
          priority: 'medium',
          timeoutMs: 8000,
        })
      }
    }

    // Record the transition and apply the mode change at session
    // destination, after the plan-mode context preparation (classifier
    // activation side effects when the default mode is the auto mode).
    context.setAppState(prev => {
      const prepared = prepareContextForPlanMode(prev.toolPermissionContext)
      return {
        ...prev,
        toolPermissionContext: {
          ...prepared,
          mode: 'strategy' as never,
          prePlanMode: currentMode as never,
        },
      }
    })

    return { data: { message: ENTERED_MESSAGE } as Output }
  },
  mapToolResultToToolResultBlockParam(output: Output, toolUseID: string) {
    const workflow = isPlanModeInterviewPhaseEnabled()
      ? TERSE_WORKFLOW
      : CHECKLIST_WORKFLOW
    return {
      type: 'tool_result' as const,
      tool_use_id: toolUseID,
      content: `${output.message}\n\n${workflow}`,
    }
  },
  renderToolUseMessage() {
    return null
  },
  renderToolResultMessage: UI.renderToolResultMessage,
  renderToolUseRejectedMessage: UI.renderToolUseRejectedMessage,
})
