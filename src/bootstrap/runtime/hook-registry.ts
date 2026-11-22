import type { HookEvent } from '../../utils/hooks/contract.js'
import type { ExtensionHookMatcher } from 'src/utils/settings/types.js'
import { notBuilt, unbuilt, type Unbuilt } from '../../pi/holes.js'

export type RegisteredHookMatcher = Unbuilt

export class HookRegistryOwner {
  registeredHooks: Partial<Record<HookEvent, RegisteredHookMatcher[]>> | null = unbuilt('src/bootstrap/runtime/hook-registry.ts:7')

  registerHookCallbacks(hooks: Partial<Record<HookEvent, RegisteredHookMatcher[]>>): void {
    return notBuilt('src/bootstrap/runtime/hook-registry.ts:9')
  }

  clearRegisteredExtensionHooks(): void {
    return notBuilt('src/bootstrap/runtime/hook-registry.ts:22')
  }
}
