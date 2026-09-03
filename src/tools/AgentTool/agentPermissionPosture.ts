/**
 * The permission posture of a sub-agent: ONE owner for the two facts the
 * runner stamps on a child's view of the session — whether its asks can
 * reach an operator, and whether it counts as an interactive session — and
 * for the overlay that composes the child's app-state view from the
 * parent's.
 *
 * The law: an agent inherits its parent's ask road. A background agent of a
 * session that can ask uses that session's own road (the focused chat's
 * consent card, a seat's stdio prompt tool, a teammate's leader) exactly as
 * the main thread does; a background agent of a prompt-less parent is
 * prompt-less. A caller's explicit answer, or a bubble definition, overrides
 * the inheritance. Without this owner every background agent was stamped
 * prompt-less and non-interactive by construction, so its ask never left
 * the mode wrapper — a plain deny in default mode, a structured deny at the
 * flow floors, a machine deny on a classifier block — while the same ask
 * from the main thread parked on the operator's card.
 */
import type { AppState } from '../../state/AppStateStore.js'
import type { ToolPermissionContext } from '../../Tool.js'
import type { EffortValue } from '../../utils/effort.js'
import {
  modeBypassesPermissions,
  type PermissionMode,
} from '../../utils/permissions/PermissionMode.js'

export interface AgentPromptPostureFacts {
  /** The run is a background (async) execution. */
  isAsync: boolean
  /** A caller's explicit answer: a teammate's leader prompts; a headless
   *  workflow channel does not. */
  canShowPermissionPrompts: boolean | undefined
  /** The definition's own mode — `bubble` prompts whatever the parent does. */
  definitionMode: PermissionMode | undefined
  /** The parent's own view avoids prompts (a side loop, a prompt-less run). */
  parentAvoidsPrompts: boolean
  /** The parent option as it stands (undefined when never stated reads
   *  interactive — a host that never said so can still be asked). */
  parentNonInteractive: boolean | undefined
}

export interface AgentPromptPosture {
  avoidPrompts: boolean
  isNonInteractiveSession: boolean
}

/** The prompt posture a run carries — see the module note for the law. */
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

/**
 * Add a run's allowed tools to the command layer of a state's allow rules.
 * The operator's own layers (settings, policy, the CLI flag) stay as they
 * are — a run's grants widen the allow set, never replace it. The identity
 * for an empty list.
 */
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

/**
 * The child's view of the session state: the definition's mode overrides
 * the parent's (never under a bypass posture, never under implement); the
 * prompt posture lands on the permission context; a background run that can
 * prompt awaits automated checks before its dialog; the run's allowed tools
 * join the command layer; the resolved effort replaces the session's. The
 * parent state itself when nothing changes.
 */
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
