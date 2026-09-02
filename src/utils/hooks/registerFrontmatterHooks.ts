import { HOOK_EVENTS } from '../../entrypoints/sdk/coreTypes.js'
import type { HooksSettings } from '../settings/types.js'
import type { SetAppState } from '../messageQueueManager.js'
import { logForDebugging } from '../debug.js'
import { addSessionHook } from './sessionHooks.js'

export function registerFrontmatterHooks(
  setAppState: SetAppState,
  sessionId: string,
  hooks: HooksSettings,
  sourceName: string,
  isAgent?: boolean,
): void {
  if (!hooks || Object.keys(hooks).length === 0) return
  let registered = 0
  for (const event of HOOK_EVENTS) {
    let targetEvent = event
    if (isAgent && event === 'Stop') {
      targetEvent = 'SubagentStop'
      logForDebugging(`frontmatter hooks (${sourceName}): converted Stop to SubagentStop`)
    }
    for (const matcherGroup of hooks[event] ?? []) {
      for (const hook of matcherGroup.hooks ?? []) {
        addSessionHook(setAppState, sessionId, targetEvent, matcherGroup.matcher ?? '', hook)
        registered += 1
      }
    }
  }
  if (registered > 0) {
    logForDebugging(`frontmatter hooks (${sourceName}): registered ${registered}`)
  }
}
