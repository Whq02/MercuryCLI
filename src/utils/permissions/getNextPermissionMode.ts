/**
 * The Shift+Tab mode carousel order and the cycle-with-transition helper.
 *
 * The Mercury cycle is
 * default → implement → strategy → apollo → flow → sovereign → autopilot →
 * default, with each step falling through cleanly when its mode is
 * unavailable. The two think-first stations sit together: apollo (the
 * pre-flight interview) directly after strategy, always available. "Can
 * cycle to flow" uses the LIVE synchronous gate, not the cached
 * availability flag, which also keeps the transition helper from throwing
 * and stranding the Shift+Tab handler.
 */
import type { ToolPermissionContext } from '../../Tool.js'
import { logForDebugging } from '../debug.js'
import { isAutopilotEnabled } from '../autopilot/autopilotGates.js'
import type { PermissionMode } from '../../types/permissions.js'
import { isAutoModeGateEnabled, transitionPermissionMode } from './permissionSetup.js'

type TeamContext = { leadAgentId?: string } | undefined

/** Whether bypass permissions is available on this context. */
function bypassAvailable(context: ToolPermissionContext): boolean {
  return (context as { isBypassPermissionsModeAvailable?: boolean }).isBypassPermissionsModeAvailable === true
}

/** Whether the carousel may cycle into flow (the live gate decides). */
function canCycleToAuto(_context: ToolPermissionContext): boolean {
  // The carousel's SOLE flow gate is the live synchronous flow-mode gate, not
  // the cached availability flag on the context.
  const gateEnabled = isAutoModeGateEnabled()
  return gateEnabled
}

/**
 * The next mode in the carousel from the context's current mode. The second
 * parameter (a team context) is threaded through but unused today.
 */
export function getNextPermissionMode(
  toolPermissionContext: ToolPermissionContext,
  _teamContext?: TeamContext,
): PermissionMode {
  const mode = toolPermissionContext.mode
  switch (mode) {
    case 'default':
      return 'implement'
    case 'implement':
      return 'strategy'
    case 'strategy':
      // The interview station rides directly after strategy (the two
      // think-first stations sit together — lead call, spec).
      return 'apollo'
    case 'apollo':
      // Flow comes BEFORE sovereign: it is the lighter, classifier-gated station.
      if (canCycleToAuto(toolPermissionContext)) return 'flow'
      if (bypassAvailable(toolPermissionContext)) return 'sovereign'
      return 'default'
    case 'flow':
      return bypassAvailable(toolPermissionContext) ? 'sovereign' : 'default'
    case 'sovereign':
      if (isAutopilotEnabled() && bypassAvailable(toolPermissionContext)) return 'autopilot'
      return 'default'
    case 'autopilot':
      return 'default'
    case 'dontAsk':
      return 'default'
    default:
      // Any other mode (including bubble and scribe) returns to default.
      return 'default'
  }
}

/**
 * The next mode plus the context produced by running the transition side
 * effects from the current mode to it.
 */
export function cyclePermissionMode(
  context: ToolPermissionContext,
  teamContext?: TeamContext,
): { nextMode: PermissionMode; context: ToolPermissionContext } {
  const nextMode = getNextPermissionMode(context, teamContext)
  let nextContext = context
  try {
    nextContext = transitionPermissionMode(context.mode, nextMode, context)
  } catch (error) {
    // The live gate should already prevent an unavailable-auto transition;
    // if a transition still throws, keep the carousel responsive.
    logForDebugging(
      `permission mode transition ${context.mode} → ${nextMode} failed: ${error instanceof Error ? error.message : String(error)}`,
    )
  }
  return { nextMode, context: nextContext }
}
