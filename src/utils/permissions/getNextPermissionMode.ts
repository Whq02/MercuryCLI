import type { ToolPermissionContext } from '../../Tool.js'
import { logForDebugging } from '../debug.js'
import type { PermissionMode } from '../../types/permissions.js'
import { isFlowGateEnabled, transitionPermissionMode } from './permissionSetup.js'
import { notBuilt } from '../../pi/holes.js'


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
  return notBuilt('src/utils/permissions/getNextPermissionMode.ts:16')
}

export function cyclePermissionMode(
  context: ToolPermissionContext,
): { nextMode: PermissionMode; context: ToolPermissionContext } {
  return notBuilt('src/utils/permissions/getNextPermissionMode.ts:40')
}
