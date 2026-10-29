import type { AppState } from '../../state/AppStateStore.js'
import type { ToolPermissionContext } from '../../Tool.js'
import type { EffortValue } from '../../utils/effort.js'
import { scopedAgentToolRules } from './agentToolRules.js'
import {
  modeBypassesPermissions,
  PERMISSION_MODES,
  type PermissionMode,
} from '../../utils/permissions/PermissionMode.js'

interface AgentPromptPostureFacts {

  isAsync: boolean

  canShowPermissionPrompts: boolean | undefined

  definitionMode: PermissionMode | undefined

  parentAvoidsPrompts: boolean

  parentNonInteractive: boolean | undefined

  parentHostHoldsAsks?: boolean | undefined
}

interface AgentPromptPosture {
  avoidPrompts: boolean
  isNonInteractiveSession: boolean

  hostHoldsAsks: boolean | undefined
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
  const hostHoldsAsks = avoidPrompts ? undefined : facts.parentHostHoldsAsks
  return { avoidPrompts, isNonInteractiveSession, hostHoldsAsks }
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

interface AgentAppStateFacts {
  definitionMode: PermissionMode | undefined
  avoidPrompts: boolean
  isAsync: boolean
  allowedTools: readonly string[] | undefined
  effortValue: EffortValue | undefined
  definitionTools?: { tools?: readonly string[]; disallowedTools?: readonly string[] }
}

export function definitionModeWithinConsent(
  definitionMode: PermissionMode | undefined,
  context: Pick<ToolPermissionContext, 'isBypassPermissionsModeAvailable'>,
): PermissionMode | undefined {
  if (definitionMode === undefined) return undefined
  if (modeBypassesPermissions(definitionMode) && context.isBypassPermissionsModeAvailable !== true) return undefined
  return definitionMode
}

export function offeredDefinitionModes(bypassConsent: boolean): PermissionMode[] {
  return PERMISSION_MODES.filter(mode => bypassConsent || !modeBypassesPermissions(mode))
}

export function composeAgentAppState(
  parentState: AppState,
  facts: AgentAppStateFacts,
): AppState {
  const parentMode = parentState.toolPermissionContext.mode
  let changed = false
  let context = parentState.toolPermissionContext
  const definitionMode = definitionModeWithinConsent(facts.definitionMode, context)
  if (
    definitionMode &&
    !modeBypassesPermissions(parentMode) &&
    parentMode !== 'implement' &&
    parentMode !== definitionMode
  ) {
    context = { ...context, mode: definitionMode }
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
  if (facts.definitionTools !== undefined) {
    const rules = scopedAgentToolRules(facts.definitionTools)
    const permission = next.toolPermissionContext
    const allowNarrowing = rules.allow.length > 0 ? rules.allow : undefined
    const mergedDeny = [...new Set([...(permission.alwaysDenyRules.toolsNarrowing ?? []), ...rules.deny])]
    const denyNarrowing = mergedDeny.length > 0 ? mergedDeny : undefined
    if (allowNarrowing !== permission.alwaysAllowRules.toolsNarrowing || denyNarrowing !== permission.alwaysDenyRules.toolsNarrowing) {
      const { toolsNarrowing: _prevAllow, ...restAllow } = permission.alwaysAllowRules
      const { toolsNarrowing: _prevDeny, ...restDeny } = permission.alwaysDenyRules
      next = {
        ...next,
        toolPermissionContext: {
          ...permission,
          alwaysAllowRules: allowNarrowing ? { ...restAllow, toolsNarrowing: allowNarrowing } : restAllow,
          alwaysDenyRules: denyNarrowing ? { ...restDeny, toolsNarrowing: denyNarrowing } : restDeny,
        },
      }
    }
  }
  if (facts.effortValue !== undefined && next.effortValue !== facts.effortValue) {
    next = { ...next, effortValue: facts.effortValue }
  }
  return next
}
