import type { AppState } from '../../state/AppStateStore.js'
import type { ToolPermissionContext } from '../../Tool.js'
import type { EffortValue } from '../../utils/effort.js'
import {
  modeBypassesPermissions,
  type PermissionMode,
} from '../../utils/permissions/PermissionMode.js'

export interface AgentPromptPostureFacts {
  isAsync: boolean
  canShowPermissionPrompts: boolean | undefined
  definitionMode: PermissionMode | undefined
  parentAvoidsPrompts: boolean
  parentNonInteractive: boolean | undefined
}

export interface AgentPromptPosture {
  avoidPrompts: boolean
  isNonInteractiveSession: boolean
}

export function resolveAgentPromptPosture(
  facts: AgentPromptPostureFacts,
): AgentPromptPosture {
  const avoidPrompts =
    facts.canShowPermissionPrompts !== undefined
      ? !facts.canShowPermissionPrompts
      : facts.definitionMode === 'bubble'
        ? false
        : facts.parentAvoidsPrompts
  const isNonInteractiveSession = facts.parentNonInteractive ?? false
  return { avoidPrompts, isNonInteractiveSession }
}

export function withAllowedCommandRules<
  S extends { toolPermissionContext: ToolPermissionContext },
>(state: S, allowedTools: readonly string[]): S {
  if (allowedTools.length === 0) return state
  const existing = state.toolPermissionContext.alwaysAllowRules.command ?? []
  const merged = [...new Set([...existing, ...allowedTools])]
  return {
    ...state,
    toolPermissionContext: {
      ...state.toolPermissionContext,
      alwaysAllowRules: {
        ...state.toolPermissionContext.alwaysAllowRules,
        command: merged,
      },
    },
  }
}

export interface AgentAppStateFacts {
  definitionMode: PermissionMode | undefined
  avoidPrompts: boolean
  isAsync: boolean
  allowedTools: readonly string[] | undefined
  effortValue: EffortValue | undefined
}

export function composeAgentAppState(
  parentState: AppState,
  facts: AgentAppStateFacts,
): AppState {
  const parentMode = parentState.toolPermissionContext.mode
  let changed = false
  let context = parentState.toolPermissionContext
  if (
    facts.definitionMode &&
    !modeBypassesPermissions(parentMode) &&
    parentMode !== 'implement' &&
    parentMode !== facts.definitionMode
  ) {
    context = { ...context, mode: facts.definitionMode }
    changed = true
  }
  if (facts.avoidPrompts !== Boolean(context.shouldAvoidPermissionPrompts)) {
    context = { ...context, shouldAvoidPermissionPrompts: facts.avoidPrompts }
    changed = true
  }
  if (
    facts.isAsync &&
    !facts.avoidPrompts &&
    !context.awaitAutomatedChecksBeforeDialog
  ) {
    context = { ...context, awaitAutomatedChecksBeforeDialog: true }
    changed = true
  }
  let next: AppState = changed
    ? { ...parentState, toolPermissionContext: context }
    : parentState
  if (facts.allowedTools && facts.allowedTools.length > 0) {
    next = withAllowedCommandRules(next, facts.allowedTools)
  }
  if (facts.effortValue !== undefined && next.effortValue !== facts.effortValue) {
    next = { ...next, effortValue: facts.effortValue }
  }
  return next
}
