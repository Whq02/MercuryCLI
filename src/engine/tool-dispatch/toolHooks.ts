import type { AnyObject, CanUseToolFn, Tool, ToolUseContext } from '../../tools/kit/tool.js'
import type { AssistantMessage } from '../message-shapes/message.js'
import type { PermissionAskDecision, PermissionDecision, PermissionDecisionReason, PermissionDenyDecision } from '../../permissions/rules/permissions.js'
import { getSessionId } from '../../boot/process-state/processState.js'
import { HOOK_CUT_BUDGET_MS } from '../../integrations/event-hooks/contract.js'
import { errorMessage } from '../../platform/errors/errors.js'
import { foldAnswers } from '../../integrations/event-hooks/answer.js'
import { fireHooks, prepareHooks, type HookFireResult, type PreparedHooks } from '../../integrations/event-hooks/fire.js'
import { hooksSettingsUnreadErrors } from '../../integrations/event-hooks/hooksConfigSnapshot.js'
import { hooksFor } from '../../integrations/event-hooks/matching.js'
import type { HookScope } from '../../integrations/event-hooks/sessionHooks.js'
import { postureBypassesAsks } from '../../permissions/rules/decision/engine.js'
import { checkRuleBasedPermissions } from '../../permissions/rules/permissionDoor.js'
import { getRuleBehaviorDescription } from '../../permissions/rules/permissionResult.js'

export type HookPermissionOutcome = {
  behavior: 'allow' | 'ask' | 'deny'
  updatedInput?: AnyObject
  message?: string
  decisionReason?: PermissionDecisionReason
}

function hookScopeOf(toolUseContext: ToolUseContext): HookScope {
  return { sessionId: getSessionId(), ...(toolUseContext.agentId !== undefined ? { crewmateId: toolUseContext.agentId } : {}) }
}

export type HookAnnounce = (prepared: PreparedHooks) => void

const notifiedUnreadHookSettings = new Set<string>()

function notifyUnreadHookSettings(scope: HookScope, toolUseContext: ToolUseContext): void {
  for (const unread of hooksSettingsUnreadErrors(scope.cwd)) {
    const told = `${scope.sessionId}\n${unread.path}`
    if (notifiedUnreadHookSettings.has(told)) continue
    notifiedUnreadHookSettings.add(told)
    toolUseContext.addNotification?.({
      key: `hook-settings-unread:${unread.path}`,
      color: 'warning',
      priority: 'high',
      text: `hook settings at ${unread.path} could not be read (${unread.error}), so no hook runs — fix the file to bring them back`,
    })
  }
}

export async function beforeToolHooks(tool: Tool, toolUseID: string, input: AnyObject, toolUseContext: ToolUseContext, signal: AbortSignal, announce?: HookAnnounce): Promise<HookFireResult> {
  const scope = hookScopeOf(toolUseContext)
  try {
    hooksFor('tool.before', scope, toolUseContext.getAppState())
  } catch (error) {
    const block = `the hooks could not be read, so the ${tool.name} call is refused: ${errorMessage(error)}`
    return { event: 'tool.before', answer: { ...foldAnswers('tool.before', []), block }, outcomes: [] }
  }
  notifyUnreadHookSettings(scope, toolUseContext)
  const prepared = await prepareHooks('tool.before', { tool: tool.name, input, call_id: toolUseID }, { scope, signal, toolUseContext })
  if (prepared.names.length > 0) announce?.(prepared)
  return prepared.run()
}

export async function afterToolHooks(
  tool: Tool,
  toolUseID: string,
  input: AnyObject,
  ended: { ok: boolean; output?: unknown; error?: string; cut: boolean; wallMs: number },
  toolUseContext: ToolUseContext,
  signal: AbortSignal | undefined,
  announce?: HookAnnounce,
): Promise<HookFireResult> {
  const scope = hookScopeOf(toolUseContext)
  const prepared = await prepareHooks(
    'tool.after',
    {
      tool: tool.name,
      input,
      output: ended.output,
      call_id: toolUseID,
      ok: ended.ok,
      ...(ended.error !== undefined ? { error: ended.error } : {}),
      cut: ended.cut,
      wall_ms: Math.max(0, Math.round(ended.wallMs)),
    },
    ended.cut ? { scope, budgetMs: HOOK_CUT_BUDGET_MS, toolUseContext } : { scope, signal, toolUseContext },
  )
  if (prepared.names.length > 0) announce?.(prepared)
  return prepared.run()
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
  const ask = (asked: AnyObject, forced?: PermissionDecision): Promise<PermissionDecision> =>
    forced === undefined ? canUseTool(tool, asked, context, assistantMessage, toolUseID) : canUseTool(tool, asked, context, assistantMessage, toolUseID, forced)

  if (hookResult === undefined) return { decision: await ask(input), input }
  if (hookResult.behavior === 'deny') {
    const decision = { behavior: 'deny', message: hookResult.message, decisionReason: hookResult.decisionReason } as PermissionDenyDecision
    return { decision, input }
  }

  const effective = hookResult.updatedInput ?? input
  if (hookResult.behavior === 'ask') {
    if (postureBypassesAsks(context.getAppState().toolPermissionContext)) return { decision: await ask(effective), input: effective }
    const forced = {
      behavior: 'ask',
      ...(hookResult.message !== undefined ? { message: hookResult.message } : {}),
      ...(hookResult.updatedInput !== undefined ? { updatedInput: hookResult.updatedInput } : {}),
      ...(hookResult.decisionReason !== undefined ? { decisionReason: hookResult.decisionReason } : {}),
    } as PermissionAskDecision
    return { decision: await ask(effective, forced), input: effective }
  }

  const interactionOwed = tool.requiresUserInteraction?.() === true && hookResult.updatedInput === undefined
  if (interactionOwed || context.alwaysCallCanUseTool === true) return { decision: await ask(effective), input: effective }
  const objection = await checkRuleBasedPermissions(tool, effective, context)
  if (objection === null) {
    return { decision: { behavior: 'allow', updatedInput: effective, decisionReason: hookResult.decisionReason }, input: effective }
  }
  if (objection.behavior === 'deny') return { decision: objection, input: effective }
  return { decision: await ask(effective), input: effective }
}
