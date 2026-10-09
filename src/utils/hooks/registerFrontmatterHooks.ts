import type { HooksSettings } from '../settings/types.js'
import type { SetAppState } from '../messageQueueManager.js'
import { addSessionHooks, removeSessionHooks, type HookScope } from './sessionHooks.js'

export function registerAgentHooks(setAppState: SetAppState, scope: HookScope, hooks: HooksSettings | undefined, agentType: string): number {
  if (hooks === undefined) return 0
  return addSessionHooks(setAppState, scope, hooks, { kind: 'agent', type: agentType })
}

export function registerSkillHooks(
  setAppState: SetAppState,
  scope: HookScope,
  hooks: HooksSettings | undefined,
  skill: { name: string; root: string },
): number {
  if (hooks === undefined) return 0
  return addSessionHooks(setAppState, scope, hooks, { kind: 'skill', name: skill.name, root: skill.root })
}

export function unregisterSkillHooks(setAppState: SetAppState, scope: HookScope, skill: { name: string; root: string }): void {
  removeSessionHooks(setAppState, scope, { kind: 'skill', name: skill.name, root: skill.root })
}

export { registerFrontmatterHooks } from './oldRoad.js'
