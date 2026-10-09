import { clearRegisteredExtensionHooks, getRegisteredHooks, registerHookCallbacks } from '../../bootstrap/state.js'
import { HOOK_EVENTS, isHookEvent, type HookEvent } from '../../utils/hooks/contract.js'
import type { ExtensionHookMatcher, HookEntry } from '../../utils/settings/types.js'
import { activeFor } from '../active.js'

type Registered = NonNullable<ReturnType<typeof getRegisteredHooks>>

export function collectExtensionHooks(): { record: Partial<Record<HookEvent, ExtensionHookMatcher[]>>; hookCount: number; extensionCount: number } {
  const record: Partial<Record<HookEvent, ExtensionHookMatcher[]>> = {}
  for (const event of HOOK_EVENTS) record[event] = []
  let hookCount = 0
  const contributing = new Set<string>()
  for (const ext of activeFor('hooks')) {
    const byEvent = new Map<HookEvent, HookEntry[]>()
    for (const hook of ext.resolution.hooks) {
      if (!isHookEvent(hook.event)) continue
      let entries = byEvent.get(hook.event)
      if (!entries) {
        entries = []
        byEvent.set(hook.event, entries)
      }
      entries.push({ ...hook.hook })
      hookCount++
      contributing.add(ext.entry.id)
    }
    for (const [event, hooks] of byEvent) {
      record[event]?.push({ hooks, extensionName: ext.manifest.name, extensionRoot: ext.root, extensionId: ext.entry.id })
    }
  }
  return { record, hookCount, extensionCount: contributing.size }
}

export function loadExtensionHooks(): { hookCount: number; extensionCount: number } {
  const { record, hookCount, extensionCount } = collectExtensionHooks()
  clearRegisteredExtensionHooks()
  registerHookCallbacks(record as Registered)
  return { hookCount, extensionCount }
}
