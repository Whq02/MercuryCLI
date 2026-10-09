import type { HookEvent } from '../../utils/hooks/contract.js'
import type { ExtensionHookMatcher } from 'src/utils/settings/types.js'

export type RegisteredHookMatcher = ExtensionHookMatcher

export class HookRegistryOwner {
  registeredHooks: Partial<Record<HookEvent, RegisteredHookMatcher[]>> | null = null

  registerHookCallbacks(hooks: Partial<Record<HookEvent, RegisteredHookMatcher[]>>): void {
    if (!this.registeredHooks) {
      this.registeredHooks = {}
    }
    for (const [event, matchers] of Object.entries(hooks)) {
      const eventKey = event as HookEvent
      if (!this.registeredHooks[eventKey]) {
        this.registeredHooks[eventKey] = []
      }
      this.registeredHooks[eventKey]!.push(...matchers)
    }
  }

  clearRegisteredExtensionHooks(): void {
    this.registeredHooks = null
  }
}
