import type { Tool, ToolPermissionContext, ToolUseContext } from '../../../tools/kit/tool.js'
import type { AssistantMessage } from '../../../engine/message-shapes/message.js'
import { logForDebugging } from '../../../platform/logs/debugLog.js'
import { toError } from '../../../platform/errors/errors.js'
import { logError } from '../../../platform/logs/errorLog.js'
import { fireHooks } from '../../../integrations/event-hooks/fire.js'
import { getSessionId } from '../../../boot/process-state/processState.js'
import { AUTO_REJECT_MESSAGE, DONT_ASK_REJECT_MESSAGE } from '../../../engine/message-shapes/rejectionText.js'
import type {
  PermissionAskDecision,
  PermissionDecision,
  PermissionDenyDecision,
} from '../permissionResult.js'
import {
  applyPermissionUpdates,
  persistPermissionUpdates,
} from '../permissionUpdate.js'
import type { PermissionUpdate } from '../PermissionUpdateSchema.js'
import { decideRuleBasedPermissions, decideToolPermission } from './engine.js'
import { decideUnderFlow } from '../flowPolicy.js'
import { allowRulesThatPreAuthorise } from '../lateAllowRules.js'
import type { DecisionTrace, WrapperStageId, WrapperStageRecord, WrapperTrace } from '../permissions.js'


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
  try {
    const fired = await fireHooks(
      'permission.ask',
      {
        tool: tool.name,
        input,
        call_id: toolUseID,
        ...(suggestions !== undefined ? { suggestions } : {}),
      },
      {
        scope: {
          sessionId: getSessionId(),
          ...(context.agentId !== undefined ? { crewmateId: context.agentId } : {}),
        },
        signal: context.abortController.signal,
        toolUseContext: context,
        ...(permissionMode !== undefined ? { permissionMode } : {}),
      },
    )
    const names = fired.outcomes.map(outcome => outcome.name).join(', ')
    const { answer } = fired
    if (answer.stop !== undefined) {
      logForDebugging(`a permission.ask hook (${names}) ended the turn: ${answer.stop}`)
      context.abortController.abort()
      return {
        behavior: 'deny',
        message: answer.stop,
        decisionReason: { type: 'hook', hookName: names, reason: answer.stop },
      }
    }
    if (answer.block !== undefined) {
      return {
        behavior: 'deny',
        message: answer.block,
        decisionReason: { type: 'hook', hookName: names, reason: answer.block },
      }
    }
    if (answer.permission !== 'allow') return null
    const finalInput = answer.input ?? input
    if (answer.input !== undefined) {
      const { decision: rechecked } = await decideRuleBasedPermissions(tool, answer.input, context)
      const overridden = guardHookUpdatedInput(rechecked, tool.name)
      if (overridden !== null) {
        if (overridden.behavior === 'deny') return overridden
        return {
          behavior: 'deny',
          message: overridden.message,
          decisionReason: overridden.decisionReason ?? {
            type: 'other',
            reason: 'ask rule on hook-rewritten input',
          },
        }
      }
    }
    if (answer.rules !== undefined && answer.rules.length > 0) {
      const rules = answer.rules
      persistPermissionUpdates(rules)
      context.setAppState(prev => ({
        ...prev,
        toolPermissionContext: applyPermissionUpdates(prev.toolPermissionContext, rules),
      }))
    }
    return {
      behavior: 'allow',
      updatedInput: finalInput,
      decisionReason: { type: 'hook', hookName: names },
    }
  } catch (error) {
    logError(new Error('the permission.ask hooks failed in a prompt-less session', { cause: toError(error) }))
    return null
  }
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
  const rules = applyPermissionUpdates(appState.toolPermissionContext, grant)
  if (rules === appState.toolPermissionContext) return null
  const trialContext: ToolUseContext = {
    ...context,
    getAppState: () => ({ ...appState, toolPermissionContext: rules }),
  }
  const { decision } = await decideToolPermission(tool, input, trialContext)
  return { decision, rules }
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
  _assistantMessage: AssistantMessage,
  toolUseID: string,
  ports?: WrapperPorts,
): Promise<FullDecisionOutcome> {
  const effectivePorts = ports ?? defaultWrapperPorts
  const { decision: engineDecision, trace: engineTrace } = await decideToolPermission(
    tool,
    input,
    underStandingAllowRules(context),
  )
  const stages: WrapperStageRecord[] = []
  const recordStage = (stage: WrapperStageId, outcome: 'pass' | 'decided', note?: string): void => {
    stages.push(note === undefined ? { stage, outcome } : { stage, outcome, note })
  }

  if (engineDecision.behavior !== 'ask') {
    return {
      decision: engineDecision,
      engineTrace,
      wrapper: { stages, decidedBy: 'engine' },
    }
  }

  const appState = context.getAppState()
  const permissionContext = appState.toolPermissionContext

  if (permissionContext.mode === 'dontAsk') {
    recordStage('dontAskConversion', 'decided')
    return {
      decision: {
        behavior: 'deny',
        message: DONT_ASK_REJECT_MESSAGE(tool.name),
        decisionReason: { type: 'mode', mode: 'dontAsk' },
      },
      engineTrace,
      wrapper: { stages, decidedBy: 'dontAskConversion' },
    }
  }

  let pendingAsk: PermissionAskDecision = engineDecision

  if (permissionContext.mode === 'flow') {
    const suggestionsAllowCall = async (suggestions: PermissionUpdate[]): Promise<boolean> => {
      if (suggestions.some(update => update.type === 'setMode')) return false
      const trial = await decisionOnceGranted(tool, input, context, appState, suggestions)
      if (trial === null) return false
      if (trial.decision.behavior === 'allow') return true
      if (trial.decision.behavior !== 'ask') return false
      const retrial = await decideUnderFlow(tool, input, trial.decision, trial.rules)
      return retrial.stage === 'flowAllow'
    }
    const flowVerdict = await decideUnderFlow(
      tool,
      input,
      engineDecision,
      permissionContext,
      suggestionsAllowCall,
    )
    if (flowVerdict.stage === 'flowAllow') {
      recordStage('flowFloors', 'pass')
      recordStage('flowLaw', 'pass')
      logForDebugging(`Flow allows ${tool.name}: none of the five`)
      recordStage('flowAllow', 'decided')
      return {
        decision: flowVerdict.decision,
        engineTrace,
        wrapper: { stages, decidedBy: 'flowAllow' },
      }
    }
    if (flowVerdict.stage === 'flowLaw') {
      recordStage('flowFloors', 'pass')
    }
    const note = flowVerdict.stage === 'flowFloors' ? flowVerdict.floor : `item ${flowVerdict.ask.item}`
    if (permissionContext.shouldAvoidPermissionPrompts) {
      recordStage(flowVerdict.stage, 'pass', note)
      pendingAsk = flowVerdict.decision
    } else {
      recordStage(flowVerdict.stage, 'decided', note)
      const decision =
        flowVerdict.stage === 'flowFloors'
          ? await askWithCoveringGrant(tool, input, context, appState, flowVerdict.decision)
          : flowVerdict.decision
      return {
        decision,
        engineTrace,
        wrapper: { stages, decidedBy: flowVerdict.stage },
      }
    }
  }

  if (permissionContext.shouldAvoidPermissionPrompts) {
    const hookDecision = await effectivePorts.runHeadlessHooks(
      tool,
      input,
      toolUseID,
      context,
      permissionContext.mode,
      pendingAsk.suggestions,
    )
    if (hookDecision !== null) {
      recordStage('headlessHooks', 'decided')
      return {
        decision: hookDecision,
        engineTrace,
        wrapper: { stages, decidedBy: 'headlessHooks' },
      }
    }
    recordStage('headlessHooks', 'pass')
    recordStage('headlessAutoDeny', 'decided')
    const autoReject = AUTO_REJECT_MESSAGE(tool.name)
    const message = pendingAsk === engineDecision ? autoReject : `${pendingAsk.message} ${autoReject}`
    return {
      decision: {
        behavior: 'deny',
        message,
        decisionReason: {
          type: 'asyncAgent',
          reason: 'This session cannot present a permission prompt',
        },
      },
      engineTrace,
      wrapper: { stages, decidedBy: 'headlessAutoDeny' },
    }
  }

  const finalAsk = await askWithCoveringGrant(tool, input, context, appState, pendingAsk)
  return {
    decision: finalAsk,
    engineTrace,
    wrapper: { stages, decidedBy: 'engine' },
  }
}
