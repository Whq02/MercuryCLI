import type { Tool, ToolPermissionContext, ToolUseContext } from '../../../Tool.js'
import type { AssistantMessage } from '../../../types/message.js'
import { logForDebugging } from '../../debug.js'
import { toError } from '../../errors.js'
import { logError } from '../../log.js'
import { fireHooks } from '../../hooks/fire.js'
import { getSessionId } from '../../../bootstrap/state.js'
import { AUTO_REJECT_MESSAGE, DONT_ASK_REJECT_MESSAGE } from '../../messages/rejectionText.js'
import type {
  PermissionAskDecision,
  PermissionDecision,
  PermissionDenyDecision,
} from '../PermissionResult.js'
import {
  applyPermissionUpdates,
  persistPermissionUpdates,
} from '../PermissionUpdate.js'
import type { PermissionUpdate } from '../PermissionUpdateSchema.js'
import { decideRuleBasedPermissions, decideToolPermission } from './engine.js'
import { decideUnderFlow } from '../flowPolicy.js'
import { allowRulesThatPreAuthorise } from '../lateAllowRules.js'
import type { DecisionTrace, WrapperStageId, WrapperStageRecord, WrapperTrace } from '../../../types/permissions.js'
import { notBuilt } from '../../../pi/holes.js'


function guardHookUpdatedInput(
  recheckedDecision:
    | PermissionAskDecision
    | PermissionDenyDecision
    | PermissionDecision
    | null,
  toolName: string,
): PermissionAskDecision | PermissionDenyDecision | null {
  if (
    recheckedDecision?.behavior === 'deny' ||
    recheckedDecision?.behavior === 'ask'
  ) {
    logError(
      new Error(
        `PermissionRequest hook allowed ${toolName} with updatedInput, but a ${recheckedDecision.behavior} rule overrides: ${recheckedDecision.message}`,
      ),
    )
    return recheckedDecision
  }
  return null
}


async function consultHeadlessPermissionHooks(
  tool: Tool,
  input: { [key: string]: unknown },
  toolUseID: string,
  context: ToolUseContext,
  permissionMode: string | undefined,
  suggestions: PermissionUpdate[] | undefined,
): Promise<PermissionDecision | null> {
  return notBuilt('src/utils/permissions/decision/wrapper.ts:49')
}


function underStandingAllowRules(context: ToolUseContext): ToolUseContext {
  const read = context.getAppState().toolPermissionContext
  if (read.mode !== 'flow' || allowRulesThatPreAuthorise(read) === read) return context
  return {
    ...context,
    getAppState: () => {
      const state = context.getAppState()
      return state.toolPermissionContext.mode === 'flow' ? { ...state, toolPermissionContext: allowRulesThatPreAuthorise(state.toolPermissionContext) } : state
    },
  }
}

async function decisionOnceGranted(
  tool: Tool,
  input: Record<string, unknown>,
  context: ToolUseContext,
  appState: ReturnType<ToolUseContext['getAppState']>,
  grant: PermissionUpdate[],
): Promise<{ decision: PermissionDecision; rules: ToolPermissionContext } | null> {
  return notBuilt('src/utils/permissions/decision/wrapper.ts:114')
}

async function askWithCoveringGrant(
  tool: Tool,
  input: Record<string, unknown>,
  context: ToolUseContext,
  appState: ReturnType<ToolUseContext['getAppState']>,
  asked: PermissionAskDecision,
): Promise<PermissionAskDecision> {
  if (tool.shellCommandOf === undefined || asked.suggestions === undefined || asked.suggestions.length === 0) return asked
  const rules = asked.suggestions.filter(update => update.type !== 'setMode')
  const granted = await decisionOnceGranted(tool, input, context, appState, rules)
  if (granted?.decision.behavior === 'allow') return rules.length === asked.suggestions.length ? asked : { ...asked, suggestions: rules }
  const { suggestions: _fallsShort, ...bare } = asked
  return bare
}

interface WrapperPorts {
  runHeadlessHooks(
    tool: Tool,
    input: { [key: string]: unknown },
    toolUseID: string,
    context: ToolUseContext,
    permissionMode: string | undefined,
    suggestions: PermissionUpdate[] | undefined,
  ): Promise<PermissionDecision | null>
}

export const defaultWrapperPorts: WrapperPorts = {
  runHeadlessHooks: consultHeadlessPermissionHooks,
}

interface FullDecisionOutcome {
  decision: PermissionDecision
  engineTrace: DecisionTrace
  wrapper: WrapperTrace
}


export async function decideToolPermissionWithModes(
  tool: Tool,
  input: Record<string, unknown>,
  context: ToolUseContext,
  assistantMessage: AssistantMessage,
  toolUseID: string,
  ports?: WrapperPorts,
): Promise<FullDecisionOutcome> {
  return notBuilt('src/utils/permissions/decision/wrapper.ts:164')
}
