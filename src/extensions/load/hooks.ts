// ============================================================================
//  src/extensions/load/hooks.ts — an extension's hooks, swapped into the
//  session's hook registry ATOMICALLY: the clear lives INSIDE the register
//  operation, so there is never a moment with zero extension hooks between
//  a clear and a re-register (an event whose dispatch does not await the
//  load would otherwise stop firing for the rest of the session). The
//  operator's own hooks and SDK callbacks are never touched: the registry
//  prunes on `extensionRoot`.
// ============================================================================
import { clearRegisteredExtensionHooks, getRegisteredHooks, registerHookCallbacks } from '../../bootstrap/state.js'
import { HOOK_EVENTS } from '../../entrypoints/sdk/coreTypes.js'
import type { HookCommand } from '../../schemas/hooks.js'
import type { ExtensionHookMatcher } from '../../utils/settings/types.js'
import { activeFor } from '../active.js'

type Registered = NonNullable<ReturnType<typeof getRegisteredHooks>>

/** The matchers every active extension contributes, by event (an entry for EVERY event, empty when unused). */
export function collectExtensionHooks(): { record: Partial<Record<(typeof HOOK_EVENTS)[number], ExtensionHookMatcher[]>>; hookCount: number; extensionCount: number } {
  const record: Partial<Record<(typeof HOOK_EVENTS)[number], ExtensionHookMatcher[]>> = {}
  for (const event of HOOK_EVENTS) record[event] = []
  let hookCount = 0
  const contributing = new Set<string>()
  for (const ext of activeFor('hooks')) {
    // Group the resolved hooks back into matchers (event + matcher pattern).
    const groups = new Map<string, { event: (typeof HOOK_EVENTS)[number]; matcher: string | undefined; hooks: HookCommand[] }>()
    for (const hook of ext.resolution.hooks) {
      const key = `${hook.event}\0${hook.matcher ?? ''}`
      let group = groups.get(key)
      if (!group) {
        group = { event: hook.event as (typeof HOOK_EVENTS)[number], matcher: hook.matcher, hooks: [] }
        groups.set(key, group)
      }
      // The command line is registered UNSUBSTITUTED: the executor
      // substitutes root/data/options at spawn time, so a reload of the
      // options never needs a hook re-registration.
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

/** The atomic swap: clear the extension lane and register the fresh set in one synchronous step. */
export function loadExtensionHooks(): { hookCount: number; extensionCount: number } {
  const { record, hookCount, extensionCount } = collectExtensionHooks()
  clearRegisteredExtensionHooks()
  registerHookCallbacks(record as Registered)
  return { hookCount, extensionCount }
}

/** The extension matchers currently registered (for provers and the pane). */
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
