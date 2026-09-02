import { clearRegisteredExtensionHooks, getRegisteredHooks, registerHookCallbacks } from '../../bootstrap/state.js'
import { HOOK_EVENTS } from '../../entrypoints/sdk/coreTypes.js'
import type { HookCommand } from '../../schemas/hooks.js'
import type { ExtensionHookMatcher } from '../../utils/settings/types.js'
import { activeFor } from '../active.js'

type Registered = NonNullable<ReturnType<typeof getRegisteredHooks>>

export function collectExtensionHooks(): { record: Partial<Record<(typeof HOOK_EVENTS)[number], ExtensionHookMatcher[]>>; hookCount: number; extensionCount: number } {
  const record: Partial<Record<(typeof HOOK_EVENTS)[number], ExtensionHookMatcher[]>> = {}
  for (const event of HOOK_EVENTS) record[event] = []
  let hookCount = 0
  const contributing = new Set<string>()
  for (const ext of activeFor('hooks')) {
    const groups = new Map<string, { event: (typeof HOOK_EVENTS)[number]; matcher: string | undefined; hooks: HookCommand[] }>()
    for (const hook of ext.resolution.hooks) {
      const key = `${hook.event}\0${hook.matcher ?? ''}`
      let group = groups.get(key)
      if (!group) {
        group = { event: hook.event as (typeof HOOK_EVENTS)[number], matcher: hook.matcher, hooks: [] }
        groups.set(key, group)
      }
      group.hooks.push({ ...hook.hook } as HookCommand)
      hookCount++
      contributing.add(ext.entry.id)
    }
    for (const group of groups.values()) {
      const list = record[group.event]
      if (!list) continue
      list.push({ matcher: group.matcher, hooks: group.hooks, extensionName: ext.manifest.name, extensionRoot: ext.root, extensionId: ext.entry.id })
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

export function registeredExtensionHooks(): Array<{ event: string; matcher: ExtensionHookMatcher }> {
  const out: Array<{ event: string; matcher: ExtensionHookMatcher }> = []
  const registered = getRegisteredHooks() ?? {}
  for (const [event, matchers] of Object.entries(registered)) {
    for (const matcher of matchers ?? []) {
      if ('extensionRoot' in matcher) out.push({ event, matcher: matcher as ExtensionHookMatcher })
    }
  }
  return out
}
