import type { ToolPermissionContext } from '../../Tool.js'
import { logForDebugging } from '../debug.js'
import type { PermissionMode } from '../../types/permissions.js'
import { isFlowGateEnabled, transitionPermissionMode } from './permissionSetup.js'


function bypassAvailable(context: ToolPermissionContext): boolean {
  return (context as { isBypassPermissionsModeAvailable?: boolean }).isBypassPermissionsModeAvailable === true
}

function canCycleToFlow(_context: ToolPermissionContext): boolean {
  const gateEnabled = isFlowGateEnabled()
  return gateEnabled
}

export function getNextPermissionMode(
  toolPermissionContext: ToolPermissionContext,
): PermissionMode {
  switch (toolPermissionContext.mode) {
    case 'default':
      return 'implement'
    case 'implement':
      return 'apollo'
    case 'apollo':
      if (canCycleToFlow(toolPermissionContext)) return 'flow'
      if (bypassAvailable(toolPermissionContext)) return 'sovereign'
      return 'default'
    case 'flow':
      if (bypassAvailable(toolPermissionContext)) return 'sovereign'
      return 'default'
    case 'sovereign':
    case 'dontAsk':
    default:
      return 'default'
  }
}

export function cyclePermissionMode(
  context: ToolPermissionContext,
): { nextMode: PermissionMode; context: ToolPermissionContext } {
  const nextMode = getNextPermissionMode(context)
  let nextContext = context
  try {
    nextContext = transitionPermissionMode(context.mode, nextMode, context)
  } catch (error) {
    logForDebugging(
      `Failed to transition permission mode from ${context.mode} to ${nextMode}: ${error instanceof Error ? error.message : String(error)}`,
      { level: 'error' },
    )
  }
  return { nextMode, context: nextContext }
}
