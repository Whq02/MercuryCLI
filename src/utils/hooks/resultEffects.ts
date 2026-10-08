import type { HookEvent, SyncHookJSONOutput } from './contract.js'
import type { HookResult, ElicitationResponse } from './types.js'

export type HookSpecificReducer = (json: SyncHookJSONOutput, command: string, common: Partial<HookResult>) => Partial<HookResult>

const contextEffects: HookSpecificReducer = json => {
  const output = json.hookSpecificOutput
  return output && 'additionalContext' in output ? { additionalContext: output.additionalContext } : {}
}

const elicitationEffects: HookSpecificReducer = (json, command) => {
  const output = json.hookSpecificOutput
  if (!output || (output.hookEventName !== 'Elicitation' && output.hookEventName !== 'ElicitationResult') || !output.action) return {}
  const answer: ElicitationResponse = { action: output.action, content: output.content as ElicitationResponse['content'] | undefined }
  return {
    ...(output.hookEventName === 'Elicitation' ? { elicitationResponse: answer } : { elicitationResultResponse: answer }),
    ...(output.action === 'decline' ? { blockingError: { blockingError: json.reason || (output.hookEventName === 'Elicitation' ? 'Elicitation denied by hook' : 'Elicitation result blocked by hook'), command } } : {}),
  }
}

export const hookSpecificReducers: Partial<Record<HookEvent, HookSpecificReducer>> = {
  PreToolUse: (json, command, common) => {
    const output = json.hookSpecificOutput
    if (output?.hookEventName !== 'PreToolUse') return {}
    const permission = output.permissionDecision
    if (permission && permission !== 'allow' && permission !== 'deny' && permission !== 'ask') throw new Error(`Unknown hook permissionDecision type: ${permission}. Valid types are: allow, deny, ask`)
    return {
      ...(permission ? { permissionBehavior: permission } : {}),
      ...(permission === 'deny' ? { blockingError: { blockingError: output.permissionDecisionReason || json.reason || 'Blocked by hook', command } } : {}),
      hookPermissionDecisionReason: output.permissionDecisionReason ?? common.hookPermissionDecisionReason ?? (permission !== undefined || common.permissionBehavior !== undefined ? json.reason : undefined),
      ...(output.updatedInput ? { updatedInput: output.updatedInput } : {}),
      additionalContext: output.additionalContext,
    }
  },
  UserPromptSubmit: contextEffects,
  SessionStart: json => {
    const output = json.hookSpecificOutput
    if (output?.hookEventName !== 'SessionStart') return {}
    return { additionalContext: output.additionalContext, initialUserMessage: output.initialUserMessage, ...(output.watchPaths ? { watchPaths: output.watchPaths } : {}) }
  },
  Setup: contextEffects,
  SubagentStart: contextEffects,
  PostToolUse: json => {
    const output = json.hookSpecificOutput
    if (output?.hookEventName !== 'PostToolUse') return {}
    return { additionalContext: output.additionalContext, ...(output.updatedMCPToolOutput ? { updatedMCPToolOutput: output.updatedMCPToolOutput } : {}) }
  },
  PostToolUseFailure: contextEffects,
  PermissionRequest: json => {
    const output = json.hookSpecificOutput
    if (output?.hookEventName !== 'PermissionRequest' || !output.decision) return {}
    const decision = output.decision
    return { permissionRequestResult: decision, permissionBehavior: decision.behavior === 'allow' ? 'allow' : 'deny', ...(decision.behavior === 'allow' && decision.updatedInput ? { updatedInput: decision.updatedInput } : {}) }
  },
  Elicitation: elicitationEffects,
  ElicitationResult: elicitationEffects,
}
