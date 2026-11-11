import type { Tool, ToolUseContext } from '../../../Tool.js'
import type { AssistantMessage } from '../../../types/message.js'
import { logForDebugging } from '../../debug.js'
import { toError } from '../../errors.js'
import { logError } from '../../log.js'
import { fireHooks } from '../../hooks/fire.js'
import { getSessionId } from '../../../bootstrap/state.js'
import { AUTO_REJECT_MESSAGE, DONT_ASK_REJECT_MESSAGE } from '../../messages.js'
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
import type {
  DecisionTrace,
  WrapperStageId,
  WrapperStageRecord,
  WrapperTrace,
} from './trace.js'



export function guardHookUpdatedInput(
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
    const asked = await fireHooks(
      'permission.ask',
      { tool: tool.name, input, call_id: toolUseID, ...(suggestions !== undefined ? { suggestions } : {}) },
      { scope: { sessionId: String(getSessionId()), ...(context.agentId !== undefined ? { crewmateId: context.agentId } : {}) }, signal: context.abortController.signal, toolUseContext: context, ...(permissionMode !== undefined ? { permissionMode } : {}) },
    )
    const hookNames = asked.outcomes.map(outcome => outcome.name).join(', ')
    if (asked.answer.stop !== undefined) {
      logForDebugging(`a permission.ask hook (${hookNames}) ended the turn: ${asked.answer.stop}`)
      context.abortController.abort()
      return { behavior: 'deny', message: asked.answer.stop, decisionReason: { type: 'hook', hookName: hookNames, reason: asked.answer.stop } }
    }
    if (asked.answer.block !== undefined) {
      return { behavior: 'deny', message: asked.answer.block, decisionReason: { type: 'hook', hookName: hookNames, reason: asked.answer.block } }
    }
    if (asked.answer.permission !== 'allow') return null
    const finalInput = asked.answer.input ?? input
    if (asked.answer.input) {
      const recheck = await decideRuleBasedPermissions(tool, finalInput, context)
      const override = guardHookUpdatedInput(recheck.decision, tool.name)
      if (override) {
        if (override.behavior === 'ask') {
          return {
            behavior: 'deny',
            message: override.message,
            decisionReason: override.decisionReason ?? { type: 'other', reason: 'ask rule on hook-rewritten input' },
          }
        }
        return override
      }
    }
    if (asked.answer.rules?.length) {
      persistPermissionUpdates(asked.answer.rules)
      const rules = asked.answer.rules
      context.setAppState(prev => ({ ...prev, toolPermissionContext: applyPermissionUpdates(prev.toolPermissionContext, rules) }))
    }
    return { behavior: 'allow', updatedInput: finalInput, decisionReason: { type: 'hook', hookName: hookNames } }
  } catch (error) {
    logError(new Error('the permission.ask hooks failed in a prompt-less session', { cause: toError(error) }))
  }
  return null
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
  ports: WrapperPorts = defaultWrapperPorts,
): Promise<FullDecisionOutcome> {
  void assistantMessage
  const engineOutcome = await decideToolPermission(tool, input, underStandingAllowRules(context))
  const engineDecision = engineOutcome.decision
  const engineTrace = engineOutcome.trace

  const stageLog: WrapperStageRecord[] = []
  const recordPass = (stage: WrapperStageId, note?: string): void => {
    stageLog.push(
      note ? { stage, outcome: 'pass', note } : { stage, outcome: 'pass' },
    )
  }
  const decide = (
    stage: WrapperStageId,
    decision: PermissionDecision,
    note?: string,
  ): FullDecisionOutcome => {
    stageLog.push(
      note ? { stage, outcome: 'decided', note } : { stage, outcome: 'decided' },
    )
    return { decision, engineTrace, wrapper: { stages: stageLog, decidedBy: stage } }
  }
  const passThrough = (decision: PermissionDecision): FullDecisionOutcome => ({
    decision,
    engineTrace,
    wrapper: { stages: stageLog, decidedBy: 'engine' },
  })

  if (engineDecision.behavior === 'allow') {
    return passThrough(engineDecision)
  }

  if (engineDecision.behavior === 'ask') {
    const appState = context.getAppState()

    if (appState.toolPermissionContext.mode === 'dontAsk') {
      return decide('dontAskConversion', {
        behavior: 'deny',
        decisionReason: {
          type: 'mode',
          mode: 'dontAsk',
        },
        message: DONT_ASK_REJECT_MESSAGE(tool.name),
      })
    }

    let pending: PermissionAskDecision = engineDecision
    if (appState.toolPermissionContext.mode === 'flow') {
      const verdict = await decideUnderFlow(tool, input, engineDecision, appState.toolPermissionContext)
      if (verdict.stage === 'flowAllow') {
        recordPass('flowFloors')
        recordPass('flowLaw')
        logForDebugging(`Flow allows ${tool.name}: none of the five`)
        return decide('flowAllow', verdict.decision)
      }
      const note = verdict.stage === 'flowFloors' ? verdict.floor : `item ${verdict.ask.item}`
      if (verdict.stage === 'flowLaw') recordPass('flowFloors')
      if (!appState.toolPermissionContext.shouldAvoidPermissionPrompts) return decide(verdict.stage, verdict.decision, note)
      recordPass(verdict.stage, note)
      pending = verdict.decision
    }

    if (appState.toolPermissionContext.shouldAvoidPermissionPrompts) {
      const hookDecision = await ports.runHeadlessHooks(
        tool,
        input,
        toolUseID,
        context,
        appState.toolPermissionContext.mode,
        pending.suggestions,
      )
      if (hookDecision) {
        return decide('headlessHooks', hookDecision)
      }
      recordPass('headlessHooks')
      return decide('headlessAutoDeny', {
        behavior: 'deny',
        decisionReason: {
          type: 'asyncAgent',
          reason: 'This session cannot present a permission prompt',
        },
        message: pending === engineDecision ? AUTO_REJECT_MESSAGE(tool.name) : `${pending.message} ${AUTO_REJECT_MESSAGE(tool.name)}`,
      })
    }
  }

  return passThrough(engineDecision)
}
