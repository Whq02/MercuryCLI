import type { ToolPermissionContext } from '../../Tool.js'
import { logForDebugging } from '../debug.js'
import { isAutopilotEnabled } from '../autopilot/autopilotGates.js'
import type { PermissionMode } from '../../types/permissions.js'
import { isAutoModeGateEnabled, transitionPermissionMode } from './permissionSetup.js'

type CrewContext = { leadAgentId?: string } | undefined

function bypassAvailable(context: ToolPermissionContext): boolean {
  return (context as { isBypassPermissionsModeAvailable?: boolean }).isBypassPermissionsModeAvailable === true
}

function canCycleToAuto(_context: ToolPermissionContext): boolean {
  const gateEnabled = isAutoModeGateEnabled()
  return gateEnabled
}

export function getNextPermissionMode(
  toolPermissionContext: ToolPermissionContext,
  _crewContext?: CrewContext,
): PermissionMode {
  const mode = toolPermissionContext.mode
  switch (mode) {
    case 'default':
      return 'implement'
    case 'implement':
    case 'strategy':
      return 'apollo'
    case 'apollo':
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
      return 'default'
  }
}

export function cyclePermissionMode(
  context: ToolPermissionContext,
  crewContext?: CrewContext,
): { nextMode: PermissionMode; context: ToolPermissionContext } {
  const nextMode = getNextPermissionMode(context, crewContext)
  let nextContext = context
  try {
    nextContext = transitionPermissionMode(context.mode, nextMode, context)
  } catch (error) {
    logForDebugging(
      `permission mode transition ${context.mode} → ${nextMode} failed: ${error instanceof Error ? error.message : String(error)}`,
    )
  }
  return { nextMode, context: nextContext }
}
