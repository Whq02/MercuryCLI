import { entriesOf } from '../../utils/entriesOf.js'
import type { HookEvent } from '../../utils/hooks/contract.js'
import type { ExtensionHookMatcher } from 'src/utils/settings/types.js'

export type RegisteredHookMatcher = ExtensionHookMatcher

export class HookRegistryOwner {
  registeredHooks: Partial<Record<HookEvent, RegisteredHookMatcher[]>> | null = null

  registerHookCallbacks(hooks: Partial<Record<HookEvent, RegisteredHookMatcher[]>>): void {
    if (!this.registeredHooks) {
      this.registeredHooks = {}
    }
    for (const [event, matchers] of entriesOf(hooks)) {
      if (!matchers) continue
      let list = this.registeredHooks[event]
      if (!list) {
        list = []
        this.registeredHooks[event] = list
      }
      list.push(...matchers)
    }
  }

  clearRegisteredExtensionHooks(): void {
    this.registeredHooks = null
  }
}
