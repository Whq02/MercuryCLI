import type { HookEvent } from 'src/entrypoints/agentSdkTypes.js'
import type { HookCallbackMatcher } from 'src/types/hooks.js'
import type { ExtensionHookMatcher } from 'src/utils/settings/types.js'

export type RegisteredHookMatcher = HookCallbackMatcher | ExtensionHookMatcher

export class SdkInitOwner {
  initJsonSchema: Record<string, unknown> | null = null
  registeredHooks: Partial<Record<HookEvent, RegisteredHookMatcher[]>> | null =
    null

  registerHookCallbacks(
    hooks: Partial<Record<HookEvent, RegisteredHookMatcher[]>>,
  ): void {
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
    if (!this.registeredHooks) {
      return
    }

    const filtered: Partial<Record<HookEvent, RegisteredHookMatcher[]>> = {}
    for (const [event, matchers] of Object.entries(this.registeredHooks)) {
      const callbackHooks = matchers.filter(m => !('extensionRoot' in m))
      if (callbackHooks.length > 0) {
        filtered[event as HookEvent] = callbackHooks
      }
    }

    this.registeredHooks = Object.keys(filtered).length > 0 ? filtered : null
  }

  resetSdkInitState(): void {
    this.initJsonSchema = null
    this.registeredHooks = null
  }
}
