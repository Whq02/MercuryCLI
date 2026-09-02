// ============================================================================
//  src/bootstrap/runtime/sdk-init.ts — the SDK-init registry owner
//
//
//  Scope: SESSION — the SDK init event state (structured-output schema) and
//  the registered-hooks registry (SDK callbacks + extension hooks).
//  Merge-on-register and the extensionRoot-discriminated clear are the
//  pinned laws (prove-state-contract LAW 9).
//
//  BOOTSTRAP-ISOLATION LEAF (the same custom-rules/bootstrap-isolation
//  convention state.ts carries): this module imports ONLY types. No
//  src/utils value imports. src/bootstrap/state.ts is the ONLY sanctioned
//  importer; every consumer goes through the frozen facade.
// ============================================================================
import type { HookEvent } from 'src/entrypoints/agentSdkTypes.js'
import type { HookCallbackMatcher } from 'src/types/hooks.js'
import type { ExtensionHookMatcher } from 'src/utils/settings/types.js'

// A registered matcher is either an SDK callback bundle or an extension's
// hook (the latter carries extensionRoot — the clear discriminant).
export type RegisteredHookMatcher = HookCallbackMatcher | ExtensionHookMatcher

export class SdkInitOwner {
  // The structured-output JSON schema the SDK's initialize request carried.
  initJsonSchema: Record<string, unknown> | null = null
  // Every registered hook matcher, SDK and extension alike, by event.
  registeredHooks: Partial<Record<HookEvent, RegisteredHookMatcher[]>> | null =
    null

  registerHookCallbacks(
    hooks: Partial<Record<HookEvent, RegisteredHookMatcher[]>>,
  ): void {
    if (!this.registeredHooks) {
      this.registeredHooks = {}
    }

    // Merge-on-register (pinned law): repeat calls APPEND to an event's
    // matcher list — overwriting would drop earlier registrations.
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
      // extensionRoot discriminates: extension hooks go, SDK callbacks survive.
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
