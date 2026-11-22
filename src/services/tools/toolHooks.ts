import type { AnyObject, CanUseToolFn, Tool, ToolUseContext } from '../../Tool.js'
import type { AssistantMessage } from '../../types/message.js'
import type { PermissionDecision, PermissionDecisionReason } from '../../types/permissions.js'
import { getSessionId } from '../../bootstrap/state.js'
import { HOOK_CUT_BUDGET_MS } from '../../utils/hooks/contract.js'
import { errorMessage } from '../../utils/errors.js'
import { foldAnswers } from '../../utils/hooks/answer.js'
import { fireHooks, prepareHooks, type HookFireResult, type PreparedHooks } from '../../utils/hooks/fire.js'
import { hooksSettingsUnreadErrors } from '../../utils/hooks/hooksConfigSnapshot.js'
import { hooksFor } from '../../utils/hooks/matching.js'
import type { HookScope } from '../../utils/hooks/sessionHooks.js'
import { postureBypassesAsks } from '../../utils/permissions/decision/engine.js'
import { checkRuleBasedPermissions } from '../../utils/permissions/permissions.js'
import { getRuleBehaviorDescription } from '../../utils/permissions/PermissionResult.js'
import { notBuilt } from '../../pi/holes.js'

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
  return notBuilt('src/services/tools/toolHooks.ts:31')
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
  return notBuilt('src/services/tools/toolHooks.ts:59')
}

export function permissionDecidedHooks(
  tool: Tool,
  toolUseID: string,
  input: AnyObject,
  decided: { decision: 'allowed' | 'denied'; by: 'rule' | 'mode' | 'hook' | 'operator' | 'safety' | 'other'; reason?: string },
  toolUseContext: ToolUseContext,
  signal: AbortSignal,
): Promise<HookFireResult> {
  return notBuilt('src/services/tools/toolHooks.ts:77')
}

export function deciderOf(reason: PermissionDecisionReason | undefined): 'rule' | 'mode' | 'hook' | 'operator' | 'safety' | 'other' {
  return notBuilt('src/services/tools/toolHooks.ts:88')
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
  return notBuilt('src/services/tools/toolHooks.ts:121')
}
