import { getProjectConfigForWorkspace, saveProjectConfigForWorkspace } from '../../utils/config.js'
import type { ProjectConfig } from '../../utils/config/schema.js'
import { disabledMcpServerNamesIn, withMcpServerEnabled } from './disabledRecord.js'

export type SkillMenuState = 'off' | 'invocable'

export type SkillKitState = 'on' | SkillMenuState

export interface KitDeltasV1 {
  mcpOff: string[]
  skillStates: Record<string, SkillMenuState>
  extensionsOff: string[]
}

export function emptyKitDeltas(): KitDeltasV1 {
  return { mcpOff: [], skillStates: {}, extensionsOff: [] }
}

export function kitDeltasOf(slice: ProjectConfig): KitDeltasV1 {
  const skillStates: Record<string, SkillMenuState> = {}
  for (const [name, state] of Object.entries(slice.skillStates ?? {})) {
    if (state === 'off' || state === 'invocable') skillStates[name] = state
  }
  const extensionsOff: string[] = []
  for (const [name, state] of Object.entries(slice.extensionStates ?? {})) {
    if (state === 'off' && !extensionsOff.includes(name)) extensionsOff.push(name)
  }
  return { mcpOff: disabledMcpServerNamesIn(slice), skillStates, extensionsOff }
}

export function kitDeltasForWorkspace(workspaceDir: string): KitDeltasV1 {
  return kitDeltasOf(getProjectConfigForWorkspace(workspaceDir))
}

export function withSkillState(current: ProjectConfig, name: string, state: SkillKitState): ProjectConfig {
  const states = current.skillStates ?? {}
  const standing: SkillKitState = states[name] ?? 'on'
  if (standing === state) return current
  if (state === 'on') {
    const { [name]: _dropped, ...rest } = states
    void _dropped
    return Object.keys(rest).length === 0 ? omitKey(current, 'skillStates') : { ...current, skillStates: rest }
  }
  return { ...current, skillStates: { ...states, [name]: state } }
}

export function withExtensionState(current: ProjectConfig, name: string, on: boolean): ProjectConfig {
  const states = current.extensionStates ?? {}
  const standingOn = states[name] !== 'off'
  if (standingOn === on) return current
  if (on) {
    const { [name]: _dropped, ...rest } = states
    void _dropped
    return Object.keys(rest).length === 0 ? omitKey(current, 'extensionStates') : { ...current, extensionStates: rest }
  }
  return { ...current, extensionStates: { ...states, [name]: 'off' } }
}

function omitKey(current: ProjectConfig, key: 'skillStates' | 'extensionStates'): ProjectConfig {
  const { [key]: _dropped, ...rest } = current
  void _dropped
  return rest as ProjectConfig
}


export function setMcpServerEnabledForWorkspace(workspaceDir: string, name: string, enabled: boolean): void {
  saveProjectConfigForWorkspace(workspaceDir, current => withMcpServerEnabled(current, name, enabled))
}

export function setSkillStateForWorkspace(workspaceDir: string, name: string, state: SkillKitState): void {
  saveProjectConfigForWorkspace(workspaceDir, current => withSkillState(current, name, state))
}

export function setExtensionStateForWorkspace(workspaceDir: string, name: string, on: boolean): void {
  saveProjectConfigForWorkspace(workspaceDir, current => withExtensionState(current, name, on))
}
