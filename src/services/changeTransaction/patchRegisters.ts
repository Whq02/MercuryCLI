
import { registerOwnerScopedStore } from '../run/ownerLifecycle.js'
import type { OwnerKey } from '../run/ownerKey.js'
import { OwnerScopedStore } from '../run/ownerScopedStore.js'

export const PATCH_REGISTER_BOUNDS = {
  nameCap: 8,
  bytesCap: 512 * 1024,
  perRegisterBytes: 256 * 1024,
} as const

export interface PatchRegister {
  content: string
  fromPath: string
  cutAt: number
}

interface RegisterState {
  registers: Map<string, PatchRegister>
  evicted: Set<string>
}

const store = new OwnerScopedStore<RegisterState>({
  name: 'patch-registers',
  create: () => ({ registers: new Map(), evicted: new Set() }),
  cap: 32,
})
registerOwnerScopedStore(store)

function totalBytes(state: RegisterState): number {
  let n = 0
  for (const r of state.registers.values()) n += r.content.length
  return n
}

export function publishPatchRegister(
  owner: OwnerKey,
  name: string,
  register: PatchRegister,
): { ok: true } | { ok: false; reason: string } {
  if (register.content.length > PATCH_REGISTER_BOUNDS.perRegisterBytes) {
    return {
      ok: false,
      reason: `register '${name}' would hold ${register.content.length} bytes — the cap is ${PATCH_REGISTER_BOUNDS.perRegisterBytes}`,
    }
  }
  const state = store.get(owner)
  state.registers.delete(name)
  state.registers.set(name, register)
  state.evicted.delete(name)
  while (
    state.registers.size > PATCH_REGISTER_BOUNDS.nameCap ||
    totalBytes(state) > PATCH_REGISTER_BOUNDS.bytesCap
  ) {
    const oldest = state.registers.keys().next().value as string | undefined
    if (oldest === undefined) break
    state.registers.delete(oldest)
    state.evicted.add(oldest)
    if (state.evicted.size > 64) {
      const first = state.evicted.values().next().value
      if (first !== undefined) state.evicted.delete(first)
    }
  }
  return { ok: true }
}

export function readPatchRegister(owner: OwnerKey, name: string): PatchRegister | undefined {
  return store.peek(owner)?.registers.get(name)
}

export function patchRegisterEvicted(owner: OwnerKey, name: string): boolean {
  return store.peek(owner)?.evicted.has(name) ?? false
}

export function listPatchRegisters(owner: OwnerKey): Array<{ name: string } & PatchRegister> {
  const state = store.peek(owner)
  if (!state) return []
  return [...state.registers.entries()].map(([name, r]) => ({ name, ...r }))
}

export function _resetPatchRegistersForTesting(): void {
  store.clearAllForShutdown()
}
