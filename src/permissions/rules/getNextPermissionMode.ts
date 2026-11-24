import type { ToolPermissionContext } from '../../tools/kit/tool.js'
import { logForDebugging } from '../../platform/logs/debugLog.js'
import type { PermissionMode } from './permissions.js'
import { isFlowGateEnabled, transitionPermissionMode } from './permissionSetup.js'


function sovereignAvailable(context: ToolPermissionContext): boolean {
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
      if (sovereignAvailable(toolPermissionContext)) return 'sovereign'
      return 'default'
    case 'flow':
      if (sovereignAvailable(toolPermissionContext)) return 'sovereign'
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
      `permission mode transition ${context.mode} -> ${nextMode}: ${error instanceof Error ? error.message : String(error)}`,
      { level: 'error' },
    )
  }
  return { nextMode, context: nextContext }
}
