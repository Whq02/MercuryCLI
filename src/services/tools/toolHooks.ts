import type { AnyObject, Tool, ToolUseContext } from '../../Tool.js'
import type { CanUseToolFn } from '../../hooks/useCanUseTool.js'
import type { AssistantMessage } from '../../types/message.js'
import type { PermissionDecision, PermissionDecisionReason } from '../../types/permissions.js'
import { getSessionId } from '../../bootstrap/state.js'
import { HOOK_CUT_BUDGET_MS } from '../../utils/hooks/contract.js'
import { errorMessage } from '../../utils/errors.js'
import { foldAnswers } from '../../utils/hooks/answer.js'
import { fireHooks, type HookFireResult } from '../../utils/hooks/fire.js'
import { hooksFor } from '../../utils/hooks/matching.js'
import type { HookScope } from '../../utils/hooks/sessionHooks.js'
import { checkRuleBasedPermissions } from '../../utils/permissions/permissions.js'
import { getRuleBehaviorDescription } from '../../utils/permissions/PermissionResult.js'

export type HookPermissionOutcome = {
  behavior: 'allow' | 'ask' | 'deny'
  updatedInput?: AnyObject
  message?: string
  decisionReason?: PermissionDecisionReason
}

export function hookScopeOf(toolUseContext: ToolUseContext): HookScope {
  return { sessionId: getSessionId(), ...(toolUseContext.agentId !== undefined ? { crewmateId: toolUseContext.agentId } : {}) }
}

export function beforeToolHooks(tool: Tool, toolUseID: string, input: AnyObject, toolUseContext: ToolUseContext, signal: AbortSignal): Promise<HookFireResult> {
  const scope = hookScopeOf(toolUseContext)
  try {
    hooksFor('tool.before', scope, toolUseContext.getAppState())
  } catch (error) {
    const block = `the hooks could not be read, so the ${tool.name} call is refused: ${errorMessage(error)}`
    return Promise.resolve({ event: 'tool.before', answer: { ...foldAnswers('tool.before', []), block }, outcomes: [] })
  }
  return fireHooks('tool.before', { tool: tool.name, input, call_id: toolUseID }, { scope, signal, toolUseContext })
}

export async function afterToolHooks(
  tool: Tool,
  toolUseID: string,
  input: AnyObject,
  ended: { ok: boolean; output?: unknown; error?: string; cut: boolean },
  toolUseContext: ToolUseContext,
  signal: AbortSignal | undefined,
): Promise<HookFireResult> {
  return fireHooks(
    'tool.after',
    { tool: tool.name, input, output: ended.output, call_id: toolUseID, ok: ended.ok, ...(ended.error !== undefined ? { error: ended.error } : {}), cut: ended.cut },
    { scope: hookScopeOf(toolUseContext), toolUseContext, ...(ended.cut ? { budgetMs: HOOK_CUT_BUDGET_MS } : { signal }) },
  )
}

export function permissionDecidedHooks(
  tool: Tool,
  toolUseID: string,
  input: AnyObject,
  decided: { decision: 'allowed' | 'denied'; by: 'rule' | 'mode' | 'hook' | 'operator' | 'safety' | 'other'; reason?: string },
  toolUseContext: ToolUseContext,
  signal: AbortSignal,
): Promise<HookFireResult> {
  return fireHooks('permission.decided', { tool: tool.name, input, call_id: toolUseID, ...decided }, { scope: hookScopeOf(toolUseContext), signal, toolUseContext })
}

export function deciderOf(reason: PermissionDecisionReason | undefined): 'rule' | 'mode' | 'hook' | 'operator' | 'safety' | 'other' {
  switch (reason?.type) {
    case 'rule':
      return 'rule'
    case 'mode':
    case 'bypassedAsk':
      return 'mode'
    case 'hook':
      return 'hook'
    case 'guard':
    case 'safetyCheck':
      return 'safety'
    case 'permissionPromptTool':
    case 'asyncAgent':
    case 'sandboxOverride':
    case 'workingDir':
    case 'other':
    case 'subcommandResults':
      return 'other'
    default:
      return 'operator'
  }
}

export function hookPermissionOutcomeOf(result: HookFireResult, toolName: string): HookPermissionOutcome | undefined {
  const names = result.outcomes.map(outcome => outcome.name).join(', ')
  const reason = (words?: string): PermissionDecisionReason => ({ type: 'hook', hookName: names, ...(words !== undefined ? { reason: words } : {}) })
  const answer = result.answer
  if (answer.block !== undefined) return { behavior: 'deny', message: answer.block, decisionReason: reason(answer.block) }
  if (answer.permission === 'allow') return { behavior: 'allow', updatedInput: answer.input, decisionReason: reason() }
  if (answer.permission === 'ask') return { behavior: 'ask', updatedInput: answer.input, message: `A hook (${names}) ${getRuleBehaviorDescription('ask')} this ${toolName} call`, decisionReason: reason() }
  return undefined
}

export async function resolveHookPermissionDecision(
  hookResult: HookPermissionOutcome | undefined,
  tool: Tool,
  input: AnyObject,
  context: ToolUseContext,
  canUseTool: CanUseToolFn,
  assistantMessage: AssistantMessage,
  toolUseID: string,
): Promise<{ decision: PermissionDecision; input: AnyObject }> {
  if (hookResult?.behavior === 'allow') {
    const effectiveInput = hookResult.updatedInput ?? input
    const interactionUnsatisfied = tool.requiresUserInteraction?.() === true && hookResult.updatedInput === undefined
    if (interactionUnsatisfied || context.alwaysCallCanUseTool) {
      const decision = await canUseTool(tool, effectiveInput, context, assistantMessage, toolUseID)
      return { decision, input: effectiveInput }
    }
    const ruleObjection = await checkRuleBasedPermissions(tool, effectiveInput, context)
    if (ruleObjection === null) {
      return {
        decision: { behavior: 'allow', updatedInput: effectiveInput, ...(hookResult.decisionReason !== undefined ? { decisionReason: hookResult.decisionReason } : {}) } as PermissionDecision,
        input: effectiveInput,
      }
    }
    if (ruleObjection.behavior === 'deny') return { decision: ruleObjection, input: effectiveInput }
    const decision = await canUseTool(tool, effectiveInput, context, assistantMessage, toolUseID)
    return { decision, input: effectiveInput }
  }
  if (hookResult?.behavior === 'deny') {
    return {
      decision: { behavior: 'deny', message: hookResult.message, ...(hookResult.decisionReason !== undefined ? { decisionReason: hookResult.decisionReason } : {}) } as PermissionDecision,
      input,
    }
  }
  const inputForCallback = hookResult?.updatedInput ?? input
  const forcedDecision =
    hookResult?.behavior === 'ask'
      ? ({
          behavior: 'ask',
          ...(hookResult.message !== undefined ? { message: hookResult.message } : {}),
          ...(hookResult.updatedInput !== undefined ? { updatedInput: hookResult.updatedInput } : {}),
          ...(hookResult.decisionReason !== undefined ? { decisionReason: hookResult.decisionReason } : {}),
        } as PermissionDecision)
      : undefined
  const decision = await canUseTool(tool, inputForCallback, context, assistantMessage, toolUseID, forcedDecision)
  return { decision, input: inputForCallback }
}
